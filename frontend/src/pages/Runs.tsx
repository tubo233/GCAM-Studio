import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router-dom'
import InputChanges from '../components/InputChanges'
import { apiGet, apiPost } from '../api'
import { useProfiles } from '../context/ProfileContext'
import LogConsole from '../components/LogConsole'
import { StepFooter, StepHeader } from '../components/WorkflowChrome'
import type { Job, RunInfo } from '../types'

const { Text } = Typography

type RunMode = 'full' | 'fast' | 'dry'

const stageNames: Record<string, string> = {
  build: '生成 XML',
  configure: '准备配置',
  solve: '模型求解',
  output: '写入结果库',
  complete: '完成',
}

const JOB_STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: '排队中', color: 'default' },
  running: { label: '运行中', color: 'blue' },
  success: { label: '已完成', color: 'green' },
  failed: { label: '失败', color: 'red' },
  cancelled: { label: '已取消', color: 'orange' },
}

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  success: { label: '成功', color: 'green' },
  running: { label: '运行中', color: 'blue' },
  queued: { label: '排队中', color: 'default' },
  failed: { label: '失败', color: 'red' },
  cancelled: { label: '已取消', color: 'orange' },
  interrupted: { label: '已中断', color: 'orange' },
  'dry-run': { label: '仅检查', color: 'default' },
}

const JOB_KIND: Record<string, string> = {
  run: '模型运行',
  build: '生成 XML',
  query: '结果查询',
}

type RunInputs = {
  revision: string
  scenario_name: string
  socioeconomics: string[]
  policies: string[]
  commented_policies: string[]
  find_path: boolean
  target_file: string
  stop_year: string
}

function labelWarning(name: string, inputs: RunInputs) {
  const requested = name.match(/SSP([1-5])/i)?.[1]
  const global = inputs.socioeconomics.filter((s) => /^socioeconomics_(CORE|SSP[1-5])\.xml$/i.test(s))
  if (requested && global.length && !global.some((s) => s.toUpperCase() === `SOCIOECONOMICS_SSP${requested}.XML`))
    return `结果名含 SSP${requested}，当前全球社会经济输入为 ${global.join('、')}。`
  return ''
}

export default function Runs() {
  const nav = useNavigate()
  const { activeId, active, profiles } = useProfiles()
  const [form] = Form.useForm()
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<RunInfo[]>([])
  const location = useLocation()
  const [activeJob, setActiveJob] = useState<string>(location.state?.jobId || '')
  const [drawer, setDrawer] = useState(!!location.state?.jobId)
  const [drawerJobStatus, setDrawerJobStatus] = useState('')
  const [dryJobIds, setDryJobIds] = useState<Record<string, boolean>>({})
  const [runMode, setRunMode] = useState<RunMode>('full')
  const [starting, setStarting] = useState(false)
  const [preview, setPreview] = useState<{ id: string; inputs: RunInputs } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const inputs = preview?.id === activeId ? preview.inputs : null
  const label = Form.useWatch('scenario_name', form)
  const warning = inputs ? labelWarning(label || inputs.scenario_name, inputs) : ''

  const profileNameMap = useMemo(() => {
    const m = new Map<string, string>()
    profiles.forEach((p) => m.set(p.id, p.name))
    return m
  }, [profiles])

  useEffect(() => {
    let current = true
    setPreview(null)
    setPreviewError('')
    form.resetFields()
    if (activeId) {
      apiGet<RunInputs>(`/api/profiles/${activeId}/run-inputs`)
        .then((res) => {
          if (current) setPreview({ id: activeId, inputs: res })
        })
        .catch((e) => {
          if (current) setPreviewError(e.response?.data?.detail || '配置加载失败')
        })
    }
    return () => {
      current = false
    }
  }, [activeId, form])

  useEffect(() => {
    if (inputs?.find_path && runMode === 'fast') {
      setRunMode('full')
    }
  }, [inputs?.find_path, runMode])

  const [batchOpen, setBatchOpen] = useState(false)
  const [batchForm] = Form.useForm()
  const [batchBusy, setBatchBusy] = useState(false)

  const load = async () => {
    const [j, r] = await Promise.all([apiGet<Job[]>('/api/jobs'), apiGet<RunInfo[]>('/api/runs')])
    setJobs(j)
    setRuns(r)
  }

  useEffect(() => {
    load()
    const t = setInterval(() => load().catch(() => {}), 4000)
    return () => clearInterval(t)
  }, [])

  const start = async () => {
    if (!activeId || !inputs) return message.warning('请先选择情景（Profile）')
    const v = await form.validateFields()
    const isDry = runMode === 'dry'
    const isFast = runMode === 'fast'
    setStarting(true)
    try {
      const job = await apiPost<Job>(`/api/profiles/${activeId}/run`, {
        scenario_name: v.scenario_name || undefined,
        config_revision: inputs.revision,
        dry_run: isDry,
        stop_year: runMode === 'full' && !inputs.find_path ? v.stop_year || undefined : undefined,
        rebuild: !!v.rebuild,
        fast_mode: isFast,
      })
      if (isDry) setDryJobIds((prev) => ({ ...prev, [job.id]: true }))
      message.success('已加入运行队列')
      setActiveJob(job.id)
      setDrawerJobStatus(job.status || '')
      setDrawer(true)
      load()
    } catch (e: any) {
      message.error(e.response?.data?.detail || '提交失败')
    } finally {
      setStarting(false)
    }
  }

  const startBatch = async () => {
    const v = await batchForm.validateFields()
    const ids: string[] = v.profiles || []
    if (!ids.length) return message.warning('请选择至少一个情景')
    setBatchBusy(true)
    try {
      const configs = await Promise.all(ids.map((id) => apiGet<RunInputs>(`/api/profiles/${id}/run-inputs`)))
      for (const [i, id] of ids.entries()) {
        await apiPost(`/api/profiles/${id}/run`, {
          scenario_name: v.scenario_name || undefined,
          config_revision: configs[i].revision,
          stop_year: v.stop_year || undefined,
          fast_mode: !!v.fast_mode,
        })
      }
      message.success(`已排队 ${ids.length} 个运行`)
      setBatchOpen(false)
      load()
    } catch (e: any) {
      message.error(e.response?.data?.detail || '批量提交失败')
    } finally {
      setBatchBusy(false)
    }
  }

  const cancel = async (id: string) => {
    await apiPost(`/api/jobs/${id}/cancel`)
    message.info('已请求取消')
    load()
  }

  const showJob = (job: Job) => {
    setActiveJob(job.id)
    setDrawerJobStatus(job.status)
    setDrawer(true)
  }

  const activeJobObj = jobs.find((j) => j.id === activeJob)
  const isRunJobSuccess =
    drawerJobStatus === 'success' &&
    (!activeJobObj || activeJobObj.kind === 'run') &&
    !dryJobIds[activeJob] &&
    activeJobObj?.result?.status !== 'dry-run'
  const completedRunId: string | undefined = activeJobObj?.result?.run_id

  const primaryBtnLabel =
    runMode === 'full' ? '开始完整运行' : runMode === 'fast' ? '开始快速验证' : '仅检查配置'

  return (
    <div>
      <StepHeader
        step={4}
        title="检查与运行"
        description="核对当前情景与相比上次运行的全部改动，选择运行模式并跟踪 GCAM 求解进度。"
      />

      {!activeId && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="请先在第 ① 步选择或新建一个情景（Profile）"
          action={
            <Button type="primary" size="small" onClick={() => nav('/profiles')}>
              前往 ① 选择情景
            </Button>
          }
        />
      )}

      {/* 卡片 1：运行前核对 */}
      <Card
        title={`1. 运行前核对 · ${active?.name || '未选择情景'}`}
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button size="small" onClick={() => nav('/scenario')}>
              修改配置 ②
            </Button>
            <Button size="small" onClick={() => nav('/parameters')}>
              调整参数 ③
            </Button>
          </Space>
        }
      >
        {previewError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={previewError}
            action={
              <Button size="small" onClick={() => nav('/scenario')}>
                前往 ② 修改配置
              </Button>
            }
          />
        )}
        {inputs && (
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="当前 Profile">{active?.name || activeId}</Descriptions.Item>
            <Descriptions.Item label="场景名">{inputs.scenario_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="社会经济输入" span={2}>
              {inputs.socioeconomics.join('、') || '自定义 / 默认组件'}
            </Descriptions.Item>
            <Descriptions.Item label="已启用政策组件" span={2}>
              <Space wrap size={4}>
                {inputs.policies.length ? (
                  inputs.policies.map((p) => (
                    <Tag color="blue" key={p}>
                      {p}
                    </Tag>
                  ))
                ) : (
                  <Text type="secondary">无（纯基准情景）</Text>
                )}
                {!!inputs.commented_policies.length && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （已注释：{inputs.commented_policies.join('、')}）
                  </Text>
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="目标搜索状态" span={2}>
              {inputs.find_path ? (
                <Tag color="purple">已开启全时段目标搜索 · {inputs.target_file || '未指定目标文件'}</Tag>
              ) : (
                <Tag>未开启（按预设政策运行）</Tag>
              )}
            </Descriptions.Item>
          </Descriptions>
        )}
        {activeId && (
          <InputChanges key={activeId} pid={activeId} defaultExpanded={true} title="运行前差异核对（相比上次运行）" />
        )}
      </Card>

      {/* 卡片 2：运行模式与启动 */}
      <Card title="2. 运行模式与启动" style={{ marginBottom: 16 }}>
        <div className="run-mode-grid">
          <div
            role="radio"
            aria-checked={runMode === 'full'}
            tabIndex={0}
            className={`run-mode-card${runMode === 'full' ? ' active' : ''}`}
            onClick={() => setRunMode('full')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setRunMode('full')
              }
            }}
          >
            <Space style={{ marginBottom: 6 }}>
              <PlayCircleOutlined style={{ color: '#1668dc' }} />
              <Text strong>1. 完整运行（推荐）</Text>
            </Space>
            <div className="muted">求解全部模型时段并生成 BaseX 结果数据库，用于正式分析与跨情景对比。</div>
          </div>

          <div
            role="radio"
            aria-checked={runMode === 'fast'}
            aria-disabled={!!inputs?.find_path}
            tabIndex={inputs?.find_path ? -1 : 0}
            className={`run-mode-card${runMode === 'fast' ? ' active' : ''}${inputs?.find_path ? ' disabled' : ''}`}
            onClick={() => {
              if (!inputs?.find_path) setRunMode('fast')
            }}
            onKeyDown={(e) => {
              if (!inputs?.find_path && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setRunMode('fast')
              }
            }}
          >
            <Space style={{ marginBottom: 6 }}>
              <ThunderboltOutlined style={{ color: inputs?.find_path ? '#94a3b8' : '#d97706' }} />
              <Text strong>2. 快速验证（至 2025）</Text>
            </Space>
            <div className="muted">
              {inputs?.find_path
                ? '已启用目标搜索，需按完整时段求解'
                : '标准精度求解至 2025 年或更早，适合快速排查新政策或参数是否报错。'}
            </div>
          </div>

          <div
            role="radio"
            aria-checked={runMode === 'dry'}
            tabIndex={0}
            className={`run-mode-card${runMode === 'dry' ? ' active' : ''}`}
            onClick={() => setRunMode('dry')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setRunMode('dry')
              }
            }}
          >
            <Space style={{ marginBottom: 6 }}>
              <ToolOutlined style={{ color: '#475569' }} />
              <Text strong>3. 仅检查配置（不求解）</Text>
            </Space>
            <div className="muted">仅准备配置与重建必要 XML，不启动 gcam.exe 求解，用于验证路径与文件完整性。</div>
          </div>
        </div>

        {warning && <Alert type="warning" showIcon message={warning} style={{ marginBottom: 12 }} />}

        <Form form={form} layout="inline" initialValues={{ rebuild: false }}>
          <Form.Item name="scenario_name" label="结果名称">
            <Input style={{ width: 220 }} placeholder={inputs?.scenario_name || '使用情景中的场景名'} />
          </Form.Item>
          <Form.Item name="stop_year" label="停止年">
            <InputNumber
              min={2021}
              max={2100}
              disabled={runMode !== 'full' || !!inputs?.find_path}
              placeholder={
                inputs?.find_path
                  ? '目标搜索按完整时段'
                  : runMode === 'fast'
                    ? '固定至 2025'
                    : inputs?.stop_year && inputs.stop_year !== '-1'
                      ? `配置：${inputs.stop_year}`
                      : '模型末年'
              }
              style={{ width: 165 }}
            />
          </Form.Item>
          <Form.Item name="rebuild" label="强制重建 XML" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item>
            <Space wrap>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                disabled={!inputs}
                loading={starting}
                onClick={start}
              >
                {primaryBtnLabel}
              </Button>
              <Button icon={<UnorderedListOutlined />} onClick={() => setBatchOpen(true)}>
                多情景批量排队
              </Button>
            </Space>
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginTop: 8 }}>
          修改 CSV 后会自动触发 R 重建派生 XML；队列串行执行，避免多个 GCAM 进程同时占满内存。
        </div>
      </Card>

      {/* 卡片 3：任务队列 */}
      <Card
        title="3. 任务队列"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={jobs}
          pagination={{ pageSize: 8 }}
          locale={{ emptyText: '当前没有后台任务' }}
          columns={[
            { title: '任务', dataIndex: 'title' },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 100,
              render: (v) => <Tag>{JOB_KIND[v] || v}</Tag>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 110,
              render: (v) => {
                const st = JOB_STATUS[v] || { label: v, color: 'default' }
                return <Tag color={st.color}>{st.label}</Tag>
              },
            },
            { title: '日志行数', dataIndex: 'log_count', width: 90 },
            {
              title: '操作',
              width: 180,
              render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => showJob(r)}>
                    查看日志
                  </Button>
                  {['queued', 'running'].includes(r.status) && (
                    <Button size="small" danger icon={<StopOutlined />} onClick={() => cancel(r.id)}>
                      取消
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* 卡片 4：运行历史 */}
      <Card title="4. 运行历史">
        <Table
          size="small"
          rowKey="run_id"
          dataSource={runs}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: '尚无运行记录' }}
          columns={[
            { title: 'Run ID', dataIndex: 'run_id', width: 185 },
            {
              title: '所属情景',
              dataIndex: 'profile_id',
              render: (pid) => profileNameMap.get(pid) || pid,
            },
            { title: '场景', dataIndex: 'scenario_name' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (v, r) => {
                const st = RUN_STATUS[v || ''] || { label: v || '未知', color: 'default' }
                return (
                  <Space direction="vertical" size={0}>
                    <Space size={4} wrap>
                      <Tag color={st.color}>{st.label}</Tag>
                      {r.validation_only && <Tag color="orange">至2025验证</Tag>}
                    </Space>
                    {r.input_warnings?.map((w) => (
                      <Text type="warning" key={w} style={{ fontSize: 11 }}>
                        {w}
                      </Text>
                    ))}
                    {r.error && (
                      <Text type="danger" style={{ fontSize: 11 }}>
                        {r.error}
                      </Text>
                    )}
                  </Space>
                )
              },
            },
            { title: '阶段', dataIndex: 'stage', render: (v: string) => stageNames[v] || '—' },
            { title: '耗时', dataIndex: 'elapsed_sec', render: (v) => (v ? `${Math.round(v)} s` : '-') },
            {
              title: '创建时间',
              dataIndex: 'created_at',
              render: (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-'),
            },
            {
              title: '操作',
              width: 130,
              render: (_, r) =>
                r.status === 'success' ? (
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => nav(`/results?runId=${encodeURIComponent(r.run_id)}`)}
                  >
                    分析结果 →
                  </Button>
                ) : (
                  <Text type="secondary">—</Text>
                ),
            },
          ]}
        />
      </Card>

      <StepFooter
        prev={{ label: '上一步：③ 参数与数据', onClick: () => nav('/parameters') }}
        next={{ label: '下一步：⑤ 结果与对比', onClick: () => nav('/results') }}
      />

      <Modal
        title="多情景批量排队（串行运行）"
        open={batchOpen}
        onOk={startBatch}
        confirmLoading={batchBusy}
        onCancel={() => setBatchOpen(false)}
        okText="加入队列"
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="profiles" label="选择情景（Profile）" rules={[{ required: true, message: '至少选择一个' }]}>
            <Select
              mode="multiple"
              optionFilterProp="label"
              options={profiles.map((p) => ({
                value: p.id,
                label: `${p.name}${p.overlay_files ? ` · ${p.overlay_files} 改动` : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="scenario_name" label="统一结果名称">
            <Input placeholder="留空使用各情景自身的场景名" />
          </Form.Item>
          <Form.Item name="stop_year" label="停止年（可选，快速试跑）">
            <InputNumber min={2021} max={2100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="实时日志" open={drawer} onClose={() => setDrawer(false)} width={860}>
        {isRunJobSuccess && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            style={{ marginBottom: 12 }}
            message="运行已完成！数据库已就绪，可立即查询指标与可视化对比。"
            action={
              <Button
                type="primary"
                size="small"
                icon={<ArrowRightOutlined />}
                iconPosition="end"
                onClick={() => {
                  setDrawer(false)
                  nav(completedRunId ? `/results?runId=${encodeURIComponent(completedRunId)}` : '/results')
                }}
              >
                运行已完成！前往 ⑤ 结果与对比 →
              </Button>
            }
          />
        )}
        <LogConsole
          jobId={drawer ? activeJob : undefined}
          height={540}
          onStatusChange={(nextStatus) => {
            setDrawerJobStatus(nextStatus)
            if (['success', 'failed', 'cancelled'].includes(nextStatus)) {
              load().catch(() => {})
            }
          }}
        />
      </Drawer>
    </div>
  )
}
