import React, { useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Typography, message } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { apiPut } from '../api'
import { useProfiles } from '../context/ProfileContext'
import XmlBrowser from './XmlBrowser'

const { Title, Text } = Typography

export default function PolicyStudio() {
  const { activeId } = useProfiles()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)

  const generate = async () => {
    if (!activeId) return message.warning('请先选择 Profile')
    const v = await form.validateFields()
    const start = Number(v.start_year)
    const end = Number(v.end_year)
    if (end < start) return message.warning('结束年不能早于起始年')
    const price0 = Number(v.price)
    const growth = Number(v.growth) / 100
    const lines: string[] = []
    let p = price0
    for (let y = start; y <= end; y += 5) {
      lines.push(`        <fixedTax year="${y}">${Number(p.toFixed(6))}</fixedTax>`)
      p *= Math.pow(1 + growth, 5)
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scenario name="${String(v.scenario_name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">
  <world>
    <region name="China">
      <ghgpolicy name="CO2_LTG">
        <market>global</market>
${lines.join('\n')}
      </ghgpolicy>
    </region>
  </world>
</scenario>
`
    setBusy(true)
    try {
      const name = `carbon_tax_custom_${Date.now()}.xml`
      await apiPut('/api/xml/content', { profile_id: activeId, kind: 'policy', path: name, text: xml })
      message.success(`已生成政策文件：${name}（在“情景组件 XML / 政策”中可编辑，并在配置组件里引用）`)
      setOpen(false)
      setRevision((previous) => previous + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Title level={3} className="page-title">政策工作室</Title>
      <p className="page-sub">碳税、碳配额、净零、强迫目标、UCT/FFICT、补贴。生成的 XML 保存在当前 Profile 的覆盖层。</p>

      <Card style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setOpen(true)}>碳税曲线生成器</Button>
          <Text type="secondary">按起始年、结束年、初始税率和年增长率生成 5 年步长的 fixedTax 序列。</Text>
        </Space>
      </Card>

      <XmlBrowser key={revision} kindFilter="policy" pageTitle="政策库" pageSub="内置政策与当前 Profile 的自定义政策；保存后可在模型配置中引用。" />

      <Modal title="生成碳税政策 XML" open={open} onOk={generate} confirmLoading={busy} onCancel={() => setOpen(false)} okText="生成并保存">
        <Form form={form} layout="vertical" initialValues={{ scenario_name: 'CarbonTax', start_year: 2025, end_year: 2100, price: 25, growth: 5 }}>
          <Form.Item name="scenario_name" label="场景名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Space>
            <Form.Item name="start_year" label="起始年"><InputNumber min={2021} max={2100} /></Form.Item>
            <Form.Item name="end_year" label="结束年"><InputNumber min={2025} max={2100} /></Form.Item>
          </Space>
          <Space>
            <Form.Item name="price" label="初始税率（1990$/tC）"><InputNumber min={0} style={{ width: 180 }} /></Form.Item>
            <Form.Item name="growth" label="年增长率（%）"><InputNumber min={0} max={50} style={{ width: 150 }} /></Form.Item>
          </Space>
        </Form>
        <Alert type="info" showIcon message="当前生成器只对中国区域设置 fixedTax；全球统一碳税需要给所有区域写 policy，可后续扩展。" />
      </Modal>
    </div>
  )
}
