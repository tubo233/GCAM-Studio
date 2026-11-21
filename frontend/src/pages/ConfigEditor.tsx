import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Collapse, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons'
import { apiGet, apiPost, apiPut, http } from '../api'
import { useNavigate } from 'react-router-dom'
import InputChanges, { changed } from '../components/InputChanges'
import ScenarioSettings from './ScenarioSettings'
import { StepFooter, StepHeader } from '../components/WorkflowChrome'
import { useProfiles } from '../context/ProfileContext'
import type { XmlItem } from '../types'

const { Text } = Typography

export default function ConfigEditor() {
  const navigate = useNavigate()
  const { activeId } = useProfiles()
  if (!activeId) {
    return (
      <div>
        <StepHeader
          step={2}
          title="情景与政策"
          description="选择基础社会经济模板、配置排放政策约束与全球气候目标。"
        />
        <Alert
          type="warning"
          showIcon
          message="请先在第 ① 步选择或新建一个情景（Profile）"
          action={
            <Button type="primary" size="small" onClick={() => navigate('/profiles')}>
              前往 ① 选择情景
            </Button>
          }
        />
      </div>
    )
  }
  return <ProfileConfig key={activeId} activeId={activeId} />
}

function ProfileConfig({ activeId }: { activeId: string }) {
  const navigate = useNavigate()
  const { active, setActiveId, reload } = useProfiles()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [config, setConfig] = useState<any>(null)
  const [savedForm, setSavedForm] = useState('')
  const formSignature = (c: any) => JSON.stringify([c.components, c.files, c.strings, c.bools, c.ints, c.doubles])
  useEffect(() => {
    if (config) setSavedForm(formSignature(config))
  }, [config?.revision])

  const [xmls, setXmls] = useState<XmlItem[]>([])
  const [open, setOpen] = useState(false)
  const [addKind, setAddKind] = useState('xml')
  const [addPath, setAddPath] = useState('')
  const [addName, setAddName] = useState('')
  const [saving, setSaving] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyName, setCopyName] = useState('')

  const hasUnsaved = !!(config && savedForm && savedForm !== formSignature(config))

  const load = async () => {
    if (!activeId) return
    const [c, x] = await Promise.all([
      apiGet<any>(`/api/profiles/${activeId}/config`),
      apiGet<XmlItem[]>('/api/catalog/xml', { profile_id: activeId }),
    ])
    setConfig(c)
    setXmls(x)
    setError('')
  }

  useEffect(() => {
    load().catch((e) => setError(e.response?.data?.detail || '配置加载失败'))
  }, [activeId])

  const importConfig = (file?: File) => {
    if (!file) return
    Modal.confirm({
      title: '导入手工主配置',
      content: `用 ${file.name} 替换当前情景的主配置及页面内未保存的编辑？`,
      okText: '导入',
      cancelText: '取消',
      async onOk() {
        const body = new FormData()
        body.append('file', file)
        try {
          const r = await http.put(`/api/profiles/${activeId}/config/import`, body)
          await load()
          changed()
          const count = r.data.data.config_repairs
          message.success(
            [
              '已导入主配置',
              count && `修正 ${count} 处 XML 拼写`,
              r.data.data.rebased_inputs && `已匹配 ${r.data.data.rebased_inputs} 个本机输入文件`,
            ]
              .filter(Boolean)
              .join('，'),
          )
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

  const persistConfig = async () => {
    if (!activeId || !config) return null
    setSaving(true)
    try {
      const saved = await apiPut(`/api/profiles/${activeId}/config`, config)
      const next = { ...config, revision: saved.revision }
      setConfig(next)
      setSavedForm(formSignature(next))
      changed()
      return saved
    } catch (e: any) {
      message.error(e.response?.data?.detail || '保存失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  const save = async (goToRuns = false) => {
    const saved = await persistConfig()
    if (!saved) return
    message.success('配置已保存到当前情景')
    if (goToRuns) {
      try {
        const job = await apiPost(`/api/profiles/${activeId}/run`, { config_revision: saved.revision })
        navigate('/runs', { state: { jobId: job.id } })
      } catch (e: any) {
        message.error(e.response?.data?.detail || '提交运行失败')
      }
    }
  }

  const saveAndNavigate = async (targetPath: string) => {
    if (hasUnsaved) {
      const saved = await persistConfig()
      if (!saved) return
      message.success('已自动保存本步配置')
    }
    navigate(targetPath)
  }

  const openSaveCopy = () => {
    setCopyName(`${active?.name || activeId} 副本`)
    setCopyOpen(true)
  }

  const saveCopy = async () => {
    const name = copyName.trim()
    if (!config || !name) return
    setSaving(true)
    try {
      const copy = await apiPost(`/api/profiles/${activeId}/clone`, { name })
      await apiPut(`/api/profiles/${copy.id}/config`, config)
      await reload()
      setActiveId(copy.id)
      setCopyOpen(false)
      message.success(`已另存并切换到新情景「${name}」`)
    } catch (e: any) {
      message.error(e.response?.data?.detail || '另存为失败')
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

  return (
    <div>
      <StepHeader
        step={2}
        title={`情景与政策 · ${active?.name || activeId}`}
        description="选择社会经济模板（SSP）、启用或新建碳税/排放约束，并决定是否开启全球气候目标搜索。"
        tags={
          config ? (
            hasUnsaved ? (
              <Tag color="orange">有未保存改动</Tag>
            ) : (
              <Tag color="green">配置已保存</Tag>
            )
          ) : undefined
        }
        extra={
          <>
            <Button disabled={!config} loading={saving} onClick={openSaveCopy}>
              另存为新情景
            </Button>
            <Button type="primary" icon={<SaveOutlined />} disabled={!config} loading={saving} onClick={() => save(false)}>
              保存配置
            </Button>
            <Button disabled={!config} loading={saving} onClick={() => save(true)}>
              保存并立即运行
            </Button>
          </>
        }
      />

      {hasUnsaved && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="当前页面有尚未保存的配置改动，点击“保存配置”或底部“下一步”时将自动保存并更新对比清单。"
        />
      )}

      <InputChanges pid={activeId} defaultExpanded={false} title="相比上次运行" />

      <Card>
        {!config ? (
          <Alert type={error ? 'error' : 'info'} showIcon message={error || '正在加载配置…'} />
        ) : (
          <Tabs
            items={[
              {
                key: 'scenario',
                label: '情景与政策配置',
                children: (
                  <ScenarioSettings
                    id={activeId}
                    config={config}
                    setConfig={setConfig}
                    xmls={xmls}
                    refreshPolicies={async () => {
                      setXmls(await apiGet<XmlItem[]>('/api/catalog/xml', { profile_id: activeId }))
                    }}
                    onGoStep3={saveAndNavigate}
                  />
                ),
              },
              {
                key: 'advanced',
                label: `高级主配置 XML（${config.components.length} 组件）`,
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Alert
                      type="info"
                      showIcon
                      message="用于直接导入 GCAM 手工主配置（configuration*.xml）、调整组件加载顺序或修改标量开关。"
                      action={
                        <>
                          <input
                            type="file"
                            accept=".xml"
                            hidden
                            ref={fileRef}
                            onChange={(e) => {
                              importConfig(e.target.files?.[0])
                              e.target.value = ''
                            }}
                          />
                          <Button size="small" icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
                            导入手工主配置 (.xml)
                          </Button>
                        </>
                      }
                    />
                    <Collapse
                      defaultActiveKey={['components']}
                      items={[
                        {
                          key: 'components',
                          label: `情景组件加载顺序 (${config.components.length})`,
                          children: (
                            <>
                              <Space style={{ marginBottom: 10 }} wrap>
                                <Button icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                                  添加组件
                                </Button>
                                <Text type="secondary">组件按从上到下的顺序加载；后加载的会覆盖先加载的同名参数。</Text>
                              </Space>
                              <Table
                                size="small"
                                rowKey={(_, i) => String(i)}
                                dataSource={config.components}
                                pagination={false}
                                columns={[
                                  {
                                    title: '名称',
                                    dataIndex: 'name',
                                    width: 240,
                                    render: (v, _, i) => (
                                      <Input size="small" value={v} onChange={(e) => updateComponent(i, 'name', e.target.value)} />
                                    ),
                                  },
                                  {
                                    title: '文件',
                                    dataIndex: 'value',
                                    render: (v, _, i) => (
                                      <Input size="small" value={v} onChange={(e) => updateComponent(i, 'value', e.target.value)} />
                                    ),
                                  },
                                  {
                                    title: '顺序',
                                    width: 160,
                                    render: (_, __, i) => (
                                      <Space size={4}>
                                        {[-1, 1].map((step) => (
                                          <Button
                                            key={step}
                                            size="small"
                                            disabled={i + step < 0 || i + step >= config.components.length}
                                            onClick={() => {
                                              const rows = [...config.components]
                                              rows.splice(i + step, 0, rows.splice(i, 1)[0])
                                              setConfig({ ...config, components: rows })
                                            }}
                                          >
                                            {step < 0 ? '上移' : '下移'}
                                          </Button>
                                        ))}
                                        <Button
                                          size="small"
                                          danger
                                          icon={<DeleteOutlined />}
                                          onClick={() =>
                                            setConfig({
                                              ...config,
                                              components: config.components.filter((_: any, j: number) => j !== i),
                                            })
                                          }
                                        />
                                      </Space>
                                    ),
                                  },
                                ]}
                              />
                            </>
                          ),
                        },
                        {
                          key: 'files',
                          label: `核心文件路径 (${config.files.length})`,
                          children: (
                            <Table
                              size="small"
                              rowKey="name"
                              dataSource={config.files}
                              pagination={false}
                              columns={[
                                { title: '名称', dataIndex: 'name', width: 220 },
                                {
                                  title: '值',
                                  dataIndex: 'value',
                                  render: (v, r: any) => (
                                    <Input
                                      size="small"
                                      value={v}
                                      onChange={(e) => {
                                        const files = config.files.map((f: any) =>
                                          f.name === r.name ? { ...f, value: e.target.value } : f,
                                        )
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
                          label: '开关与标量参数 (Strings / Bools / Ints / Doubles)',
                          children: (
                            <Space direction="vertical" style={{ width: '100%' }} size={14}>
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
                                        title: '值',
                                        dataIndex: 'value',
                                        render: (v, r: any) => (
                                          <Input
                                            size="small"
                                            value={v}
                                            onChange={(e) => {
                                              const arr = config[key].map((x: any) =>
                                                x.name === r.name ? { ...x, value: e.target.value } : x,
                                              )
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
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <StepFooter
        prev={{ label: '上一步：① 选择情景', onClick: () => navigate('/profiles') }}
        secondaryNext={{
          label: '③ 参数与数据（可选） →',
          disabled: !config,
          loading: saving,
          onClick: () => saveAndNavigate('/parameters'),
        }}
        next={{
          label: '下一步：④ 检查与运行',
          disabled: !config,
          loading: saving,
          onClick: () => saveAndNavigate('/runs'),
        }}
        hint="不做精细数值微调时，可直接跳过第 ③ 步前往运行"
      />

      <Modal title="添加情景组件" open={open} onOk={addComponent} onCancel={() => setOpen(false)} okText="添加">
        <Form layout="vertical">
          <Form.Item label="类型">
            <Select
              value={addKind}
              onChange={(v) => {
                setAddKind(v)
                setAddPath('')
              }}
              options={[
                { value: 'xml', label: 'gcamdata XML' },
                { value: 'policy', label: '政策 XML' },
                { value: 'extra', label: '额外组件' },
              ]}
            />
          </Form.Item>
          <Form.Item label="文件">
            <Select
              showSearch
              optionFilterProp="label"
              value={addPath || undefined}
              onChange={setAddPath}
              options={options}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="组件名称（可选）">
            <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="例如 carbon_tax" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="另存为新情景"
        open={copyOpen}
        onOk={saveCopy}
        confirmLoading={saving}
        okButtonProps={{ disabled: !copyName.trim() }}
        onCancel={() => setCopyOpen(false)}
        okText="保存并切换"
      >
        <Form layout="vertical">
          <Form.Item label="新情景名称">
            <Input value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="输入新情景名称" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
