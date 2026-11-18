import React, { useEffect, useState } from 'react'
import { Layout, Menu, Select, Space, Tag, Typography, Tooltip } from 'antd'
import {
  AppstoreOutlined,
  BarChartOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  SlidersOutlined,
  ApartmentOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useProfiles } from '../context/ProfileContext'
import { apiGet } from '../api'
import { isLocalConsole } from '../localAccess'

const { Header, Sider, Content } = Layout
const { Text } = Typography

const items = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/profiles', icon: <AppstoreOutlined />, label: '情景库' },
  { key: '/parameters', icon: <SlidersOutlined />, label: '参数中心' },
  { key: '/data', icon: <FolderOpenOutlined />, label: '数据文件' },
  { key: '/xml', icon: <FileTextOutlined />, label: '情景组件 XML' },
  { key: '/model-config', icon: <ApartmentOutlined />, label: '模型配置' },
  { key: '/policy', icon: <ExperimentOutlined />, label: '政策工作室' },
  { key: '/runs', icon: <PlayCircleOutlined />, label: '运行中心' },
  { key: '/results', icon: <BarChartOutlined />, label: '结果与导出' },
  { key: '/compare', icon: <ApartmentOutlined />, label: '跨运行对比' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置与诊断' },
]

export default function AppLayout() {
  const nav = useNavigate()
  const loc = useLocation()
  const { profiles, activeId, setActiveId, reload } = useProfiles()
  const [health, setHealth] = useState<any>(null)

  useEffect(() => {
    apiGet('/api/health').then(setHealth).catch(() => {})
  }, [])

  const menuItems = isLocalConsole() ? items : items.filter((item) => item.key !== '/settings')
  const selected = menuItems.find((i) => i.key !== '/' && loc.pathname.startsWith(i.key))?.key || '/'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={218} theme="dark" style={{ position: 'sticky', top: 0, height: '100vh' }}>
        <div style={{ padding: '18px 18px 10px', color: '#fff' }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.2 }}>GCAM-China Studio</div>
          <div style={{ fontSize: 11, color: '#8ba3c7', marginTop: 4 }}>情景与数据工作台 · v{health?.version || '0.1.4'}</div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={menuItems}
          onClick={(e) => nav(e.key)}
          style={{ borderInlineEnd: 0 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            borderBottom: '1px solid #e8e8e8',
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Space size={12}>
            <Text strong>当前参数环境</Text>
            <Select
              style={{ width: 320 }}
              value={activeId || undefined}
              placeholder="请选择或新建 Profile"
              options={profiles.map((p) => ({ value: p.id, label: `${p.name}${p.overlay_files ? ` · ${p.overlay_files} 个改动` : ''}` }))}
              onChange={setActiveId}
              onClick={() => reload()}
              showSearch
              optionFilterProp="label"
            />
          </Space>
          <Space size={10}>
            {health && (
              <>
                <Tooltip title={`GCAM 根目录：${health.gcam_root}`}>
                  <Tag color={health.gcam_root_exists ? 'green' : 'red'}>模型目录</Tag>
                </Tooltip>
                <Tag color={health.java_exists ? 'green' : 'red'}>Java 21</Tag>
                <Tag color={health.rscript_exists ? 'green' : 'red'}>R 4.4.2</Tag>
                <Tag color={health.model_interface_exists ? 'green' : 'red'}>ModelInterface</Tag>
              </>
            )}
          </Space>
        </Header>
        <Content style={{ padding: 20, background: '#f5f7fa' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
