export interface PolicyEntry {
  region: string
  policy: string
  market: string
  constraintYears: string[]
  fixedTaxYears: string[]
}

export interface PolicyAnalysis {
  filename: string
  valid: boolean
  error?: string
  normalizedText: string
  autoMergedCount: number
  rootTag: string
  regions: string[]
  markets: string[]
  policies: string[]
  years: string[]
  minYear?: number
  maxYear?: number
  hasExplicitConstraint: boolean
  entries: PolicyEntry[]
  sameMarketWarnings: string[]
  filenameWarnings: string[]
  suggestedFilename: string
}

export function formatRegionLabel(region: string): string {
  if (region === 'SC') return '四川 (SC)'
  if (region === 'CQ') return '重庆 (CQ)'
  return region
}

export function checkPolicyFilename(filename: string): {
  filenameWarnings: string[]
  suggestedFilename: string
  hasNonAscii: boolean
  hasSpaces: boolean
} {
  const suggestedFilename = filename.trim().replace(/\s*_+\s*|\s+/g, '_')
  const hasNonAscii = /[^\x00-\x7F]/.test(filename)
  const hasSpaces = /\s/.test(filename)
  const filenameWarnings: string[] = []
  if (hasNonAscii) {
    filenameWarnings.push('GCAM 底层无法可靠读取中文文件名，建议改为纯英文文件名')
  }
  if (hasSpaces) {
    filenameWarnings.push(`文件名包含空格，建议规范化为「${suggestedFilename}」`)
  }
  return { filenameWarnings, suggestedFilename, hasNonAscii, hasSpaces }
}

export function mergeScenarios(text: string): { merged: string; count: number } | null {
  const clean = text.replace(/^\uFEFF/, '')
  const declMatch = clean.match(/^\s*(<\?xml[^?]*\?>)/i)
  const body = clean.replace(/^\s*<\?xml[^?]*\?>/i, '')
  const parts = new DOMParser().parseFromString(`<parts>${body}</parts>`, 'application/xml')
  const scenarios = Array.from(parts.documentElement.children)
  if (parts.querySelector('parsererror') || scenarios.length < 2) return null

  const first = scenarios[0]
  const world = first.firstElementChild
  if (
    !world ||
    scenarios.some(
      (s) =>
        s.tagName !== 'scenario' ||
        s.childElementCount !== 1 ||
        s.firstElementChild?.tagName !== 'world' ||
        s.attributes.length !== first.attributes.length ||
        Array.from(s.attributes).some((a) => a.value !== first.getAttribute(a.name)) ||
        s.firstElementChild.attributes.length > 0,
    )
  ) {
    return null
  }

  for (const s of scenarios.slice(1)) {
    world.append(...Array.from(s.firstElementChild!.childNodes))
  }

  const decl = declMatch ? declMatch[1] : '<?xml version="1.0" encoding="UTF-8"?>'
  const serialized = new XMLSerializer()
    .serializeToString(first)
    .replace(/^\s*<\?xml\b[^?]*\?>\s*/i, '')
  return {
    merged: `${decl}\n${serialized}`,
    count: scenarios.length,
  }
}

function formatYearsLabel(years: string[]): string {
  if (!years.length) return ''
  if (years.length === 1) return `${years[0]} 年`
  if (years.length <= 4) return `${years.join('、')} 年`
  return `${years[0]}–${years[years.length - 1]} 年（共 ${years.length} 个年份）`
}

export function analyzePolicyXml(filename: string, rawText: string): PolicyAnalysis {
  const { filenameWarnings, suggestedFilename } = checkPolicyFilename(filename)
  const cleaned = rawText.replace(/^\uFEFF/, '')
  let normalizedText = rawText
  let autoMergedCount = 0

  let doc = new DOMParser().parseFromString(cleaned, 'application/xml')
  if (doc.querySelector('parsererror')) {
    const merged = mergeScenarios(cleaned)
    if (merged) {
      const mergedDoc = new DOMParser().parseFromString(merged.merged, 'application/xml')
      if (!mergedDoc.querySelector('parsererror')) {
        doc = mergedDoc
        normalizedText = merged.merged
        autoMergedCount = merged.count
      }
    }
  }

  const parserErr = doc.querySelector('parsererror')
  if (parserErr || !doc.documentElement) {
    const errText = (parserErr?.textContent || 'XML 解析失败').trim().split(/\r?\n/)[0].slice(0, 160)
    return {
      filename,
      valid: false,
      error: errText,
      normalizedText: rawText,
      autoMergedCount: 0,
      rootTag: '',
      regions: [],
      markets: [],
      policies: [],
      years: [],
      hasExplicitConstraint: false,
      entries: [],
      sameMarketWarnings: [],
      filenameWarnings,
      suggestedFilename,
    }
  }

  const rootTag = doc.documentElement.tagName
  const hasExplicitConstraint = doc.getElementsByTagName('constraint').length > 0

  const policyEls = Array.from(
    doc.querySelectorAll('ghgpolicy, linked-ghg-policy, policy-portfolio-standard'),
  )
  const entries: PolicyEntry[] = policyEls.map((el) => {
    const region = el.closest('region')?.getAttribute('name')?.trim() || '全球'
    const policy = el.getAttribute('name')?.trim() || ''
    const marketEl =
      Array.from(el.children).find((c) => c.tagName === 'market') || el.querySelector('market')
    const market = marketEl?.textContent?.trim() || ''
    const constraintYears = Array.from(el.getElementsByTagName('constraint'))
      .map((c) => c.getAttribute('year')?.trim() || '')
      .filter(Boolean)
    const fixedTaxYears = Array.from(el.getElementsByTagName('fixedTax'))
      .map((c) => c.getAttribute('year')?.trim() || '')
      .filter(Boolean)
    return { region, policy, market, constraintYears, fixedTaxYears }
  })

  const regionSet = new Set<string>()
  for (const r of Array.from(doc.getElementsByTagName('region'))) {
    const name = r.getAttribute('name')?.trim()
    if (name) regionSet.add(name)
  }
  for (const e of entries) {
    if (e.region) regionSet.add(e.region)
  }

  const marketSet = new Set<string>()
  const policySet = new Set<string>()
  for (const e of entries) {
    if (e.market) marketSet.add(e.market)
    if (e.policy) policySet.add(e.policy)
  }

  const collectYears = (elements: Element[]) =>
    elements
      .map((el) => el.getAttribute('year')?.trim() || '')
      .filter((y) => y !== '' && Number.isFinite(Number(y)))

  let rawYears = collectYears(
    Array.from(doc.querySelectorAll('constraint, fixedTax, share-of-sector-output')),
  )
  if (!rawYears.length) {
    rawYears = collectYears(Array.from(doc.querySelectorAll('[year]')))
  }
  const years = Array.from(new Set(rawYears)).sort((a, b) => Number(a) - Number(b))
  const minYear = years.length ? Number(years[0]) : undefined
  const maxYear = years.length ? Number(years[years.length - 1]) : undefined

  const sameMarketWarnings: string[] = []
  const byMarketPolicy = new Map<string, { market: string; policy: string; entries: PolicyEntry[] }>()
  for (const entry of entries) {
    if (!entry.market || !entry.policy || !entry.constraintYears.length) continue
    const key = `${entry.market}\0${entry.policy}`
    let group = byMarketPolicy.get(key)
    if (!group) {
      group = { market: entry.market, policy: entry.policy, entries: [] }
      byMarketPolicy.set(key, group)
    }
    group.entries.push(entry)
  }

  for (const group of byMarketPolicy.values()) {
    const yearToRegions = new Map<string, Set<string>>()
    for (const entry of group.entries) {
      for (const y of entry.constraintYears) {
        let regs = yearToRegions.get(y)
        if (!regs) {
          regs = new Set<string>()
          yearToRegions.set(y, regs)
        }
        regs.add(entry.region)
      }
    }
    const overlapYears: string[] = []
    const overlapRegions = new Set<string>()
    for (const [y, regs] of yearToRegions.entries()) {
      if (regs.size >= 2) {
        overlapYears.push(y)
        for (const r of regs) overlapRegions.add(r)
      }
    }
    if (overlapYears.length > 0) {
      overlapYears.sort((a, b) => Number(a) - Number(b))
      const regionList = Array.from(overlapRegions).map(formatRegionLabel).join('、')
      const yearLabel = formatYearsLabel(overlapYears)
      sameMarketWarnings.push(
        `市场「${group.market}」（政策 ${group.policy}）在 ${yearLabel} 被 ${regionList} 重复写了 constraint 上限。GCAM 中同一年对同一市场重复写 constraint 后者可能覆盖前者；若为各省独立限额请将不同省设不同 market，若为联合市场建议仅在一处写合并上限。`,
      )
    }
  }

  return {
    filename,
    valid: true,
    normalizedText,
    autoMergedCount,
    rootTag,
    regions: Array.from(regionSet),
    markets: Array.from(marketSet),
    policies: Array.from(policySet),
    years,
    minYear,
    maxYear,
    hasExplicitConstraint,
    entries,
    sameMarketWarnings,
    filenameWarnings,
    suggestedFilename,
  }
}

export function detectPolicyConflicts(
  items: { name: string; entries: PolicyEntry[] }[],
): string[] {
  const warnings: string[] = []
  for (let i = 0; i < items.length; i++) {
    const a = items[i]
    const mapA = new Map<string, Set<string>>()
    for (const e of a.entries) {
      if (!e.region || !e.policy) continue
      const key = `${e.region}\0${e.policy}`
      let markets = mapA.get(key)
      if (!markets) {
        markets = new Set<string>()
        mapA.set(key, markets)
      }
      if (e.market) markets.add(e.market)
    }

    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]
      const conflictRegions = new Set<string>()
      const conflictPolicies = new Set<string>()
      const conflictMarkets = new Set<string>()

      for (const e of b.entries) {
        if (!e.region || !e.policy) continue
        const key = `${e.region}\0${e.policy}`
        const marketsA = mapA.get(key)
        if (!marketsA) continue
        conflictRegions.add(e.region)
        conflictPolicies.add(e.policy)
        for (const m of marketsA) conflictMarkets.add(m)
        if (e.market) conflictMarkets.add(e.market)
      }

      if (conflictRegions.size > 0) {
        const formattedRegions = Array.from(conflictRegions).map(formatRegionLabel)
        const regionText =
          formattedRegions.length <= 5
            ? formattedRegions.join('、')
            : `${formattedRegions.slice(0, 5).join('、')} 等 ${formattedRegions.length} 个地区`
        const policyText = Array.from(conflictPolicies).join('、')
        const marketText =
          conflictMarkets.size > 0
            ? `（涉及市场：${Array.from(conflictMarkets).join('、')}）`
            : ''
        warnings.push(
          `「${a.name}」与「${b.name}」在地区 ${regionText} 重复定义了政策 ${policyText}${marketText}，后加载的组件可能覆盖前者或引发市场冲突。`,
        )
      }
    }
  }
  return warnings
}
