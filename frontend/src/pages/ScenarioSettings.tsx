import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { ImportOutlined, InboxOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost, apiPut, fmtSize } from '../api'
import PolicyFileEditor, { type PolicyDraft } from '../components/PolicyFileEditor'
import PolicyBatchImportModal from '../components/PolicyBatchImportModal'
import { changed, failure, useInputVersion } from '../components/InputChanges'
import ConstraintForm from '../components/ConstraintForm'
import { useProfiles } from '../context/ProfileContext'
import { ParameterGrid } from './ParameterTable'
import type { XmlItem } from '../types'
import { analyzePolicyXml, detectPolicyConflicts, type PolicyAnalysis } from '../utils/policyXml'

const { Text } = Typography

type RowItem = { name: string; value: string }
const policyPath = (value: string) => ('/' + value.replace(/\\/g, '/')).match(/\/input\/policy\/(.+)$/i)?.[1]
const policyRow = (path: string) => ({ name: path.replace(/\.xml$/i, ''), value: '../input/policy/' + path })
function field(rows: RowItem[], name: string, value: string) {
  return rows.some((r) => r.name === name)
    ? rows.map((r) => (r.name === name ? { ...r, value } : r))
    : [...rows, { name, value }]
}

const TEMPLATE_HINTS: Record<string, string> = {
  'configuration_china.xml': 'Reference（基准）',
  'configuration_china_ssp1.xml': 'SSP1 可持续',
  'configuration_china_ssp2.xml': 'SSP2 中间路线',
  'configuration_china_ssp3.xml': 'SSP3 区域竞争',
  'configuration_china_ssp4.xml': 'SSP4 不平等',
  'configuration_china_ssp5.xml': 'SSP5 化石燃料',
}

const MAX_ANALYZE_BYTES = 2 * 1024 * 1024

type CrossPolicyItem = {
  key: string
  profileId: string
  profileName: string
  path: string
  size: number
}

export default function ScenarioSettings({
  id,
  config,
  setConfig,
  xmls,
  refreshPolicies,
  onGoStep3,
}: {
  id: string
  config: any
  setConfig: React.Dispatch<React.SetStateAction<any>>
  xmls: XmlItem[]
  refreshPolicies: () => Promise<void>
  onGoStep3?: (targetPath: string) => void
}) {
  const [searchParams] = useSearchParams()
  const { profiles } = useProfiles()
  const [drawerState, setDrawerState] = useState<{ label: string; group: string; source: string } | null>(null)
  const [library, setLibrary] = useState(() => searchParams.get('openPolicy') === '1')
  const [creating, setCreating] = useState(false)
  const [advice, setAdvice] = useState<string[]>([])
  const [policyInfo, setPolicyInfo] = useState<{ source: string; file: string; description: string }[]>([])
  const version = useInputVersion()

  useEffect(() => {
    if (searchParams.get('openPolicy') === '1') setLibrary(true)
  }, [searchParams])

  useEffect(() => {
    let live = true
    const timer = setTimeout(
      () =>
        apiPost(`/api/profiles/${id}/input-advice`, config)
          .then((v) => {
            if (live) {
              setAdvice(v.warnings)
              setPolicyInfo(v.policies)
            }
          })
          .catch((e) => {
            if (live) setAdvice([failure(e)])
          }),
      200,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [id, version, config])

  const openDrawer = (label: string, group: string, source = '') => {
    setDrawerState({ label, group, source })
  }

  const [search, setSearch] = useState('')
  const [file, setFile] = useState<PolicyDraft | null>(null)
  const [batchFiles, setBatchFiles] = useState<{ name: string; text: string }[] | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [extra, setExtra] = useState<string[]>([])
  const [templateBusy, setTemplateBusy] = useState(false)
  const [template, setTemplate] = useState<string>()
  const importRef = useRef<HTMLInputElement>(null)
  const openId = useRef(0)

  const [crossOpen, setCrossOpen] = useState(false)
  const [crossLoading, setCrossLoading] = useState(false)
  const [crossItems, setCrossItems] = useState<CrossPolicyItem[]>([])
  const [crossSearch, setCrossSearch] = useState('')
  const [crossBusyKey, setCrossBusyKey] = useState('')

  const active = (config.components as RowItem[]).map((r) => policyPath(r.value)).filter((s): s is string => !!s)
  const activeKey = active.join('\0')
  const target = (config.files as RowItem[]).find((r) => r.name === 'policy-target-file')?.value || ''
  const targetPath = policyPath(target) || target
  const findPath = /^(1|true)$/i.test(config.bools.find((r: RowItem) => r.name === 'find-path')?.value || '')
  const all = [...new Set([...active, ...extra, ...xmls.filter((x) => x.kind === 'policy').map((x) => x.path)])]
  const selectedPolicies = policyInfo.filter((p) => config.components.some((c: RowItem) => c.value === p.file))
  const fallbackActive = active.filter(
    (p) => !selectedPolicies.some((sp) => policyPath(sp.file) === p),
  )
  const items = all.filter((path) => path.toLowerCase().includes(search.toLowerCase()))
  const options = all.map((value) => ({ value, label: value }))

  const [activeAnalyses, setActiveAnalyses] = useState<{ path: string; analysis: PolicyAnalysis }[]>([])

  useEffect(() => {
    let cancelled = false
    const paths = activeKey ? activeKey.split('\0') : []
    if (!paths.length) {
      setActiveAnalyses([])
      return
    }
    const timer = setTimeout(async () => {
      const sizeMap = new Map(
        xmls.filter((x) => x.kind === 'policy').map((x) => [x.path, x.size]),
      )
      const results = await Promise.all(
        paths.map(async (rel) => {
          const knownSize = sizeMap.get(rel)
          if (knownSize !== undefined && knownSize > MAX_ANALYZE_BYTES) return null
          try {
            const r = await apiGet<{ text?: string; size?: number }>('/api/xml/content', {
              profile_id: id,
              kind: 'policy',
              path: rel,
            })
            if (!r?.text) return null
            if ((r.size ?? r.text.length) > MAX_ANALYZE_BYTES || r.text.length > MAX_ANALYZE_BYTES) {
              return null
            }
            return { path: rel, analysis: analyzePolicyXml(rel, r.text) }
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) {
        setActiveAnalyses(
          results.filter(
            (item): item is { path: string; analysis: PolicyAnalysis } =>
              !!item && item.analysis.valid,
          ),
        )
      }
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, activeKey, version, xmls])

  const activeCrossConflicts = useMemo(
    () =>
      detectPolicyConflicts(
        activeAnalyses.map((a) => ({ name: a.path, entries: a.analysis.entries })),
      ),
    [activeAnalyses],
  )
  const activeSameMarketWarnings = useMemo(
    () =>
      activeAnalyses.flatMap((a) =>
        a.analysis.sameMarketWarnings.map((w) => `${a.path}：${w}`),
      ),
    [activeAnalyses],
  )
  const explicitConstraintPolicies = useMemo(
    () => activeAnalyses.filter((a) => a.analysis.hasExplicitConstraint).map((a) => a.path),
    [activeAnalyses],
  )
  const findPathConflict = findPath && explicitConstraintPolicies.length > 0

  const openXml = async (path: string, kind: 'xml' | 'policy' = 'policy') => {
    const request = ++openId.current
    try {
      const r = await apiGet('/api/xml/content', { profile_id: id, kind, path, run_input: kind === 'xml' })
      if (openId.current === request)
        setFile({ path, text: r.text, kind, source: r.source, overlay: r.is_overlay })
    } catch (e: any) {
      message.error(e.response?.data?.detail || '文件读取失败')
    }
  }

  const toggle = (path: string, on: boolean) =>
    setConfig((c: any) => {
      const rows: RowItem[] = c.components
      return {
        ...c,
        components: on
          ? rows.some((r) => policyPath(r.value) === path)
            ? rows
            : [...rows, policyRow(path)]
          : rows.filter((r) => policyPath(r.value) !== path),
      }
    })

  const useTemplate = async (name: string) => {
    setTemplateBusy(true)
    try {
      const rows = await apiPost(`/api/profiles/${id}/config/template-components`, {
        template: name,
        components: config.components,
      })
      setConfig((c: any) => ({ ...c, components: rows }))
      setTemplate(name)
      message.success(`已切换基础组件模板为 ${name}`)
    } catch (e: any) {
      message.error(e.response?.data?.detail || '无法读取模板')
    } finally {
      setTemplateBusy(false)
    }
  }

  const savedFile = async (path: string, root: string, use: boolean) => {
    if (file?.kind !== 'xml') setExtra((prev) => [...new Set([...prev, path])])
    if (use) {
      const next = { ...config }
      if (root === 'policy-target-runner') {
        next.files = field(next.files, 'policy-target-file', policyRow(path).value)
        next.bools = field(next.bools, 'find-path', '1')
      } else if (next.components.some((r: RowItem) => policyPath(r.value) === path)) {
        next.components = next.components.map((r: RowItem) =>
          policyPath(r.value) === path ? { ...r, value: policyRow(path).value } : r,
        )
      } else {
        next.components = [...next.components, policyRow(path)]
      }
      try {
        const result = await apiPut(`/api/profiles/${id}/config`, next)
        setConfig({ ...next, revision: result.revision })
      } catch (error: any) {
        setConfig(next)
        throw new Error('文件已保存，配置仍在编辑中。' + (error.response?.data?.detail || '请重试保存配置。'))
      }
    }
    setFile(null)
    changed()
    await refreshPolicies()
  }

  const example = ['spa14_tax.xml', 'carbon_tax_0.xml', '2025_target_finder.xml']
  const addExample = () =>
    setConfig((c: any) => {
      const missing = example.filter((p) => !c.components.some((r: RowItem) => policyPath(r.value) === p))
      return { ...c, components: [...c.components, ...missing.map(policyRow)] }
    })

  const importPolicies = async (fileList: FileList | File[] | null) => {
    if (!fileList || !fileList.length) return
    const rawFiles = Array.from(fileList)
    const xmlFiles = rawFiles.filter((f) => f.name.toLowerCase().endsWith('.xml'))
    if (!xmlFiles.length) {
      message.warning('请选择 .xml 格式的政策文件')
      return
    }
    if (xmlFiles.length < rawFiles.length) {
      message.info(`已忽略 ${rawFiles.length - xmlFiles.length} 个非 .xml 文件`)
    }
    const request = ++openId.current
    const loaded = await Promise.all(
      xmlFiles.map(async (f) => ({ name: f.name, text: await f.text() })),
    )
    if (openId.current !== request) return
    if (loaded.length === 1) {
      setBatchFiles(null)
      setFile({ path: loaded[0].name, text: loaded[0].text })
    } else {
      setFile(null)
      setBatchFiles(loaded)
    }
  }

  const openCrossProfileModal = async () => {
    setCrossOpen(true)
    setCrossSearch('')
    setCrossLoading(true)
    try {
      const others = profiles.filter((p) => p.id !== id)
      const list = await Promise.all(
        others.map(async (other) => {
          try {
            const ov = await apiGet<{ kind: string; path: string; size: number }[]>(
              `/api/profiles/${other.id}/overlay`,
            )
            return ov
              .filter((x) => x.kind === 'policy' && x.path.toLowerCase().endsWith('.xml'))
              .map((x) => ({
                key: `${other.id}\0${x.path}`,
                profileId: other.id,
                profileName: other.name,
                path: x.path,
                size: x.size,
              }))
          } catch {
            return []
          }
        }),
      )
      setCrossItems(list.flat())
    } finally {
      setCrossLoading(false)
    }
  }

  const importFromOtherProfile = async (item: CrossPolicyItem, enableNow: boolean) => {
    setCrossBusyKey(item.key)
    try {
      const res = await apiGet<{ text: string }>('/api/xml/content', {
        profile_id: item.profileId,
        kind: 'policy',
        path: item.path,
      })
      await apiPut('/api/xml/content', {
        profile_id: id,
        kind: 'policy',
        path: item.path,
        text: res.text,
      })
      setExtra((prev) => [...new Set([...prev, item.path])])

      if (enableNow) {
        const analysis = analyzePolicyXml(item.path, res.text)
        const next = {
          ...config,
          files: [...(config.files || [])],
          bools: [...(config.bools || [])],
          components: [...(config.components || [])],
        }
        if (analysis.valid && analysis.rootTag === 'policy-target-runner') {
          next.files = field(next.files, 'policy-target-file', policyRow(item.path).value)
          next.bools = field(next.bools, 'find-path', '1')
        } else if (next.components.some((r: RowItem) => policyPath(r.value) === item.path)) {
          next.components = next.components.map((r: RowItem) =>
            policyPath(r.value) === item.path ? { ...r, value: policyRow(item.path).value } : r,
          )
        } else {
          next.components = [...next.components, policyRow(item.path)]
        }
        const saved = await apiPut(`/api/profiles/${id}/config`, next)
        setConfig({ ...next, revision: saved.revision })
      }

      changed()
      await refreshPolicies()
      message.success(
        enableNow
          ? `已从「${item.profileName}」引入并启用 ${item.path}`
          : `已从「${item.profileName}」引入 ${item.path} 到政策库`,
      )
    } catch (e: any) {
      message.error(e.response?.data?.detail || e.message || '引入政策失败')
    } finally {
      setCrossBusyKey('')
    }
  }

  const ssp = (config.strings as RowItem[]).find((r) => r.name === 'scenarioName')?.value.match(/SSP([1-5])/i)?.[1]
  const socio = (config.components as RowItem[])
    .map((r) => r.value.split(/[\\/]/).pop() || '')
    .filter((n) => /^socioeconomics_/i.test(n))
  const mismatch =
    ssp &&
    socio.some((n) => /^socioeconomics_(CORE|SSP[1-5])\.xml$/i.test(n)) &&
    !socio.some((n) => n.toUpperCase() === `SOCIOECONOMICS_SSP${ssp}.XML`)
  const growthFile = socio.some((n) => /^socioeconomics_CHINA_SSP/i.test(n))
    ? 'socioeconomics/SSP/SSP_database_2024.csv.gz'
    : 'gcam-china/SSPS_GDP.csv'

  const goStep3 = (path: string) => {
    if (onGoStep3) onGoStep3(path)
  }

  const activePolicyRows = [
    ...selectedPolicies.map((p) => ({
      key: p.source,
      name: p.source.split(/[\\/]/).pop() || p.source,
      description: p.description || '已启用政策组件',
      source: p.source,
      file: p.file,
      policyRel: policyPath(p.file),
    })),
    ...fallbackActive.map((rel) => ({
      key: rel,
      name: rel,
      description: '已启用（读取详情中…）',
      source: '',
      file: policyRow(rel).value,
      policyRel: rel,
    })),
  ]

  const filteredCrossItems = crossItems.filter((item) => {
    const q = crossSearch.trim().toLowerCase()
    if (!q) return true
    return (
      item.profileName.toLowerCase().includes(q) ||
      item.path.toLowerCase().includes(q)
    )
  })

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragActive(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragActive(false)
        void importPolicies(e.dataTransfer.files)
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* 卡片 1：基础方案与社会经济输入 */}
        <Card size="small" title="1. 基础方案与社会经济输入">
          <Form layout="vertical" component="div">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item
                  label="基础组件模板（切换 SSP 路线）"
                  extra="套用模板会保留你额外添加的自定义组件和政策"
                  style={{ marginBottom: 12 }}
                >
                  <Select
                    style={{ width: '100%' }}
                    placeholder="选择模板（如 configuration_china_ssp2.xml）"
                    loading={templateBusy}
                    disabled={templateBusy}
                    value={template}
                    onChange={useTemplate}
                    options={config.templates.map((value: string) => ({
                      value,
                      label: TEMPLATE_HINTS[value] ? `${TEMPLATE_HINTS[value]} (${value})` : value,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label="场景名称（scenarioName）"
                  extra="运行完成后会作为默认结果场景标识写入数据库"
                  style={{ marginBottom: 12 }}
                >
                  <Input
                    value={config.strings.find((r: RowItem) => r.name === 'scenarioName')?.value || ''}
                    onChange={(e) =>
                      setConfig({ ...config, strings: field(config.strings, 'scenarioName', e.target.value) })
                    }
                  />
                </Form.Item>
              </Col>
            </Row>
            <div>
              <Text type="secondary" style={{ marginRight: 8 }}>当前社会经济输入（点击可在右侧抽屉直接编辑地区-年份数值）：</Text>
              <Space wrap size={6}>
                {(config.components as RowItem[])
                  .filter((r) => /(?:^|[\\/])socioeconomics[^\\/]*\.xml$/i.test(r.value))
                  .map((r, i) => {
                    const path = r.value.replace(/\\/g, '/')
                    const prefix = (config.model_root || '').replace(/\\/g, '/') + '/input/gcamdata/xml/'
                    const relative =
                      path.match(/^(?:\.\.\/|\.\/)?input\/gcamdata\/xml\/(.+)$/i)?.[1] ||
                      (path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : '')
                    return relative ? (
                      <Button
                        size="small"
                        key={i}
                        title="在抽屉中按地区和年份编辑"
                        onClick={() => openDrawer(relative, '', 'input/gcamdata/xml/' + relative)}
                      >
                        {relative}
                      </Button>
                    ) : (
                      <Tag key={i}>{r.value}</Tag>
                    )
                  })}
              </Space>
            </div>
          </Form>
          {mismatch && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 12 }}
              message={`情景名含 SSP${ssp}，但当前社会经济输入为 ${socio.join('、')}，请确认是否与研究路线一致。`}
            />
          )}
        </Card>

        {/* 卡片 2：约束与政策组件 */}
        <Card
          size="small"
          title={`2. 约束与政策组件（已启用 ${activePolicyRows.length} 项）`}
          extra={
            <Space wrap>
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建约束 / 碳税
              </Button>
              <Button size="small" icon={<UploadOutlined />} onClick={() => importRef.current?.click()}>
                上传 / 批量导入政策 XML
              </Button>
              <Button size="small" icon={<ImportOutlined />} onClick={openCrossProfileModal}>
                从其他情景引入
              </Button>
              <Button size="small" onClick={() => setLibrary((v) => !v)}>
                {library ? '收起政策库' : '从政策库挑选'}
              </Button>
            </Space>
          }
        >
          <div
            className="dropzone-hint"
            role="button"
            tabIndex={0}
            onClick={() => importRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                importRef.current?.click()
              }
            }}
            style={{
              cursor: 'pointer',
              padding: '14px 16px',
              borderWidth: 1.5,
              borderColor: dragActive ? '#1677ff' : '#cbd5e1',
              background: dragActive ? '#eff6ff' : '#f8fafc',
              color: dragActive ? '#1d4ed8' : '#475569',
              transition: 'all 0.15s ease',
            }}
          >
            <Space size={8}>
              <InboxOutlined style={{ fontSize: 16, color: '#1677ff' }} />
              <span>
                点击选择或将 1 个或多个政策 <code>.xml</code> 文件拖放到此处（支持批量导入体检、多 scenario 自动合并与冲突告警）
              </span>
            </Space>
          </div>

          <input
            ref={importRef}
            type="file"
            accept=".xml"
            multiple
            hidden
            onChange={(e) => {
              void importPolicies(e.target.files)
              e.target.value = ''
            }}
          />

          {(activeCrossConflicts.length > 0 || activeSameMarketWarnings.length > 0 || findPathConflict) && (
            <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
              {activeCrossConflicts.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`已启用政策之间存在 ${activeCrossConflicts.length} 处地区/政策重复定义冲突`}
                  description={
                    <Space direction="vertical" size={4}>
                      {activeCrossConflicts.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </Space>
                  }
                />
              )}
              {activeSameMarketWarnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message="已启用政策存在同市场重复 constraint 上限风险"
                  description={
                    <Space direction="vertical" size={4}>
                      {activeSameMarketWarnings.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </Space>
                  }
                />
              )}
              {findPathConflict && (
                <Alert
                  type="warning"
                  showIcon
                  message="显式排放上限与全球气候目标搜索（find-path）同时开启提醒"
                  description={`当前已启用的政策（${explicitConstraintPolicies.join('、')}）包含显式 <constraint> 上限，同时下方已开启 find-path 目标搜索。两者同时开启可能互相干扰，请确认是否需要关闭下方的 find-path。`}
                />
              )}
            </Space>
          )}

          {activePolicyRows.length ? (
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={activePolicyRows}
              columns={[
                { title: '政策文件', dataIndex: 'name', width: 220, render: (v) => <Text strong>{v}</Text> },
                { title: '作用范围与摘要', dataIndex: 'description' },
                {
                  title: '操作',
                  width: 230,
                  render: (_, r) => (
                    <Space>
                      {r.source && (
                        <Button size="small" onClick={() => openDrawer(`政策参数 · ${r.name}`, '', r.source)}>
                          编辑数值
                        </Button>
                      )}
                      {r.policyRel && (
                        <Button size="small" onClick={() => openXml(r.policyRel!)}>
                          查看 XML
                        </Button>
                      )}
                      <Button
                        size="small"
                        danger
                        type="text"
                        onClick={() =>
                          setConfig({
                            ...config,
                            components: config.components.filter((c: RowItem) => c.value !== r.file),
                          })
                        }
                      >
                        停用
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          ) : (
            <Text type="secondary">尚未启用任何政策组件（即纯基准情景）。可点击右上角新建碳税/排放上限或从政策库开启。</Text>
          )}

          {library && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f0f0f0' }}>
              <Space wrap style={{ marginBottom: 10 }}>
                <Input.Search
                  style={{ width: 260 }}
                  placeholder="搜索政策库文件名…"
                  allowClear
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button icon={<ReloadOutlined />} onClick={refreshPolicies}>
                  刷新政策库
                </Button>
              </Space>
              <Table
                size="small"
                rowKey={(p) => p}
                dataSource={items}
                pagination={{ pageSize: 6, showSizeChanger: false }}
                columns={[
                  {
                    title: '政策库文件（点击可预览或编辑 XML）',
                    render: (_, p) => (
                      <Button type="link" style={{ paddingInline: 0 }} onClick={() => openXml(p)}>
                        {p}
                      </Button>
                    ),
                  },
                  {
                    title: '启用状态',
                    width: 110,
                    render: (_, p) => (
                      <Switch aria-label={`启用 ${p}`} checked={active.includes(p)} onChange={(v) => toggle(p, v)} />
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Card>

        {/* 卡片 3：全球气候目标搜索（可选） */}
        <Card
          size="small"
          title="3. 全球气候目标搜索（find-path，可选）"
          extra={
            <Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {findPath ? '已开启全时段目标搜索' : '未开启（默认按预设政策运行）'}
              </Text>
              <Switch
                aria-label="搜索气候目标"
                checked={findPath}
                checkedChildren="开启"
                unCheckedChildren="关闭"
                onChange={(checked) =>
                  setConfig({ ...config, bools: field(config.bools, 'find-path', checked ? '1' : '0') })
                }
              />
            </Space>
          }
        >
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap>
              <Text type="secondary">目标定义文件：</Text>
              <Select
                aria-label="目标文件"
                showSearch
                value={targetPath || undefined}
                placeholder="选择目标文件"
                style={{ minWidth: 280 }}
                options={options}
                onChange={(p) =>
                  setConfig({ ...config, files: field(config.files, 'policy-target-file', policyRow(p).value) })
                }
              />
              <Button
                disabled={!targetPath || !all.includes(targetPath)}
                onClick={() =>
                  findPath
                    ? openDrawer('全球气候目标', '全球气候目标', policyInfo.find((p) => p.file === target)?.source || '')
                    : openXml(targetPath)
                }
              >
                编辑目标参数
              </Button>
              {example.every((p) => all.includes(p)) && (
                <Button title={example.join('、')} onClick={addExample}>
                  加入模型自带的 2025 碳价示例组件
                </Button>
              )}
            </Space>
            {advice.map((w) => (
              <Alert type="warning" showIcon key={w} message={w} />
            ))}
          </Space>
        </Card>

        {/* 底部引导条：需要微调人口、GDP 或技术数据时前往第 ③ 步 */}
        <Card size="small" style={{ background: '#f8fafc' }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text strong>需要调整人口、GDP、技术成本或底层 CSV 数据？（可选 · 进入第 ③ 步）</Text>
            <Space wrap size={[16, 8]}>
              <Space size={6} wrap>
                <Text type="secondary" style={{ fontSize: 12 }}>人口与经济：</Text>
                {['设定人口', '设定 GDP'].map((g) => (
                  <Button
                    key={g}
                    size="small"
                    onClick={() => goStep3('/parameters?' + new URLSearchParams({ tab: 'xml', group: g }).toString())}
                  >
                    {g}
                  </Button>
                ))}
                <Button
                  size="small"
                  type="dashed"
                  onClick={() =>
                    goStep3(
                      '/parameters?' +
                        new URLSearchParams({ tab: 'csv', file: 'gcam-china/Population_Growth_Rates.csv' }).toString(),
                    )
                  }
                >
                  修改人口增长假设 (CSV)
                </Button>
                <Button
                  size="small"
                  type="dashed"
                  onClick={() =>
                    goStep3('/parameters?' + new URLSearchParams({ tab: 'csv', file: growthFile }).toString())
                  }
                >
                  修改 GDP 假设 (CSV)
                </Button>
              </Space>
              <Space size={6} wrap>
                <Text type="secondary" style={{ fontSize: 12 }}>排放与技术：</Text>
                {['排放与碳价', '技术成本', '技术效率', '发电占比'].map((g) => (
                  <Button
                    key={g}
                    size="small"
                    onClick={() => goStep3('/parameters?' + new URLSearchParams({ tab: 'xml', group: g }).toString())}
                  >
                    {g}
                  </Button>
                ))}
              </Space>
            </Space>
          </Space>
        </Card>
      </Space>

      <Drawer
        title={drawerState?.label || '编辑参数'}
        open={!!drawerState}
        onClose={() => setDrawerState(null)}
        width={920}
        destroyOnClose
      >
        {drawerState && (
          <ParameterGrid
            key={drawerState.group + drawerState.source}
            pid={id}
            group={drawerState.group}
            initialSource={drawerState.source}
            onExpandFull={(params) => {
              setDrawerState(null)
              goStep3('/parameters?' + new URLSearchParams({ tab: 'xml', ...params }).toString())
            }}
          />
        )}
      </Drawer>

      {creating && (
        <ConstraintForm
          close={() => setCreating(false)}
          preview={(v) => {
            setCreating(false)
            setFile(v)
          }}
        />
      )}

      {file && (
        <PolicyFileEditor
          key={file.path}
          profileId={id}
          file={file}
          close={() => setFile(null)}
          saved={savedFile}
        />
      )}

      {batchFiles && (
        <PolicyBatchImportModal
          profileId={id}
          config={config}
          files={batchFiles}
          close={() => setBatchFiles(null)}
          onImported={async (nextConfig, importedPaths) => {
            if (importedPaths?.length) {
              setExtra((prev) => [...new Set([...prev, ...importedPaths])])
            }
            if (nextConfig) {
              setConfig(nextConfig)
            }
            setBatchFiles(null)
            changed()
            await refreshPolicies()
          }}
        />
      )}

      <Modal
        open={crossOpen}
        title="从其他情景引入政策 XML"
        width={780}
        onCancel={() => setCrossOpen(false)}
        footer={
          <Button onClick={() => setCrossOpen(false)}>关闭</Button>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap>
            <Input.Search
              style={{ width: 280 }}
              placeholder="按情景名称或文件名筛选…"
              allowClear
              value={crossSearch}
              onChange={(e) => setCrossSearch(e.target.value)}
            />
            <Button icon={<ReloadOutlined />} loading={crossLoading} onClick={openCrossProfileModal}>
              刷新列表
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="key"
            loading={crossLoading}
            dataSource={filteredCrossItems}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{ emptyText: '其他情景中暂无已保存的政策 XML 文件' }}
            columns={[
              {
                title: '来源情景名',
                dataIndex: 'profileName',
                width: 180,
                render: (v) => <Text strong>{v}</Text>,
              },
              {
                title: '政策文件名',
                dataIndex: 'path',
                render: (p: string) => (
                  <Space size={6}>
                    <span>{p}</span>
                    {active.includes(p) && <Tag color="blue">当前已启用</Tag>}
                  </Space>
                ),
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 95,
                render: (s: number) => fmtSize(s),
              },
              {
                title: '操作',
                width: 210,
                render: (_, r) => {
                  const rowBusy = crossBusyKey === r.key
                  return (
                    <Space size={6}>
                      <Button
                        size="small"
                        loading={rowBusy}
                        disabled={!!crossBusyKey && !rowBusy}
                        onClick={() => importFromOtherProfile(r, false)}
                      >
                        引入到政策库
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        loading={rowBusy}
                        disabled={!!crossBusyKey && !rowBusy}
                        onClick={() => importFromOtherProfile(r, true)}
                      >
                        引入并启用
                      </Button>
                    </Space>
                  )
                },
              },
            ]}
          />
        </Space>
      </Modal>
    </section>
  )
}
