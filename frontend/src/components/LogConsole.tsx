import React, { useEffect, useRef, useState } from 'react'
import { Tag } from 'antd'

export default function LogConsole({ jobId, height = 360 }: { jobId?: string; height?: number }) {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const boxRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setLines([])
    setStatus('')
    if (!jobId) return
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    let latestId = -1
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        const id = Number(e.lastEventId)
        if (d.line && (!e.lastEventId || id > latestId)) {
          latestId = id
          setLines((prev) => [...prev, d.line].slice(-12000))
        }
        if (d.status) setStatus(d.status)
      } catch {}
    }
    es.addEventListener('done', (e: any) => {
      try {
        const d = JSON.parse(e.data)
        setStatus(d.status)
      } catch {}
      es.close()
    })
    es.onerror = () => {
      setStatus((prev) => ['success', 'failed', 'cancelled'].includes(prev) ? prev : '重新连接日志…')
    }
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`)
        if (!response.ok) return
        const { data } = await response.json()
        if (['success', 'failed', 'cancelled'].includes(data.status)) {
          setStatus(data.status)
          setLines(data.logs || [])
          es.close()
        }
      } catch {}
    }, 5000)
    return () => { es.close(); clearInterval(poll) }
  }, [jobId])

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        状态：<Tag color={status === 'success' ? 'green' : status === 'failed' ? 'red' : 'blue'}>{status || '等待中'}</Tag>
      </div>
      <pre ref={boxRef} className="code-box" style={{ height }}>
        {lines.length ? lines.join('\n') : '等待日志…'}
      </pre>
    </div>
  )
}
