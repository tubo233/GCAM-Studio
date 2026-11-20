import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { apiGet, apiPost, apiPut, http } from '../api'
import { useNavigate } from 'react-router-dom'
import InputChanges, {changed} from '../components/InputChanges'
import ScenarioSettings from './ScenarioSettings'
import DataFiles from './DataFiles'
import { useProfiles } from '../context/ProfileContext'
import type { XmlItem } from '../types'

const { Title, Text } = Typography

export default function ConfigEditor() {
  const { activeId } = useProfiles()
  if (!activeId) return <Alert type="warning" showIcon message="请先选择一个参数环境（Profile）" />
  return <ProfileConfig key={activeId} activeId={activeId} />
}

function ProfileConfig({ activeId }: { activeId: string }) {
  const navigate = useNavigate()
  const { active, setActiveId, reload } = useProfiles()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<any>(null)
  const [savedForm,setSavedForm] = useState('')
  const formSignature=(c:any)=>JSON.stringify([c.components,c.files,c.strings,c.bools,c.ints,c.doubles])
  useEffect(()=>{if(config)setSavedForm(formSignature(config))},[config?.revision])
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
    setError('')
  }

  useEffect(() => { load().catch(e => setError(e.response?.data?.detail || '配置加载失败')) }, [activeId])

  const importConfig = (file?: File) => {
    if (!file) return
    Modal.confirm({
      title: '导入手工主配置', content: `用 ${file.name} 替换当前 Profile 的主配置及页面内未保存的编辑？`,
      okText: '导入', cancelText: '取消',
      async onOk() {
        const body = new FormData()
        body.append('file', file)
        try {
          const r = await http.put(`/api/profiles/${activeId}/config/import`, body)
          await load()
          changed()
          const count = r.data.data.config_repairs
          message.success(['已导入主配置', count && `修正 ${count} 处 XML 拼写`, r.data.data.rebased_inputs && `已匹配 ${r.data.data.rebased_inputs} 个本机输入文件`].filter(Boolean).join('，'))
        } catch (e: any) {
          message.error(e.response?.data?.detail || '导入失败')
          throw e
        }
      },
    })
  }

  const options = useMemo(
    () => xmls.filter((x) => x.kind === addKind).map((x) => ({ value: x.path, label: `${x.name}  (${x.category})` })),
    [xmls, addKind],
  )

  const save = async (goToRuns = false) => {
    if (!activeId || !config) return
    setSaving(true)
    try {
      const saved = await apiPut(`/api/profiles/${activeId}/config`, config)
      setConfig((c: any) => ({...c, revision: saved.revision}))
      message.success('配置已保存到当前 Profile')
      changed()
      if (goToRuns) {
        const job = await apiPost(`/api/profiles/${activeId}/run`, {config_revision:saved.revision})
        navigate('/runs', {state:{jobId:job.id}})
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const saveCopy = async () => {
    if (!config) return
    const name = window.prompt('新情景名称', `${active?.name || activeId} 副本`)?.trim()
    if (!name) return
    setSaving(true)
    try {
      const copy = await apiPost(`/api/profiles/${activeId}/clone`, {name})
      await apiPut(`/api/profiles/${copy.id}/config`, config)
      await reload()
      setActiveId(copy.id)
      message.success('已切换到新情景，可继续编辑')
    } catch (e: any) {
      message.error(e.response?.data?.detail || '另存为失败')
    } finally { setSaving(false) }
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

  return (
    <div>
      <Title level={3} className="page-title">情景编辑 · {active?.name}</Title>


      {config && savedForm && savedForm !== formSignature(config) && <Alert type="info" showIcon message="配置有待保存的改动，保存后将更新下方对照清单。"/>}
      <InputChanges pid={activeId}/>
      <Card
        extra={<Space><input type="file" accept=".xml" hidden ref={fileRef} onChange={e => { importConfig(e.target.files?.[0]); e.target.value = '' }} />
          <Button onClick={() => fileRef.current?.click()}>导入手工主配置</Button>
          <Button disabled={!config} loading={saving} onClick={saveCopy}>另存为情景</Button>
          <Button type="primary" icon={<SaveOutlined />} disabled={!config} loading={saving} onClick={() => save()}>保存配置</Button>
          <Button disabled={!config} loading={saving} onClick={() => save(true)}>保存并运行</Button></Space>}
        title="当前情景"
      >
        {!config ? (
          <Alert type={error ? "error" : "info"} showIcon message={error || "加载中…"} />
        ) : (
          <Tabs
            items={[
              { key: 'scenario', label: '情景与政策', children: <ScenarioSettings id={activeId} config={config} setConfig={setConfig} xmls={xmls} refreshPolicies={async () => {
                setXmls(await apiGet<XmlItem[]>('/api/catalog/xml', {profile_id:activeId}))
              }}/>  },
              { key: 'data', label: '输入数据 CSV', children: <DataFiles chinaInput={config.components.map((r: any) => String(r.value).split(/[\\/]/).pop()).filter((n: string) => /^socioeconomics_CHINA(?:_SSP[1-5])?\.xml$/i.test(n)).pop()} /> },
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
                          render: (v, _, i) => <Input size="small" value={v} onChange={e => updateComponent(i, 'value', e.target.value)}/>,
                        },
                        {
                          title: '顺序', width: 150,
                          render: (_, __, i) => <Space size={2}>{[-1,1].map(step => <Button key={step} size="small" disabled={i+step < 0 || i+step >= config.components.length} onClick={() => {
                            const rows = [...config.components]
                            rows.splice(i+step, 0, rows.splice(i, 1)[0])
                            setConfig({...config,components:rows})
                          }}>{step < 0 ? '上移' : '下移'}</Button>)}
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setConfig({ ...config, components: config.components.filter((_: any, j: number) => j !== i) })} /></Space>,
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
