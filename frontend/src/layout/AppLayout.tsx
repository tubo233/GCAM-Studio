import React, { useEffect, useState } from 'react'
import { Badge, Button, Layout, Menu, Select, Space, Tag, Tooltip, Typography } from 'antd'
import {
  AppstoreAddOutlined,
  BarChartOutlined,
  DashboardOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  SlidersOutlined,
  ApartmentOutlined,
  ExperimentOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useProfiles } from '../context/ProfileContext'
import { apiGet } from '../api'
import { isLocalConsole } from '../localAccess'
import { stepForPath, WORKFLOW_STEPS, WorkflowBar } from '../components/WorkflowChrome'
import type { Job } from '../types'

const { Header, Sider, Content } = Layout
const { Text } = Typography

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const { profiles, activeId, setActiveId, reload } = useProfiles()
  const [health, setHealth] = useState<any>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const localConsole = isLocalConsole()

  useEffect(() => {
    apiGet('/api/health').then(setHealth).catch(() => {})
  }, [])

  useEffect(() => {
    let live = true
    const fetchJobs = () => {
      apiGet<Job[]>('/api/jobs')
        .then((list) => {
          if (live && Array.isArray(list)) setJobs(list)
        })
        .catch(() => {})
    }
    fetchJobs()
    const timer = setInterval(fetchJobs, 6000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const activeJob = jobs.find((j) => j.status === 'running') || jobs.find((j) => j.status === 'queued')
  const envReady = !!(
    health?.gcam_root_exists &&
    (health?.java_ok ?? health?.java_exists) &&
    (health?.rscript_ok ?? health?.rscript_exists) &&
    health?.model_interface_exists
  )

  const currentStep = stepForPath(loc.pathname)
  const selectedKey =
    (currentStep ? WORKFLOW_STEPS.find((s) => s.step === currentStep)?.key : null) ||
    (loc.pathname.startsWith('/settings') ? '/settings' : '/')

  const menuItems: any[] = [
    { key: '/', icon: <DashboardOutlined />, label: '工作台总览' },
    {
      type: 'group',
      label: '执行流程',
      children: [
        { key: '/profiles', icon: <ExperimentOutlined />, label: '① 选择情景' },
        { key: '/scenario', icon: <ApartmentOutlined />, label: '② 情景与政策' },
        { key: '/parameters', icon: <SlidersOutlined />, label: '③ 参数与数据' },
        {
          key: '/runs',
          icon: <PlayCircleOutlined />,
          label: (
            <Space size={6}>
              <span>④ 检查与运行</span>
              {activeJob && <Badge status="processing" />}
            </Space>
          ),
        },
        { key: '/results', icon: <BarChartOutlined />, label: '⑤ 结果与对比' },
      ],
    },
  ]

  if (localConsole) {
    menuItems.push({
      type: 'group',
      label: '系统',
      children: [
        {
          key: '/settings',
          icon: <SettingOutlined />,
          label: (
            <Space size={6}>
              <span>环境设置与诊断</span>
              {health && !envReady && <Badge status="error" />}
            </Space>
          ),
        },
      ],
    })
  }

  const healthTooltip = health ? (
    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
      <div>模型目录：{health.gcam_root_exists ? '正常' : '未就绪'}（{health.gcam_root || '-'}）</div>
      <div>Java 21：{(health.java_ok ?? health.java_exists) ? '正常' : '异常'}</div>
      <div>R / R 包：{(health.rscript_ok ?? health.rscript_exists) ? '正常' : '异常'}</div>
      <div>ModelInterface：{health.model_interface_exists ? '正常' : '缺失'}</div>
      {localConsole && <div style={{ marginTop: 4, color: '#93c5fd' }}>点击前往“环境设置与诊断”</div>}
    </div>
  ) : (
    '正在检查本机运行环境…'
  )

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={232} theme="dark" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto' }}>
        <div style={{ padding: '18px 18px 10px', color: '#fff' }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.2 }}>GCAM-China Studio</div>
          <div style={{ fontSize: 11, color: '#8ba3c7', marginTop: 4 }}>
            情景与数据工作台 · v{health?.version || '0.1.4'}
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={(e) => nav(e.key)}
          style={{ borderInlineEnd: 0 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            borderBottom: '1px solid #e6ebf2',
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 10,
            gap: 12,
          }}
        >
          <Space size={10}>
            <Text strong>当前情景</Text>
            <Select
              style={{ width: 300 }}
              value={activeId || undefined}
              placeholder="请选择或新建情景（Profile）"
              options={profiles.map((p) => ({
                value: p.id,
                label: `${p.name}${p.overlay_files ? ` · ${p.overlay_files} 个改动` : ''}`,
              }))}
              onChange={setActiveId}
              onClick={() => reload()}
              showSearch
              optionFilterProp="label"
            />
            <Tooltip title="管理或新建情景">
              <Button icon={<AppstoreAddOutlined />} onClick={() => nav('/profiles')} />
            </Tooltip>
          </Space>
          <Space size={10}>
            {activeJob && (
              <Tag
                color="processing"
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                onClick={() => nav('/runs')}
              >
                {activeJob.status === 'running' ? '正在执行' : '排队中'}：{activeJob.title || activeJob.kind}
              </Tag>
            )}
            {health && (
              <Tooltip title={healthTooltip}>
                <Tag
                  color={envReady ? 'green' : 'error'}
                  style={{ cursor: localConsole ? 'pointer' : 'default', marginInlineEnd: 0 }}
                  onClick={() => {
                    if (localConsole) nav('/settings')
                  }}
                >
                  {envReady ? '环境就绪' : '环境待检查'}
                </Tag>
              </Tooltip>
            )}
          </Space>
        </Header>
        <Content style={{ padding: 20, background: '#f4f6f9' }}>
          {currentStep !== null && (
            <WorkflowBar
              currentStep={currentStep}
              hasProfile={!!activeId}
              hasRunningJob={!!activeJob}
            />
          )}
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
