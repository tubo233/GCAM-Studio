import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography, message } from 'antd'
import { CheckCircleOutlined, ReloadOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons'
import Editor from '@monaco-editor/react'
import { apiGet, apiPut, apiPost } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { XmlItem } from '../types'

const { Title, Text } = Typography

export default function XmlBrowser({ kindFilter, pageTitle, pageSub }: { kindFilter?: string; pageTitle?: string; pageSub?: string }) {
  const { activeId } = useProfiles()
  const [items, setItems] = useState<XmlItem[]>([])
  const [selected, setSelected] = useState<XmlItem | null>(null)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState(kindFilter || '')
  const [category, setCategory] = useState('')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tooLarge, setTooLarge] = useState(false)
  const [loadedKey, setLoadedKey] = useState('')
  const ready = !!selected && loadedKey === `${activeId}:${selected.id}`

  const load = async () => {
    const list = await apiGet<XmlItem[]>('/api/catalog/xml', { profile_id: activeId || undefined })
    setItems(list)
    if (!selected || !list.some((item) => item.id === selected.id)) {
      setSelected(list.find((item) => !kindFilter || item.kind === kindFilter) || null)
    }
  }

  useEffect(() => { load() }, [activeId])

  const categories = useMemo(() => Array.from(new Set(items.filter((i) => !kind || i.kind === kind).map((i) => i.category))), [items, kind])

  const filtered = useMemo(() => {
    let list = items
    if (kind) list = list.filter((i) => i.kind === kind)
    if (category) list = list.filter((i) => i.category === category)
    if (search.trim()) {
      const s = search.toLowerCase()
      list = list.filter((i) => i.name.toLowerCase().includes(s) || (i.scenario_name || '').toLowerCase().includes(s))
    }
    return list
  }, [items, kind, category, search])

  useEffect(() => {
    let cancelled = false
    setLoadedKey('')
    setText('')
    if (!selected || !activeId) { setLoading(false); return }
    setTooLarge(selected.size > 8 * 1024 * 1024)
    setDirty(false)
    if (selected.size > 8 * 1024 * 1024) {
      setText('')
      setLoading(false)
      return
    }
    setLoading(true)
    apiGet<any>('/api/xml/content', { profile_id: activeId, kind: selected.kind, path: selected.path })
      .then((r) => { if (!cancelled) { setText(r.text); setLoadedKey(`${activeId}:${selected.id}`) } })
      .catch(() => { if (!cancelled) message.error('无法加载 XML 文件') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selected, activeId])

  const save = async () => {
    if (!selected || !activeId) return message.warning('请先选择 Profile')
    if (loading || !ready) return message.warning('请等待文件加载完成')
    setSaving(true)
    try {
      const r = await apiPut<any>('/api/xml/content', { profile_id: activeId, kind: selected.kind, path: selected.path, text })
      if (r.valid) message.success('已保存并写入 Profile 覆盖层')
      else message.warning('已保存，但 XML 格式有误：' + r.error)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const validate = async () => {
    const r = await apiPost<any>('/api/xml/validate', { text })
    if (r.valid) message.success('XML 格式正确')
    else message.error('XML 格式错误：' + r.error)
  }

  return (
    <div>
      <Title level={3} className="page-title">{pageTitle || '情景组件 XML'}</Title>
      <p className="page-sub">{pageSub || '304 个 gcamdata 情景组件 + 57 个政策 + 5 个额外组件；修改后存入当前 Profile。'}</p>

      {!activeId && <Alert type="warning" showIcon message="请先在顶部选择一个参数环境（Profile）" style={{ marginBottom: 16 }} />}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Card style={{ width: 420, flex: '0 0 420px' }} bodyStyle={{ padding: 12 }}>
          <Space style={{ marginBottom: 10 }} wrap>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索文件名 / scenario"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 200 }}
            />
            {!kindFilter && (
              <Select
                style={{ width: 120 }}
                value={kind || undefined}
                placeholder="全部类型"
                allowClear
                onChange={setKind}
                options={[{ value: 'xml', label: 'gcamdata' }, { value: 'policy', label: '政策' }, { value: 'extra', label: '额外' }]}
              />
            )}
            <Select
              style={{ width: 150 }}
              value={category || undefined}
              placeholder="全部分类"
              allowClear
              onChange={setCategory}
              options={categories.map((c) => ({ value: c, label: c }))}
            />
          </Space>
          <div style={{ maxHeight: 'calc(100vh - 240px)', overflow: 'auto' }}>
            <Table
              size="small"
              rowKey="id"
              dataSource={filtered}
              pagination={{ pageSize: 20, size: 'small', showSizeChanger: false }}
              onRow={(r) => ({ onClick: () => { if (!saving) setSelected(r) }, style: { cursor: 'pointer' } })}
              rowClassName={(r) => (selected?.id === r.id ? 'ant-table-row-selected' : '')}
              columns={[
                { title: '文件', dataIndex: 'name', ellipsis: true },
                { title: '分类', dataIndex: 'category', width: 100, render: (v) => <Tag>{v}</Tag> },
              ]}
            />
          </div>
        </Card>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card
            title={selected ? <Space><Text strong>{selected.name}</Text><Tag>{selected.category}</Tag>{selected.scenario_name && <Tag color="blue">scenario: {selected.scenario_name}</Tag>}</Space> : '选择 XML'}
            extra={
              <Space>
                <Button icon={<CheckCircleOutlined />} onClick={validate} disabled={tooLarge || !text}>校验</Button>
                <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save} disabled={tooLarge || !dirty || loading || !ready}>保存</Button>
                <Button icon={<ReloadOutlined />} onClick={load}>刷新列表</Button>
              </Space>
            }
          >
            {tooLarge ? (
              <Alert type="warning" showIcon message="该 XML 文件超过 8 MB，浏览器编辑器不适合打开。" description="请使用外部编辑器或通过数据文件页下载查看；保存时可用替换文件方式。" />
            ) : (
              <Editor
                height="calc(100vh - 300px)"
                language="xml"
                value={text}
                loading={loading ? '加载中…' : undefined}
                onChange={(v) => { if (ready && !loading && !saving) { setText(v || ''); setDirty(true) } }}
                options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'off', scrollBeyondLastLine: false, automaticLayout: true, editContext: false, readOnly: loading || !ready || saving }}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
