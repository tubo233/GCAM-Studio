import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Spin, Table, Tag, Typography, message } from 'antd'
import { FolderOpenOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { apiGet, apiPost, apiPut } from '../api'

const { Title, Text } = Typography

type DirEntry = { name: string; path: string }
type BrowseMode = 'folder' | 'file'

function errorDetail(err: any, fallback: string): string {
  const detail = err?.response?.data?.detail
  return typeof detail === 'string' ? detail : fallback
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (idx <= 0) return ''
  if (trimmed.charAt(idx - 1) === ':') return trimmed.slice(0, idx + 1)
  return trimmed.slice(0, idx)
}

function PathField({
  value,
  onChange,
  placeholder,
  onBrowse,
}: {
  value?: string
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  onBrowse: () => void
}) {
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input value={value} onChange={onChange} placeholder={placeholder} />
      <Button icon={<FolderOpenOutlined />} onClick={onBrowse}>浏览</Button>
    </Space.Compact>
  )
}

function PathBrowser({
  mode,
  title,
  initial,
  onCancel,
  onSelect,
}: {
  mode: BrowseMode
  title: string
  initial: string
  onCancel: () => void
  onSelect: (path: string) => void
}) {
  const [current, setCurrent] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [files, setFiles] = useState<DirEntry[]>([])
  const [drives, setDrives] = useState<DirEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [atDrives, setAtDrives] = useState(true)
  const [loading, setLoading] = useState(true)

  const loadDrives = async () => {
    setLoading(true)
    try {
      const list = await apiGet<DirEntry[]>('/api/fs/drives')
      setDrives(list || [])
      setAtDrives(true)
      setCurrent('')
      setParent(null)
      setDirs([])
      setFiles([])
      setTruncated(false)
    } catch (err: any) {
      message.error(errorDetail(err, '无法读取磁盘列表'))
    } finally {
      setLoading(false)
    }
  }

  const loadDir = async (path: string) => {
    setLoading(true)
    try {
      const listing = await apiGet<any>('/api/fs/list', { path })
      setAtDrives(false)
      setCurrent(listing.path || path)
      setParent(listing.parent ?? null)
      setDirs(listing.dirs || [])
      setFiles(listing.files || [])
      setTruncated(!!listing.truncated)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const start = initial.trim()
    if (!start) {
      loadDrives()
      return
    }
    loadDir(start).catch(async () => {
      const parentPath = parentOf(start)
      if (!parentPath) {
        await loadDrives()
        return
      }
      try {
        await loadDir(parentPath)
      } catch (err: any) {
        message.error(errorDetail(err, '无法打开该路径'))
        await loadDrives()
      }
    })
    // Remounted by the parent whenever a new browse starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal
      open
      title={title}
      width={720}
      onCancel={onCancel}
      onOk={() => {
        if (mode === 'folder' && current) onSelect(current)
      }}
      okText="使用当前文件夹"
      cancelText={mode === 'folder' ? '取消' : '关闭'}
      okButtonProps={{ disabled: mode !== 'folder' || !current, style: mode === 'folder' ? undefined : { display: 'none' } }}
    >
      <Space style={{ marginBottom: 8 }}>
        <Button disabled={loading || atDrives} onClick={() => (parent ? loadDir(parent).catch((err) => message.error(errorDetail(err, '无法打开上层目录'))) : loadDrives())}>
          向上
        </Button>
        <Text ellipsis style={{ maxWidth: 560 }}>{atDrives ? '此电脑' : current}</Text>
      </Space>
      <Spin spinning={loading}>
        <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
          {atDrives && drives.map((drive) => (
            <Button key={drive.path} type="text" block style={{ textAlign: 'left' }} icon={<FolderOpenOutlined />} onClick={() => loadDir(drive.path).catch((err) => message.error(errorDetail(err, '无法打开磁盘')))}>
              {drive.name}
            </Button>
          ))}
          {!atDrives && dirs.map((dir) => (
            <Button key={dir.path} type="text" block style={{ textAlign: 'left' }} icon={<FolderOpenOutlined />} onClick={() => loadDir(dir.path).catch((err) => message.error(errorDetail(err, '无法打开文件夹')))}>
              {dir.name}
            </Button>
          ))}
          {!atDrives && mode === 'file' && files.map((file) => (
            <Button key={file.path} type="text" block style={{ textAlign: 'left' }} onClick={() => onSelect(file.path)}>
              {file.name}
            </Button>
          ))}
          {!atDrives && dirs.length === 0 && (mode !== 'file' || files.length === 0) && (
            <div style={{ padding: 12 }} className="muted">这个文件夹是空的</div>
          )}
        </div>
      </Spin>
      {truncated && <Alert style={{ marginTop: 8 }} type="warning" showIcon message="条目太多，只显示了一部分。" />}
      {mode === 'file' && <p className="page-sub">点文件名即可选中。点文件夹进入下一层。</p>}
    </Modal>
  )
}

export default function Settings() {
  const [form] = Form.useForm()
  const [health, setHealth] = useState<any>(null)
  const [settings, setSettings] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [picker, setPicker] = useState<{ field: string; mode: BrowseMode; title: string; initial: string } | null>(null)

  const load = async () => {
    const [s, h] = await Promise.all([apiGet<any>('/api/settings'), apiGet<any>('/api/health')])
    setHealth(h)
    if (s) {
      const { migration: _migration, ...rest } = s
      setSettings(rest)
    }
  }

  useEffect(() => {
    if (health?.can_edit_settings && settings) form.setFieldsValue(settings)
  }, [form, health, settings])

  useEffect(() => { load().catch((err) => message.error(errorDetail(err, '无法读取设置'))) }, [])

  const save = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const saved = await apiPut<any>('/api/settings', v)
      const migration = saved?.migration
      if (migration?.from && migration?.to) {
        message.success(`已将数据从 ${migration.from} 迁到 ${migration.to}`)
      } else {
        message.success('设置已保存（部分路径修改后建议重启应用）')
      }
    } catch (err: any) {
      message.error(errorDetail(err, '保存设置失败'))
      return
    } finally {
      setSaving(false)
    }
    await load()
  }

  const rebuild = async () => {
    await apiPost('/api/catalog?force=true')
    message.success('目录索引已重建')
    await load()
  }

  const canEdit = health?.can_edit_settings === true
  const checks = health
    ? [
        { name: 'GCAM 模型目录', value: health.gcam_root, ok: health.gcam_root_exists, hint: '包含 exe/、input/、output/ 的目录' },
        { name: 'gcam.exe', value: health.gcam_exe, ok: health.gcam_exe_exists, hint: 'GCAM 求解器' },
        { name: 'Java 21', value: health.java, ok: health.java_ok, hint: health.java_message || '检查 64 位 JDK 21 和 jvm.dll' },
        { name: 'Rscript 与 R 包', value: health.rscript, ok: health.rscript_ok, hint: health.rscript_message || 'gcamdata 生成 XML' },
        { name: 'ModelInterface.jar', value: health.model_interface, ok: health.model_interface_exists, hint: '数据库查询' },
      ]
    : []

  return (
    <div>
      <Title level={3} className="page-title">设置与诊断</Title>
      <p className="page-sub">
        {canEdit
          ? 'JDK、R 和 GCAM 路径保存在这台电脑上。同事通过局域网可以改情景参数并运行，但不能改这些路径。'
          : '模型在主机上运行。你可以修改情景参数并查看结果。'}
      </p>

      {!canEdit && health && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="JDK / GCAM 路径属于运行模型的电脑，请在那台电脑上修改。"
        />
      )}

      {canEdit && (
        <Card title="路径设置" style={{ marginBottom: 16 }} extra={<Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>保存</Button>}>
          <Form form={form} layout="vertical" style={{ maxWidth: 900 }}>
            <Form.Item name="gcam_root" label="GCAM 模型根目录" rules={[{ required: true }]}>
              <PathField placeholder="选择包含 exe、input、output 的文件夹" onBrowse={() => setPicker({ field: 'gcam_root', mode: 'folder', title: '选择 GCAM 模型根目录', initial: form.getFieldValue('gcam_root') || '' })} />
            </Form.Item>
            <Form.Item
              name="data_dir"
              label="Studio 数据目录（Profile / 构建 / 运行）"
              extra="保存后会把当前目录中的 Profile、构建、运行和查询结果迁到新目录。设置文件仍留在原处，用来记住这个路径。"
            >
              <PathField placeholder="选择用于存放 Profile 和运行结果的文件夹" onBrowse={() => setPicker({ field: 'data_dir', mode: 'folder', title: '选择 Studio 数据目录', initial: form.getFieldValue('data_dir') || '' })} />
            </Form.Item>
            <Form.Item name="rscript" label="Rscript.exe">
              <PathField placeholder="选择 Rscript.exe" onBrowse={() => setPicker({ field: 'rscript', mode: 'file', title: '选择 Rscript.exe', initial: form.getFieldValue('rscript') || '' })} />
            </Form.Item>
            <Form.Item name="java" label="java.exe（JDK 21）">
              <PathField placeholder="选择 java.exe" onBrowse={() => setPicker({ field: 'java', mode: 'file', title: '选择 java.exe', initial: form.getFieldValue('java') || '' })} />
            </Form.Item>
            <Form.Item name="max_builds" label="每个 Profile 保留的构建数">
              <InputNumber min={1} max={20} />
            </Form.Item>
          </Form>
        </Card>
      )}

      <Card title="环境自检" extra={<Space><Button icon={<ReloadOutlined />} onClick={() => load().catch((err) => message.error(errorDetail(err, '无法读取设置')))}>重新检测</Button><Button onClick={rebuild}>重建目录索引</Button></Space>}>
        {!health ? <Spin /> : (
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={checks}
            columns={[
              { title: '检查项', dataIndex: 'name', width: 180 },
              { title: '状态', dataIndex: 'ok', width: 90, render: (v) => <Tag color={v ? 'green' : 'red'}>{v ? '正常' : '缺失'}</Tag> },
              { title: '路径', dataIndex: 'value', render: (v) => <span className="muted">{v || '-'}</span> },
              { title: '说明', dataIndex: 'hint' },
            ]}
          />
        )}
        {health && !health.gcam_root_exists && <Alert style={{ marginTop: 12 }} type="error" showIcon message="模型目录无效，请先选择正确的 GCAM-China 根目录。" />}
      </Card>

      {picker && (
        <PathBrowser
          key={`${picker.field}:${picker.initial}`}
          mode={picker.mode}
          title={picker.title}
          initial={picker.initial}
          onCancel={() => setPicker(null)}
          onSelect={(path) => {
            form.setFieldValue(picker.field, path)
            setPicker(null)
          }}
        />
      )}
    </div>
  )
}
