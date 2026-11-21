import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Tag, Typography } from 'antd'
import { DownOutlined, ReloadOutlined, UpOutlined } from '@ant-design/icons'
import { apiGet, apiPost } from '../api'

export const changed = () => window.dispatchEvent(new Event('scenario-input-saved'))
export const filename = (s: string) => s.split(/[\\/]/).pop() || s
export const failure = (e: any) => e.response?.data?.detail || e.message || '读取失败'
export const locationLabel = (r: any) =>
  [
    r.region === 'SC' ? '四川 (SC)' : r.region === 'CQ' ? '重庆 (CQ)' : r.region,
    r.market && `市场 ${r.market}`,
    r.sector,
    r.technology,
    r.input,
    r.policy,
    r.year,
    r.label,
  ]
    .filter(Boolean)
    .join(' · ')

export function useInputVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const update = () => setVersion((v) => v + 1)
    window.addEventListener('scenario-input-saved', update)
    window.addEventListener('focus', update)
    return () => {
      window.removeEventListener('scenario-input-saved', update)
      window.removeEventListener('focus', update)
    }
  }, [])
  return version
}

type Change = { single?: any; summary?: string; source: string; type: string; before?: string; after?: string }
type Report = {
  changes: Change[]
  reference: { run_id: string; status: string; created_at: string; model_started_at?: string } | null
  recorded: boolean
  custom?: string[]
  sources: string[]
  policy_summaries?: Record<string, string>
  pending?: boolean
}

const CHANGE_TAG_COLORS: Record<string, string> = {
  新增: 'green',
  修改: 'orange',
  停用: 'red',
  配置: 'blue',
  调整: 'purple',
}

const STATUS_TEXT: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '运行中',
  cancelled: '已取消',
  interrupted: '已中断',
}

function Details({ pid, source }: { pid: string; source: string }) {
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ rows: any[]; more: boolean }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setData(undefined)
    setError('')
    apiGet(`/api/profiles/${pid}/input-changes/detail`, { source, offset, limit: 30 })
      .then((v) => {
        if (live) setData(v)
      })
      .catch((e) => {
        if (live) setError(failure(e))
      })
    return () => {
      live = false
    }
  }, [pid, source, offset])
  return (
    <div style={{ padding: '6px 12px', background: '#f8fafc', borderRadius: 6, marginTop: 4 }}>
      {error ||
        (!data ? (
          <span className="muted">读取改动明细…</span>
        ) : (
          <>
            {!data.rows.length && <span className="muted">文件内容或结构已变更</span>}
            {data.rows.map((r, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.7 }}>
                {locationLabel(r)}　{r.before ?? '—'} → {r.after ?? '—'} {r.unit}
              </div>
            ))}
            <Space style={{ marginTop: 4 }}>
              {offset > 0 && (
                <Button size="small" onClick={() => setOffset(offset - 30)}>
                  上一页
                </Button>
              )}
              {data.more && (
                <Button size="small" onClick={() => setOffset(offset + 30)}>
                  下一页
                </Button>
              )}
            </Space>
          </>
        ))}
    </div>
  )
}

function ChangeLine({ pid, c, version }: { pid: string; c: Change; version: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 6 }}>
      <Tag color={CHANGE_TAG_COLORS[c.type] || 'default'}>{c.type}</Tag>
      {['配置', '调整'].includes(c.type) ? (
        <span style={{ fontSize: 13 }}>
          {c.source}　<Typography.Text type="secondary">{c.before || '—'} → {c.after || '—'}</Typography.Text>
        </span>
      ) : (
        <Button type="link" title={c.source} size="small" style={{ paddingInline: 4 }} onClick={() => setOpen((v) => !v)}>
          {filename(c.source)}　
          {c.single
            ? `${locationLabel(c.single)}　${c.single.before ?? '—'} → ${c.single.after ?? '—'}`
            : c.summary}{' '}
          ({open ? '收起' : '查看改动'})
        </Button>
      )}
      {open && <Details key={`${version}/${c.source}`} pid={pid} source={c.source} />}
    </div>
  )
}

export default function InputChanges({
  pid,
  defaultExpanded = false,
  title = '相比上次运行',
}: {
  pid: string
  defaultExpanded?: boolean
  title?: string
}) {
  const version = useInputVersion()
  const [data, setData] = useState<Report>()
  const [job, setJob] = useState('')
  const [starting, setStarting] = useState(false)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showSources, setShowSources] = useState(false)
  const [error, setError] = useState('')

  const build = async () => {
    setStarting(true)
    try {
      const r = await apiPost(`/api/profiles/${pid}/build`)
      setJob(r.id)
    } catch (e) {
      setError(failure(e))
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (!job) return
    let live = true
    const timer = setInterval(async () => {
      try {
        const r = await apiGet(`/api/jobs/${job}`)
        if (live && ['success', 'failed', 'cancelled'].includes(r.status)) {
          setJob('')
          if (r.status === 'success') changed()
          else setError(r.error || '生成失败')
        }
      } catch (e) {
        if (live) {
          setJob('')
          setError(failure(e))
        }
      }
    }, 3000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [job])

  useEffect(() => {
    let live = true
    setError('')
    apiGet(`/api/profiles/${pid}/input-changes`)
      .then((v) => {
        if (live) setData(v)
      })
      .catch((e) => {
        if (live) setError(failure(e))
      })
    return () => {
      live = false
    }
  }, [pid, version])

  const renderStatusBadge = () => {
    if (error) return <Tag color="red">读取失败</Tag>
    if (!data) return <Tag>读取中…</Tag>
    if (!data.recorded) {
      return data.reference ? <Tag>上次值未记录</Tag> : <Tag color="blue">尚无实际运行记录</Tag>
    }
    if (!data.changes.length) return <Tag color="green">与上次运行一致</Tag>
    return <Tag color="orange">共 {data.changes.length} 项改动</Tag>
  }

  const refSummary = data?.reference
    ? `${new Date(data.reference.model_started_at || data.reference.created_at).toLocaleString()} · ${data.reference.run_id} · ${
        STATUS_TEXT[data.reference.status] || data.reference.status
      }`
    : ''

  if (!expanded) {
    return (
      <div className="change-bar">
        <Space wrap size={8}>
          <Typography.Text strong style={{ fontSize: 13 }}>{title}</Typography.Text>
          {renderStatusBadge()}
          {refSummary && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{refSummary}</Typography.Text>}
          {data?.pending && (
            <>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>CSV 已改，待生成 XML</Tag>
              <Button size="small" type="primary" ghost loading={starting || !!job} onClick={build}>
                生成并查看派生值
              </Button>
            </>
          )}
          {error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{error}</Typography.Text>}
        </Space>
        <Space size={6}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={changed}>
            刷新
          </Button>
          <Button size="small" icon={<DownOutlined />} onClick={() => setExpanded(true)}>
            展开明细
          </Button>
        </Space>
      </div>
    )
  }

  return (
    <Card
      size="small"
      title={
        <Space wrap size={8}>
          <span>{title}</span>
          {renderStatusBadge()}
        </Space>
      }
      extra={
        <Space size={6}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={changed}>
            刷新
          </Button>
          <Button size="small" icon={<UpOutlined />} onClick={() => setExpanded(false)}>
            收起
          </Button>
        </Space>
      }
      style={{ margin: '10px 0 14px' }}
    >
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 8 }} />}
      {data ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {data.reference && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              对照基准：{refSummary}
            </Typography.Text>
          )}
          {data.pending && (
            <Alert
              type="warning"
              showIcon
              message="底层源数据（CSV）已修改，尚未通过 R 重新生成派生 XML。"
              action={
                <Button size="small" type="primary" loading={starting || !!job} onClick={build}>
                  生成并查看派生值
                </Button>
              }
            />
          )}
          {!data.recorded ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {data.reference
                  ? '该运行记录缺少输入快照，以下列出当前生效的政策与自定义文件。'
                  : '此情景尚未启动过模型运行，首次运行后将自动保存输入快照作为对照基准。'}
              </Typography.Text>
              {Object.entries(data.policy_summaries || {}).map(([k, v]) => (
                <div key={k} style={{ fontSize: 13 }}>
                  <Tag color="blue">政策</Tag>
                  <Typography.Text strong>{filename(k)}</Typography.Text>　{v}
                </div>
              ))}
              {!!data.custom?.length && (
                <div style={{ fontSize: 13 }}>
                  <Tag color="orange">自定义输入</Tag>
                  {data.custom.join('、')}
                </div>
              )}
              <div>
                <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => setShowSources((v) => !v)}>
                  {showSources ? '收起' : '查看'}当前启用的输入文件（{data.sources.length} 个）
                </Button>
                {showSources && (
                  <div style={{ maxHeight: 180, overflow: 'auto', background: '#f8fafc', padding: 8, borderRadius: 6, fontSize: 12 }}>
                    {data.sources.map((s) => (
                      <div key={s}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {!data.changes.length && (
                <Typography.Text type="secondary">当前保存的配置与输入数据和上次运行完全一致。</Typography.Text>
              )}
              {data.changes.map((c) => (
                <ChangeLine key={c.source} pid={pid} c={c} version={version} />
              ))}
            </>
          )}
        </Space>
      ) : (
        !error && <span className="muted">正在读取情景对照…</span>
      )}
    </Card>
  )
}
