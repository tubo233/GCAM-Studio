import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { PlayCircleOutlined, ReloadOutlined, StopOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { apiGet, apiPost } from '../api'
import { useProfiles } from '../context/ProfileContext'
import LogConsole from '../components/LogConsole'
import type { Job, RunInfo } from '../types'

const { Title, Text } = Typography
const stageNames: Record<string, string> = { build: '生成 XML', configure: '准备配置', solve: '模型求解', output: '写入结果库', complete: '完成' }

export default function Runs() {
  const { activeId, active, profiles } = useProfiles()
  const [form] = Form.useForm()
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [activeJob, setActiveJob] = useState<string>('')
  const [drawer, setDrawer] = useState(false)
  const [starting, setStarting] = useState(false)
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
    if (!activeId) return message.warning('请先选择参数环境')
    const v = await form.validateFields()
    setStarting(true)
    try {
      const job = await apiPost<Job>(`/api/profiles/${activeId}/run`, {
        scenario_name: v.scenario_name,
        stop_year: v.stop_year || undefined,
        rebuild: !!v.rebuild,
        fast_mode: !!v.fast_mode,
      })
      message.success('已加入运行队列')
      setActiveJob(job.id)
      setDrawer(true)
      load()
    } finally {
      setStarting(false)
    }
  }

  const startBatch = async () => {
    const v = await batchForm.validateFields()
    const ids: string[] = v.profiles || []
    if (!ids.length) return message.warning('请选择至少一个 Profile')
    setBatchBusy(true)
    try {
      for (const id of ids) {
        await apiPost(`/api/profiles/${id}/run`, {
          scenario_name: v.scenario_name,
          stop_year: v.stop_year || undefined,
          fast_mode: !!v.fast_mode,
        })
      }
      message.success(`已排队 ${ids.length} 个运行`)
      setBatchOpen(false)
      load()
    } finally {
      setBatchBusy(false)
    }
  }

  const cancel = async (id: string) => {
    await apiPost(`/api/jobs/${id}/cancel`)
    message.info('已请求取消')
    load()
  }

  const showJob = (id: string) => {
    setActiveJob(id)
    setDrawer(true)
  }

  return (
    <div>
      <Title level={3} className="page-title">运行中心</Title>
      <p className="page-sub">生成 XML → GCAM 求解 → 生成 BaseX 数据库。队列串行执行，避免多个 GCAM 同时占用内存。</p>

      {!activeId && <Alert type="warning" showIcon message="请先在顶部选择一个参数环境（Profile）" style={{ marginBottom: 16 }} />}

      <Card title={`新建运行：${active?.name || '未选择 Profile'}`} style={{ marginBottom: 16 }}>
        <Form form={form} layout="inline" initialValues={{ scenario_name: 'Reference', rebuild: false, fast_mode: false }}>
          <Form.Item name="scenario_name" label="场景名" rules={[{ required: true }]}>
            <Input style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="stop_year" label="停止年">
            <InputNumber min={2021} max={2100} placeholder="留空 = 2100" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="rebuild" label="重新生成 XML" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="fast_mode" label="快速验证（标准精度，至2025）" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" icon={<PlayCircleOutlined />} loading={starting} onClick={start}>开始运行</Button>
              <Button icon={<UnorderedListOutlined />} onClick={() => setBatchOpen(true)}>批量排队</Button>
            </Space>
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginTop: 8 }}>
          修改 CSV 后会自动生成新 XML；快速验证保留标准精度，只计算至 2025 年或更早。正式情景请关闭快速验证。计算期间可能暂时没有新日志。
        </div>
      </Card>

      <Card title="任务队列" extra={<Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>} style={{ marginBottom: 16 }}>
        <Table
          size="small"
          rowKey="id"
          dataSource={jobs}
          pagination={{ pageSize: 8 }}
          columns={[
            { title: '任务', dataIndex: 'title' },
            { title: '类型', dataIndex: 'kind', width: 90, render: (v) => <Tag>{v}</Tag> },
            {
              title: '状态', dataIndex: 'status', width: 110,
              render: (v) => <Tag color={v === 'success' ? 'green' : v === 'failed' ? 'red' : v === 'running' ? 'blue' : v === 'cancelled' ? 'orange' : 'default'}>{v}</Tag>,
            },
            { title: '日志', dataIndex: 'log_count', width: 80 },
            {
              title: '操作', width: 180,
              render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => showJob(r.id)}>查看日志</Button>
                  {['queued', 'running'].includes(r.status) && <Button size="small" danger icon={<StopOutlined />} onClick={() => cancel(r.id)}>取消</Button>}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="运行历史">
        <Table
          size="small"
          rowKey="run_id"
          dataSource={runs}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Run ID', dataIndex: 'run_id', width: 200 },
            { title: 'Profile', dataIndex: 'profile_id' },
            { title: '场景', dataIndex: 'scenario_name' },
            { title: '状态', dataIndex: 'status', render: (v, r) => <Space direction="vertical" size={0}><Tag color={v === 'success' ? 'green' : v === 'running' ? 'blue' : 'red'}>{v}</Tag>{r.validation_only && <Tag color="orange">至2025验证</Tag>}{r.error && <Text type="danger" style={{ fontSize: 11 }}>{r.error}</Text>}</Space> },
            { title: '阶段', dataIndex: 'stage', render: (v: string) => stageNames[v] || '—' },
            { title: '耗时', dataIndex: 'elapsed_sec', render: (v) => (v ? `${Math.round(v)} s` : '-') },
            { title: '创建时间', dataIndex: 'created_at', render: (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-') },
            { title: '数据库', dataIndex: 'db', render: (v) => <span className="muted" style={{ fontSize: 11 }}>{v || '-'}</span> },
          ]}
        />
      </Card>

      <Modal title="批量排队（多个 Profile 串行运行）" open={batchOpen} onOk={startBatch} confirmLoading={batchBusy} onCancel={() => setBatchOpen(false)} okText="加入队列">
        <Form form={batchForm} layout="vertical" initialValues={{ scenario_name: 'Reference' }}>
          <Form.Item name="profiles" label="选择参数环境" rules={[{ required: true, message: '至少选择一个' }]}>
            <Select mode="multiple" optionFilterProp="label" options={profiles.map((p) => ({ value: p.id, label: `${p.name}${p.overlay_files ? ` · ${p.overlay_files} 改动` : ''}` }))} />
          </Form.Item>
          <Form.Item name="scenario_name" label="场景名前缀"><Input /></Form.Item>
          <Form.Item name="stop_year" label="停止年（可选，快速试跑）"><InputNumber min={2021} max={2100} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Drawer title="实时日志" open={drawer} onClose={() => setDrawer(false)} width={860}>
        <LogConsole jobId={drawer ? activeJob : undefined} height={560} />
      </Drawer>
    </div>
  )
}
