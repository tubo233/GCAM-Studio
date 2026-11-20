import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Tag, Typography } from 'antd'
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
    <div style={{ padding: '4px 12px' }}>
      {error ||
        (!data ? (
          '读取改动…'
        ) : (
          <>
            {!data.rows.length && '文件内容或结构已变更'}
            {data.rows.map((r, i) => (
              <div key={i}>
                {locationLabel(r)}　{r.before ?? '—'} → {r.after ?? '—'} {r.unit}
              </div>
            ))}
            <Space>
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
export default function InputChanges({ pid }: { pid: string }) {
  const version = useInputVersion()
  const [data, setData] = useState<Report>()
  const [job, setJob] = useState('')
  const [starting, setStarting] = useState(false)
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
  const [error, setError] = useState('')
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
  return (
    <Card
      size="small"
      title="相比上次运行"
      extra={
        <Button size="small" type="text" onClick={changed}>
          刷新
        </Button>
      }
      style={{ margin: '12px 0' }}
    >
      {error && <Alert type="warning" message={error} />}
      {data ? (
        <>
          {data.reference && (
            <Typography.Text type="secondary">
              {new Date(data.reference.model_started_at || data.reference.created_at).toLocaleString()} ·{' '}
              {data.reference.run_id} ·{' '}
              {(
                {
                  success: '成功',
                  failed: '失败',
                  running: '运行中',
                  cancelled: '已取消',
                  interrupted: '已中断',
                } as Record<string, string>
              )[data.reference.status] || data.reference.status}
            </Typography.Text>
          )}
          {data.pending && (
            <div>
              源数据待生成 XML。{' '}
              <Button size="small" loading={starting || !!job} onClick={build}>
                生成并查看派生值
              </Button>
            </div>
          )}
          {!data.recorded ? (
            <>
              <div>{data.reference ? '上次值未记录' : '此情景尚无实际运行记录'}</div>
              {Object.entries(data.policy_summaries || {}).map(([k, v]) => (
                <div key={k}>
                  {filename(k)}　{v}
                </div>
              ))}
              {!!data.custom?.length && <div>当前自定义输入 · {data.custom.join('、')}</div>}
              <details>
                <summary>当前启用的输入（{data.sources.length}）</summary>
                {data.sources.map((s) => (
                  <div key={s}>{s}</div>
                ))}
              </details>
            </>
          ) : (
            <>
              {!data.changes.length && <div>已保存输入与上次运行相同</div>}
              {data.changes.map((c) => (
                <ChangeLine key={c.source} pid={pid} c={c} version={version} />
              ))}
            </>
          )}
        </>
      ) : (
        !error && '正在读取情景…'
      )}
    </Card>
  )
}
function ChangeLine({ pid, c, version }: { pid: string; c: Change; version: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 5 }}>
      <Tag>{c.type}</Tag>
      {['配置', '调整'].includes(c.type) ? (
        <>
          {c.source}　{c.before || '—'} → {c.after || '—'}
        </>
      ) : (
        <Button type="link" title={c.source} size="small" onClick={() => setOpen((v) => !v)}>
          {filename(c.source)}　
          {c.single
            ? `${locationLabel(c.single)}　${c.single.before ?? '—'} → ${c.single.after ?? '—'}`
            : c.summary}{' '}
          {open ? '收起' : '查看改动'}
        </Button>
      )}
      {open && <Details key={`${version}/${c.source}`} pid={pid} source={c.source} />}
    </div>
  )
}
