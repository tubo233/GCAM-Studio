import React from 'react'
import { Badge, Button, Space, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined, CheckOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Title, Text } = Typography

export interface WorkflowStepMeta {
  step: number
  key: string
  short: string
  title: string
  desc: string
  optional?: boolean
}

export const WORKFLOW_STEPS: WorkflowStepMeta[] = [
  {
    step: 1,
    key: '/profiles',
    short: '选择情景',
    title: '选择或新建情景（Profile）',
    desc: '每套情景完全隔离，仅保存你修改的配置与数据覆盖层。',
  },
  {
    step: 2,
    key: '/scenario',
    short: '情景与政策',
    title: '设定社会经济模板、政策约束与气候目标',
    desc: '选择 SSP 方案、配置碳税或排放上限，决定本次模拟的核心政策组合。',
  },
  {
    step: 3,
    key: '/parameters',
    short: '参数与数据',
    title: '微调参数与底层数据',
    desc: '按需调整人口、GDP、技术成本/效率或底层 CSV（不做精细数据改动可直接跳过）。',
    optional: true,
  },
  {
    step: 4,
    key: '/runs',
    short: '检查与运行',
    title: '核对改动并启动 GCAM 求解',
    desc: '查看相比上次运行的全部变化，选择运行模式并跟踪模型求解进度。',
  },
  {
    step: 5,
    key: '/results',
    short: '结果与对比',
    title: '查询指标、可视化与跨情景对比',
    desc: '从成功运行的数据库提取指标图表，支持多运行横向对比与按需导出。',
  },
]

export function stepForPath(pathname: string): number | null {
  if (pathname.startsWith('/profiles')) return 1
  if (pathname.startsWith('/scenario') || pathname.startsWith('/model-config') || pathname.startsWith('/policy')) return 2
  if (
    pathname.startsWith('/parameters') ||
    pathname.startsWith('/parameter-table') ||
    pathname.startsWith('/data') ||
    pathname.startsWith('/xml')
  ) {
    return 3
  }
  if (pathname.startsWith('/runs')) return 4
  if (pathname.startsWith('/results') || pathname.startsWith('/compare')) return 5
  return null
}

export function WorkflowBar({
  currentStep,
  hasProfile,
  hasRunningJob,
}: {
  currentStep: number
  hasProfile: boolean
  hasRunningJob: boolean
}) {
  const nav = useNavigate()

  return (
    <nav className="workflow-bar" aria-label="GCAM 执行流程步骤">
      {WORKFLOW_STEPS.map((item, idx) => {
        const isActive = item.step === currentStep
        const isDone = (item.step === 1 && hasProfile && currentStep > 1) || item.step < currentStep
        return (
          <React.Fragment key={item.key}>
            {idx > 0 && <span className="workflow-arrow" aria-hidden="true">→</span>}
            <button
              type="button"
              className={`workflow-step${isActive ? ' active' : ''}${isDone && !isActive ? ' done' : ''}`}
              onClick={() => nav(item.key)}
              title={item.desc}
            >
              <span className="step-badge">
                {isDone && !isActive ? <CheckOutlined style={{ fontSize: 11 }} /> : item.step}
              </span>
              <span>{item.short}</span>
              {item.optional && (
                <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', padding: '0 5px' }}>可选</Tag>
              )}
              {item.step === 4 && hasRunningJob && <Badge status="processing" />}
            </button>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

export function StepHeader({
  step,
  title,
  description,
  tags,
  extra,
}: {
  step?: number
  title: string
  description: string
  tags?: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <div className="step-header">
      <div>
        <div className="step-header-title">
          {step !== undefined && (
            <span
              className="step-badge"
              style={{ width: 26, height: 26, fontSize: 13, background: '#1668dc', color: '#fff', borderColor: '#1668dc' }}
            >
              {step}
            </span>
          )}
          <Title level={3} className="page-title" style={{ margin: 0 }}>
            {title}
          </Title>
          {tags}
        </div>
        <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
          {description}
        </Text>
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  )
}

export interface FooterAction {
  label: string
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}

export function StepFooter({
  prev,
  next,
  secondaryNext,
  hint,
}: {
  prev?: FooterAction
  next?: FooterAction
  secondaryNext?: FooterAction
  hint?: string
}) {
  return (
    <div className="step-footer">
      <div>
        {prev ? (
          <Button icon={<ArrowLeftOutlined />} onClick={prev.onClick} loading={prev.loading} disabled={prev.disabled}>
            {prev.label}
          </Button>
        ) : (
          <span />
        )}
      </div>
      {hint && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Text>
      )}
      <Space wrap>
        {secondaryNext && (
          <Button onClick={secondaryNext.onClick} loading={secondaryNext.loading} disabled={secondaryNext.disabled}>
            {secondaryNext.label}
          </Button>
        )}
        {next && (
          <Button
            type="primary"
            icon={<ArrowRightOutlined />}
            iconPosition="end"
            onClick={next.onClick}
            loading={next.loading}
            disabled={next.disabled}
          >
            {next.label}
          </Button>
        )}
      </Space>
    </div>
  )
}
