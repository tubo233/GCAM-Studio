import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Select, Space, Table, Typography, message } from 'antd'
import { BarChartOutlined, ReloadOutlined } from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import { apiGet } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { RunInfo } from '../types'

const { Title, Text } = Typography

export default function Compare({
  embedded = false,
  initialSelected,
}: {
  embedded?: boolean
  initialSelected?: string[]
} = {}) {
  const { profiles } = useProfiles()
  const [results, setResults] = useState<any[]>([])
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [selected, setSelected] = useState<string[]>(initialSelected || [])
  const [groupBy, setGroupBy] = useState('total')
  const [section, setSection] = useState('')
  const [sections, setSections] = useState<string[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!initialSelected?.length) return
    setSelected((prev) => Array.from(new Set([...prev, ...initialSelected])))
  }, [initialSelected])

  const load = async () => {
    const [list, runList] = await Promise.all([apiGet<any[]>('/api/results'), apiGet<RunInfo[]>('/api/runs')])
    setResults(list)
    setRuns(runList)
  }

  useEffect(() => {
    load()
  }, [])

  const runMap = useMemo(() => {
    const m = new Map<string, RunInfo>()
    runs.forEach((r) => m.set(r.run_id, r))
    return m
  }, [runs])

  const profileNameMap = useMemo(() => {
    const m = new Map<string, string>()
    profiles.forEach((p) => m.set(p.id, p.name))
    return m
  }, [profiles])

  const runCompare = async (sec = section, gb = groupBy) => {
    if (selected.length < 2) return message.warning('请至少选择两个结果')
    setLoading(true)
    try {
      const r = await apiGet<any>('/api/compare/results', { ids: selected.join(','), section: sec, group_by: gb })
      setSections(r.sections || [])
      const nextSection = sec || (r.sections || [])[0] || ''
      if (nextSection !== sec) {
        setSection(nextSection)
        const r2 = await apiGet<any>('/api/compare/results', { ids: selected.join(','), section: nextSection, group_by: gb })
        setRows(r2.rows || [])
      } else {
        setRows(r.rows || [])
      }
    } finally {
      setLoading(false)
    }
  }

  const chartOption = useMemo(() => {
    if (!rows.length) return null
    const byName = new Map<string, Map<number, number>>()
    rows.forEach((r) => {
      const label = groupBy === 'total' ? r.name : `${r.name} · ${r.group}`
      const cur = byName.get(label) || new Map<number, number>()
      cur.set(r.year, (cur.get(r.year) || 0) + r.value)
      byName.set(label, cur)
    })
    const years = Array.from(new Set(rows.map((r) => r.year))).sort((a, b) => a - b)
    let entries = Array.from(byName.entries())
    if (entries.length > 16) entries = entries.slice(0, 16)
    return {
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 0 },
      grid: { left: 60, right: 24, top: 48, bottom: 32 },
      xAxis: { type: 'category', data: years.map(String) },
      yAxis: { type: 'value' },
      series: entries.map(([name, vals]) => ({
        name,
        type: 'line',
        smooth: true,
        data: years.map((y) => vals.get(y) ?? null),
      })),
    }
  }, [rows, groupBy])

  return (
    <div>
      {!embedded && (
        <>
          <Title level={3} className="page-title">跨运行对比</Title>
          <p className="page-sub">选择两次或多次运行的查询结果，按年份对齐比较。建议选择同名查询（同一 section），否则单位可能不同。</p>
        </>
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="三步完成对比：1. 在下表勾选至少 2 份同类型查询结果 → 2. 选择聚合方式与查询 Section → 3. 点击“生成对比”查看年度折线图与明细数据。"
      />

      <Card
        title={`选择结果（已选 ${selected.length} 份）`}
        extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>}
        style={{ marginBottom: 16 }}
      >
        <Table
          size="small"
          rowKey="id"
          dataSource={results}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{ emptyText: '尚无已查询结果，请先在“单次运行查询与分析”标签页运行查询' }}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
          columns={[
            { title: '结果名称', dataIndex: 'name' },
            {
              title: '所属情景（Profile）',
              render: (_, r) => {
                const run = runMap.get(r.run_id)
                return run ? profileNameMap.get(run.profile_id) || run.profile_id : '—'
              },
            },
            {
              title: '场景名',
              render: (_, r) => runMap.get(r.run_id)?.scenario_name || r.run_id || '—',
            },
            { title: '行数', dataIndex: 'rows', width: 90 },
            { title: '创建时间', dataIndex: 'created_at', width: 170, render: (v) => String(v || '').replace('T', ' ').slice(0, 19) },
          ]}
        />
        <Space style={{ marginTop: 12 }} wrap>
          <Text strong>聚合方式：</Text>
          <Select
            style={{ width: 180 }}
            value={groupBy}
            onChange={(v) => {
              setGroupBy(v)
              if (selected.length >= 2) runCompare(section, v)
            }}
            options={[{ value: 'total', label: '全部合计' }, { value: 'region', label: '按区域' }, { value: 'sector', label: '按部门/燃料' }]}
          />
          <Text strong>查询 Section：</Text>
          <Select
            style={{ width: 360 }}
            value={section || undefined}
            placeholder="生成对比后可选或切换查询"
            onChange={(v) => {
              setSection(v)
              if (selected.length >= 2) runCompare(v, groupBy)
            }}
            options={sections.map((s) => ({ value: s, label: s }))}
          />
          <Button type="primary" icon={<BarChartOutlined />} loading={loading} onClick={() => runCompare()}>
            生成对比
          </Button>
        </Space>
      </Card>

      <Card title="对比图表" style={{ marginBottom: 16 }}>
        {chartOption ? <ReactECharts option={chartOption} style={{ height: 460 }} /> : <Empty description="选择两个以上结果并点击“生成对比”" />}
      </Card>

      <Card title={`对比数据（${rows.length.toLocaleString()} 行）`}>
        <Table
          size="small"
          rowKey={(r, i) => `${r.result_id}-${r.section}-${r.group}-${r.year}-${i}`}
          dataSource={rows}
          pagination={{ pageSize: 30 }}
          columns={[
            { title: '结果', dataIndex: 'name', width: 220, ellipsis: true },
            { title: 'Section', dataIndex: 'section', width: 260, ellipsis: true },
            { title: '分组', dataIndex: 'group', width: 160, ellipsis: true },
            { title: '年份', dataIndex: 'year', width: 90 },
            { title: '值', dataIndex: 'value', render: (v) => Number(v).toPrecision(6) },
          ]}
        />
      </Card>
    </div>
  )
}
