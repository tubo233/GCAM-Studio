import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Drawer, Input, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import { apiGet, apiPost } from '../api'
import LogConsole from '../components/LogConsole'
import type { Job, QueryItem, RunInfo } from '../types'

const { Title, Text } = Typography

export default function Results() {
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [runId, setRunId] = useState('')
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
  const currentRun = useRef(runId)
  currentRun.current = runId
  const previewGeneration = useRef(0)
  const activeRun = runs.find((run) => run.run_id === runId)

  const load = async () => {
    const [r, q] = await Promise.all([apiGet<RunInfo[]>('/api/runs'), apiGet<any>('/api/catalog/queries')])
    const successful = r.filter((x) => x.status === 'success')
    setRuns(successful)
    setQueries(q.flat)
    if (!successful.some((run) => run.run_id === currentRun.current)) setRunId(successful[0]?.run_id || '')
  }

  useEffect(() => { load() }, [])

  const loadResults = async (id = runId) => {
    if (!id) return
    const data = await apiGet<any[]>(`/api/runs/${id}/results`)
    if (currentRun.current === id) setResults(data)
  }

  useEffect(() => {
    setResults([]); setPreview(null); setPreviewId(''); previewGeneration.current++
    if (runId) loadResults(runId).catch(() => message.error('无法读取该运行的查询结果'))
  }, [runId])

  useEffect(() => {
    if (!jobId) return
    const t = setInterval(async () => {
      const j = await apiGet<Job>(`/api/jobs/${jobId}`)
      if (['success', 'failed', 'cancelled'].includes(j.status)) {
        clearInterval(t)
        setRunning(false)
        loadResults()
        if (j.status === 'success') message.success('查询完成')
      }
    }, 2500)
    return () => clearInterval(t)
  }, [jobId, runId])

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
      const job = await apiPost<Job>(`/api/runs/${runId}/query`, { query_ids: selected, name: `查询 ${selected.length} 条` })
      setJobId(job.id)
      setDrawer(true)
      message.success('查询任务已启动')
    } catch (error: any) {
      setRunning(false)
      message.error(error?.response?.data?.detail || '无法启动查询')
    }
  }

  const showPreview = async (id: string) => {
    setPreviewId(id)
    setPreview(null)
    const generation = ++previewGeneration.current
    const requestedRun = runId
    const p = await apiGet<any>(`/api/results/${id}/preview`, { limit: 300 })
    if (generation === previewGeneration.current && currentRun.current === requestedRun) setPreview(p)
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
    const groups = Array.from(new Set(preview.rows.map((r: any) => String(r[groupCol] ?? '')))).slice(0, 12)
    const series = groups.map((g) => ({
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
      <Title level={3} className="page-title">结果与导出</Title>
      <p className="page-sub">从 BaseX 数据库批量查询，预览并导出 CSV / Excel。China 专用查询在“GCAM China”组。</p>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Text strong>选择运行：</Text>
          <Select
            style={{ width: 420 }}
            value={runId || undefined}
            placeholder="选择一次成功的运行"
            onChange={setRunId}
            options={runs.map((r) => ({ value: r.run_id, label: `${r.scenario_name || r.run_id} · ${r.profile_id}${r.validation_only ? ' · 快速验证' : ''} · ${String(r.created_at || '').slice(0, 10)}` }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => { load(); loadResults() }}>刷新</Button>
        </Space>
      </Card>
      {activeRun?.validation_only && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={`本次为标准精度快速验证，计算至 ${activeRun.calculated_through || activeRun.stop_year || 2025} 年。新导出结果仅保留实际计算范围。`} />}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Card
          title={`可用查询（${queries.length} 条）`}
          style={{ width: 560, flex: '0 0 560px' }}
          extra={<Tag color="blue">已选 {selected.length}</Tag>}
        >
          <Space style={{ marginBottom: 10 }} wrap>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索查询标题"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 210 }}
            />
            <Select
              style={{ width: 190 }}
              value={group || undefined}
              placeholder="全部查询组"
              allowClear
              onChange={setGroup}
              options={groups.map((g) => ({ value: g, label: g }))}
            />
            <Button size="small" onClick={() => setSelected(queries.filter((q) => q.group.includes('GCAM China')).map((q) => q.id))}>中国核心包</Button>
            <Button size="small" onClick={() => setSelected(queries.filter((q) => /elec|electricity/i.test(q.title)).map((q) => q.id))}>电力专题</Button>
            <Button size="small" onClick={() => setSelected(queries.filter((q) => /socio|gdp|population/i.test(q.title)).map((q) => q.id))}>社会经济</Button>
            <Button size="small" onClick={() => setSelected(queries.map((q) => q.id))}>全部</Button>
            <Button size="small" onClick={() => setSelected([])}>清空</Button>
          </Space>
          <Table
            size="small"
            rowKey="id"
            dataSource={filtered}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            columns={[
              { title: '组', dataIndex: 'group', width: 170, ellipsis: true },
              { title: '查询', dataIndex: 'title' },
              { title: '类型', dataIndex: 'tag', width: 150, render: (v) => <Tag>{v}</Tag> },
            ]}
          />
          <Button type="primary" block icon={<PlayCircleOutlined />} loading={running} onClick={runQuery} style={{ marginTop: 12 }} disabled={!runId}>
            运行选中查询
          </Button>
        </Card>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card title="导出结果" style={{ marginBottom: 16 }}>
            <Table
              size="small"
              rowKey="id"
              dataSource={results}
              pagination={{ pageSize: 6 }}
              locale={{ emptyText: '还没有查询结果' }}
              columns={[
                { title: '名称', dataIndex: 'name' },
                { title: '行数', dataIndex: 'rows', width: 90 },
                { title: '时间', dataIndex: 'created_at', render: (v) => String(v || '').replace('T', ' ').slice(0, 19) },
                {
                  title: '操作', width: 170,
                  render: (_, r) => (
                    <Space>
                      <Button size="small" onClick={() => showPreview(r.id)}>预览</Button>
                      <Button size="small" icon={<DownloadOutlined />} href={`/api/results/${r.id}/download`}>CSV</Button>
                      <Button size="small" icon={<DownloadOutlined />} href={`/api/results/${r.id}/export.xlsx`}>Excel</Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card title={previewId ? `预览 · ${preview?.total || 0} 行` : '预览'}>
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
                    children: chartOption ? <ReactECharts option={chartOption} style={{ height: 460 }} /> : <Alert type="info" showIcon message="该结果没有年份列，无法绘图。" />,
                  },
                ]}
              />
            ) : (
              <Alert type="info" showIcon message="在左侧选择查询并运行，或点击结果表中的“预览”。" />
            )}
          </Card>
        </div>
      </div>

      <Drawer title="查询日志" open={drawer} onClose={() => setDrawer(false)} width={860}>
        <LogConsole jobId={jobId} height={540} />
      </Drawer>
    </div>
  )
}
