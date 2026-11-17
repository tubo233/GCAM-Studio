import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Input, Pagination, Row, Space, Table, Tabs, Tag, Typography } from 'antd'
import { ArrowRightOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { CatalogFile, XmlItem } from '../types'

const { Title, Text, Paragraph } = Typography

const MODULE_DESC: Record<string, { title: string; desc: string; keys: string[] }> = {
  'gcam-china': { title: '中国省级参数', desc: '31 省人口/GDP、城镇化、电网、煤电 vintage、省级水与排放、核电激励等中国特有数据。', keys: ['人口/GDP', '城镇化', '电力负荷段', '煤电 vintage', '省级水'] },
  energy: { title: '能源供应与转换', desc: '煤油气铀资源、成本曲线、可再生资源、炼油、氢、天然气加工、终端能源技术。', keys: ['资源量', '成本曲线', '可再生潜力', '炼油/氢', '技术份额'] },
  aglu: { title: '农业与土地利用', desc: '作物产量/面积/成本、畜牧、化肥、灌溉、土地分配、保护区、生物质、土地碳价与贸易。', keys: ['作物产量', '畜牧', '化肥', '土地分配', '生物质'] },
  water: { title: '水资源', desc: '12 流域供给、地表/地下水、部门需水、海水淡化、电力冷却水系数。', keys: ['流域供给', '工业/市政需水', '农业灌溉', '海水淡化', '电力水系数'] },
  emissions: { title: '排放与空气质量', desc: 'CO2、CH4、N2O、含氟气体、气溶胶；排放因子、MAC 曲线、控制政策。', keys: ['CO2', '非 CO2', 'MAC', '排放因子', '控制政策'] },
  socioeconomics: { title: '社会经济', desc: 'SSP 人口/GDP 路径、收入分配、各部门收入弹性。', keys: ['SSP 路径', '人口', 'GDP', '收入弹性'] },
  common: { title: '通用映射', desc: 'GCAM 区域名称、单位、映射表等公共数据。', keys: ['区域映射', '单位', '通用表'] },
  'gcam-usa': { title: '美国模块（中国模型不使用）', desc: 'GCAM-USA 专用数据；保留用于完整性，不影响中国模型结果。', keys: ['USA 州级', 'USA 电力', 'USA 交通'] },
  tests: { title: '测试数据', desc: 'gcamdata 测试用文件。', keys: ['测试'] },
}

const LOGICAL = [
  { id: 'socio', title: '社会经济', desc: 'SSP 人口/GDP、城镇化、收入分配、收入弹性', fileModules: ['socioeconomics'], patterns: [], target: '/data?module=socioeconomics' },
  { id: 'energy', title: '能源资源', desc: '煤油气铀资源、成本曲线、可再生潜力、燃料价格与贸易', fileModules: ['energy'], patterns: ['resource', 'supply', 'price', 'trade', 'refin', 'liquids', 'gas', 'coal', 'oil', 'uranium', 'hydro', 'wind', 'solar', 'geo', 'bio'], target: '/data?module=energy&search=resource' },
  { id: 'electricity', title: '电力', desc: '6 大电网、负荷段、发电技术、核电、煤电 vintage、省间贸易', fileModules: ['gcam-china', 'energy'], patterns: ['elec', 'load', 'grid', 'nuclear', 'vintage', 'A23.elec'], target: '/data?module=gcam-china&search=elec' },
  { id: 'industry', title: '工业', desc: '水泥/钢铁/化工/铝/造纸/食品/其他工业的产量、技术、成本、贸易', fileModules: ['gcam-china', 'energy'], patterns: ['industry', 'cement', 'steel', 'chemical', 'aluminum', 'paper', 'food_processing', 'Fert', 'A323'], target: '/data?module=energy&search=industry' },
  { id: 'buildings', title: '建筑', desc: '城乡/住宅商业、建筑面积、HDD/CDD、家电效率、饱和与成本', fileModules: ['gcam-china', 'energy'], patterns: ['A44', 'building', 'floorspace', 'HDDCDD', 'L245'], target: '/data?module=gcam-china&search=A44' },
  { id: 'transport', title: '交通', desc: '客运/货运、UCD 数据、方式份额、技术效率、VOTT', fileModules: ['gcam-china', 'energy'], patterns: ['transport', 'trn', 'A54', 'UCD'], target: '/data?module=energy&search=transport' },
  { id: 'aglu', title: '农业与土地利用', desc: '作物产量/面积/成本、畜牧、化肥、灌溉、土地、生物质、碳价', fileModules: ['aglu'], patterns: [], target: '/data?module=aglu' },
  { id: 'water', title: '水资源', desc: '12 流域供给、地表/地下水、部门需水、海水淡化、电力水系数', fileModules: ['water'], patterns: [], target: '/data?module=water' },
  { id: 'emissions', title: '排放', desc: 'CO2/CH4/N2O/含氟气体/气溶胶、排放因子、MAC、控制政策', fileModules: ['emissions'], patterns: [], target: '/data?module=emissions' },
  { id: 'climate', title: '气候', desc: 'Hector / MAGICC / 无气候模型、强迫目标', xmlCategory: '气候', target: '/xml' },
  { id: 'policy', title: '政策', desc: '碳税、碳配额、净零 2060、UCT/FFICT、补贴、核电激励', xmlKind: 'policy', target: '/policy' },
  { id: 'settings', title: '模型设置', desc: '时间/停止年、求解器、并行度、输出开关、情景组件', settings: true, target: '/model-config' },
]

export default function Parameters() {
  const nav = useNavigate()
  const { activeId } = useProfiles()
  const [files, setFiles] = useState<CatalogFile[]>([])
  const [xmls, setXmls] = useState<XmlItem[]>([])
  const [loading, setLoading] = useState(false)
  const [activeModule, setActiveModule] = useState('gcam-china')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 24

  const load = async () => {
    setLoading(true)
    try {
      const [f, x] = await Promise.all([apiGet<CatalogFile[]>('/api/catalog/files'), apiGet<XmlItem[]>('/api/catalog/xml')])
      setFiles(f)
      setXmls(x)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const modules = useMemo(() => {
    const m = new Map<string, CatalogFile[]>()
    files.forEach((f) => {
      const arr = m.get(f.module) || []
      arr.push(f)
      m.set(f.module, arr)
    })
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [files])

  const current = useMemo(() => {
    let list = files.filter((f) => f.module === activeModule)
    if (search.trim()) {
      const s = search.toLowerCase()
      list = list.filter((f) => (f.title || '').toLowerCase().includes(s) || f.name.toLowerCase().includes(s) || (f.columns || []).some((c) => c.toLowerCase().includes(s)))
    }
    return list
  }, [files, activeModule, search])

  const pageItems = current.slice((page - 1) * pageSize, page * pageSize)

  const logicalModules = useMemo(() => {
    return LOGICAL.map((m: any) => {
      let count = 0
      if (m.settings) count = 6
      else if (m.xmlKind) count = xmls.filter((x) => x.kind === m.xmlKind).length
      else if (m.xmlCategory) count = xmls.filter((x) => x.category === m.xmlCategory).length
      else {
        count = files.filter((f) => {
          if (!m.fileModules.includes(f.module)) return false
          if (!m.patterns || !m.patterns.length) return true
          return m.patterns.some((p: string) => f.path.toLowerCase().includes(p.toLowerCase()))
        }).length
      }
      return { ...m, count }
    })
  }, [files, xmls])

  return (
    <div>
      <Title level={3} className="page-title">参数中心</Title>
      <p className="page-sub">按 12 个 GCAM 模块组织，每个文件都有结构化编辑入口；点击模块或文件卡片即可进入编辑。</p>

      {!activeId && <Alert type="warning" showIcon message="请先在顶部选择一个参数环境（Profile），修改会写入该 Profile。" style={{ marginBottom: 16 }} />}

      <Card
        title={`12 个功能模块 · 覆盖 ${logicalModules.filter((m) => m.count > 0).length}/12`}
        style={{ marginBottom: 16 }}
        extra={<Text type="secondary">点击卡片进入对应文件或编辑器</Text>}
      >
        <Row gutter={[12, 12]}>
          {logicalModules.map((m) => (
            <Col xs={24} sm={12} md={8} xl={6} key={m.id}>
              <Card size="small" hoverable onClick={() => nav((m as any).target)}>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text strong>{m.title}</Text>
                    <Tag color={m.count ? 'blue' : 'red'}>{m.count} 项</Tag>
                  </Space>
                  <span className="muted" style={{ fontSize: 12 }}>{m.desc}</span>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Card
        title={`数据目录覆盖：${modules.length} 个目录 · ${files.length} 个文件`}
        extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>}
        style={{ marginBottom: 16 }}
      >
        <Row gutter={[16, 16]}>
          {modules.map(([id, list]) => {
            const meta = MODULE_DESC[id] || { title: id, desc: '', keys: [] }
            return (
              <Col xs={24} md={12} xl={8} key={id}>
                <Card
                  hoverable
                  onClick={() => { setActiveModule(id); setPage(1); setSearch('') }}
                  title={<Space><Text strong>{meta.title}</Text><Tag>{list.length} 文件</Tag></Space>}
                  extra={<ArrowRightOutlined />}
                >
                  <Paragraph type="secondary" style={{ minHeight: 44 }}>{meta.desc}</Paragraph>
                  <Space wrap>{meta.keys.map((k) => <Tag key={k} color="blue">{k}</Tag>)}</Space>
                </Card>
              </Col>
            )
          })}
        </Row>
      </Card>

      <Card
        title="参数文件卡片"
        extra={<Input prefix={<SearchOutlined />} placeholder="在当前模块中搜索" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} allowClear style={{ width: 260 }} />}
      >
        <Tabs
          activeKey={activeModule}
          onChange={(k) => { setActiveModule(k); setPage(1); setSearch('') }}
          items={modules.map(([id, list]) => ({ key: id, label: `${MODULE_DESC[id]?.title || id} (${list.length})` }))}
        />
        {pageItems.length === 0 ? (
          <Empty description="没有匹配的文件" />
        ) : (
          <>
            <Row gutter={[12, 12]}>
              {pageItems.map((f) => (
                <Col xs={24} md={12} xl={8} xxl={6} key={f.path}>
                  <Card
                    size="small"
                    hoverable
                    title={<Text ellipsis style={{ maxWidth: 260 }} title={f.title || f.name}>{f.title || f.name}</Text>}
                    extra={<Tag color={f.long_format ? 'purple' : 'default'}>{f.long_format ? '长表' : '宽表'}</Tag>}
                    onClick={() => nav(`/data?module=${encodeURIComponent(f.module)}&file=${encodeURIComponent(f.path)}`)}
                  >
                    <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{f.path}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <div>单位：{f.units || '-'}</div>
                      <div>行数：{f.rows?.toLocaleString()} · 列数：{f.columns?.length || 0}</div>
                      <div>列：{(f.columns || []).slice(0, 4).join(', ')}{(f.columns || []).length > 4 ? ' …' : ''}</div>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
            <div style={{ textAlign: 'right', marginTop: 14 }}>
              <Pagination current={page} pageSize={pageSize} total={current.length} showSizeChanger={false} onChange={setPage} showTotal={(t) => `共 ${t} 个文件`} />
            </div>
          </>
        )}
      </Card>

      <Card title="覆盖矩阵（按模块）" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="module"
          pagination={false}
          dataSource={modules.map(([id, list]) => ({ module: id, label: MODULE_DESC[id]?.title || id, files: list.length, csv: list.filter((f) => f.file_type === 'csv').length, xlsx: list.filter((f) => f.file_type === 'xlsx').length }))}
          columns={[
            { title: '模块 ID', dataIndex: 'module', width: 160 },
            { title: '模块', dataIndex: 'label' },
            { title: '文件数', dataIndex: 'files', width: 100 },
            { title: 'CSV', dataIndex: 'csv', width: 90 },
            { title: 'Excel', dataIndex: 'xlsx', width: 90 },
            { title: '状态', render: () => <Tag color="green">可编辑</Tag> },
          ]}
        />
      </Card>
    </div>
  )
}
