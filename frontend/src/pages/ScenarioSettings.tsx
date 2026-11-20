import React, { useRef, useState } from 'react'
import { Button, Checkbox, Form, Input, Select, Space, Switch, Table, Typography, message } from 'antd'
import { apiGet, apiPost, apiPut } from '../api'
import PolicyFileEditor, { type PolicyDraft } from '../components/PolicyFileEditor'
import type { XmlItem } from '../types'

type Row = {name: string; value: string}
const policyPath = (value: string) => ('/' + value.replace(/\\/g, '/')).match(/\/input\/policy\/(.+)$/i)?.[1]
const policyRow = (path: string) => ({name:path.replace(/\.xml$/i,''), value:'../input/policy/' + path})
function field(rows: Row[], name: string, value: string) {
  return rows.some(r => r.name === name) ? rows.map(r => r.name === name ? {...r, value} : r) : [...rows, {name,value}]
}

export default function ScenarioSettings({id, config, setConfig, xmls, refreshPolicies}: {
  id: string; config: any; setConfig: React.Dispatch<React.SetStateAction<any>>; xmls: XmlItem[]; refreshPolicies: () => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [file, setFile] = useState<PolicyDraft | null>(null)
  const [extra, setExtra] = useState<string[]>([])
  const [templateBusy, setTemplateBusy] = useState(false)
  const [template, setTemplate] = useState<string>()
  const importRef = useRef<HTMLInputElement>(null)
  const openId = useRef(0)
  const active = (config.components as Row[]).map(r => policyPath(r.value)).filter((s): s is string => !!s)
  const target = (config.files as Row[]).find(r => r.name === 'policy-target-file')?.value || ''
  const targetPath = policyPath(target) || target
  const findPath = /^(1|true)$/i.test(config.bools.find((r: Row) => r.name === 'find-path')?.value || '')
  const all = [...new Set([...active, ...extra, ...xmls.filter(x => x.kind === 'policy').map(x => x.path)])]
  const items = all.filter(path => path.toLowerCase().includes(search.toLowerCase()))
  const options = all.map(value => ({value, label:value}))

  const open = async (path: string, kind: 'xml' | 'policy' = 'policy') => {
    const request = ++openId.current
    try {
      const r = await apiGet('/api/xml/content', {profile_id:id,kind,path,run_input:kind === 'xml'})
      if (openId.current === request) setFile({path, text:r.text, kind, source:r.source, overlay:r.is_overlay})
    } catch (e: any) { message.error(e.response?.data?.detail || '文件读取失败') }
  }
  const toggle = (path: string, on: boolean) => setConfig((c: any) => {
    const rows: Row[] = c.components
    return {...c, components: on ? rows.some(r => policyPath(r.value) === path) ? rows : [...rows, policyRow(path)] :
      rows.filter(r => policyPath(r.value) !== path)}
  })
  const useTemplate = async (name: string) => {
    setTemplateBusy(true)
    try {
      const rows = await apiPost(`/api/profiles/${id}/config/template-components`, {template:name, components:config.components})
      setConfig((c: any) => ({...c, components:rows}))
      setTemplate(name)
    } catch (e: any) {message.error(e.response?.data?.detail || '无法读取模板')}
    finally {setTemplateBusy(false)}
  }
  const savedFile = async (path: string, root: string, use: boolean) => {
    if (file?.kind !== 'xml') setExtra(prev => [...new Set([...prev, path])])
    if (use) {
      const next = {...config}
      if (root === 'policy-target-runner') {
        next.files = field(next.files,'policy-target-file',policyRow(path).value)
        next.bools = field(next.bools,'find-path','1')
      } else if (next.components.some((r: Row) => policyPath(r.value) === path)) {
        next.components = next.components.map((r: Row) => policyPath(r.value) === path ? {...r,value:policyRow(path).value} : r)
      } else {
        next.components = [...next.components,policyRow(path)]
      }
      try {
        const result = await apiPut(`/api/profiles/${id}/config`, next)
        setConfig({...next, revision:result.revision})
      } catch (error: any) {
        setConfig(next)
        throw new Error('文件已保存，配置仍在编辑中。' + (error.response?.data?.detail || '请重试保存配置。'))
      }
    }
    setFile(null)
  }
  const example = ['spa14_tax.xml','carbon_tax_0.xml','2025_target_finder.xml']
  const addExample = () => setConfig((c: any) => {
    const missing = example.filter(p => !c.components.some((r: Row) => policyPath(r.value) === p))
    return {...c,components:[...c.components,...missing.map(policyRow)]}
  })
  return <Space direction="vertical" size="middle" style={{width:'100%'}}>
    <Form layout="vertical" component="div">
      <Space align="start" wrap>
        <Form.Item label="基础组件模板"><Select style={{minWidth:260}} placeholder="套用模板，保留自定义组件和政策"
          loading={templateBusy} disabled={templateBusy} value={template} onChange={useTemplate}
          options={config.templates.map((value:string) => ({value,label:value}))}/></Form.Item>
        <Form.Item label="场景名称"><Input value={config.strings.find((r: Row) => r.name === 'scenarioName')?.value || ''}
          onChange={e => setConfig({...config,strings:field(config.strings,'scenarioName',e.target.value)})}/></Form.Item>
      </Space>
      <div>当前社会经济输入 · {(config.components as Row[]).filter(r => /(?:^|[\\/])socioeconomics[^\\/]*\.xml$/i.test(r.value)).map((r,i) => {
        const path = r.value.replace(/\\/g,'/')
        const prefix = (config.model_root || '').replace(/\\/g,'/') + '/input/gcamdata/xml/'
        const relative = path.match(/^(?:\.\.\/|\.\/)?input\/gcamdata\/xml\/(.+)$/i)?.[1] ||
          (path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : '')
        return relative ? <Button type="link" key={i} title="按地区和年份编辑当前组件" onClick={() => open(relative, 'xml')}>{relative}</Button>
          : <Typography.Text key={i}>{r.value} </Typography.Text>
      })}</div>
    </Form>
    <Space wrap>
      <Checkbox checked={findPath} onChange={e => setConfig({...config,bools:field(config.bools,'find-path',e.target.checked ? '1':'0')})}>搜索气候目标</Checkbox>
      <Select aria-label="目标文件" showSearch value={targetPath || undefined} placeholder="目标文件" style={{minWidth:255}} options={options}
        onChange={p => setConfig({...config,files:field(config.files,'policy-target-file',policyRow(p).value)})}/>
      <Button disabled={!targetPath || !all.includes(targetPath)} onClick={() => open(targetPath)}>编辑目标</Button>
      {example.every(p => all.includes(p)) && <Button title={example.join('、')} onClick={addExample}>加入模型自带的 2025 碳价示例组件</Button>}
    </Space>
    <Space wrap>
      <Input.Search style={{width:250}} placeholder="搜索政策文件" allowClear value={search} onChange={e => setSearch(e.target.value)}/>
      <Button onClick={() => importRef.current?.click()}>导入政策 XML</Button>
      <Button onClick={() => refreshPolicies().catch(() => message.error('政策目录刷新失败'))}>刷新政策目录</Button>
      <input ref={importRef} type="file" accept=".xml" hidden onChange={async e => {
        const f = e.target.files?.[0]; e.target.value = ''
        if (f) { ++openId.current; setFile({path:f.name, text:await f.text()}) }
      }}/>
    </Space>
    <Table size="small" rowKey={p => p} dataSource={items} pagination={{pageSize:8,showSizeChanger:false}}
      columns={[{title:'政策文件',render:(_,p) => <Button type="link" onClick={() => open(p)}>{p}</Button>},
        {title:'作为情景组件启用',width:190,render:(_,p) => <Switch aria-label={`启用 ${p}`} checked={active.includes(p)} onChange={v => toggle(p,v)}/>}]}/>
    <Typography.Text type="secondary">文件内容保存在当前 Profile。模板、目标和勾选状态随「保存配置」生效。</Typography.Text>
    {file && <PolicyFileEditor key={file.path} profileId={id} file={file} close={() => setFile(null)} saved={savedFile}/>}
  </Space>
}
