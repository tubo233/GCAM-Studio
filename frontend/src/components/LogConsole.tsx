import React, { useEffect, useRef, useState } from 'react'
import { Tag } from 'antd'

const statusNames: Record<string, string> = { queued: '排队中', running: '运行中', success: '已完成', failed: '失败', cancelled: '已取消' }

export default function LogConsole({
  jobId,
  height = 360,
  onStatusChange,
}: {
  jobId?: string
  height?: number
  onStatusChange?: (status: string) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const boxRef = useRef<HTMLPreElement>(null)
  const onStatusRef = useRef(onStatusChange)
  onStatusRef.current = onStatusChange

  const updateStatus = (next: string) => {
    setStatus(next)
    if (next) onStatusRef.current?.(next)
  }

  useEffect(() => {
    setLines([])
    setStatus('')
    if (!jobId) return
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    const controller = new AbortController()
    let checking = false
    const stop = () => {
      controller.abort()
      es.close()
      clearInterval(poll)
    }
    let latestId = -1
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        const id = Number(e.lastEventId)
        if (d.line && (!e.lastEventId || id > latestId)) {
          latestId = id
          setLines((prev) => [...prev, d.line].slice(-12000))
        }
        if (d.status) updateStatus(d.status)
      } catch {}
    }
    es.addEventListener('done', (e: any) => {
      try {
        const d = JSON.parse(e.data)
        updateStatus(d.status)
      } catch {}
      stop()
    })
    es.onerror = () => {
      setStatus((prev) => (['success', 'failed', 'cancelled'].includes(prev) ? prev : '重新连接日志…'))
    }
    const poll = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        const options = { signal: controller.signal }
        const response = await fetch(`/api/jobs/${jobId}?include_logs=false`, options)
        if (controller.signal.aborted) return
        if (response.status === 404) {
          setStatus('任务已不在队列，请查看运行历史')
          stop()
          return
        }
        if (!response.ok) return
        const { data } = await response.json()
        if (controller.signal.aborted) return
        if (['success', 'failed', 'cancelled'].includes(data.status)) {
          const history = await fetch(`/api/jobs/${jobId}`, options)
          if (!history.ok) return
          const { data: final } = await history.json()
          if (controller.signal.aborted) return
          setLines((final.logs || []).slice(-12000))
          updateStatus(data.status)
          stop()
        } else if (es.readyState === EventSource.OPEN) {
          updateStatus(data.status)
        }
      } catch {
      } finally {
        checking = false
      }
    }, 5000)
    return stop
  }, [jobId])

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        状态：
        <Tag color={status === 'success' ? 'green' : status === 'failed' ? 'red' : 'blue'}>
          {statusNames[status] || status || '等待中'}
        </Tag>
      </div>
      <pre ref={boxRef} className="code-box" style={{ height }}>
        {lines.length ? lines.join('\n') : '等待日志…'}
      </pre>
    </div>
  )
}
