import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { apiGet, apiPut } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { XmlItem } from '../types'

const { Title, Text } = Typography

export default function ConfigEditor() {
  const { activeId } = useProfiles()
  const [config, setConfig] = useState<any>(null)
  const [xmls, setXmls] = useState<XmlItem[]>([])
  const [open, setOpen] = useState(false)
  const [addKind, setAddKind] = useState('xml')
  const [addPath, setAddPath] = useState('')
  const [addName, setAddName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!activeId) return
    const [c, x] = await Promise.all([apiGet<any>(`/api/profiles/${activeId}/config`), apiGet<XmlItem[]>('/api/catalog/xml', { profile_id: activeId })])
    setConfig(c)
    setXmls(x)
  }

  useEffect(() => { load() }, [activeId])

  const options = useMemo(
    () => xmls.filter((x) => x.kind === addKind).map((x) => ({ value: x.path, label: `${x.name}  (${x.category})` })),
    [xmls, addKind],
  )

  const save = async () => {
    if (!activeId || !config) return
    setSaving(true)
    try {
      await apiPut(`/api/profiles/${activeId}/config`, config)
      message.success('配置已保存到当前 Profile')
    } finally {
      setSaving(false)
    }
  }

  const addComponent = () => {
    if (!addPath) return message.warning('请选择组件')
    const prefix = addKind === 'xml' ? '../input/gcamdata/xml/' : addKind === 'policy' ? '../input/policy/' : '../input/extra/'
    setConfig({
      ...config,
      components: [...config.components, { name: addName || addPath.replace(/\.xml$/, ''), value: prefix + addPath }],
    })
    setOpen(false)
    setAddPath('')
    setAddName('')
  }

  const updateComponent = (idx: number, key: string, value: string) => {
    const comps = [...config.components]
    comps[idx] = { ...comps[idx], [key]: value }
    setConfig({ ...config, components: comps })
  }

  if (!activeId) return <Alert type="warning" showIcon message="请先选择一个参数环境（Profile）" />

  return (
    <div>
      <Title level={3} className="page-title">模型配置</Title>
      <p className="page-sub">直接编辑当前 Profile 的 configuration.xml：情景组件、输入输出文件、字符串/布尔/整数开关。</p>

      <Card
        extra={<Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>保存配置</Button>}
        title="configuration.xml"
      >
        {!config ? (
          <Alert type="info" showIcon message="加载中…" />
        ) : (
          <Tabs
            items={[
              {
                key: 'components',
                label: `情景组件 (${config.components.length})`,
                children: (
                  <>
                    <Space style={{ marginBottom: 10 }}>
                      <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>添加组件</Button>
                      <Text type="secondary">组件按从上到下的顺序加载；后加载的会覆盖先加载的同名参数。</Text>
                    </Space>
                    <Table
                      size="small"
                      rowKey={(_, i) => String(i)}
                      dataSource={config.components}
                      pagination={false}
                      columns={[
                        {
                          title: '名称', dataIndex: 'name', width: 260,
                          render: (v, _, i) => <Input size="small" value={v} onChange={(e) => updateComponent(i, 'name', e.target.value)} />,
                        },
                        {
                          title: '文件', dataIndex: 'value',
                          render: (v) => <span className="muted" style={{ fontSize: 12 }}>{v}</span>,
                        },
                        {
                          title: '操作', width: 80,
                          render: (_, __, i) => <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setConfig({ ...config, components: config.components.filter((_: any, j: number) => j !== i) })} />,
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'files',
                label: `文件 (${config.files.length})`,
                children: (
                  <Table
                    size="small"
                    rowKey="name"
                    dataSource={config.files}
                    pagination={false}
                    columns={[
                      { title: '名称', dataIndex: 'name', width: 220 },
                      {
                        title: '值', dataIndex: 'value',
                        render: (v, r: any) => (
                          <Input
                            size="small"
                            value={v}
                            onChange={(e) => {
                              const files = config.files.map((f: any) => (f.name === r.name ? { ...f, value: e.target.value } : f))
                              setConfig({ ...config, files })
                            }}
                          />
                        ),
                      },
                    ]}
                  />
                ),
              },
              {
                key: 'scalars',
                label: '开关与参数',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size={16}>
                    {['strings', 'bools', 'ints', 'doubles'].map((key) => (
                      <Card size="small" title={key} key={key}>
                        <Table
                          size="small"
                          rowKey="name"
                          dataSource={config[key]}
                          pagination={false}
                          columns={[
                            { title: '名称', dataIndex: 'name', width: 260 },
                            {
                              title: '值', dataIndex: 'value',
                              render: (v, r: any) => (
                                <Input
                                  size="small"
                                  value={v}
                                  onChange={(e) => {
                                    const arr = config[key].map((x: any) => (x.name === r.name ? { ...x, value: e.target.value } : x))
                                    setConfig({ ...config, [key]: arr })
                                  }}
                                />
                              ),
                            },
                          ]}
                        />
                      </Card>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal title="添加情景组件" open={open} onOk={addComponent} onCancel={() => setOpen(false)} okText="添加">
        <Form layout="vertical">
          <Form.Item label="类型">
            <Select value={addKind} onChange={(v) => { setAddKind(v); setAddPath('') }} options={[{ value: 'xml', label: 'gcamdata XML' }, { value: 'policy', label: '政策 XML' }, { value: 'extra', label: '额外组件' }]} />
          </Form.Item>
          <Form.Item label="文件">
            <Select showSearch optionFilterProp="label" value={addPath || undefined} onChange={setAddPath} options={options} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="组件名称（可选）">
            <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="例如 carbon_tax" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
