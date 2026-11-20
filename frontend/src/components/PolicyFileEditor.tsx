import React, { useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Tabs, message } from 'antd'
import { apiPut } from '../api'

export interface PolicyDraft { path: string; text: string; imported?: boolean }

const fields = new Set(['constraint', 'fixedTax', 'market', 'tax-name', 'target-value', 'target-type',
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

export default function PolicyFileEditor({profileId, file, close, saved}: {
  profileId: string; file: PolicyDraft; close: () => void; saved: (path: string, root: string, use: boolean) => Promise<void>
}) {
  const [text, setText] = useState(file.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const doc = useMemo(() => new DOMParser().parseFromString(text, 'application/xml'), [text])
  const invalid = !!doc.querySelector('parsererror')
  const merged = useMemo(() => invalid ? mergeScenarios(text) : null, [invalid, text])
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => invalid ? [] : Array.from(doc.getElementsByTagName('*'))
    .filter(el => !el.childElementCount && fields.has(el.tagName))
    .map((el, i) => ({id: i, region: el.closest('region')?.getAttribute('name') || '全球',
      policy: el.closest('ghgpolicy,linked-ghg-policy')?.getAttribute('name') || '', el})), [doc, invalid])

  const change = (el: Element, attr: string, value: string) => {
    if (attr === 'text') el.textContent = value
    else el.setAttribute(attr, value)
    serialize()
  }
  const serialize = () => {
    const declaration = text.match(/^\s*<\?xml[^?]*\?>\s*/)?.[0] || ''
    setText(declaration + new XMLSerializer().serializeToString(doc))
  }
  const save = async (use: boolean) => {
    setBusy(true)
    try {
      await apiPut('/api/xml/content', {profile_id: profileId, kind: 'policy', path: file.path, text})
      await saved(file.path, doc.documentElement.tagName, use)
      message.success(use ? '文件及当前配置已保存' : '已保存到当前 Profile')
    } catch (e: any) { setError(e.response?.data?.detail || e.message || '保存失败') }
    finally { setBusy(false) }
  }
  return <Modal open title={file.path} width={900} onCancel={close} footer={<Space>
    <Button disabled={busy} onClick={close}>关闭</Button>
    <Button loading={busy} onClick={() => save(false)}>保存文件</Button>
    <Button type="primary" loading={busy} onClick={() => save(true)}>
      {doc.documentElement.tagName === 'policy-target-runner' ? '保存并选为目标' : '保存并启用组件'}
    </Button>
  </Space>}>
    {merged && <Alert type="info" showIcon message="检测到多个并列的 scenario，可合并后在表格中编辑。" action={<Button onClick={() => setText(merged)}>合并地区到同一情景</Button>} />}
    {error && <Alert type="error" showIcon message={error} />}
    <Tabs defaultActiveKey={rows.length ? 'values' : 'source'} items={[
      {key:'values', label:'政策数值', children: <><Input.Search aria-label="筛选政策参数" style={{width:250,marginBottom:8}} placeholder="筛选地区、政策或参数" allowClear value={filter} onChange={e => setFilter(e.target.value)}/>
      <Table size="small" rowKey="id" dataSource={rows.filter(r => [r.region,r.policy,r.el.tagName].some(v => v.toLowerCase().includes(filter.toLowerCase())))} pagination={{pageSize:12}}
        locale={{emptyText:'可在 XML 源码中编辑此文件'}} columns={[
          {title:'地区',dataIndex:'region'}, {title:'政策',dataIndex:'policy'},
          {title:'参数',render:(_, r) => r.el.tagName},
          {title:'年份',render:(_, r) => r.el.hasAttribute('year') ? <Input aria-label="年份" value={r.el.getAttribute('year') || ''} onChange={e => change(r.el, 'year', e.target.value)} /> : '—'},
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
