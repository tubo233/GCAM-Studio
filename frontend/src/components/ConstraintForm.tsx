import React from 'react'
import { Form, Input, InputNumber, Modal, Select } from 'antd'
import type { PolicyDraft } from './PolicyFileEditor'

type PolicyValues = { kind: string; region: string; market: string; name: string; year: number; value: number }
export default function ConstraintForm({
  close,
  preview,
}: {
  close: () => void
  preview: (v: PolicyDraft) => void
}) {
  const [form] = Form.useForm<PolicyValues>()
  const kind = Form.useWatch('kind', form)
  const create = async () => {
    const v = await form.validateFields()
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
    <Modal open title="新建约束" okText="预览约束" onOk={create} onCancel={close}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: 'constraint', name: 'CO2', region: 'SC', market: 'SC', year: 2025 }}
      >
        <Form.Item label="约束类型" name="kind">
          <Select
            onChange={(k) => form.setFieldValue('name', k === 'share-of-sector-output' ? '' : 'CO2')}
            options={[
              { value: 'constraint', label: '排放上限' },
              { value: 'fixedTax', label: '固定碳价' },
              { value: 'share-of-sector-output', label: '发电占比约束' },
            ]}
          />
        </Form.Item>
        <Form.Item
          label={kind === 'share-of-sector-output' ? '已连接发电技术的政策名称' : '温室气体或政策名称'}
          name="name"
          rules={[{ required: true, whitespace: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="地区代码" name="region" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="市场代码" name="market" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="模型年份" name="year" rules={[{ required: true }]}>
          <InputNumber precision={0} />
        </Form.Item>
        <Form.Item
          label={kind === 'share-of-sector-output' ? '占比（0–1）' : '数值（按所选政策的模型单位）'}
          name="value"
          rules={[{ required: true }]}
        >
          <InputNumber
            min={kind === 'share-of-sector-output' ? 0 : undefined}
            max={kind === 'share-of-sector-output' ? 1 : undefined}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
