import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd'
import { AppstoreAddOutlined, FolderOpenOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../api'
import { isLocalConsole } from '../localAccess'
import { useProfiles } from '../context/ProfileContext'
import type { RunInfo } from '../types'

const { Title, Text } = Typography

export default function Dashboard() {
  const nav = useNavigate()
  const { profiles, active, activeId } = useProfiles()
  const [stats, setStats] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [runs, setRuns] = useState<RunInfo[]>([])

  const load = async () => {
    const [s, h, r] = await Promise.all([apiGet('/api/stats'), apiGet('/api/health'), apiGet('/api/runs')])
    setStats(s)
    setHealth(h)
    setRuns(r)
  }

  useEffect(() => {
    load()
  }, [])

  const catalog = stats?.catalog || {}
  const envOk = health?.gcam_root_exists && health?.java_exists && health?.rscript_exists
  const localConsole = isLocalConsole()

  return (
    <div>
      <Title level={3} className="page-title">总览</Title>
      <p className="page-sub">GCAM-China v8 · 31 省 + 6 电网 · 基准年 2021 · 本地桌面工作台</p>

      {!envOk && health && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="运行环境未就绪"
          description={`模型目录 ${health.gcam_root_exists ? '✓' : '✗'} · Java ${health.java_exists ? '✓' : '✗'} · R ${health.rscript_exists ? '✓' : '✗'}${localConsole ? '。请到“设置与诊断”检查路径。' : '。运行环境由主机配置。'}`}
          action={localConsole ? <Button size="small" onClick={() => nav('/settings')}>去设置</Button> : undefined}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Card className="stat-card"><Statistic title="输入 CSV" value={catalog.files || 0} suffix="个" /></Card></Col>
        <Col xs={12} md={6}><Card className="stat-card"><Statistic title="情景 XML" value={catalog.xml || 0} suffix="个" /></Card></Col>
        <Col xs={12} md={6}><Card className="stat-card"><Statistic title="可用查询" value={catalog.queries || 0} suffix="条" /></Card></Col>
        <Col xs={12} md={6}><Card className="stat-card"><Statistic title="参数环境" value={profiles.length} suffix="套" /></Card></Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={14}>
          <Card
            title="当前参数环境"
            extra={<Button onClick={() => nav('/profiles')} icon={<AppstoreAddOutlined />}>管理情景库</Button>}
          >
            {active ? (
              <Space direction="vertical" size={6}>
                <Space>
                  <Text strong style={{ fontSize: 18 }}>{active.name}</Text>
                  <Tag color="blue">{active.base_config}</Tag>
                  <Tag>{active.overlay_files || 0} 个改动文件</Tag>
                </Space>
                <Text type="secondary">{active.description || '暂无描述'}</Text>
                <Space style={{ marginTop: 8 }}>
                  <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => nav('/data')}>编辑数据</Button>
                  <Button icon={<PlayCircleOutlined />} onClick={() => nav('/runs')}>运行 GCAM</Button>
                </Space>
              </Space>
            ) : (
              <Space direction="vertical">
                <Text type="secondary">还没有参数环境。创建一个 Profile 开始。</Text>
                <Button type="primary" onClick={() => nav('/profiles')}>新建 Profile</Button>
              </Space>
            )}
          </Card>

          <Card title="最近运行" style={{ marginTop: 16 }} extra={<Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>}>
            <Table
              size="small"
              rowKey="run_id"
              pagination={false}
              dataSource={runs.slice(0, 6)}
              locale={{ emptyText: '还没有运行记录' }}
              columns={[
                { title: '场景', dataIndex: 'scenario_name', render: (v, r) => v || r.run_id },
                { title: 'Profile', dataIndex: 'profile_id' },
                { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'success' ? 'green' : v === 'failed' ? 'red' : 'blue'}>{v || 'unknown'}</Tag> },
                { title: '耗时', dataIndex: 'elapsed_sec', render: (v) => (v ? `${Math.round(v)} s` : '-') },
                { title: '创建时间', dataIndex: 'created_at', render: (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-') },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="快捷入口">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              <Button block size="large" onClick={() => nav('/parameters')}>参数中心 · 12 个模块</Button>
              <Button block size="large" onClick={() => nav('/data')}>数据文件 · 1,123 个 CSV</Button>
              <Button block size="large" onClick={() => nav('/xml')}>情景组件 · 304 个 XML</Button>
              <Button block size="large" onClick={() => nav('/policy')}>政策工作室 · 碳税 / 净零</Button>
              <Button block size="large" onClick={() => nav('/results')}>结果与导出 · 363 条查询</Button>
            </Space>
          </Card>

          <Card title="模型信息" style={{ marginTop: 16 }}>
            <div className="muted" style={{ lineHeight: 1.9 }}>
              <div>模型根目录：{health?.gcam_root || '-'}</div>
              <div>gcam.exe：{health?.gcam_exe_exists ? '已找到' : '未找到'}</div>
              <div>Java：{health?.java || '-'}</div>
              <div>Rscript：{health?.rscript || '-'}</div>
              <div>ModelInterface：{health?.model_interface || '-'}</div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
