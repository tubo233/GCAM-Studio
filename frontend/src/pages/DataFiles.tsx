import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Drawer, Empty, Input, InputNumber, List, Modal, Radio, Select, Space, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import { DownloadOutlined, EditOutlined, ReloadOutlined, SearchOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons'
import { apiGet, apiPatch, apiPost, fmtSize } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { CatalogFile, FileInfo } from '../types'

const { Title, Text } = Typography

type DataContext = { key: string; profileId: string; path: string; page: number; pageSize: number }

function EditableCell({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  const committed = useRef(false)
  useEffect(() => setV(value), [value])
  if (!editing) {
    return (
      <div className="editable-cell" onDoubleClick={() => { if (!disabled) { committed.current = false; setV(value); setEditing(true) } }} title="双击编辑">
        {value}
      </div>
    )
  }
  const save = () => {
    if (committed.current || disabled) return
    committed.current = true
    setEditing(false)
    if (v !== value) onSave(v)
  }
  return (
    <Input
      size="small"
      disabled={disabled}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onPressEnter={save}
    />
  )
}

export default function DataFiles() {
  const { activeId, active } = useProfiles()
  const initialParams = new URLSearchParams(window.location.search)
  const initialModule = initialParams.get('module') || ''
  const initialFile = initialParams.get('file') || ''
  const initialSearch = initialParams.get('search') || ''
  const [files, setFiles] = useState<CatalogFile[]>([])
  const [module, setModule] = useState(initialModule)
  const [search, setSearch] = useState(initialSearch)
  const [selected, setSelected] = useState<CatalogFile | null>(null)
  const [info, setInfo] = useState<FileInfo | null>(null)
  const [rows, setRows] = useState<string[][]>([])
  const [rowIds, setRowIds] = useState<number[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(80)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [diffOpen, setDiffOpen] = useState(false)
  const [diff, setDiff] = useState<any[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkCol, setBulkCol] = useState('')
  const [bulkOp, setBulkOp] = useState('scale')
  const [bulkValue, setBulkValue] = useState(1.1)
  const [dirty, setDirty] = useState(0)
  const [revision, setRevision] = useState(0)
  const [rowSearch, setRowSearch] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [yearColumn, setYearColumn] = useState<string>()
  const [loaded, setLoaded] = useState<DataContext | null>(null)
  const [writing, setWriting] = useState(false)
  const writingRef = useRef(false)
  const generation = useRef(0)
  const contextKey = JSON.stringify([activeId, selected?.path || '', page, pageSize, rowSearch])
  const currentContext = useRef(contextKey)
  currentContext.current = contextKey
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const ready = !!loaded && loaded.key === contextKey && !loading


  const loadFiles = async () => {
    const list = await apiGet<CatalogFile[]>('/api/catalog/files')
    setFiles(list)
    if (!selected && list.length) {
      setSelected(
        (initialFile ? list.find((f) => f.path === initialFile) : undefined) ||
          list.find((f) => f.path === 'gcam-china/population_thous_province.csv') ||
          list.find((f) => f.module === 'gcam-china' && f.rows > 0) ||
          list.find((f) => f.rows > 0) ||
          list[0],
      )
    }
  }

  useEffect(() => { loadFiles() }, [])

  const modules = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>()
    files.forEach((f) => {
      const cur = m.get(f.module) || { label: f.module_label, count: 0 }
      cur.count++
      m.set(f.module, cur)
    })
    return Array.from(m.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [files])

  const filtered = useMemo(() => {
    let list = files
    if (module) list = list.filter((f) => f.module === module)
    if (search.trim()) {
      const s = search.toLowerCase()
      list = list.filter((f) => f.path.toLowerCase().includes(s) || (f.title || '').toLowerCase().includes(s) || (f.columns || []).some((c) => c.toLowerCase().includes(s)))
    }
    return list
  }, [files, module, search])

  // A table is one immutable identity: profile, file and page. Never mix responses.
  useEffect(() => {
    setPage(1)
    setRowSearch('')
    setSearchDraft('')
    setYearColumn(undefined)
    setBulkOpen(false)
    setDiffOpen(false)
  }, [activeId, selected?.path])

  useEffect(() => {
    const request = ++generation.current
    let cancelled = false
    setLoaded(null)
    loadedRef.current = null
    setInfo(null)
    setRows([])
    setRowIds([])
    setTotal(0)
    setLoadError('')
    if (!activeId || !selected) { setLoading(false); return }
    const snapshot: DataContext = { key: contextKey, profileId: activeId, path: selected.path, page, pageSize }
    setLoading(true)
    const receive = (nextInfo: FileInfo, result: any) => {
      if (cancelled || generation.current !== request || currentContext.current !== snapshot.key) return
      setInfo(nextInfo)
      setRows(result.rows)
      setRowIds(result.row_ids)
      setTotal(result.total)
      setLoaded(snapshot)
      setLoading(false)
    }
    if (selected.file_type === 'xlsx') {
      receive({ kind: 'data', path: selected.path, resolved_path: selected.path, is_overlay: false,
        title: selected.title, units: '', description: '', columns: [], key_columns: [], year_columns: [],
        column_types: {}, long_format: false, rows: 0, size: selected.size, diff_count: 0 },
        { rows: [], row_ids: [], total: 0 })
      return () => { cancelled = true }
    }
    Promise.all([
      apiGet<FileInfo>('/api/files/info', { profile_id: snapshot.profileId, kind: 'data', path: snapshot.path }),
      apiGet<any>('/api/files/page', { profile_id: snapshot.profileId, kind: 'data', path: snapshot.path,
        offset: (snapshot.page - 1) * snapshot.pageSize, limit: snapshot.pageSize, search: rowSearch || undefined }),
    ]).then(([nextInfo, result]) => receive(nextInfo, result)).catch(() => {
      if (!cancelled && currentContext.current === snapshot.key) {
        setLoading(false)
        setLoadError('无法加载所选数据文件，请刷新重试')
        message.error('无法加载所选数据文件')
      }
    })
    return () => { cancelled = true }
  }, [activeId, selected?.path, page, pageSize, rowSearch, revision])

  const loadPage = (p = page, ps = pageSize) => {
    setPage(p)
    setPageSize(ps)
    setRevision((value) => value + 1)
  }

  const writeSnapshot = useCallback(async (snapshot: DataContext | null, action: () => Promise<any>, title: string) => {
    if (!snapshot || currentContext.current !== snapshot.key || loadedRef.current?.key !== snapshot.key || writingRef.current) return false
    writingRef.current = true
    setWriting(true)
    try {
      await action()
      if (currentContext.current === snapshot.key) {
        loadedRef.current = null
        setLoaded(null)
        setLoading(true)
        setDirty((value) => value + 1)
        setRevision((value) => value + 1)
        message.success({ content: title, duration: 1 })
      }
      return true
    } catch (error: any) {
      const detail = error?.response?.data?.detail
      message.error(typeof detail === 'string' ? detail : '保存失败，请查看运行任务或输入值')
      return false
    } finally {
      writingRef.current = false
      setWriting(false)
    }
  }, [])

  const saveCell = useCallback((snapshot: DataContext | null, rowId: number, column: string, value: string) => {
    if (!snapshot || !Number.isInteger(rowId)) return
    return writeSnapshot(snapshot, () => apiPatch('/api/files/cells', {
      profile_id: snapshot.profileId, kind: 'data', path: snapshot.path, edits: [{ row: rowId, column, value }],
    }), '已保存')
  }, [writeSnapshot])

  const openDiff = async () => {
    const snapshot = loaded
    if (!ready || !snapshot || writing) return
    const result = await apiGet<any[]>('/api/profiles/' + snapshot.profileId + '/diff', { kind: 'data', path: snapshot.path })
    if (currentContext.current === snapshot.key) { setDiff(result); setDiffOpen(true) }
  }

  const revert = async () => {
    const snapshot = loaded
    if (!ready || !snapshot) return
    const done = await writeSnapshot(snapshot, () => apiPost('/api/files/revert', {
      profile_id: snapshot.profileId, kind: 'data', path: snapshot.path,
    }), '已恢复到基线')
    if (done && currentContext.current === snapshot.key) setPage(1)
  }

  const runBulk = async () => {
    const snapshot = loaded
    if (!ready || !snapshot || !bulkCol) return
    const done = await writeSnapshot(snapshot, () => apiPost('/api/files/bulk', {
      profile_id: snapshot.profileId, kind: 'data', path: snapshot.path, operation: bulkOp, column: bulkCol,
      factor: bulkOp === 'scale' ? bulkValue : undefined, value: bulkOp === 'set' ? String(bulkValue) : undefined,
    }), '批量修改完成')
    if (done && currentContext.current === snapshot.key) setBulkOpen(false)
  }

  const columns = useMemo(() => {
    if (!info) return []
    const visible = yearColumn ? info.columns.filter(c => !info.year_columns.includes(c) || c === yearColumn) : info.columns
    return visible.map((c) => ({
      title: c,
      dataIndex: c,
      key: c,
      width: Math.max(110, Math.min(240, c.length * 12 + 40)),
      ellipsis: true,
      render: (_: any, __: any, idx: number) => {
        const colIdx = info.columns.indexOf(c)
        const value = rows[idx]?.[colIdx] ?? ''
        return <EditableCell key={`${contextKey}:${rowIds[idx]}:${c}`} disabled={!ready || writing} value={value} onSave={(v) => saveCell(loaded, rowIds[idx], c, v)} />
      },
    }))
  }, [info, rows, rowIds, loaded, ready, writing, contextKey, saveCell, yearColumn])

  const dataSource = rows.map((r, i) => ({ key: rowIds[i] ?? i, ...Object.fromEntries(info?.columns.map((c, j) => [c, r[j]] ) || []) }))

  return (
    <div>
      <Title level={3} className="page-title">数据文件</Title>
      <p className="page-sub">全部 1,123 个 gcamdata 输入文件；双击单元格编辑，改动只写入当前 Profile 的覆盖层。</p>

      {!activeId && <Alert type="warning" showIcon message="请先在顶部选择一个参数环境（Profile）" style={{ marginBottom: 16 }} />}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Card style={{ width: 340, flex: '0 0 340px' }} styles={{ body: { padding: 12 } }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索文件名 / 标题 / 列名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            style={{ marginBottom: 10 }}
          />
          <Select
            style={{ width: '100%', marginBottom: 10 }}
            value={module || undefined}
            placeholder="全部模块"
            allowClear
            onChange={setModule}
            options={modules.map(([id, m]) => ({ value: id, label: `${m.label} (${m.count})` }))}
          />
          <div className="split-list">
            <List
              size="small"
              dataSource={filtered}
              pagination={{ pageSize: 30, size: 'small', showSizeChanger: false }}
              renderItem={(f) => (
                <div
                  className={`file-row ${selected?.path === f.path ? 'active' : ''}`}
                  onClick={() => { if (!writingRef.current) setSelected(f) }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Text ellipsis style={{ maxWidth: 220 }}>{f.name}</Text>
                    <Tag style={{ marginInlineEnd: 0 }} color={f.file_type === 'xlsx' ? 'gold' : 'default'}>{f.file_type}</Tag>
                  </div>
                  <div className="muted" style={{ marginTop: 2 }}>{f.title || f.path}</div>
                  <div className="muted">{f.rows?.toLocaleString()} 行 · {fmtSize(f.size)}</div>
                </div>
              )}
            />
          </div>
        </Card>

        <div style={{ flex: 1, minWidth: 0 }}>
          {!selected ? (
            <Card><Empty description="选择左侧文件开始" /></Card>
          ) : (
            <Card
              title={<Space><Text strong>{selected.name}</Text><Tag>{selected.module_label}</Tag>{info?.is_overlay && <Tag color="orange">已修改</Tag>}</Space>}
              extra={
                <Space>
                  <Button icon={<ReloadOutlined />} disabled={writing || loading} onClick={() => loadPage(page, pageSize)}>刷新</Button>
                  <Button icon={<DownloadOutlined />} href={`/api/files/export?profile_id=${activeId}&kind=data&path=${encodeURIComponent(selected.path)}`}>导出</Button>
                  <Button icon={<EditOutlined />} onClick={() => { setBulkCol(info?.columns[0] || ''); setBulkOpen(true) }} disabled={!ready || writing || selected.file_type === 'xlsx'}>批量修改</Button>
                  <Button icon={<UndoOutlined />} onClick={revert} disabled={!ready || writing || !info?.is_overlay}>恢复基线</Button>
                </Space>
              }
            >
              {activeId && (!ready || loading) && <Alert type={loadError ? 'error' : 'info'} showIcon message={loadError || '正在读取所选数据，请等待加载完成'} />}
              {ready && info && (
                <>
                  <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
                    <Descriptions.Item label="标题" span={2}>{info.title || '-'}</Descriptions.Item>
                    <Descriptions.Item label="单位">{info.units || '-'}</Descriptions.Item>
                    <Descriptions.Item label="行数">{info.rows.toLocaleString()}</Descriptions.Item>
                    <Descriptions.Item label="列数">{info.columns.length}</Descriptions.Item>
                    <Descriptions.Item label="格式">{info.long_format ? '长表（year 列）' : '宽表（年份列）'}</Descriptions.Item>
                    <Descriptions.Item label="改动">{info.diff_count ? <a onClick={openDiff}>{info.diff_count} 处</a> : '无'}</Descriptions.Item>
                  </Descriptions>
                  <div className="muted" style={{ marginBottom: 10 }}>路径：{selected.path}</div>
                  {info.description && <Alert type="info" showIcon message={info.description} style={{ marginBottom: 12 }} />}
                  {selected.file_type === 'xlsx' ? (
                    <Alert type="warning" showIcon message="Excel 文件暂以原文件方式管理：可下载、替换，不支持表格内编辑。" />
                  ) : (
                    <>
                      <Space wrap style={{ marginBottom: 8 }}>
                        <Input.Search aria-label="筛选数据行" placeholder="搜地区、部门等行内容" style={{width:230}}
                          allowClear disabled={writing} value={searchDraft} onChange={e => setSearchDraft(e.target.value)}
                          onSearch={value => { setPage(1); setRowSearch(value.trim()) }}/>
                        {!!info.year_columns.length && <Select aria-label="显示年份" style={{width:150}} allowClear showSearch
                          placeholder="显示全部年份" value={yearColumn} onChange={setYearColumn}
                          options={info.year_columns.map(value => ({value,label:value}))}/>}
                        <Text type="secondary">双击单元格编辑</Text>
                        {dirty > 0 && <Tag color="green">本次会话已保存 {dirty} 次</Tag>}
                      </Space>
                      <Table
                        size="small"
                        bordered
                        key={contextKey}
                        loading={loading || writing}
                        dataSource={dataSource}
                        columns={columns as any}
                        scroll={{ x: 'max-content', y: 'calc(100vh - 470px)' }}
                        pagination={{
                          current: page,
                          pageSize,
                          total,
                          showSizeChanger: true,
                          pageSizeOptions: [40, 80, 200, 500],
                          showTotal: (t) => `共 ${t.toLocaleString()} 行`,
                          onChange: (p, ps) => { if (!writingRef.current) loadPage(p, ps) },
                        }}
                      />
                    </>
                  )}
                </>
              )}
            </Card>
          )}
        </div>
      </div>

      <Drawer title="与基线差异" open={diffOpen} onClose={() => setDiffOpen(false)} width={720}>
        <Table
          size="small"
          rowKey={(r, i) => String(i)}
          dataSource={diff}
          columns={[
            { title: '行', dataIndex: 'row', width: 60 },
            { title: '键', dataIndex: 'key', render: (v) => <span className="muted">{JSON.stringify(v)}</span> },
            { title: '列', dataIndex: 'column', width: 160 },
            { title: '原值', dataIndex: 'old', width: 140 },
            { title: '新值', dataIndex: 'new', width: 140 },
          ]}
        />
      </Drawer>

      <Modal title="批量修改整列" open={bulkOpen} confirmLoading={writing} okButtonProps={{ disabled: !ready || writing }} onOk={runBulk} onCancel={() => setBulkOpen(false)} okText="执行">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            value={bulkCol || undefined}
            onChange={setBulkCol}
            placeholder="选择列"
            options={(info?.columns || []).map((c) => ({ value: c, label: c }))}
          />
          <Radio.Group value={bulkOp} onChange={(e) => setBulkOp(e.target.value)}>
            <Radio.Button value="scale">按比例缩放</Radio.Button>
            <Radio.Button value="set">设为固定值</Radio.Button>
          </Radio.Group>
          <InputNumber style={{ width: '100%' }} value={bulkValue} onChange={(v) => setBulkValue(Number(v))} />
          <span className="muted">缩放示例：填 1.1 表示 +10%；0.9 表示 -10%。只对数值单元格生效。</span>
        </Space>
      </Modal>
    </div>
  )
}
