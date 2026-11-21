import React, { useEffect, useRef, useState } from 'react'
import { Button, Card, Dropdown, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiDelete, apiPost } from '../api'
import { useProfiles } from '../context/ProfileContext'
import { StepFooter, StepHeader } from '../components/WorkflowChrome'
import type { Profile } from '../types'

const { Text } = Typography

const TEMPLATES = [
  { value: 'configuration_china.xml', label: 'Reference（基准）' },
  { value: 'configuration_china_ssp1.xml', label: 'SSP1 可持续' },
  { value: 'configuration_china_ssp2.xml', label: 'SSP2 中间路线' },
  { value: 'configuration_china_ssp3.xml', label: 'SSP3 区域竞争' },
  { value: 'configuration_china_ssp4.xml', label: 'SSP4 不平等' },
  { value: 'configuration_china_ssp5.xml', label: 'SSP5 化石燃料' },
]

const TEMPLATE_LABELS = Object.fromEntries(TEMPLATES.map((t) => [t.value, t.label]))

export default function Profiles() {
  const nav = useNavigate()
  const { profiles, active, activeId, setActiveId, reload } = useProfiles()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [cloneTarget, setCloneTarget] = useState<Profile | null>(null)
  const [cloneName, setCloneName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    reload()
  }, [])

  const create = async (goNext: boolean) => {
    const v = await form.validateFields()
    setBusy(true)
    try {
      const p = await apiPost<Profile>('/api/profiles', v)
      message.success(p.config_repairs ? `情景已创建，配置副本已自动修正 ${p.config_repairs} 处 XML 拼写` : '情景已创建')
      setOpen(false)
      form.resetFields()
      await reload()
      setActiveId(p.id)
      if (goNext) nav('/scenario')
    } catch (e: any) {
      message.error(e.response?.data?.detail || '创建情景失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Profile) => {
    try {
      await apiDelete(`/api/profiles/${p.id}`)
      message.success(`已删除情景「${p.name}」`)
      await reload()
    } catch (e: any) {
      message.error(e.response?.data?.detail || '删除失败')
    }
  }

  const confirmRemove = (p: Profile) => {
    Modal.confirm({
      title: `确认删除情景「${p.name}」？`,
      content: '会永久删除该情景的配置覆盖层、XML 构建产物和运行历史记录，不可恢复。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove(p),
    })
  }

  const importZip = async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const response = await fetch('/api/profiles/import', { method: 'POST', body: fd })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || '导入失败')
      await reload()
      setActiveId(result.data.id)
      message.success('已导入并选中情景')
    } catch (e: any) {
      message.error(e.message || '情景导入失败')
    }
  }

  const clone = async () => {
    if (!cloneTarget || !cloneName.trim()) return
    await apiPost(`/api/profiles/${cloneTarget.id}/clone`, { name: cloneName.trim() })
    message.success('已克隆为新情景')
    setCloneTarget(null)
    setCloneName('')
    await reload()
  }

  return (
    <div>
      <StepHeader
        step={1}
        title="选择或新建情景（Profile）"
        description="每套情景完全隔离，只保存修改过的配置与覆盖数据，未修改部分自动回落到模型基线。"
        extra={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.[0]) void importZip(e.target.files[0])
                e.target.value = ''
              }}
            />
            <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
              从备份导入 (.zip)
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => reload()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              新建情景
            </Button>
          </>
        }
      />

      <Card title={`共 ${profiles.length} 套情景环境`}>
        <Table
          rowKey="id"
          dataSource={profiles}
          pagination={false}
          scroll={{ x: 'max-content' }}
          rowClassName={(r) => (r.id === activeId ? 'profile-row-active' : '')}
          locale={{ emptyText: '还没有情景环境，点击右上角“新建情景”开始' }}
          columns={[
            {
              title: '名称与说明',
              dataIndex: 'name',
              minWidth: 180,
              render: (v, r) => (
                <Space direction="vertical" size={0}>
                  <Space wrap size={6}>
                    <Text strong style={{ whiteSpace: 'nowrap' }}>{v}</Text>
                    {r.id === activeId && <Tag color="blue" style={{ marginInlineEnd: 0 }}>当前使用</Tag>}
                  </Space>
                  <span className="muted">{r.description || '暂无描述'}</span>
                </Space>
              ),
            },
            {
              title: '基础配置',
              dataIndex: 'base_config',
              render: (v) => (
                <Tooltip title={v || '-'}>
                  <Tag>{TEMPLATE_LABELS[v] || v || '-'}</Tag>
                </Tooltip>
              ),
            },
            {
              title: '改动文件',
              dataIndex: 'overlay_files',
              width: 85,
              render: (v) => <Tag color={v ? 'orange' : 'default'}>{v || 0}</Tag>,
            },
            {
              title: '构建 / 运行',
              width: 95,
              render: (_, r) => `${r.builds || 0} / ${r.runs || 0}`,
            },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              width: 155,
              render: (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-'),
            },
            {
              title: '操作',
              width: 250,
              render: (_, r) => (
                <Space>
                  {r.id === activeId ? (
                    <Button size="small" type="primary" onClick={() => nav('/scenario')}>
                      进入 ② 情景与政策 →
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        onClick={() => {
                          setActiveId(r.id)
                          nav('/scenario')
                        }}
                      >
                        切换并配置 →
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          setActiveId(r.id)
                          message.success(`已切换当前情景为「${r.name}」`)
                        }}
                      >
                        仅选中
                      </Button>
                    </>
                  )}
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'clone',
                          icon: <CopyOutlined />,
                          label: '克隆为副本',
                          onClick: () => {
                            setCloneTarget(r)
                            setCloneName(`${r.name} 副本`)
                          },
                        },
                        {
                          key: 'export',
                          icon: <DownloadOutlined />,
                          label: (
                            <a href={`/api/profiles/${r.id}/export`} download>
                              备份导出 (.zip)
                            </a>
                          ),
                        },
                        { type: 'divider' },
                        {
                          key: 'delete',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: '删除情景',
                          onClick: () => confirmRemove(r),
                        },
                      ],
                    }}
                  >
                    <Button size="small">
                      更多 <DownOutlined />
                    </Button>
                  </Dropdown>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <StepFooter
        prev={{ label: '返回工作台总览', onClick: () => nav('/') }}
        next={{
          label: '下一步：② 情景与政策',
          disabled: !activeId,
          onClick: () => nav('/scenario'),
        }}
        hint={active ? `当前情景：${active.name}` : '请先创建或选择一个情景'}
      />

      <Modal
        title="新建情景（Profile）"
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button loading={busy} onClick={() => create(false)}>
              仅创建
            </Button>
            <Button type="primary" loading={busy} onClick={() => create(true)}>
              创建并前往配置 →
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ template: 'configuration_china.xml' }}>
          <Form.Item name="name" label="情景名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：SSP2 + 碳税 25" />
          </Form.Item>
          <Form.Item name="template" label="基础配置模板" rules={[{ required: true }]}>
            <Select options={TEMPLATES} />
          </Form.Item>
          <Form.Item name="description" label="研究用途说明（可选）">
            <Input.TextArea rows={2} placeholder="记录该情景的假设背景，方便团队成员理解…" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`克隆情景：${cloneTarget?.name || ''}`}
        open={!!cloneTarget}
        onOk={clone}
        onCancel={() => setCloneTarget(null)}
        okText="确认克隆"
      >
        <Input value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="新情景名称" />
      </Modal>
    </div>
  )
}
