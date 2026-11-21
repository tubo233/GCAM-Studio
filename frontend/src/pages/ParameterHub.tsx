import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Space, Tabs, Tag, Typography } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiGet } from '../api'
import { useProfiles } from '../context/ProfileContext'
import { StepFooter, StepHeader } from '../components/WorkflowChrome'
import InputChanges from '../components/InputChanges'
import { fieldGroups, ParameterGrid } from './ParameterTable'
import DataFiles from './DataFiles'
import XmlBrowser from './XmlBrowser'

const { Text } = Typography

type HubTab = 'xml' | 'csv' | 'raw-xml'

const CSV_DOMAINS: { id: string; label: string; modules: string[]; patterns: string[] }[] = [
  { id: 'all', label: '全部领域', modules: [], patterns: [] },
  { id: 'gcam-china', label: '中国省级', modules: ['gcam-china'], patterns: [] },
  { id: 'socio', label: '社会经济', modules: ['socioeconomics'], patterns: [] },
  {
    id: 'energy',
    label: '能源资源',
    modules: ['energy'],
    patterns: ['resource', 'supply', 'price', 'trade', 'refin', 'liquids', 'gas', 'coal', 'oil', 'uranium', 'hydro', 'wind', 'solar', 'geo', 'bio'],
  },
  {
    id: 'electricity',
    label: '电力',
    modules: ['gcam-china', 'energy'],
    patterns: ['elec', 'load', 'grid', 'nuclear', 'vintage', 'A23.elec'],
  },
  {
    id: 'industry',
    label: '工业',
    modules: ['gcam-china', 'energy'],
    patterns: ['industry', 'cement', 'steel', 'chemical', 'aluminum', 'paper', 'food_processing', 'Fert', 'A323'],
  },
  {
    id: 'buildings',
    label: '建筑',
    modules: ['gcam-china', 'energy'],
    patterns: ['A44', 'building', 'floorspace', 'HDDCDD', 'L245'],
  },
  {
    id: 'transport',
    label: '交通',
    modules: ['gcam-china', 'energy'],
    patterns: ['transport', 'trn', 'A54', 'UCD'],
  },
  { id: 'aglu', label: '农业与土地', modules: ['aglu'], patterns: [] },
  { id: 'water', label: '水资源', modules: ['water'], patterns: [] },
  { id: 'emissions', label: '排放', modules: ['emissions'], patterns: [] },
]

export default function ParameterHub() {
  const nav = useNavigate()
  const { activeId, active } = useProfiles()
  const [searchParams, setSearchParams] = useSearchParams()
  const [chinaInput, setChinaInput] = useState('')
  const [domainId, setDomainId] = useState('all')

  const rawTab = searchParams.get('tab')
  const tab: HubTab =
    rawTab === 'xml' || rawTab === 'csv' || rawTab === 'raw-xml'
      ? rawTab
      : searchParams.has('file') || searchParams.has('module')
        ? 'csv'
        : 'xml'

  const group = searchParams.get('group') || ''
  const source = searchParams.get('source') || ''
  const query = searchParams.get('query') || ''
  const file = searchParams.get('file') || ''
  const module = searchParams.get('module') || ''
  const search = searchParams.get('search') || ''

  useEffect(() => {
    if (!activeId) {
      setChinaInput('')
      return
    }
    let live = true
    apiGet<{ socioeconomics?: string[] }>(`/api/profiles/${activeId}/run-inputs`)
      .then((res) => {
        if (!live) return
        const found = res?.socioeconomics?.find((s) => /^socioeconomics_CHINA.*\.xml$/i.test(s)) || ''
        setChinaInput(found)
      })
      .catch(() => {
        if (live) setChinaInput('')
      })
    return () => {
      live = false
    }
  }, [activeId])

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([k, v]) => {
      if (v) next.set(k, v)
      else next.delete(k)
    })
    setSearchParams(next, { replace: true })
  }

  if (!activeId) {
    return (
      <div>
        <StepHeader
          step={3}
          title="参数与数据"
          description="按需微调人口、GDP、技术参数或底层 CSV（不做精细数据改动可直接跳过）。"
          tags={<Tag>可选步骤</Tag>}
        />
        <Alert
          type="warning"
          showIcon
          message="请先在第 ① 步选择或新建一个情景（Profile）"
          action={
            <Button type="primary" size="small" onClick={() => nav('/profiles')}>
              前往 ① 选择情景
            </Button>
          }
        />
      </div>
    )
  }

  const activeDomain = CSV_DOMAINS.find((d) => d.id === domainId) || CSV_DOMAINS[0]

  return (
    <div key={activeId}>
      <StepHeader
        step={3}
        title={`参数与数据 · ${active?.name || activeId}`}
        description="按需调整人口、GDP、技术成本/效率或底层 CSV（不做精细数据改动可直接跳过进入第 ④ 步）。"
        tags={<Tag>可选步骤</Tag>}
      />

      <InputChanges pid={activeId} defaultExpanded={false} />

      <Card>
        <Tabs
          activeKey={tab}
          onChange={(k) => updateParams({ tab: k })}
          items={[
            {
              key: 'xml',
              label: '快捷模型参数（推荐 · 立即生效）',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text type="secondary">
                    直接定位并修改当前情景生效 XML 中的地区与年份数值，保存后立即生效，无需重新运行 R 构建。
                  </Text>
                  <Space wrap size={[8, 8]}>
                    <Button
                      size="small"
                      type={!group ? 'primary' : 'default'}
                      onClick={() => updateParams({ group: null, source: null })}
                    >
                      全部
                    </Button>
                    {Object.keys(fieldGroups).map((g) => (
                      <Button
                        key={g}
                        size="small"
                        type={group === g ? 'primary' : 'default'}
                        onClick={() => updateParams({ group: g, source: null })}
                      >
                        {g}
                      </Button>
                    ))}
                  </Space>
                  <ParameterGrid
                    pid={activeId}
                    group={group}
                    initialSource={source}
                    initialQuery={query}
                  />
                </Space>
              ),
            },
            {
              key: 'csv',
              label: '底层源数据 CSV（修改后需 R 重建 XML）',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text type="secondary">
                    编辑 gcamdata 底层 CSV 源表并写入当前情景覆盖层；下次运行前会自动（或点击上方“生成并查看派生值”）通过 R 重建派生 XML。
                  </Text>
                  <Space wrap size={[6, 6]}>
                    {CSV_DOMAINS.map((d) => (
                      <Button
                        key={d.id}
                        size="small"
                        type={domainId === d.id ? 'primary' : 'default'}
                        onClick={() => {
                          setDomainId(d.id)
                          if (module) updateParams({ module: null })
                        }}
                      >
                        {d.label}
                      </Button>
                    ))}
                  </Space>
                  <DataFiles
                    embedded
                    chinaInput={chinaInput}
                    initialModule={module}
                    initialFile={file}
                    initialSearch={search}
                    logicalModules={activeDomain.modules}
                    patternFilter={activeDomain.patterns}
                  />
                </Space>
              ),
            },
            {
              key: 'raw-xml',
              label: '原始 XML 源码（高级）',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text type="secondary">
                    面向高级用户的 XML 源码编辑器：支持查看、校验并覆盖任意 gcamdata 组件、政策文件或额外组件源码。
                  </Text>
                  <XmlBrowser embedded />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <StepFooter
        prev={{ label: '上一步：② 情景与政策', onClick: () => nav('/scenario') }}
        next={{ label: '下一步：④ 检查与运行', onClick: () => nav('/runs') }}
        hint="如已完成参数微调（或无需微调），可直接进入第 ④ 步核对并启动运行"
      />
    </div>
  )
}
