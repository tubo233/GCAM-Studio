import React, { useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Tabs, message } from 'antd'
import { apiPost, apiPut } from '../api'

export interface PolicyDraft { path: string; text: string; kind?: 'xml' | 'policy'; source?: string; overlay?: boolean }

const fields = new Set(['share-of-sector-output', 'constraint', 'fixedTax', 'totalPop', 'GDP', 'market', 'tax-name', 'target-value', 'target-type',
  'first-tax-year', 'initial-tax-guess', 'max-tax', 'target-tolerance', 'max-iterations', 'path-discount-rate'])

function mergeScenarios(text: string) {
  const parts = new DOMParser().parseFromString('<parts>' + text.replace(/^\s*<\?xml[^?]*\?>/, '') + '</parts>', 'application/xml')
  const scenarios = Array.from(parts.documentElement.children)
  if (parts.querySelector('parsererror') || scenarios.length < 2) return null
  const first = scenarios[0]
  const world = first.firstElementChild
  if (!world || scenarios.some(s => s.tagName !== 'scenario' || s.childElementCount !== 1 ||
      s.firstElementChild?.tagName !== 'world' || s.attributes.length !== first.attributes.length ||
      Array.from(s.attributes).some(a => a.value !== first.getAttribute(a.name)) || s.firstElementChild.attributes.length)) return null
  for (const s of scenarios.slice(1)) world.append(...Array.from(s.firstElementChild!.childNodes))
  return new XMLSerializer().serializeToString(first)
}

export default function PolicyFileEditor({profileId, file, close, saved, rawSource}: {
  rawSource?: string; profileId: string; file: PolicyDraft; close: () => void; saved: (path: string, root: string, use: boolean) => Promise<void>
}) {
  const [text, setText] = useState(() => file.source ? file.text : (mergeScenarios(file.text) || file.text))
  const joined = useMemo(() => !file.source && !!mergeScenarios(file.text), [file])
  const kind = file.kind || 'policy'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const doc = useMemo(() => new DOMParser().parseFromString(text, 'application/xml'), [text])
  const invalid = !!doc.querySelector('parsererror')
  const merged = useMemo(() => invalid ? mergeScenarios(text) : null, [invalid, text])
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => invalid ? [] : Array.from(doc.getElementsByTagName('*'))
    .filter(el => !el.childElementCount && fields.has(el.tagName))
    .map((el, i) => ({id: i, region: el.closest('region')?.getAttribute('name') || '全球',
      market: el.closest('ghgpolicy,linked-ghg-policy,policy-portfolio-standard')?.querySelector('market')?.textContent || '',
      policy: el.closest('ghgpolicy,linked-ghg-policy,policy-portfolio-standard')?.getAttribute('name') || '', el})), [doc, invalid])

  const change = (el: Element, attr: string, value: string) => {
    if (attr === 'text') el.textContent = value
    else el.setAttribute(attr, value)
    serialize()
  }
  const serialize = () => {
    const declaration = text.match(/^\s*<\?xml[^?]*\?>\s*/)?.[0] || ''
    const serialized = new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml\b[^?]*\?>\s*/, '')
    setText(declaration + serialized)
  }
  const save = async (use: boolean) => {
    setBusy(true)
    try {
      if(invalid) throw new Error('XML 格式有误，请检查源码。')
      if (rawSource) await apiPut(`/api/profiles/${profileId}/parameter-source`, {source:rawSource,text})
      else await apiPut('/api/xml/content', {profile_id: profileId, kind, path: file.path, text})
      await saved(file.path, doc.documentElement.tagName, use)
      message.success(use ? '文件及当前配置已保存' : '已保存到当前 Profile')
    } catch (e: any) { setError(e.response?.data?.detail || e.message || '保存失败') }
    finally { setBusy(false) }
  }
  return <Modal open title={file.path} width={900} onCancel={close} footer={<Space>
    <Button disabled={busy} onClick={close}>关闭</Button>
    <Button loading={busy} onClick={() => save(false)}>保存文件</Button>
    {kind === 'policy' && <Button type="primary" loading={busy} onClick={() => save(true)}>
      {doc.documentElement.tagName === 'policy-target-runner' ? '保存并选为目标' : '加入当前情景'}
    </Button>}
  </Space>}>
    {kind === 'xml' && !rawSource && <Alert type="info" showIcon message={`数据来源：${file.source}。直接保存的 XML 将优先于 CSV 生成的同名组件。`}
      action={file.overlay && <Button onClick={async () => {
        if (!window.confirm('移除本文件的 Profile 覆盖，恢复使用构建或模型中的 XML？')) return
        try {
          await apiPost('/api/files/revert', {profile_id:profileId,kind,path:file.path})
          close()
          message.success('已恢复使用构建或模型中的 XML')
        } catch (e: any) { setError(e.response?.data?.detail || '恢复失败') }
      }}>恢复随构建更新</Button>}/>}
    {merged && <Alert type="info" showIcon message="检测到多个并列的 scenario，可合并后在表格中编辑。" action={<Button onClick={() => setText(merged)}>合并地区到同一情景</Button>} />}
    {joined && <Alert type="info" message="预览已将文件中并列的 scenario 合为一个，保留各地区及市场设置。"/>}
    {rawSource && <Alert type="info" message="此处编辑源 XML。统一参数表中单独指定的值会在此文件之上应用。"/>}
    {error && <Alert type="error" showIcon message={error} />}
    <Tabs defaultActiveKey={!rawSource && rows.length ? 'values' : 'source'} items={[
      {key:'values', label:kind === 'xml' ? '地区与年份' : '政策数值', children: <><Input.Search aria-label="筛选政策参数" style={{width:250,marginBottom:8}} placeholder="筛选地区、年份或参数" allowClear value={filter} onChange={e => setFilter(e.target.value)}/>
      <Table size="small" rowKey="id" dataSource={rows.filter(r => {
          const searchable = [r.region, r.policy, r.el.tagName, r.el.closest('[year]')?.getAttribute('year')].join(' ').toLowerCase()
          return filter.toLowerCase().trim().split(/\s+/).every(term => searchable.includes(term))
        })} pagination={{pageSize:12}}
        locale={{emptyText:'可在 XML 源码中编辑此文件'}} columns={[
          {title:'地区',dataIndex:'region'}, {title:'市场',dataIndex:'market'}, {title:'政策',dataIndex:'policy'},
          {title:'参数',render:(_, r) => r.el.tagName},
          {title:'年份',render:(_, r) => r.el.hasAttribute('year') ? <Input aria-label="年份" value={r.el.getAttribute('year') || ''} onChange={e => change(r.el, 'year', e.target.value)} /> : r.el.closest('[year]')?.getAttribute('year') || '—'},
          {title:'值',render:(_, r) => <Input aria-label="参数值" value={r.el.textContent || ''} onChange={e => change(r.el, 'text', e.target.value)} />},
          {title:'',render:(_,r) => ['constraint','fixedTax'].includes(r.el.tagName) && <Button size="small" onClick={() => {
            const siblings = Array.from(r.el.parentElement!.children).filter(el => el.tagName === r.el.tagName && el.hasAttribute('year'))
            const copy = r.el.cloneNode(true) as Element
            copy.setAttribute('year',String(Math.max(...siblings.map(el => Number(el.getAttribute('year'))), Number(r.el.getAttribute('year'))) + 5))
            r.el.parentElement!.insertBefore(copy, siblings[siblings.length - 1]?.nextSibling || null)
            serialize()
          }}>增加年份</Button>},
        ]}/></>},
      {key:'source', label:'XML 源码', children:<Input.TextArea aria-label="政策 XML 源码" rows={18}
        style={{fontFamily:'monospace'}} value={text} onChange={e => setText(e.target.value)} />},
    ]}/>
  </Modal>
}
