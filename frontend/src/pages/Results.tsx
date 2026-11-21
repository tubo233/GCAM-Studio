import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  DownOutlined,
  DownloadOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiGet, apiPost } from '../api'
import LogConsole from '../components/LogConsole'
import { StepFooter, StepHeader } from '../components/WorkflowChrome'
import { useProfiles } from '../context/ProfileContext'
import Compare from './Compare'
import type { Job, QueryItem, RunInfo } from '../types'

const { Text } = Typography

export default function Results() {
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeId, profiles } = useProfiles()

  const tab = searchParams.get('tab') === 'compare' ? 'compare' : 'query'
  const urlRunId = searchParams.get('runId') || ''

  const [runs, setRuns] = useState<RunInfo[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runId, setRunId] = useState(urlRunId)
  const [queries, setQueries] = useState<QueryItem[]>([])
  const [group, setGroup] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [results, setResults] = useState<any[]>([])
  const [preview, setPreview] = useState<any>(null)
  const [previewId, setPreviewId] = useState('')
  const [jobId, setJobId] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [running, setRunning] = useState(false)
  const [compareSeed, setCompareSeed] = useState<string[]>([])

  const currentRun = useRef(runId)
  currentRun.current = runId
  const previewGeneration = useRef(0)
  const handledSuccessJob = useRef('')

  const profileNameMap = useMemo(() => {
    const m = new Map<string, string>()
    profiles.forEach((p) => m.set(p.id, p.name))
    return m
  }, [profiles])

  const activeRun = runs.find((run) => run.run_id === runId)

  const pickDefaultRunId = useCallback(
    (successful: RunInfo[], preferredUrlId: string, curId: string) => {
      if (preferredUrlId && successful.some((r) => r.run_id === preferredUrlId)) {
        return preferredUrlId
      }
      if (curId && successful.some((r) => r.run_id === curId)) {
        return curId
      }
      const activeProfileRun = activeId ? successful.find((r) => r.profile_id === activeId) : undefined
      return activeProfileRun?.run_id || successful[0]?.run_id || ''
    },
    [activeId],
  )

  const load = useCallback(async () => {
    const [r, q] = await Promise.all([apiGet<RunInfo[]>('/api/runs'), apiGet<any>('/api/catalog/queries')])
    const successful = r.filter((x) => x.status === 'success')
    setRuns(successful)
    setRunsLoaded(true)
    setQueries(q.flat)
    const nextRunId = pickDefaultRunId(successful, urlRunId, currentRun.current)
    if (nextRunId !== currentRun.current) {
      setRunId(nextRunId)
    }
  }, [pickDefaultRunId, urlRunId])

  useEffect(() => {
    load().catch(() => setRunsLoaded(true))
  }, [load])

  useEffect(() => {
    if (urlRunId && runs.some((r) => r.run_id === urlRunId) && urlRunId !== runId) {
      setRunId(urlRunId)
    }
  }, [urlRunId, runs, runId])

  const loadResults = useCallback(async (id = currentRun.current) => {
    if (!id) return []
    const data = await apiGet<any[]>(`/api/runs/${id}/results`)
    if (currentRun.current === id) setResults(data)
    return data
  }, [])

  useEffect(() => {
    setResults([])
    setPreview(null)
    setPreviewId('')
    previewGeneration.current++
    if (runId) loadResults(runId).catch(() => message.error('无法读取该运行的查询结果'))
  }, [runId, loadResults])

  const showPreview = useCallback(async (id: string) => {
    setPreviewId(id)
    setPreview(null)
    const generation = ++previewGeneration.current
    const requestedRun = currentRun.current
    const p = await apiGet<any>(`/api/results/${id}/preview`, { limit: 300 })
    if (generation === previewGeneration.current && currentRun.current === requestedRun) {
      setPreview(p)
    }
  }, [])

  const onQueryJobFinished = useCallback(
    async (finishedJobId: string, status: string) => {
      if (status !== 'success') {
        setRunning(false)
        loadResults().catch(() => {})
        return
      }
      if (handledSuccessJob.current === finishedJobId) return
      handledSuccessJob.current = finishedJobId
      setRunning(false)
      message.success('查询完成，已自动加载最新结果预览')
      const fresh = await loadResults().catch(() => [])
      if (fresh.length) {
        await showPreview(fresh[0].id).catch(() => {})
      }
    },
    [loadResults, showPreview],
  )

  useEffect(() => {
    if (!jobId) return
    const t = setInterval(async () => {
      try {
        const j = await apiGet<Job>(`/api/jobs/${jobId}`)
        if (['success', 'failed', 'cancelled'].includes(j.status)) {
          clearInterval(t)
          await onQueryJobFinished(jobId, j.status)
        }
      } catch {}
    }, 2500)
    return () => clearInterval(t)
  }, [jobId, onQueryJobFinished])

  const groups = useMemo(() => Array.from(new Set(queries.map((q) => q.group))), [queries])

  const filtered = useMemo(() => {
    let list = queries
    if (group) list = list.filter((q) => q.group === group)
    if (search.trim()) {
      const s = search.toLowerCase()
      list = list.filter((q) => q.title.toLowerCase().includes(s) || q.group.toLowerCase().includes(s))
    }
    return list
  }, [queries, group, search])

  const runQuery = async () => {
    if (!runId) return message.warning('请选择运行')
    if (!selected.length) return message.warning('请至少选择一条查询')
    setRunning(true)
    try {
      const job = await apiPost<Job>(`/api/runs/${runId}/query`, {
        query_ids: selected,
        name: `查询 ${selected.length} 条`,
      })
      handledSuccessJob.current = ''
      setJobId(job.id)
      setDrawer(true)
      message.success('查询任务已启动')
    } catch (error: any) {
      setRunning(false)
      message.error(error?.response?.data?.detail || '无法启动查询')
    }
  }

  const updateUrlParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([k, v]) => {
      if (v) next.set(k, v)
      else next.delete(k)
    })
    setSearchParams(next, { replace: true })
  }

  const addToCompare = (id: string) => {
    setCompareSeed((prev) => Array.from(new Set([...prev, id])))
    updateUrlParams({ tab: 'compare' })
  }

  const previewColumns = (preview?.columns || []).map((c: string) => ({
    title: c,
    dataIndex: c,
    key: c,
    ellipsis: true,
    width: 130,
  }))

  const chartOption = useMemo(() => {
    if (!preview?.rows?.length) return null
    const cols: string[] = preview.columns || []
    const years = cols.filter((c) => /^(19|20|21)\d{2}$/.test(c))
    if (!years.length) return null
    const groupCol = cols.find((c) => ['region', 'sector', 'fuel', 'technology'].includes(c)) || cols[0]
    const chartGroups = Array.from(new Set(preview.rows.map((r: any) => String(r[groupCol] ?? '')))).slice(0, 12)
    const series = chartGroups.map((g) => ({
      name: g,
      type: 'line',
      smooth: true,
      data: years.map((y) => {
        const row = preview.rows.find((r: any) => String(r[groupCol] ?? '') === g)
        return Number(row?.[y] ?? 0)
      }),
    }))
    return {
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 0 },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value' },
      series,
    }
  }, [preview])

  return (
    <div>
      <StepHeader
        step={5}
        title="结果与对比"
        description="从 BaseX 数据库查询指标、生成折线图与明细表，支持多运行横向对比及按需导出 CSV / Excel。"
      />

      <Tabs
        activeKey={tab}
        onChange={(nextTab) => updateUrlParams({ tab: nextTab })}
        items={[
          {
            key: 'query',
            label: '单次运行查询与分析',
            children: runsLoaded && !runs.length ? (
              <Card>
                <Empty description="暂无成功完成的 GCAM 运行记录">
                  <Button type="primary" onClick={() => nav('/runs')}>
                    前往 ④ 检查与运行 →
                  </Button>
                </Empty>
              </Card>
            ) : (
              <div>
                <Card style={{ marginBottom: 16 }}>
                  <Space wrap>
                    <Text strong>选择运行：</Text>
                    <Select
                      style={{ width: 460 }}
                      value={runId || undefined}
                      placeholder="选择一次成功的运行"
                      onChange={(nextId) => {
                        setRunId(nextId)
                        updateUrlParams({ runId: nextId })
                      }}
                      options={runs.map((r) => ({
                        value: r.run_id,
                        label: `${r.scenario_name || r.run_id} · ${profileNameMap.get(r.profile_id) || r.profile_id}${
                          r.validation_only ? ' · 快速验证' : ''
                        } · ${String(r.created_at || '').slice(0, 10)}`,
                      }))}
                    />
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        load()
                        loadResults()
                      }}
                    >
                      刷新
                    </Button>
                  </Space>
                </Card>

                {activeRun?.validation_only && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message={`本次为标准精度快速验证，计算至 ${
                      activeRun.calculated_through || activeRun.stop_year || 2025
                    } 年。新导出结果仅保留实际计算范围。`}
                  />
                )}

                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <Card
                    title={`选择查询指标（${queries.length} 条可用）`}
                    style={{ width: 540, flex: '0 0 540px' }}
                    extra={<Tag color="blue">已选 {selected.length}</Tag>}
                  >
                    <Space style={{ marginBottom: 10 }} wrap>
                      <Input
                        prefix={<SearchOutlined />}
                        placeholder="搜索查询标题"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        allowClear
                        style={{ width: 200 }}
                      />
                      <Select
                        style={{ width: 190 }}
                        value={group || undefined}
                        placeholder="全部查询组"
                        allowClear
                        onChange={setGroup}
                        options={groups.map((g) => ({ value: g, label: g }))}
                      />
                      <Button
                        size="small"
                        onClick={() => setSelected(queries.filter((q) => q.group.includes('GCAM China')).map((q) => q.id))}
                      >
                        中国核心包
                      </Button>
                      <Button
                        size="small"
                        onClick={() => setSelected(queries.filter((q) => /elec|electricity/i.test(q.title)).map((q) => q.id))}
                      >
                        电力专题
                      </Button>
                      <Button
                        size="small"
                        onClick={() => setSelected(queries.filter((q) => /socio|gdp|population/i.test(q.title)).map((q) => q.id))}
                      >
                        社会经济
                      </Button>
                      <Button size="small" onClick={() => setSelected(queries.map((q) => q.id))}>
                        全部
                      </Button>
                      <Button size="small" onClick={() => setSelected([])}>
                        清空
                      </Button>
                    </Space>
                    <Table
                      size="small"
                      rowKey="id"
                      dataSource={filtered}
                      rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                      columns={[
                        { title: '组', dataIndex: 'group', width: 160, ellipsis: true },
                        { title: '查询', dataIndex: 'title' },
                        { title: '类型', dataIndex: 'tag', width: 140, render: (v) => <Tag>{v}</Tag> },
                      ]}
                    />
                    <Button
                      type="primary"
                      block
                      icon={<PlayCircleOutlined />}
                      loading={running}
                      onClick={runQuery}
                      style={{ marginTop: 12 }}
                      disabled={!runId}
                    >
                      运行选中查询
                    </Button>
                  </Card>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Card title="已查询结果集" style={{ marginBottom: 16 }}>
                      <Table
                        size="small"
                        rowKey="id"
                        dataSource={results}
                        pagination={{ pageSize: 6 }}
                        locale={{ emptyText: '还没有查询结果，请在左侧选择指标并点击“运行选中查询”' }}
                        columns={[
                          { title: '名称', dataIndex: 'name' },
                          { title: '行数', dataIndex: 'rows', width: 90 },
                          { title: '时间', dataIndex: 'created_at', width: 165, render: (v) => String(v || '').replace('T', ' ').slice(0, 19) },
                          {
                            title: '操作',
                            width: 240,
                            render: (_, r) => (
                              <Space>
                                <Button size="small" type="primary" onClick={() => showPreview(r.id)}>
                                  查看预览
                                </Button>
                                <Button size="small" onClick={() => addToCompare(r.id)}>
                                  加入对比
                                </Button>
                                <Dropdown
                                  menu={{
                                    items: [
                                      {
                                        key: 'csv',
                                        icon: <DownloadOutlined />,
                                        label: <a href={`/api/results/${r.id}/download`}>CSV</a>,
                                      },
                                      {
                                        key: 'xlsx',
                                        icon: <DownloadOutlined />,
                                        label: <a href={`/api/results/${r.id}/export.xlsx`}>Excel</a>,
                                      },
                                    ],
                                  }}
                                >
                                  <Button size="small" icon={<DownloadOutlined />}>
                                    下载 <DownOutlined />
                                  </Button>
                                </Dropdown>
                              </Space>
                            ),
                          },
                        ]}
                      />
                    </Card>

                    <Card
                      title={previewId ? `数据预览（表格 / ECharts 折线图）· ${preview?.total || 0} 行` : '数据预览（表格 / ECharts 折线图）'}
                      extra={
                        previewId ? (
                          <Space wrap>
                            <Button size="small" icon={<DownloadOutlined />} href={`/api/results/${previewId}/download`}>
                              下载 CSV
                            </Button>
                            <Button size="small" icon={<DownloadOutlined />} href={`/api/results/${previewId}/export.xlsx`}>
                              下载 Excel
                            </Button>
                            <Button size="small" type="primary" ghost onClick={() => addToCompare(previewId)}>
                              去多运行对比 →
                            </Button>
                          </Space>
                        ) : undefined
                      }
                    >
                      {preview ? (
                        <Tabs
                          items={[
                            {
                              key: 'table',
                              label: '表格',
                              children: (
                                <Table
                                  size="small"
                                  bordered
                                  rowKey={(_, i) => String(i)}
                                  dataSource={preview.rows}
                                  columns={previewColumns}
                                  scroll={{ x: 'max-content', y: 420 }}
                                  pagination={{ pageSize: 30, showSizeChanger: false }}
                                />
                              ),
                            },
                            {
                              key: 'chart',
                              label: '图表',
                              children: chartOption ? (
                                <ReactECharts option={chartOption} style={{ height: 460 }} />
                              ) : (
                                <Alert type="info" showIcon message="该结果没有年份列，无法绘图。" />
                              ),
                            },
                          ]}
                        />
                      ) : (
                        <Alert type="info" showIcon message="在左侧选择查询并运行，或点击上方结果表中的“查看预览”。" />
                      )}
                    </Card>
                  </div>
                </div>
              </div>
            ),
          },
          {
            key: 'compare',
            label: '多运行横向对比',
            children: <Compare embedded initialSelected={compareSeed} />,
          },
        ]}
      />

      <StepFooter
        prev={{ label: '上一步：④ 检查与运行', onClick: () => nav('/runs') }}
        secondaryNext={{ label: '新建下一对比情景 ①', onClick: () => nav('/profiles') }}
        next={{ label: '回到工作台总览', onClick: () => nav('/') }}
      />

      <Drawer title="查询日志" open={drawer} onClose={() => setDrawer(false)} width={860}>
        <LogConsole
          jobId={jobId}
          height={540}
          onStatusChange={(nextStatus) => {
            if (jobId && ['success', 'failed', 'cancelled'].includes(nextStatus)) {
              void onQueryJobFinished(jobId, nextStatus)
            }
          }}
        />
      </Drawer>
    </div>
  )
}
