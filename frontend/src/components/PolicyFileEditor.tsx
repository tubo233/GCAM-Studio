import React, { useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Tabs, Typography, message } from 'antd'
import { apiPost, apiPut } from '../api'
import { analyzePolicyXml, mergeScenarios } from '../utils/policyXml'

const { Text } = Typography

export interface PolicyDraft {
  path: string
  text: string
  kind?: 'xml' | 'policy'
  source?: string
  overlay?: boolean
}

const fields = new Set([
  'share-of-sector-output',
  'constraint',
  'fixedTax',
  'totalPop',
  'GDP',
  'market',
  'tax-name',
  'target-value',
  'target-type',
  'first-tax-year',
  'initial-tax-guess',
  'max-tax',
  'target-tolerance',
  'max-iterations',
  'path-discount-rate',
])

export default function PolicyFileEditor({
  profileId,
  file,
  close,
  saved,
  rawSource,
}: {
  rawSource?: string
  profileId: string
  file: PolicyDraft
  close: () => void
  saved: (path: string, root: string, use: boolean) => Promise<void>
}) {
  const initialMerge = useMemo(() => (!file.source ? mergeScenarios(file.text) : null), [file])
  const [text, setText] = useState(() => (initialMerge ? initialMerge.merged : file.text))
  const joinedCount = initialMerge?.count || 0
  const canRename = !file.source && !rawSource
  const [targetPath, setTargetPath] = useState(file.path)
  const kind = file.kind || 'policy'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const doc = useMemo(() => new DOMParser().parseFromString(text, 'application/xml'), [text])
  const invalid = !!doc.querySelector('parsererror')
  const merged = useMemo(() => (invalid ? mergeScenarios(text) : null), [invalid, text])
  const activePath = canRename ? targetPath : file.path
  const analysis = useMemo(() => analyzePolicyXml(activePath, text), [activePath, text])

  const [filter, setFilter] = useState('')
  const rows = useMemo(
    () =>
      invalid
        ? []
        : Array.from(doc.getElementsByTagName('*'))
            .filter((el) => !el.childElementCount && fields.has(el.tagName))
            .map((el, i) => ({
              id: i,
              region: el.closest('region')?.getAttribute('name') || '全球',
              market:
                el.closest('ghgpolicy,linked-ghg-policy,policy-portfolio-standard')?.querySelector('market')
                  ?.textContent || '',
              policy:
                el.closest('ghgpolicy,linked-ghg-policy,policy-portfolio-standard')?.getAttribute('name') || '',
              el,
            })),
    [doc, invalid],
  )

  const change = (el: Element, attr: string, value: string) => {
    if (attr === 'text') el.textContent = value
    else el.setAttribute(attr, value)
    serialize()
  }

  const serialize = () => {
    const declaration = text.match(/^\s*<\?xml[^?]*\?>\s*/)?.[0] || ''
    const serialized = new XMLSerializer()
      .serializeToString(doc)
      .replace(/^\s*<\?xml\b[^?]*\?>\s*/, '')
    setText(declaration + serialized)
  }

  const save = async (use: boolean) => {
    setBusy(true)
    setError('')
    try {
      const savePath = (canRename ? targetPath : file.path).trim()
      if (!savePath) throw new Error('保存文件名不能为空。')
      if (canRename && !/\.xml$/i.test(savePath)) throw new Error('保存文件名须以 .xml 结尾。')
      if (invalid) throw new Error('XML 格式有误，请检查源码。')
      if (rawSource) await apiPut(`/api/profiles/${profileId}/parameter-source`, { source: rawSource, text })
      else await apiPut('/api/xml/content', { profile_id: profileId, kind, path: savePath, text })
      await saved(savePath, doc.documentElement.tagName, use)
      message.success(use ? '文件及当前配置已保存' : '已保存到当前 Profile')
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const hasNonAscii = /[^\x00-\x7F]/.test(targetPath)
  const hasSpaces = /\s/.test(targetPath)

  return (
    <Modal
      open
      title={canRename ? targetPath || file.path : file.path}
      width={900}
      onCancel={close}
      footer={
        <Space>
          <Button disabled={busy} onClick={close}>
            关闭
          </Button>
          <Button loading={busy} onClick={() => save(false)}>
            保存文件
          </Button>
          {kind === 'policy' && (
            <Button type="primary" loading={busy} onClick={() => save(true)}>
              {doc.documentElement.tagName === 'policy-target-runner' ? '保存并选为目标' : '加入当前情景'}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
        {canRename && (
          <Space wrap align="center">
            <Text strong>保存文件名：</Text>
            <Input
              aria-label="保存文件名"
              style={{ width: 320 }}
              value={targetPath}
              status={hasNonAscii || !targetPath.trim() ? 'error' : hasSpaces ? 'warning' : undefined}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="例如 co2_SC.xml"
            />
            {hasSpaces && (
              <Button size="small" onClick={() => setTargetPath(analysis.suggestedFilename)}>
                一键规范化空格
              </Button>
            )}
          </Space>
        )}

        {canRename && hasNonAscii && (
          <Alert
            type="warning"
            showIcon
            message="GCAM 底层无法可靠读取中文文件名，建议改为纯英文文件名"
          />
        )}

        {canRename && hasSpaces && (
          <Alert
            type="info"
            showIcon
            message={`文件名包含空格，建议规范化为「${analysis.suggestedFilename}」`}
            action={
              <Button size="small" onClick={() => setTargetPath(analysis.suggestedFilename)}>
                使用建议文件名
              </Button>
            }
          />
        )}

        {kind === 'xml' && !rawSource && (
          <Alert
            type="info"
            showIcon
            message={`数据来源：${file.source}。直接保存的 XML 将优先于 CSV 生成的同名组件。`}
            action={
              file.overlay && (
                <Button
                  onClick={async () => {
                    if (!window.confirm('移除本文件的 Profile 覆盖，恢复使用构建或模型中的 XML？')) return
                    try {
                      await apiPost('/api/files/revert', { profile_id: profileId, kind, path: file.path })
                      close()
                      message.success('已恢复使用构建或模型中的 XML')
                    } catch (e: any) {
                      setError(e.response?.data?.detail || '恢复失败')
                    }
                  }}
                >
                  恢复随构建更新
                </Button>
              )
            }
          />
        )}

        {merged && (
          <Alert
            type="info"
            showIcon
            message={`检测到 ${merged.count} 个并列的 scenario，可合并后在表格中编辑。`}
            action={<Button onClick={() => setText(merged.merged)}>合并地区到同一情景</Button>}
          />
        )}

        {joinedCount > 0 && (
          <Alert
            type="info"
            showIcon
            message={`预览已将文件中 ${joinedCount} 个并列的 scenario 合为一个，保留各地区及市场设置。`}
          />
        )}

        {analysis.sameMarketWarnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="检测到同市场重复上限（constraint）"
            description={
              <Space direction="vertical" size={4}>
                {analysis.sameMarketWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Space>
            }
          />
        )}

        {rawSource && <Alert type="info" message="此处编辑源 XML。统一参数表中单独指定的值会在此文件之上应用。" />}
        {error && <Alert type="error" showIcon message={error} />}
      </Space>

      <Tabs
        defaultActiveKey={!rawSource && rows.length ? 'values' : 'source'}
        items={[
          {
            key: 'values',
            label: kind === 'xml' ? '地区与年份' : '政策数值',
            children: (
              <>
                <Input.Search
                  aria-label="筛选政策参数"
                  style={{ width: 250, marginBottom: 8 }}
                  placeholder="筛选地区、年份或参数"
                  allowClear
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <Table
                  size="small"
                  rowKey="id"
                  dataSource={rows.filter((r) => {
                    const searchable = [
                      r.region,
                      r.policy,
                      r.el.tagName,
                      r.el.closest('[year]')?.getAttribute('year'),
                    ]
                      .join(' ')
                      .toLowerCase()
                    return filter
                      .toLowerCase()
                      .trim()
                      .split(/\s+/)
                      .every((term) => searchable.includes(term))
                  })}
                  pagination={{ pageSize: 12 }}
                  locale={{ emptyText: '可在 XML 源码中编辑此文件' }}
                  columns={[
                    { title: '地区', dataIndex: 'region' },
                    { title: '市场', dataIndex: 'market' },
                    { title: '政策', dataIndex: 'policy' },
                    { title: '参数', render: (_, r) => r.el.tagName },
                    {
                      title: '年份',
                      render: (_, r) =>
                        r.el.hasAttribute('year') ? (
                          <Input
                            aria-label="年份"
                            value={r.el.getAttribute('year') || ''}
                            onChange={(e) => change(r.el, 'year', e.target.value)}
                          />
                        ) : (
                          r.el.closest('[year]')?.getAttribute('year') || '—'
                        ),
                    },
                    {
                      title: '值',
                      render: (_, r) => (
                        <Input
                          aria-label="参数值"
                          value={r.el.textContent || ''}
                          onChange={(e) => change(r.el, 'text', e.target.value)}
                        />
                      ),
                    },
                    {
                      title: '',
                      render: (_, r) =>
                        ['constraint', 'fixedTax'].includes(r.el.tagName) && (
                          <Button
                            size="small"
                            onClick={() => {
                              const siblings = Array.from(r.el.parentElement!.children).filter(
                                (el) => el.tagName === r.el.tagName && el.hasAttribute('year'),
                              )
                              const copy = r.el.cloneNode(true) as Element
                              copy.setAttribute(
                                'year',
                                String(
                                  Math.max(
                                    ...siblings.map((el) => Number(el.getAttribute('year'))),
                                    Number(r.el.getAttribute('year')),
                                  ) + 5,
                                ),
                              )
                              r.el.parentElement!.insertBefore(
                                copy,
                                siblings[siblings.length - 1]?.nextSibling || null,
                              )
                              serialize()
                            }}
                          >
                            增加年份
                          </Button>
                        ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'source',
            label: 'XML 源码',
            children: (
              <Input.TextArea
                aria-label="政策 XML 源码"
                rows={18}
                style={{ fontFamily: 'monospace' }}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            ),
          },
        ]}
      />
    </Modal>
  )
}
