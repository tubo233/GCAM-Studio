import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd'
import {
  ArrowRightOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../api'
import { isLocalConsole } from '../localAccess'
import { useProfiles } from '../context/ProfileContext'
import { StepHeader, WORKFLOW_STEPS } from '../components/WorkflowChrome'
import type { RunInfo } from '../types'

const { Text } = Typography

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  success: { label: '成功', color: 'green' },
  failed: { label: '失败', color: 'red' },
  running: { label: '运行中', color: 'processing' },
  queued: { label: '排队中', color: 'default' },
  cancelled: { label: '已取消', color: 'orange' },
  interrupted: { label: '已中断', color: 'orange' },
  'dry-run': { label: '仅检查', color: 'default' },
}

export default function Dashboard() {
  const nav = useNavigate()
  const { profiles, active, activeId } = useProfiles()
  const [stats, setStats] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [resultsList, setResultsList] = useState<any[]>([])
  const [runInputs, setRunInputs] = useState<any>(null)
  const [changes, setChanges] = useState<any>(null)
  const localConsole = isLocalConsole()

  const load = useCallback(async () => {
    const [s, h, r, res] = await Promise.all([
      apiGet('/api/stats'),
      apiGet('/api/health'),
      apiGet<RunInfo[]>('/api/runs'),
      apiGet<any[]>('/api/results').catch(() => []),
    ])
    setStats(s)
    setHealth(h)
    setRuns(r || [])
    setResultsList(res || [])
  }, [])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  useEffect(() => {
    if (!activeId) {
      setRunInputs(null)
      setChanges(null)
      return
    }
    let live = true
    Promise.all([
      apiGet(`/api/profiles/${activeId}/run-inputs`).catch(() => null),
      apiGet(`/api/profiles/${activeId}/input-changes`).catch(() => null),
    ]).then(([ri, ch]) => {
      if (!live) return
      setRunInputs(ri)
      setChanges(ch)
    })
    return () => {
      live = false
    }
  }, [activeId])

  const profileNameMap = useMemo(() => {
    const m = new Map<string, string>()
    profiles.forEach((p) => m.set(p.id, p.name))
    return m
  }, [profiles])

  const catalog = stats?.catalog || {}
  const envOk = !!(
    health?.gcam_root_exists &&
    (health?.java_ok ?? health?.java_exists) &&
    (health?.rscript_ok ?? health?.rscript_exists) &&
    health?.model_interface_exists
  )

  const activeRuns = useMemo(() => runs.filter((r) => r.profile_id === activeId), [runs, activeId])
  const latestActiveRun = activeRuns[0]

  const getStepStatusTag = (step: number) => {
    if (step === 1) {
      return active ? <Tag color="green">已选：{active.name}</Tag> : <Tag color="orange">待选择</Tag>
    }
    if (step === 2) {
      if (!active) return <Tag>先选情景</Tag>
      return runInputs ? <Tag color="blue">{runInputs.policies?.length || 0} 项政策</Tag> : <Tag>模板与政策</Tag>
    }
    if (step === 3) {
      if (active?.overlay_files) return <Tag color="orange">{active.overlay_files} 项覆盖改动</Tag>
      return <Tag>可选微调</Tag>
    }
    if (step === 4) {
      if (!active) return <Tag>待就绪</Tag>
      if (!latestActiveRun) return <Tag>未运行</Tag>
      const st = RUN_STATUS[latestActiveRun.status || ''] || { label: latestActiveRun.status || '未知', color: 'default' }
      return <Tag color={st.color}>最近：{st.label}</Tag>
    }
    return resultsList.length ? <Tag color="blue">{resultsList.length} 份结果</Tag> : <Tag>查询与对比</Tag>
  }

  const changesSummary = () => {
    if (!changes) return '—'
    if (!changes.recorded) return changes.reference ? '上次快照未记录' : '尚未启动过实际运行'
    if (!changes.changes?.length) return '与上次运行完全一致'
    return `有 ${changes.changes.length} 项待核对改动`
  }

  return (
    <div>
      <StepHeader
        title="工作台总览"
        description="GCAM-China v8 · 31 省 + 6 电网 · 基准年 2021 · 按下方 5 步即可完成情景设定、模型求解与结果分析"
      />

      {!envOk && health && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="本机运行环境未完全就绪"
          description={`模型目录 ${health.gcam_root_exists ? '✓' : '✗'} · Java 21 ${(health.java_ok ?? health.java_exists) ? '✓' : '✗'} · R/R包 ${(health.rscript_ok ?? health.rscript_exists) ? '✓' : '✗'} · ModelInterface ${health.model_interface_exists ? '✓' : '✗'}${localConsole ? '。请前往“环境设置与诊断”检查路径。' : '。运行环境由主机配置。'}`}
          action={localConsole ? <Button size="small" onClick={() => nav('/settings')}>去设置</Button> : undefined}
        />
      )}

      <Card
        title="5 步执行流程"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>点击任意步骤卡片直接进入</Text>}
        style={{ marginBottom: 16 }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 12,
          }}
        >
          {WORKFLOW_STEPS.map((item) => (
            <div
              key={item.key}
              className="flow-card"
              role="button"
              tabIndex={0}
              onClick={() => nav(item.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  nav(item.key)
                }
              }}
            >
              <div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  <Space size={6} style={{ flexShrink: 0 }}>
                    <span className="step-badge" style={{ background: '#eff6ff', color: '#1668dc', borderColor: '#bfdbfe' }}>
                      {item.step}
                    </span>
                    <Text strong style={{ whiteSpace: 'nowrap' }}>{item.short}</Text>
                  </Space>
                  {getStepStatusTag(item.step)}
                </div>
                <div className="muted" style={{ lineHeight: 1.5 }}>{item.desc}</div>
              </div>
              <div style={{ fontSize: 12, color: '#1668dc', fontWeight: 500 }}>
                进入第 {item.step} 步 <ArrowRightOutlined />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card
            title="当前情景快速继续"
            extra={
              <Space>
                <Button size="small" icon={<SwapOutlined />} onClick={() => nav('/profiles')}>
                  切换情景
                </Button>
                <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => nav('/profiles')}>
                  新建情景
                </Button>
              </Space>
            }
          >
            {active ? (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Space wrap>
                  <Text strong style={{ fontSize: 18 }}>{active.name}</Text>
                  <Tag color="blue">{active.base_config || 'configuration_china.xml'}</Tag>
                  <Tag color={active.overlay_files ? 'orange' : 'default'}>{active.overlay_files || 0} 个覆盖改动</Tag>
                  {runInputs?.find_path && <Tag color="purple">已启用气候目标搜索</Tag>}
                </Space>
                <Text type="secondary">{active.description || '暂无情景描述'}</Text>
                <div style={{ background: '#f8fafc', padding: '10px 12px', borderRadius: 8, fontSize: 13, lineHeight: 1.8 }}>
                  <div><Text type="secondary">场景名称：</Text>{runInputs?.scenario_name || '—'}</div>
                  <div><Text type="secondary">社会经济输入：</Text>{runInputs?.socioeconomics?.join('、') || '默认组件'}</div>
                  <div><Text type="secondary">已启用政策：</Text>{runInputs?.policies?.length ? runInputs.policies.join('、') : '暂未启用政策组件'}</div>
                  <div><Text type="secondary">相比上次运行：</Text>{changesSummary()}</div>
                </div>
                <Space wrap style={{ marginTop: 4 }}>
                  <Button type="primary" onClick={() => nav('/scenario')}>
                    进入 ② 情景与政策 <ArrowRightOutlined />
                  </Button>
                  <Button onClick={() => nav('/parameters')}>③ 调整参数与数据</Button>
                  <Button onClick={() => nav('/runs')}>④ 检查与运行</Button>
                </Space>
              </Space>
            ) : (
              <Space direction="vertical" size={8}>
                <Text type="secondary">当前还没有选中任何情景（Profile）。先创建或选择一个情景，再开始配置政策和运行模型。</Text>
                <Button type="primary" onClick={() => nav('/profiles')}>
                  前往 ① 选择或新建情景 <ArrowRightOutlined />
                </Button>
              </Space>
            )}
          </Card>

          <Card
            title="最近运行"
            style={{ marginTop: 16 }}
            extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>}
          >
            <Table
              size="small"
              rowKey="run_id"
              pagination={false}
              dataSource={runs.slice(0, 6)}
              locale={{ emptyText: '还没有运行记录，可在第 ④ 步启动首次运行' }}
              columns={[
                { title: '场景', dataIndex: 'scenario_name', render: (v, r) => v || r.run_id },
                { title: '所属情景', dataIndex: 'profile_id', render: (pid) => profileNameMap.get(pid) || pid },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (v) => {
                    const st = RUN_STATUS[v || ''] || { label: v || '未知', color: 'default' }
                    return <Tag color={st.color}>{st.label}</Tag>
                  },
                },
                { title: '耗时', dataIndex: 'elapsed_sec', render: (v) => (v ? `${Math.round(v)} s` : '-') },
                {
                  title: '操作',
                  width: 120,
                  render: (_, r) =>
                    r.status === 'success' ? (
                      <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => nav(`/results?runId=${encodeURIComponent(r.run_id)}`)}>
                        查看结果 →
                      </Button>
                    ) : (
                      <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => nav('/runs')}>
                        运行中心
                      </Button>
                    ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title="模型与数据统计">
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Card size="small" className="stat-card">
                  <Statistic title="底层输入 CSV" value={catalog.files || 0} suffix="个" />
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" className="stat-card">
                  <Statistic title="情景组件 XML" value={catalog.xml || 0} suffix="个" />
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" className="stat-card">
                  <Statistic title="可用结果查询" value={catalog.queries || 0} suffix="条" />
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" className="stat-card">
                  <Statistic title="已建情景" value={profiles.length} suffix="套" />
                </Card>
              </Col>
            </Row>
          </Card>

          <Card
            title="本机运行环境"
            style={{ marginTop: 16 }}
            extra={localConsole ? <Button size="small" icon={<SettingOutlined />} onClick={() => nav('/settings')}>设置</Button> : undefined}
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">GCAM 根目录</Text>
                <Tag color={health?.gcam_root_exists ? 'green' : 'red'}>{health?.gcam_root_exists ? '正常' : '未就绪'}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">gcam.exe 求解器</Text>
                <Tag color={health?.gcam_exe_exists ? 'green' : 'red'}>{health?.gcam_exe_exists ? '已找到' : '未找到'}</Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">Java 21 (64-bit)</Text>
                <Tag color={(health?.java_ok ?? health?.java_exists) ? 'green' : 'red'}>
                  {(health?.java_ok ?? health?.java_exists) ? '正常' : '异常'}
                </Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">Rscript 与 R 包</Text>
                <Tag color={(health?.rscript_ok ?? health?.rscript_exists) ? 'green' : 'red'}>
                  {(health?.rscript_ok ?? health?.rscript_exists) ? '正常' : '异常'}
                </Tag>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">ModelInterface.jar</Text>
                <Tag color={health?.model_interface_exists ? 'green' : 'red'}>
                  {health?.model_interface_exists ? '正常' : '缺失'}
                </Tag>
              </div>
              <div className="muted" style={{ paddingTop: 4, wordBreak: 'break-all' }}>
                路径：{health?.gcam_root || '-'}
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
