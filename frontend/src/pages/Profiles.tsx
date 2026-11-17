import React, { useEffect, useRef, useState } from 'react'
import { Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, Upload, message } from 'antd'
import { CopyOutlined, DeleteOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiDelete, apiGet, apiPost } from '../api'
import { useProfiles } from '../context/ProfileContext'
import type { Profile } from '../types'

const { Title, Text } = Typography

const TEMPLATES = [
  { value: 'configuration_china.xml', label: 'Reference（基准）' },
  { value: 'configuration_china_ssp1.xml', label: 'SSP1 可持续' },
  { value: 'configuration_china_ssp2.xml', label: 'SSP2 中间路线' },
  { value: 'configuration_china_ssp3.xml', label: 'SSP3 区域竞争' },
  { value: 'configuration_china_ssp4.xml', label: 'SSP4 不平等' },
  { value: 'configuration_china_ssp5.xml', label: 'SSP5 化石燃料' },
]

export default function Profiles() {
  const nav = useNavigate()
  const { profiles, activeId, setActiveId, reload } = useProfiles()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [cloneTarget, setCloneTarget] = useState<Profile | null>(null)
  const [cloneName, setCloneName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { reload() }, [])

  const create = async () => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const p = await apiPost<Profile>('/api/profiles', v)
      message.success('Profile 已创建')
      setOpen(false)
      form.resetFields()
      await reload()
      setActiveId(p.id)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Profile) => {
    await apiDelete(`/api/profiles/${p.id}`)
    message.success('已删除')
    await reload()
  }

  const importZip = async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    await fetch('/api/profiles/import', { method: 'POST', body: fd })
    message.success('Profile 已导入')
    await reload()
  }

  const clone = async () => {
    if (!cloneTarget || !cloneName.trim()) return
    await apiPost(`/api/profiles/${cloneTarget.id}/clone`, { name: cloneName.trim() })
    message.success('已克隆')
    setCloneTarget(null)
    setCloneName('')
    await reload()
  }

  return (
    <div>
      <Title level={3} className="page-title">情景库（参数环境）</Title>
      <p className="page-sub">每套参数完全隔离，类似 conda 环境；运行时按需选择。只保存改过的文件，未改的自动回落到基线。</p>

      <Card
        extra={
          <Space>
            <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && importZip(e.target.files[0])} />
            <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>导入</Button>
            <Button icon={<ReloadOutlined />} onClick={() => reload()}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建 Profile</Button>
          </Space>
        }
        title={`共 ${profiles.length} 套参数环境`}
      >
        <Table
          rowKey="id"
          dataSource={profiles}
          pagination={false}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (v, r) => (
                <Space direction="vertical" size={0}>
                  <Space>
                    <Text strong>{v}</Text>
                    {r.id === activeId && <Tag color="blue">当前</Tag>}
                  </Space>
                  <span className="muted">{r.description || '暂无描述'}</span>
                </Space>
              ),
            },
            { title: '基础配置', dataIndex: 'base_config', render: (v) => <Tag>{v || '-'}</Tag> },
            { title: '改动文件', dataIndex: 'overlay_files', render: (v) => <Tag color={v ? 'orange' : 'default'}>{v || 0}</Tag> },
            { title: '构建', dataIndex: 'builds', render: (v) => v || 0 },
            { title: '运行', dataIndex: 'runs', render: (v) => v || 0 },
            { title: '更新时间', dataIndex: 'updated_at', render: (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-') },
            {
              title: '操作',
              width: 280,
              render: (_, r) => (
                <Space>
                  <Button size="small" type={r.id === activeId ? 'default' : 'primary'} onClick={() => { setActiveId(r.id); nav('/data') }}>
                    打开
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} href={`/api/profiles/${r.id}/export`}>导出</Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => { setCloneTarget(r); setCloneName(`${r.name} 副本`) }}>克隆</Button>
                  <Popconfirm title="确认删除该 Profile？" description="会删除其覆盖层、构建和运行记录，不可恢复。" onConfirm={() => remove(r)}>
                    <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="新建参数环境" open={open} onOk={create} confirmLoading={busy} onCancel={() => setOpen(false)} okText="创建">
        <Form form={form} layout="vertical" initialValues={{ template: 'configuration_china.xml' }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：SSP2 + 碳税 25" />
          </Form.Item>
          <Form.Item name="template" label="基础配置模板" rules={[{ required: true }]}>
            <Select options={TEMPLATES} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="这组参数用来做什么…" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`克隆：${cloneTarget?.name || ''}`}
        open={!!cloneTarget}
        onOk={clone}
        onCancel={() => setCloneTarget(null)}
        okText="克隆"
      >
        <Input value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="新 Profile 名称" />
      </Modal>
    </div>
  )
}
