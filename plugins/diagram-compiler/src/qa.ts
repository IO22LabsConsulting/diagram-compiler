// Tier-1 lint: deterministic checks on the positioned scene. Every finding names the elements
// and a spec-level fix, so the author can repair the spec without seeing pixels.
import type { Page } from './layout/index.ts'
import { missingGlyphs, textWidth } from './metrics.ts'
import { foreignGroups, hit, sameEnds, segHitsBox, segments, segsCross, sharedRun } from './geom.ts'
import type { TextRun } from './scene.ts'
import type { Spec } from './spec.ts'
import { contrast } from './theme.ts'

export type Finding = { rule: string; severity: 'error' | 'warn' | 'info'; elements: string[]; message: string; fix: string }
export type LintReport = { ok: boolean; errors: number; warnings: number; findings: Finding[] }

// markup and shell that has no business in a label; a placeholder like <task_id> or a path like /api/x is fine
const SUSPICIOUS = /(https?:\/\/|www\.|javascript:|<\/?(script|iframe|img|svg|style|object|embed|link|a|div|span)\b[^>]*>|\$\(|`|\{\{|;\s*(rm|curl|wget)\b)/i

function specTexts(spec: Spec): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [{ id: 'title', text: spec.title }]
  const flow = (f: { nodes: { id: string; label: string; sublabel?: string; bullets?: string[] }[]; edges: { from: string; to: string; label?: string }[] }, pre = '') => {
    for (const nd of f.nodes) for (const t of [nd.label, nd.sublabel, ...(nd.bullets ?? [])]) if (t) out.push({ id: pre + nd.id, text: t })
    for (const e of f.edges) if (e.label) out.push({ id: `${pre}${e.from}->${e.to}`, text: e.label })
  }
  if (spec.diagram_type === 'flow') flow(spec)
  if (spec.diagram_type === 'sequence') {
    for (const a of spec.actors) for (const t of [a.label, a.sublabel]) if (t) out.push({ id: a.id, text: t })
    spec.steps.forEach((st, i) => { for (const t of 'divider' in st ? [st.divider] : [st.label, st.detail]) if (t) out.push({ id: `steps[${i}]`, text: t }) })
  }
  if (spec.diagram_type === 'table') {
    spec.columns.forEach((t, i) => out.push({ id: `columns[${i}]`, text: t }))
    spec.rows.forEach((r, i) => r.cells.forEach((t, j) => t && out.push({ id: `rows[${i}].cells[${j}]`, text: t })))
  }
  if (spec.diagram_type === 'grid')
    for (const p of spec.panels) {
      for (const t of [p.title, p.caption, ...(p.bullets ?? [])]) if (t) out.push({ id: p.id, text: t })
      if (p.diagram?.diagram_type === 'flow') flow(p.diagram, `${p.id}/`)
    }
  return out
}

const labelText = (e: { label?: { run: { text: string }; run2?: { text: string } } }) => (e.label ? e.label.run.text + (e.label.run2 ? ' ' + e.label.run2.text : '') : '')

export function lint(page: Page, spec: Spec): LintReport {
  const f: Finding[] = []
  const add = (rule: string, severity: Finding['severity'], elements: string[], message: string, fix: string) => f.push({ rule, severity, elements, message, fix })
  const { nodes, edges } = page

  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (hit(nodes[i]!, nodes[j]!, 4))
        add('overlap.node', 'error', [nodes[i]!.id, nodes[j]!.id], `nodes "${nodes[i]!.id}" and "${nodes[j]!.id}" overlap`, 'remove one of the nodes or move it into a different group; if this persists it is a layout bug')

  for (const id of page.clipped ?? []) add('overflow.text', 'error', [id], `text in ${id} did not fit and was cut with an ellipsis`, `shorten ${id} (a cell holds about 6 short lines)`)
  for (const nd of nodes) {
    if (nd.truncated) add('overflow.text', 'error', [nd.id], `text on "${nd.id}" did not fit and was cut with an ellipsis`, `shorten the label, sublabel or bullets on "${nd.id}" (aim for 5 words or fewer per line)`)
    if (nd.iconMissing) add('icon.missing', 'warn', [nd.id], `icon "${nd.iconMissing}" is not in the registry; no icon was drawn`, `run \`diagram icons --search ${nd.iconMissing.split('-')[0]}\` and use a listed name, or drop the icon`)
  }

  const allRuns: { id: string; r: TextRun }[] = [
    ...nodes.flatMap((nd) => nd.texts.map((r) => ({ id: nd.id, r }))),
    ...page.groups.flatMap((g) => (g.label ? [{ id: g.id, r: g.label }] : [])),
    ...edges.flatMap((e) => (e.label ? [e.label.run, ...(e.label.run2 ? [e.label.run2] : [])].map((r) => ({ id: e.id, r })) : [])),
    ...page.panels.flatMap((p) => [...p.texts, ...(p.badge ? [p.badge.run] : [])].map((r) => ({ id: p.id, r }))),
    ...page.texts.map((r) => ({ id: 'page', r })),
  ]
  const lowContrast = new Set<string>()
  const noGlyph = new Map<string, Set<string>>()
  for (const { id, r } of allRuns) {
    if (r.bg !== 'none' && contrast(r.fill, r.bg) < 4.5) lowContrast.add(id)
    const miss = missingGlyphs(r.text, r.font)
    if (miss.length) noGlyph.set(id, new Set([...(noGlyph.get(id) ?? []), ...miss]))
  }
  for (const id of lowContrast) add('contrast.text', 'error', [id], `text on "${id}" has contrast below 4.5:1`, `change the colour or emphasis of "${id}"`)
  for (const [id, chars] of noGlyph)
    add('text.missing-glyph', 'error', [id], `"${id}" uses characters the bundled fonts cannot draw: ${[...chars].join(' ')}`, 'rewrite the text with Latin letters, digits and common punctuation (no emoji or CJK)')

  const segs = edges.map(segments)
  edges.forEach((e, i) => {
    for (const nd of nodes) {
      if (nd.id === e.from || nd.id === e.to) continue
      const inner = { x: nd.x + 2, y: nd.y + 2, w: nd.w - 4, h: nd.h - 4 }
      if (segs[i]!.some((s) => segHitsBox(s, inner)))
        add('overlap.edge-node', 'warn', [`${e.from}->${e.to}`, nd.id], `edge ${e.from} -> ${e.to} runs through node "${nd.id}"`, `list "${e.from}" and "${e.to}" next to each other in nodes, put them in the same group, or drop the edge`)
    }
    edges.forEach((other, j) => {
      if (i !== j && other.label && segs[i]!.some((s) => segHitsBox(s, other.label!)))
        add('overlap.label-edge', 'warn', [`${e.from}->${e.to}`, `${other.from}->${other.to}`], `edge ${e.from} -> ${e.to} crosses the label "${labelText(other)}"`, 'shorten or drop that edge label, or move its detail into a node sublabel')
    })
  })

  for (const e of edges)
    for (const g of page.groups)
      if (e.label && g.label && hit(e.label, { x: g.label.x, y: g.label.y - g.label.size, w: g.label.text.length * 6.7, h: g.label.size + 4 }))
        add('overlap.label-title', 'warn', [`${e.from}->${e.to}`, g.id], `edge label "${labelText(e)}" covers the title of group "${g.id}"`, 'shorten or drop that edge label')

  edges.forEach((e, i) => {
    for (const g of page.groups)
      if (g.label && segs[i]!.some((sg) => segHitsBox(sg, { x: g.label!.x, y: g.label!.y - g.label!.size + 1, w: g.label!.text.length * 6.6, h: g.label!.size })))
        add('overlap.edge-title', 'warn', [`${e.from}->${e.to}`, g.id], `edge ${e.from} -> ${e.to} is drawn through the title of group "${g.id}"`, `shorten the label of group "${g.id}", or connect the edge to a different member of the group`)
    for (const g of foreignGroups(page, e, segs[i]!))
      add('overlap.edge-group', 'warn', [`${e.from}->${e.to}`, g.id], `edge ${e.from} -> ${e.to} cuts through group "${g.id}", which it does not belong to`, `connect the edge to group "${g.id}" itself, move one of its ends into that group, or drop the edge`)
    for (let j = i + 1; j < edges.length; j++)
      if (!sameEnds(e, edges[j]!) && sharedRun(segs[i]!, segs[j]!) > 24)
        add('overlap.edge-edge', 'warn', [`${e.from}->${e.to}`, `${edges[j]!.from}->${edges[j]!.to}`], `edges ${e.from} -> ${e.to} and ${edges[j]!.from} -> ${edges[j]!.to} run on top of each other and read as one path`, 'drop one of the two edges, or route one of them through a shared intermediate node')
  })

  for (const e of edges)
    for (const nd of nodes)
      if (e.label && hit(e.label, { x: nd.x + 2, y: nd.y + 2, w: nd.w - 4, h: nd.h - 4 }))
        add('overlap.label-node', 'warn', [`${e.from}->${e.to}`, nd.id], `edge label "${labelText(e)}" is drawn over node "${nd.id}"`, 'shorten that edge label to one or two words, or move its detail into a node sublabel')
  for (const g of page.groups)
    if (g.label && textWidth(g.label.text, g.label.font, g.label.size) + 24 > g.w)
      add('overflow.group-title', 'warn', [g.id], `the title of group "${g.id}" is wider than the group`, `shorten the label of group "${g.id}"`)

  for (const e of edges)
    if (e.label && (e.label.x < 0 || e.label.y < 0 || e.label.x + e.label.w > page.w || e.label.y + e.label.h > page.h))
      add('overflow.label', 'error', [`${e.from}->${e.to}`], `edge label "${labelText(e)}" is cut off by the edge of the canvas`, 'shorten that edge label; if it persists it is a layout bug')

  const crossed: string[] = []
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = [edges[i]!, edges[j]!]
      if (a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from) continue
      if (segs[i]!.some((s) => segs[j]!.some((t) => segsCross(s, t)))) crossed.push(`${a.from}->${a.to}`, `${b.from}->${b.to}`)
    }
  const crossings = crossed.length / 2
  if (crossings >= 1)
    add('crossings.edge', crossings >= 3 || crossings / edges.length > 0.2 ? 'warn' : 'info', [...new Set(crossed)], `${crossings} edge crossings across ${edges.length} edges`, 'remove secondary edges, group the nodes these edges connect, or split the diagram into grid panels')

  const centre = new Map([...nodes, ...page.groups].map((b) => [b.id, [b.x + b.w / 2, b.y + b.h / 2] as const]))
  edges.forEach((e, i) => {
    const [a, b] = [centre.get(e.from), centre.get(e.to)]
    if (!a || !b) return
    const len = segs[i]!.reduce((t, [p, q]) => t + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), 0)
    const direct = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    if (len > 420 && len > 1.7 * direct)
      add('edge.detour', 'warn', [`${e.from}->${e.to}`], `edge ${e.from} -> ${e.to} takes a long way round`, `mark the edge kind "loop" if it points back upstream; otherwise put "${e.from}" and "${e.to}" in the same or neighbouring groups, or drop it`)
  })

  // advice that fits this spec: never suggest a setting the author has already used
  const fixed = spec.canvas.aspect !== 'auto'
  const white = 1 - page.contentArea / (page.w * page.h)
  const natural = page.naturalW / page.naturalH
  const named = Object.entries({ '4:5': 0.8, '1:1': 1, '16:9': 16 / 9, A4: 210 / 297 }).reduce((a, b) => (Math.abs(Math.log(b[1] / natural)) < Math.abs(Math.log(a[1] / natural)) ? b : a))[0]
  const reshape = (): string => {
    if (spec.diagram_type === 'grid') return spec.columns ? 'remove `columns` so the compiler can choose' : 'add or remove a panel so the grid fills a full row'
    if (spec.diagram_type === 'table') return 'shorten the longest cells, or drop a column'
    if (spec.diagram_type === 'sequence') return 'split the sequence in two at a natural pause, or merge steps that always happen together'
    if (spec.diagram_type === 'mindmap') return 'a mindmap is landscape by nature: for a portrait or square canvas use a `tree` or a `grid` instead'
    if (spec.diagram_type === 'tree') return 'move leaf detail into sublabels so parents have fewer children, or split the tree into a grid of smaller trees'
    if (spec.hints.direction) return 'remove hints.direction so the compiler can choose the layout'
    if (spec.groups.length < 2 && spec.nodes.length > 6) return 'put the nodes into 2-4 groups (stages or layers) so the compiler can fold the flow into bands'
    return 'cut secondary nodes, or split the story into a grid with one stage per panel'
  }
  if (fixed && white > 0.3)
    add('density.canvas', white > 0.6 ? 'error' : 'warn', [], `${Math.round(white * 100)}% of the canvas is empty padding added to reach aspect ${spec.canvas.aspect}`,
      `${reshape()}${named !== spec.canvas.aspect ? `; this content is naturally closer to "${named}"` : ''}; or use canvas.aspect "auto"`)
  const pageRatio = page.w / page.h
  if (!fixed && Math.max(page.w, page.h) > 1400 && (pageRatio > 2.4 || pageRatio < 0.5))
    add('aspect.extreme', 'warn', [], `the diagram is a ${pageRatio > 1 ? 'very wide ribbon' : 'very tall strip'} (${pageRatio > 1 ? pageRatio.toFixed(1) + ':1' : '1:' + (1 / pageRatio).toFixed(1)}); text will be small at normal size`, reshape())
  if (page.w > 8000 || page.h > 8000) add('canvas.too-large', 'error', [], `canvas is ${page.w}x${page.h}; the limit is 8000 per side`, 'split the diagram into several smaller ones')

  if (spec.diagram_type === 'flow' && spec.edges.length) {
    const used = new Set(spec.edges.flatMap((e) => [e.from, e.to]))
    const grouped = new Map(spec.groups.flatMap((g) => g.members.map((m) => [m, g.id] as const)))
    for (const nd of spec.nodes)
      if (!used.has(nd.id) && !used.has(grouped.get(nd.id) ?? '') && !spec.annotations.some((a) => a.target === nd.id))
        add('spec.unreferenced', 'info', [nd.id], `node "${nd.id}" has no edges`, 'connect it, or remove it if it is not part of the story')
  }
  for (const { id, text } of specTexts(spec))
    if (SUSPICIOUS.test(text)) add('label.suspicious', 'warn', [id], `text on "${id}" looks like a URL or code`, 'use a short plain-language label instead')

  const errors = f.filter((x) => x.severity === 'error').length
  return { ok: errors === 0, errors, warnings: f.filter((x) => x.severity === 'warn').length, findings: f }
}
