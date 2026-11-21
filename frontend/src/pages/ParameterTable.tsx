import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Input, Modal, Select, Space, Table, Tabs, Tag, Tooltip, message } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPut } from '../api'
import { useProfiles } from '../context/ProfileContext'
import InputChanges, {
  changed,
  failure,
  filename,
  locationLabel,
  useInputVersion,
} from '../components/InputChanges'
import PolicyFileEditor, { type PolicyDraft } from '../components/PolicyFileEditor'
import DataFiles from './DataFiles'

export const fieldGroups: Record<string, string> = {
  设定人口: 'totalPop',
  '设定 GDP': 'GDP',
  排放与碳价: 'constraint,fixedTax',
  全球气候目标: 'target-value,target-type,tax-name,first-tax-year',
  技术成本: 'capital-overnight,OM-fixed,OM-var,input-cost',
  技术效率: 'efficiency',
  发电占比: 'share-of-sector-output',
}
type Row = {
  id: string
  field: string
  label: string
  value: string
  original: string
  specified: boolean
  unit?: string
  [k: string]: any
}
const regionLabel = (r?: string) => (r === 'SC' ? '四川 (SC)' : r === 'CQ' ? '重庆 (CQ)' : r)

export function ParameterGrid({
  pid,
  group = '',
  initialSource = '',
  initialQuery = '',
  onExpandFull,
}: {
  pid: string
  group?: string
  initialSource?: string
  initialQuery?: string
  onExpandFull?: (params: { source: string; query: string; group: string }) => void
}) {
  const [sources, setSources] = useState<string[]>([])
  const [source, setSource] = useState(initialSource)
  const [query, setQuery] = useState(initialQuery)
  const [draft, setDraft] = useState(initialQuery)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ rows: Row[]; more: boolean; overrides: number }>()
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<React.Key[]>([])
  const [editing, setEditing] = useState<Row[]>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const scanId = useRef(0)
  const [matches, setMatches] = useState<string[]>([])
  const [scanning, setScanning] = useState('')
  const [scanError, setScanError] = useState('')
  useEffect(() => {
    setOffset(0)
    setScanning('')
    setMatches([])
    setScanError('')
    return () => {
      ++scanId.current
    }
  }, [pid, group])
  useEffect(() => {
    setSource(initialSource)
    setOffset(0)
  }, [initialSource])
  useEffect(() => {
    setQuery(initialQuery)
    setDraft(initialQuery)
    setOffset(0)
  }, [initialQuery])
  const across = async () => {
    const id = ++scanId.current
    setMatches([])
    setScanError('')
    const q = draft.trim()
    for (const file of sources) {
      if (id !== scanId.current) return
      setScanning(filename(file))
      try {
        const result = await apiGet(`/api/profiles/${pid}/parameter-rows`, {
          source: file,
          query: q,
          fields: fieldGroups[group] || '',
          limit: 1,
        })
        if (id !== scanId.current) return
        if (result.rows.length) setMatches((prev) => [...prev, file])
      } catch (e) {
        if (id === scanId.current) setScanError(`${filename(file)} · ${failure(e)}`)
      }
    }
    if (id === scanId.current) setScanning('已查完')
  }
  const openMatch = (s: string) => {
    ++scanId.current
    setScanning('')
    setMatches([])
    setOffset(0)
    setQuery(draft.trim())
    setSource(s)
  }
  const [xml, setXml] = useState<PolicyDraft | null>(null)
  const version = useInputVersion()
  useEffect(() => {
    let live = true
    apiGet(`/api/profiles/${pid}/parameter-sources`, { fields: fieldGroups[group] || '' })
      .then((v: string[]) => {
        if (live) {
          setSources(v)
          setSource((s) => (v.includes(s) ? s : v[0] || ''))
        }
      })
      .catch((e) => {
        if (live) setError(failure(e))
      })
    return () => {
      live = false
    }
  }, [pid, group, version])
  useEffect(() => {
    let live = true
    setData(undefined)
    setSelection([])
    setError('')
    if (source)
      apiGet(`/api/profiles/${pid}/parameter-rows`, {
        source,
        query,
        fields: fieldGroups[group] || '',
        offset,
        limit: 30,
      })
        .then((v) => {
          if (live) setData(v)
        })
        .catch((e) => {
          if (live) setError(failure(e))
        })
    return () => {
      live = false
    }
  }, [pid, source, group, query, offset, version])
  const start = (r: Row[]) => {
    setEditing(r)
    setValue(r.length === 1 ? r[0].value : '')
  }
  const write = async (rows: Row[], v: string | null) => {
    setBusy(true)
    try {
      await apiPut(`/api/profiles/${pid}/parameter-rows`, {
        source,
        updates: rows.map((r) => ({ id: r.id, before: r.value, value: v })),
      })
      setEditing([])
      changed()
      message.success('已保存到当前情景')
    } catch (e) {
      message.error(failure(e))
    } finally {
      setBusy(false)
    }
  }
  const raw = async () => {
    try {
      const v = await apiGet(`/api/profiles/${pid}/parameter-source`, { source })
      setXml({ path: v.path, kind: v.kind, text: v.text, source: v.source, overlay: v.overlay })
    } catch (e) {
      message.error(failure(e))
    }
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Select
          aria-label="参数来源"
          showSearch
          placeholder="选择来源文件"
          style={{ width: 330 }}
          value={source || undefined}
          options={sources.map((s) => ({ value: s, label: filename(s), title: s }))}
          optionFilterProp="label"
          onChange={(s) => {
            setOffset(0)
            setSource(s)
          }}
        />
        <Input.Search
          aria-label="筛选参数"
          placeholder="地区、年份、技术、市场或参数"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onSearch={(q) => {
            setQuery(q)
            setOffset(0)
          }}
          allowClear
          style={{ width: 270 }}
        />
        <Button disabled={!draft.trim()} onClick={across}>
          跨文件查找
        </Button>
        {source && <Button onClick={raw}>查看源 XML</Button>}
        {onExpandFull && (
          <Button type="link" onClick={() => onExpandFull({ source, query, group })}>
            在 ③ 参数与数据中展开完整视图 →
          </Button>
        )}
      </Space>
      {scanning && (
        <Space wrap>
          <span>
            {scanning} · {matches.length} 个来源匹配
          </span>
          <Button
            size="small"
            onClick={() => {
              ++scanId.current
              setScanning('')
              setMatches([])
            }}
          >
            结束查找
          </Button>
          {matches.map((s) => (
            <Button key={s} size="small" onClick={() => openMatch(s)}>
              {filename(s)}
            </Button>
          ))}
        </Space>
      )}
      {scanError && <Alert type="warning" message={scanError} />}
      {error && <Alert type="warning" message={error} />}
      <Table
        size="small"
        rowKey="id"
        dataSource={data?.rows || []}
        loading={!!source && !data && !error}
        pagination={false}
        locale={{ emptyText: '当前筛选下没有参数' }}
        rowSelection={{ selectedRowKeys: selection, onChange: setSelection }}
        columns={[
          {
            title: '地区 / 市场',
            render: (_, r) => [regionLabel(r.region), r.market && `市场 ${r.market}`].filter(Boolean).join(' · ') || '—',
          },
          {
            title: '部门 / 技术 / 政策',
            render: (_, r) => [r.sector, r.technology, r.input, r.policy].filter(Boolean).join(' · ') || '—',
          },
          { title: '参数', dataIndex: 'label' },
          { title: '年份', dataIndex: 'year' },
          {
            title: '当前值',
            render: (_, r) => (
              <Space size={4} wrap>
                <span>
                  {r.value} {r.unit || ''}
                </span>
                {r.specified && (
                  <Tooltip title={`原值：${r.original ?? '—'}`}>
                    <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                      已指定
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            title: '',
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => start([r])}>
                  编辑
                </Button>
                {r.specified && (
                  <Button size="small" onClick={() => write([r], null)}>
                    随源数据更新
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Space wrap>
        {!!data?.overrides && (
          <Button
            onClick={() =>
              Modal.confirm({
                title: `清除 ${filename(source)} 的 ${data.overrides} 项指定值？`,
                okText: '恢复随源数据更新',
                onOk: async () => {
                  await apiPut(`/api/profiles/${pid}/parameter-rows`, { source, clear: true })
                  changed()
                },
              })
            }
          >
            清除此文件指定值
          </Button>
        )}
        <Button
          disabled={!selection.length}
          onClick={() => start((data?.rows || []).filter((r) => selection.includes(r.id)))}
        >
          修改所选 {selection.length || ''} 项
        </Button>
        <Button disabled={!offset} onClick={() => setOffset(offset - 30)}>
          上一页
        </Button>
        <Button disabled={!data?.more} onClick={() => setOffset(offset + 30)}>
          下一页
        </Button>
      </Space>
      <Modal
        open={editing.length > 0}
        title={editing.length === 1 ? locationLabel(editing[0]) : `批量修改 ${editing.length} 项`}
        onCancel={() => setEditing([])}
        confirmLoading={busy}
        onOk={() => write(editing, value)}
        okText="保存指定值"
        okButtonProps={{ disabled: !value.trim() }}
      >
        <Input aria-label="指定值" value={value} onChange={(e) => setValue(e.target.value)} />
      </Modal>
      {xml && (
        <PolicyFileEditor
          profileId={pid}
          file={xml}
          close={() => setXml(null)}
          saved={async () => {
            setXml(null)
            changed()
          }}
          rawSource={source}
        />
      )}
    </Space>
  )
}
export default function ParameterTable() {
  const { activeId } = useProfiles()
  const [params] = useSearchParams()
  return activeId ? (
    <div key={activeId}>
      <h2>统一参数表</h2>
      <InputChanges pid={activeId} />
      <Card>
        <Tabs
          defaultActiveKey={params.has('file') ? 'csv' : 'xml'}
          items={[
            {
              key: 'xml',
              label: '当前模型参数',
              children: (
                <ParameterGrid
                  pid={activeId}
                  group={params.get('group') || ''}
                  initialSource={params.get('source') || ''}
                  initialQuery={params.get('query') || ''}
                />
              ),
            },
            { key: 'csv', label: '源数据表', children: <DataFiles /> },
          ]}
        />
      </Card>
    </div>
  ) : (
    <Alert message="请先选择情景" />
  )
}
