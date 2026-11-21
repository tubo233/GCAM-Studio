import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { apiPut } from '../api'
import {
  analyzePolicyXml,
  checkPolicyFilename,
  detectPolicyConflicts,
  formatRegionLabel,
  type PolicyAnalysis,
} from '../utils/policyXml'

const { Text } = Typography

type RowItem = { name: string; value: string }
const policyPath = (value: string) => ('/' + value.replace(/\\/g, '/')).match(/\/input\/policy\/(.+)$/i)?.[1]
const policyRow = (path: string) => ({ name: path.replace(/\.xml$/i, ''), value: '../input/policy/' + path })

function setField(rows: RowItem[], name: string, value: string): RowItem[] {
  return rows.some((r) => r.name === name)
    ? rows.map((r) => (r.name === name ? { ...r, value } : r))
    : [...rows, { name, value }]
}

interface BatchRow {
  key: string
  originalName: string
  targetName: string
  analysis: PolicyAnalysis
  enableNow: boolean
}

export default function PolicyBatchImportModal({
  profileId,
  config,
  files,
  close,
  onImported,
}: {
  profileId: string
  config: any
  files: { name: string; text: string }[]
  close: () => void
  onImported: (nextConfig?: any, importedPaths?: string[]) => Promise<void>
}) {
  const [rows, setRows] = useState<BatchRow[]>(() =>
    files.map((f, idx) => {
      const analysis = analyzePolicyXml(f.name, f.text)
      return {
        key: `${idx}-${f.name}`,
        originalName: f.name,
        targetName: f.name,
        analysis,
        enableNow: analysis.valid,
      }
    }),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setRows(
      files.map((f, idx) => {
        const analysis = analyzePolicyXml(f.name, f.text)
        return {
          key: `${idx}-${f.name}`,
          originalName: f.name,
          targetName: f.name,
          analysis,
          enableNow: analysis.valid,
        }
      }),
    )
    setError('')
  }, [files])

  const updateTargetName = (key: string, value: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, targetName: value } : r)))
  }

  const toggleEnable = (key: string, checked: boolean) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, enableNow: checked } : r)))
  }

  const validRows = useMemo(() => rows.filter((r) => r.analysis.valid), [rows])
  const enabledRows = useMemo(() => validRows.filter((r) => r.enableNow), [validRows])

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of validRows) {
      const k = r.targetName.trim().toLowerCase()
      if (k) counts.set(k, (counts.get(k) || 0) + 1)
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, n]) => n > 1)
        .map(([k]) => k),
    )
  }, [validRows])

  const hasInvalidTargetNames = useMemo(
    () =>
      validRows.some((r) => {
        const clean = r.targetName.trim()
        return !clean || !/\.xml$/i.test(clean) || duplicateNames.has(clean.toLowerCase())
      }),
    [validRows, duplicateNames],
  )

  const crossConflicts = useMemo(
    () =>
      detectPolicyConflicts(
        enabledRows.map((r) => ({
          name: r.targetName.trim() || r.originalName,
          entries: r.analysis.entries,
        })),
      ),
    [enabledRows],
  )

  const sameMarketItems = useMemo(
    () =>
      validRows.flatMap((r) =>
        r.analysis.sameMarketWarnings.map((w) => ({
          name: r.targetName.trim() || r.originalName,
          warning: w,
        })),
      ),
    [validRows],
  )

  const handleConfirm = async () => {
    if (!validRows.length || hasInvalidTargetNames) return
    setBusy(true)
    setError('')
    try {
      const savedPaths: string[] = []
      for (const r of validRows) {
        const cleanName = r.targetName.trim()
        await apiPut('/api/xml/content', {
          profile_id: profileId,
          kind: 'policy',
          path: cleanName,
          text: r.analysis.normalizedText,
        })
        savedPaths.push(cleanName)
      }

      if (enabledRows.length > 0) {
        const nextConfig = {
          ...config,
          files: [...(config.files || [])],
          bools: [...(config.bools || [])],
          components: [...(config.components || [])],
        }
        for (const r of enabledRows) {
          const cleanName = r.targetName.trim()
          if (r.analysis.rootTag === 'policy-target-runner') {
            nextConfig.files = setField(nextConfig.files, 'policy-target-file', policyRow(cleanName).value)
            nextConfig.bools = setField(nextConfig.bools, 'find-path', '1')
          } else if (nextConfig.components.some((c: RowItem) => policyPath(c.value) === cleanName)) {
            nextConfig.components = nextConfig.components.map((c: RowItem) =>
              policyPath(c.value) === cleanName ? { ...c, value: policyRow(cleanName).value } : c,
            )
          } else {
            nextConfig.components = [...nextConfig.components, policyRow(cleanName)]
          }
        }
        const result = await apiPut(`/api/profiles/${profileId}/config`, nextConfig)
        await onImported({ ...nextConfig, revision: result.revision }, savedPaths)
        message.success(`已导入 ${validRows.length} 个政策文件，并启用 ${enabledRows.length} 个到当前情景`)
      } else {
        await onImported(undefined, savedPaths)
        message.success(`已导入 ${validRows.length} 个政策文件到当前情景政策库`)
      }
    } catch (e: any) {
      setError(e.response?.data?.detail || e.message || '批量导入失败')
    } finally {
      setBusy(false)
    }
  }

  const renderRegionsSummary = (regions: string[]) => {
    if (!regions.length) return '—'
    const formatted = regions.map(formatRegionLabel)
    return formatted.length <= 4
      ? formatted.join('、')
      : `${formatted.slice(0, 4).join('、')} 等 ${formatted.length} 个`
  }

  return (
    <Modal
      open
      title={`批量导入政策 XML（共 ${rows.length} 个文件，可启用 ${enabledRows.length} 个）`}
      width={1020}
      onCancel={busy ? undefined : close}
      maskClosable={!busy}
      footer={
        <Space>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!validRows.length || hasInvalidTargetNames}
            onClick={handleConfirm}
          >
            确认导入（保存 {validRows.length} 个 · 启用 {enabledRows.length} 个）
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {crossConflicts.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`已勾选“立即启用”的政策之间存在 ${crossConflicts.length} 处跨文件冲突（可关闭其中冲突项的开关后导入）`}
            description={
              <Space direction="vertical" size={4}>
                {crossConflicts.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Space>
            }
          />
        )}

        {sameMarketItems.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`检测到 ${sameMarketItems.length} 处同市场重复 constraint 上限`}
            description={
              <Space direction="vertical" size={4}>
                {sameMarketItems.map((item, i) => (
                  <div key={i}>
                    <Text strong>{item.name}：</Text>
                    {item.warning}
                  </div>
                ))}
              </Space>
            }
          />
        )}

        {error && <Alert type="error" showIcon message={error} />}

        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: '保存文件名',
              width: 270,
              render: (_, r) => {
                const clean = r.targetName.trim()
                const isEmpty = !clean
                const missingExt = !!clean && !/\.xml$/i.test(clean)
                const isDup = !!clean && duplicateNames.has(clean.toLowerCase())
                const { hasNonAscii, hasSpaces, suggestedFilename } = checkPolicyFilename(r.targetName)
                return (
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Input
                      size="small"
                      disabled={!r.analysis.valid || busy}
                      value={r.targetName}
                      status={
                        isEmpty || missingExt || isDup || hasNonAscii
                          ? 'error'
                          : hasSpaces
                            ? 'warning'
                            : undefined
                      }
                      onChange={(e) => updateTargetName(r.key, e.target.value)}
                    />
                    {isEmpty && (
                      <Text type="danger" style={{ fontSize: 12 }}>
                        文件名不能为空
                      </Text>
                    )}
                    {missingExt && (
                      <Text type="danger" style={{ fontSize: 12 }}>
                        文件名须以 .xml 结尾
                      </Text>
                    )}
                    {isDup && (
                      <Text type="danger" style={{ fontSize: 12 }}>
                        与其他待导入文件重名
                      </Text>
                    )}
                    {hasNonAscii && (
                      <Text type="danger" style={{ fontSize: 12 }}>
                        含中文或非 ASCII 字符，GCAM 底层无法可靠读取，建议改为英文文件名
                      </Text>
                    )}
                    {hasSpaces && (
                      <Space size={6}>
                        <Text type="warning" style={{ fontSize: 12 }}>
                          含空格
                        </Text>
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0, height: 'auto', fontSize: 12 }}
                          onClick={() => updateTargetName(r.key, suggestedFilename)}
                        >
                          一键清理空格
                        </Button>
                      </Space>
                    )}
                  </Space>
                )
              },
            },
            {
              title: '体检状态',
              width: 190,
              render: (_, r) => {
                if (!r.analysis.valid) {
                  return <Tag color="error">XML 错误不可导入</Tag>
                }
                return (
                  <Space direction="vertical" size={4}>
                    {r.analysis.autoMergedCount > 0 ? (
                      <Tag color="processing">已自动合并 {r.analysis.autoMergedCount} 个 scenario</Tag>
                    ) : (
                      <Tag color="success">正常</Tag>
                    )}
                    {r.analysis.sameMarketWarnings.length > 0 && <Tag color="warning">同市场重复上限</Tag>}
                  </Space>
                )
              },
            },
            {
              title: '解析摘要',
              render: (_, r) => {
                if (!r.analysis.valid) {
                  return <Text type="danger">{r.analysis.error || 'XML 格式有误'}</Text>
                }
                const { rootTag, regions, policies, markets, minYear, maxYear } = r.analysis
                const yearText =
                  minYear !== undefined
                    ? minYear === maxYear
                      ? `${minYear}`
                      : `${minYear}–${maxYear}`
                    : '—'
                return (
                  <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                    <div>
                      <Text type="secondary">地区：</Text>
                      {renderRegionsSummary(regions)}
                    </div>
                    <div>
                      <Text type="secondary">政策：</Text>
                      {policies.join('、') || '—'}
                      <Text type="secondary" style={{ marginLeft: 10 }}>
                        市场：
                      </Text>
                      {markets.join('、') || '—'}
                      <Text type="secondary" style={{ marginLeft: 10 }}>
                        年份：
                      </Text>
                      {yearText}
                      {rootTag && rootTag !== 'scenario' && (
                        <Tag style={{ marginLeft: 8 }}>{rootTag}</Tag>
                      )}
                    </div>
                  </Space>
                )
              },
            },
            {
              title: '立即启用到当前情景',
              width: 145,
              align: 'center',
              render: (_, r) => (
                <Switch
                  aria-label={`启用 ${r.targetName}`}
                  checked={r.enableNow}
                  disabled={!r.analysis.valid || busy}
                  onChange={(checked) => toggleEnable(r.key, checked)}
                />
              ),
            },
          ]}
        />
      </Space>
    </Modal>
  )
}
