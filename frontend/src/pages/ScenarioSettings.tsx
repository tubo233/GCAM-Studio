import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Select, Space, Switch, Table, Typography, message } from 'antd'
import { apiGet, apiPost, apiPut } from '../api'
import PolicyFileEditor, { type PolicyDraft } from '../components/PolicyFileEditor'
import { Link } from 'react-router-dom'
import { changed, failure, useInputVersion } from '../components/InputChanges'
import ConstraintForm from '../components/ConstraintForm'
import { ParameterGrid } from './ParameterTable'
import type { XmlItem } from '../types'

type Row = { name: string; value: string }
const policyPath = (value: string) => ('/' + value.replace(/\\/g, '/')).match(/\/input\/policy\/(.+)$/i)?.[1]
const policyRow = (path: string) => ({ name: path.replace(/\.xml$/i, ''), value: '../input/policy/' + path })
function field(rows: Row[], name: string, value: string) {
  return rows.some((r) => r.name === name)
    ? rows.map((r) => (r.name === name ? { ...r, value } : r))
    : [...rows, { name, value }]
}

export default function ScenarioSettings({
  id,
  config,
  setConfig,
  xmls,
  refreshPolicies,
}: {
  id: string
  config: any
  setConfig: React.Dispatch<React.SetStateAction<any>>
  xmls: XmlItem[]
  refreshPolicies: () => Promise<void>
}) {
  const [group, setGroup] = useState('')
  const [library, setLibrary] = useState(false)
  const [creating, setCreating] = useState(false)
  const [advice, setAdvice] = useState<string[]>([])
  const [policyInfo, setPolicyInfo] = useState<{ source: string; file: string; description: string }[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const version = useInputVersion()
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
  const showGroup = (label: string, source = '') => {
    setGroup(label)
    setSelectedSource(source)
  }
  const [search, setSearch] = useState('')
  const [file, setFile] = useState<PolicyDraft | null>(null)
  const [extra, setExtra] = useState<string[]>([])
  const [templateBusy, setTemplateBusy] = useState(false)
  const [template, setTemplate] = useState<string>()
  const importRef = useRef<HTMLInputElement>(null)
  const openId = useRef(0)
  const active = (config.components as Row[]).map((r) => policyPath(r.value)).filter((s): s is string => !!s)
  const target = (config.files as Row[]).find((r) => r.name === 'policy-target-file')?.value || ''
  const targetPath = policyPath(target) || target
  const findPath = /^(1|true)$/i.test(config.bools.find((r: Row) => r.name === 'find-path')?.value || '')
  const all = [...new Set([...active, ...extra, ...xmls.filter((x) => x.kind === 'policy').map((x) => x.path)])]
  const selectedPolicies = policyInfo.filter((p) => config.components.some((c: Row) => c.value === p.file))
  const items = all.filter((path) => path.toLowerCase().includes(search.toLowerCase()))
  const options = all.map((value) => ({ value, label: value }))

  const open = async (path: string, kind: 'xml' | 'policy' = 'policy') => {
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
      const rows: Row[] = c.components
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
      } else if (next.components.some((r: Row) => policyPath(r.value) === path)) {
        next.components = next.components.map((r: Row) =>
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
      const missing = example.filter((p) => !c.components.some((r: Row) => policyPath(r.value) === p))
      return { ...c, components: [...c.components, ...missing.map(policyRow)] }
    })
  const importPolicy = async (f?: File) => {
    if (f) {
      ++openId.current
      setFile({ path: f.name, text: await f.text() })
    }
  }
  const ssp = (config.strings as Row[]).find((r) => r.name === 'scenarioName')?.value.match(/SSP([1-5])/i)?.[1]
  const socio = (config.components as Row[])
    .map((r) => r.value.split(/[\\/]/).pop() || '')
    .filter((n) => /^socioeconomics_/i.test(n))
  const mismatch =
    ssp &&
    socio.some((n) => /^socioeconomics_(CORE|SSP[1-5])\.xml$/i.test(n)) &&
    !socio.some((n) => n.toUpperCase() === `SOCIOECONOMICS_SSP${ssp}.XML`)
  const growthFile = socio.some((n) => /^socioeconomics_CHINA_SSP/i.test(n))
    ? 'socioeconomics/SSP/SSP_database_2024.csv.gz'
    : 'gcam-china/SSPS_GDP.csv'
  return (
    <section
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void importPolicy(e.dataTransfer.files[0])
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Form layout="vertical" component="div">
          <Space align="start" wrap>
            <Form.Item label="基础组件模板">
              <Select
                style={{ minWidth: 260 }}
                placeholder="套用模板，保留自定义组件和政策"
                loading={templateBusy}
                disabled={templateBusy}
                value={template}
                onChange={useTemplate}
                options={config.templates.map((value: string) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item label="场景名称">
              <Input
                value={config.strings.find((r: Row) => r.name === 'scenarioName')?.value || ''}
                onChange={(e) =>
                  setConfig({ ...config, strings: field(config.strings, 'scenarioName', e.target.value) })
                }
              />
            </Form.Item>
          </Space>
          <div>
            当前社会经济输入 ·{' '}
            {(config.components as Row[])
              .filter((r) => /(?:^|[\\/])socioeconomics[^\\/]*\.xml$/i.test(r.value))
              .map((r, i) => {
                const path = r.value.replace(/\\/g, '/')
                const prefix = (config.model_root || '').replace(/\\/g, '/') + '/input/gcamdata/xml/'
                const relative =
                  path.match(/^(?:\.\.\/|\.\/)?input\/gcamdata\/xml\/(.+)$/i)?.[1] ||
                  (path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : '')
                return relative ? (
                  <Button
                    type="link"
                    key={i}
                    title="按地区和年份编辑当前组件"
                    onClick={() => showGroup('当前社会经济参数', 'input/gcamdata/xml/' + relative)}
                  >
                    {relative}
                  </Button>
                ) : (
                  <Typography.Text key={i}>{r.value} </Typography.Text>
                )
              })}
          </div>
        </Form>
        {mismatch && (
          <Alert
            type="warning"
            showIcon
            message={`情景名含 SSP${ssp}，当前社会经济输入为 ${socio.join('、')}。`}
          />
        )}
        <Space wrap>
          <Checkbox
            checked={findPath}
            onChange={(e) =>
              setConfig({ ...config, bools: field(config.bools, 'find-path', e.target.checked ? '1' : '0') })
            }
          >
            搜索气候目标
          </Checkbox>
          <Select
            aria-label="目标文件"
            showSearch
            value={targetPath || undefined}
            placeholder="目标文件"
            style={{ minWidth: 255 }}
            options={options}
            onChange={(p) =>
              setConfig({ ...config, files: field(config.files, 'policy-target-file', policyRow(p).value) })
            }
          />
          <Button
            disabled={!targetPath || !all.includes(targetPath)}
            onClick={() =>
              findPath
                ? showGroup('全球气候目标', policyInfo.find((p) => p.file === target)?.source)
                : open(targetPath)
            }
          >
            编辑目标
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
        <div>
          <Typography.Text strong>当前约束与政策</Typography.Text>　
          <Button type="primary" onClick={() => setLibrary(!library)}>
            添加约束
          </Button>
        </div>
        {selectedPolicies.length ? (
          <Space direction="vertical">
            {selectedPolicies.map((p) => (
              <Space key={p.source} wrap>
                <Button size="small" onClick={() => showGroup('当前政策参数', p.source)}>
                  {p.source.split(/[\\/]/).pop()}
                </Button>
                <span>{p.description}</span>
                <Button
                  size="small"
                  type="text"
                  onClick={() =>
                    setConfig({ ...config, components: config.components.filter((c: Row) => c.value !== p.file) })
                  }
                >
                  停用
                </Button>
              </Space>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {active.length ? active.join('、') : '尚未启用政策组件'}
          </Typography.Text>
        )}
        <input
          ref={importRef}
          type="file"
          accept=".xml"
          hidden
          onChange={(e) => {
            void importPolicy(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {library && (
          <Space direction="vertical">
            <Space wrap>
              <Button onClick={() => setCreating(true)}>新建约束</Button>
              <Button onClick={() => importRef.current?.click()}>导入政策 XML</Button>
              <Input.Search
                style={{ width: 245 }}
                placeholder="搜索政策库，也可拖入 XML"
                allowClear
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button onClick={refreshPolicies}>刷新政策库</Button>
            </Space>
            <Table
              size="small"
              rowKey={(p) => p}
              dataSource={items}
              pagination={{ pageSize: 6 }}
              columns={[
                {
                  title: '政策库',
                  render: (_, p) => (
                    <Button type="link" onClick={() => open(p)}>
                      {p}
                    </Button>
                  ),
                },
                {
                  title: '启用',
                  render: (_, p) => (
                    <Switch aria-label={`启用 ${p}`} checked={active.includes(p)} onChange={(v) => toggle(p, v)} />
                  ),
                },
              ]}
            />
          </Space>
        )}
        <div>
          <Typography.Text strong>人口与经济</Typography.Text>　
          <Space wrap>
            {['设定人口', '设定 GDP'].map((g) => (
              <Button key={g} onClick={() => showGroup(g)}>
                {g}
              </Button>
            ))}
            <Link to="/parameter-table?file=gcam-china%2FPopulation_Growth_Rates.csv">修改人口增长假设</Link>
            <Link to={'/parameter-table?file=' + encodeURIComponent(growthFile)}>修改 GDP 假设</Link>
          </Space>
        </div>
        <div>
          <Typography.Text strong>排放与气候</Typography.Text>　
          <Space>
            {['排放与碳价', '全球气候目标'].map((g) => (
              <Button key={g} onClick={() => showGroup(g)}>
                {g}
              </Button>
            ))}
          </Space>
        </div>
        <div>
          <Typography.Text strong>能源技术</Typography.Text>　
          <Space>
            {['技术成本', '技术效率', '发电占比'].map((g) => (
              <Button key={g} onClick={() => showGroup(g)}>
                {g}
              </Button>
            ))}
          </Space>
        </div>
        {group && (
          <div>
            <h3>{group}</h3>
            <ParameterGrid
              key={group + selectedSource}
              pid={id}
              group={group}
              initialSource={selectedSource}
              links
            />
          </div>
        )}
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
      </Space>
    </section>
  )
}
