import React, { useState } from 'react'
import { Alert, Form, Input, InputNumber, Modal, Segmented, Select, Space, message } from 'antd'
import type { PolicyDraft } from './PolicyFileEditor'

type PolicyValues = {
  kind: string
  region: string
  market: string
  name: string
  year: number
  value: number
  scenario_name: string
  curve_region: string
  curve_market: string
  curve_policy: string
  start_year: number
  end_year: number
  price: number
  growth: number
}

function escapeXmlAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export default function ConstraintForm({
  close,
  preview,
}: {
  close: () => void
  preview: (v: PolicyDraft) => void
}) {
  const [mode, setMode] = useState<'single' | 'tax_curve'>('single')
  const [form] = Form.useForm<PolicyValues>()
  const kind = Form.useWatch('kind', form)

  const create = async () => {
    const v = await form.validateFields()
    if (mode === 'tax_curve') {
      const start = Number(v.start_year)
      const end = Number(v.end_year)
      if (end < start) {
        message.warning('结束年不能早于起始年')
        return
      }
      const price0 = Number(v.price)
      const growth = Number(v.growth) / 100
      const lines: string[] = []
      let p = price0
      for (let y = start; y <= end; y += 5) {
        lines.push(`        <fixedTax year="${y}">${Number(p.toFixed(6))}</fixedTax>`)
        p *= Math.pow(1 + growth, 5)
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scenario name="${escapeXmlAttr(v.scenario_name.trim())}">
  <world>
    <region name="${escapeXmlAttr(v.curve_region.trim())}">
      <ghgpolicy name="${escapeXmlAttr(v.curve_policy.trim())}">
        <market>${escapeXmlAttr(v.curve_market.trim())}</market>
${lines.join('\n')}
      </ghgpolicy>
    </region>
  </world>
</scenario>
`
      preview({ path: `carbon_tax_custom_${Date.now()}.xml`, text: xml })
      return
    }

    const doc = document.implementation.createDocument('', 'scenario')
    const child = (parent: Element, tag: string, text?: string) => {
      const el = doc.createElement(tag)
      if (text !== undefined) el.textContent = text
      parent.append(el)
      return el
    }
    const region = child(child(doc.documentElement, 'world'), 'region')
    region.setAttribute('name', v.region.trim())
    const share = v.kind === 'share-of-sector-output'
    const policy = child(region, share ? 'policy-portfolio-standard' : 'ghgpolicy')
    policy.setAttribute('name', v.name.trim())
    child(policy, 'market', v.market.trim())
    if (share) {
      child(policy, 'policyType', 'RES')
      child(policy, 'isShareBased', '1')
    }
    child(policy, v.kind, String(v.value)).setAttribute('year', String(v.year))
    preview({ path: `${v.kind}_${Date.now()}.xml`, text: new XMLSerializer().serializeToString(doc) })
  }

  return (
    <Modal open title="新建政策与约束" width={540} okText="预览并保存" onOk={create} onCancel={close}>
      <Segmented
        block
        value={mode}
        onChange={(val) => setMode(val as 'single' | 'tax_curve')}
        style={{ marginBottom: 16 }}
        options={[
          { value: 'single', label: '单点 / 常规约束（上限、碳价、发电占比）' },
          { value: 'tax_curve', label: '多年碳税增长曲线（5 年步长）' },
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          kind: 'constraint',
          name: 'CO2',
          region: 'SC',
          market: 'SC',
          year: 2025,
          scenario_name: 'CarbonTax',
          curve_region: 'China',
          curve_market: 'global',
          curve_policy: 'CO2_LTG',
          start_year: 2025,
          end_year: 2100,
          price: 25,
          growth: 5,
        }}
      >
        {mode === 'single' ? (
          <>
            <Form.Item label="约束类型" name="kind">
              <Select
                onChange={(k) => form.setFieldValue('name', k === 'share-of-sector-output' ? '' : 'CO2')}
                options={[
                  { value: 'constraint', label: '排放上限（constraint）' },
                  { value: 'fixedTax', label: '固定碳价（fixedTax）' },
                  { value: 'share-of-sector-output', label: '发电占比约束（share-of-sector-output）' },
                ]}
              />
            </Form.Item>
            <Form.Item
              label={kind === 'share-of-sector-output' ? '已连接发电技术的政策名称' : '温室气体或政策名称'}
              name="name"
              rules={[{ required: true, whitespace: true }]}
            >
              <Input placeholder={kind === 'share-of-sector-output' ? '例如：RES_wind' : '例如：CO2 或 CO2_LTG'} />
            </Form.Item>
            <Space style={{ width: '100%' }} align="start" size={12}>
              <Form.Item
                label="地区代码"
                name="region"
                extra="如 China、SC（四川）、CQ（重庆）"
                rules={[{ required: true, whitespace: true }]}
                style={{ width: 230 }}
              >
                <Input />
              </Form.Item>
              <Form.Item
                label="市场代码"
                name="market"
                extra="如 global、China、SC（可与地区不同）"
                rules={[{ required: true, whitespace: true }]}
                style={{ width: 230 }}
              >
                <Input />
              </Form.Item>
            </Space>
            <Space style={{ width: '100%' }} align="start" size={12}>
              <Form.Item label="模型年份" name="year" rules={[{ required: true }]}>
                <InputNumber min={2021} max={2100} precision={0} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item
                label={kind === 'share-of-sector-output' ? '占比（0–1）' : '数值（按所选政策的模型单位）'}
                name="value"
                rules={[{ required: true }]}
              >
                <InputNumber
                  min={kind === 'share-of-sector-output' ? 0 : undefined}
                  max={kind === 'share-of-sector-output' ? 1 : undefined}
                  style={{ width: 240 }}
                />
              </Form.Item>
            </Space>
          </>
        ) : (
          <>
            <Form.Item label="XML 场景名（scenario name）" name="scenario_name" rules={[{ required: true, whitespace: true }]}>
              <Input />
            </Form.Item>
            <Space style={{ width: '100%' }} align="start" size={12}>
              <Form.Item label="地区代码" name="curve_region" rules={[{ required: true, whitespace: true }]} style={{ width: 150 }}>
                <Input />
              </Form.Item>
              <Form.Item label="市场代码" name="curve_market" rules={[{ required: true, whitespace: true }]} style={{ width: 150 }}>
                <Input />
              </Form.Item>
              <Form.Item label="政策 / 气体名" name="curve_policy" rules={[{ required: true, whitespace: true }]} style={{ width: 165 }}>
                <Input />
              </Form.Item>
            </Space>
            <Space style={{ width: '100%' }} align="start" size={12}>
              <Form.Item label="起始年" name="start_year" rules={[{ required: true }]}>
                <InputNumber min={2021} max={2100} precision={0} style={{ width: 110 }} />
              </Form.Item>
              <Form.Item label="结束年" name="end_year" rules={[{ required: true }]}>
                <InputNumber min={2025} max={2100} precision={0} style={{ width: 110 }} />
              </Form.Item>
              <Form.Item label="初始税率（1990$/tC）" name="price" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item label="年增长率（%）" name="growth" rules={[{ required: true }]}>
                <InputNumber min={0} max={50} style={{ width: 105 }} />
              </Form.Item>
            </Space>
            <Alert
              type="info"
              showIcon
              message="将按 5 年步长生成 fixedTax 序列；预览时可点击“加入当前情景”一键保存并启用，无需手动去配置页挂载。"
            />
          </>
        )}
      </Form>
    </Modal>
  )
}
