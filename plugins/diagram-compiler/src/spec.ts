// Diagram Spec v1: the contract between the LLM and the compiler.
// Says what is in the diagram, never where. Specs are untrusted input.
import { z } from 'zod'

export const LIMITS = { nodes: 500, edges: 1000, branchDepth: 4, panels: 12 }

// No control or bidi-override characters anywhere in rendered text.
const CLEAN = /^[^\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]*$/
const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(CLEAN, 'control or bidi characters are not allowed')
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'id must start with a letter; letters, digits, _ and - only (max 40)')
const Icon = z.string().regex(/^[a-z0-9-]{1,40}$/, 'icon is a lowercase kebab-case name; see `diagram icons --search <term>`')

// Where in the source material an element comes from. Never drawn; `diagram verify --root` checks it.
const Src = z.strictObject({
  file: z.string().min(1).max(240).regex(CLEAN, 'control or bidi characters are not allowed'),
  line: z.number().int().min(1).optional(),
  text: z.string().trim().min(2).max(120).regex(CLEAN, 'control or bidi characters are not allowed').optional(),
})
const Source = z.union([Src, z.array(Src).min(1).max(8)]).optional()
export type Src = z.infer<typeof Src>

export const COLORS = ['green', 'blue', 'amber', 'pink', 'violet', 'cyan'] as const
const Color = z.enum(COLORS)
export type ColorName = (typeof COLORS)[number]

const Node = z.strictObject({
  id: Id,
  kind: z.enum(['box', 'icon', 'store', 'actor', 'model', 'note', 'chip']).default('box'),
  label: text(40),
  sublabel: text(60).optional(),
  bullets: z.array(text(48)).max(6).optional(),
  icon: Icon.optional(),
  emphasis: z.enum(['primary', 'secondary', 'muted']).default('secondary'),
  color: Color.optional(),
  source: Source,
})

const Edge = z.strictObject({
  from: Id,
  to: Id,
  label: text(28).optional(),
  style: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  arrow: z.enum(['none', 'end', 'both']).default('end'),
  kind: z.enum(['flow', 'loop', 'async']).default('flow'),
  source: Source,
})

const Group = z.strictObject({
  id: Id,
  label: text(40),
  members: z.array(Id).min(1),
  style: z.enum(['dashed-box', 'filled', 'lane']).default('dashed-box'),
  color: Color.optional(),
})

const Annotation = z.strictObject({ target: Id, text: text(80) })

const flowBody = {
  nodes: z.array(Node).min(1).max(LIMITS.nodes),
  edges: z.array(Edge).max(LIMITS.edges).default([]),
  groups: z.array(Group).default([]),
  annotations: z.array(Annotation).default([]),
  hints: z.strictObject({ direction: z.enum(['LR', 'TB']).optional() }).default({}),
}

export type Branch = { label: string; sublabel?: string; icon?: string; color?: ColorName; source?: Src | Src[]; children?: Branch[] }
const Branch: z.ZodType<Branch> = z.strictObject({
  label: text(40),
  sublabel: text(60).optional(),
  icon: Icon.optional(),
  color: Color.optional(),
  source: Source,
  get children() {
    return z.array(Branch).max(12).optional()
  },
})
const treeBody = { root: Branch }

const FlowPanel = z.strictObject({ diagram_type: z.literal('flow'), ...flowBody })
const MindmapPanel = z.strictObject({ diagram_type: z.literal('mindmap'), ...treeBody })
const TreePanel = z.strictObject({ diagram_type: z.literal('tree'), ...treeBody })

const Panel = z.strictObject({
  id: Id,
  title: text(48),
  badge: z.string().regex(/^[A-Za-z0-9]{1,3}$/, 'badge is 1-3 letters or digits').optional(),
  color: Color.optional(),
  caption: text(120).optional(),
  bullets: z.array(text(64)).max(6).optional(),
  source: Source,
  diagram: z.discriminatedUnion('diagram_type', [FlowPanel, MindmapPanel, TreePanel]).optional(),
})

const doc = {
  spec_version: z.literal('1.0'),
  title: text(80),
  subtitle: text(140).optional(),
  theme: z.enum(['clean-light', 'clean-dark']).default('clean-light'),
  canvas: z.strictObject({ aspect: z.enum(['auto', '4:5', '1:1', '16:9', 'A4']).default('auto') }).default({ aspect: 'auto' }),
  footer: text(160).optional(),
  // folders this diagram covers: a change there that nothing cites is reported by `diagram stale`. Never drawn.
  scope: z.array(z.string().min(1).max(200).regex(CLEAN, 'control or bidi characters are not allowed')).max(20).optional(),
}

export const VARIANTS = {
  flow: z.strictObject({ ...doc, diagram_type: z.literal('flow'), ...flowBody }),
  mindmap: z.strictObject({ ...doc, diagram_type: z.literal('mindmap'), ...treeBody }),
  tree: z.strictObject({ ...doc, diagram_type: z.literal('tree'), ...treeBody }),
  grid: z.strictObject({
    ...doc,
    diagram_type: z.literal('grid'),
    columns: z.number().int().min(1).max(4).optional(),
    panels: z.array(Panel).min(1).max(LIMITS.panels),
  }),
  // who talks to whom, in order: actors across the top, one message per row, time runs down
  sequence: z.strictObject({
    ...doc,
    diagram_type: z.literal('sequence'),
    actors: z.array(z.strictObject({ id: Id, label: text(28), sublabel: text(40).optional(), kind: z.enum(['box', 'actor', 'store', 'model']).default('box'), icon: Icon.optional(), color: Color.optional(), source: Source })).min(2).max(8),
    steps: z.array(z.union([
      z.strictObject({ from: Id, to: Id, label: text(48), detail: text(64).optional(), kind: z.enum(['call', 'reply', 'async']).default('call'), source: Source }),
      z.strictObject({ divider: text(48) }),
    ])).min(1).max(40),
  }),
  // rows by columns: the first column names the row, the others describe it
  table: z.strictObject({
    ...doc,
    diagram_type: z.literal('table'),
    columns: z.array(text(28)).min(2).max(7),
    rows: z.array(z.strictObject({ cells: z.array(z.string().max(140)).min(2).max(7), color: Color.optional(), source: Source })).min(1).max(24),
  }),
}
export const DIAGRAM_TYPES = Object.keys(VARIANTS) as (keyof typeof VARIANTS)[]
export const Spec = z.discriminatedUnion('diagram_type', [VARIANTS.flow, VARIANTS.mindmap, VARIANTS.tree, VARIANTS.grid, VARIANTS.table, VARIANTS.sequence])

export type Spec = z.infer<typeof Spec>
export type FlowBody = Pick<z.infer<typeof VARIANTS.flow>, 'nodes' | 'edges' | 'groups' | 'annotations' | 'hints'>
export type SpecNode = z.infer<typeof Node>
export type SpecEdge = z.infer<typeof Edge>
export type SpecGroup = z.infer<typeof Group>
export type SpecPanel = z.infer<typeof Panel>
export type PanelDiagram = NonNullable<SpecPanel['diagram']>

export type Issue = { code: string; path: string; message: string; element_id?: string }
export class SpecError extends Error {
  issues: Issue[]
  constructor(issues: Issue[]) {
    super(`${issues.length} spec error(s): ${issues[0]?.path} ${issues[0]?.message}`)
    this.issues = issues
  }
}

const pathStr = (p: PropertyKey[]) => p.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '')

function flattenZod(issues: z.core.$ZodIssue[], out: Issue[], base: PropertyKey[] = []) {
  for (const i of issues) {
    const path = [...base, ...i.path]
    // invalid_union hides the useful errors one level down
    const nested = (i as { errors?: z.core.$ZodIssue[][] }).errors
    if (i.code === 'invalid_union' && nested?.length) {
      const best = [...nested].sort((a, b) => a.length - b.length)[0]!
      if (best.length) {
        flattenZod(best, out, path)
        continue
      }
    }
    let message = i.message
    if (i.code === 'invalid_union') message = `diagram_type must be one of: ${DIAGRAM_TYPES.join(', ')}`
    out.push({ code: 'spec.schema', path: pathStr(path), message })
  }
}

function branchChecks(root: Branch, path: string, issues: Issue[]) {
  let count = 0
  const walk = (b: Branch, depth: number, p: string) => {
    count++
    if (depth > LIMITS.branchDepth) issues.push({ code: 'spec.limit', path: p, message: `branches nest deeper than ${LIMITS.branchDepth} levels` })
    else b.children?.forEach((c, i) => walk(c, depth + 1, `${p}.children[${i}]`))
  }
  walk(root, 0, path)
  if (count > LIMITS.nodes) issues.push({ code: 'spec.limit', path, message: `more than ${LIMITS.nodes} branches` })
}

function flowChecks(f: FlowBody, path: string, issues: Issue[]) {
  const p = (s: string) => (path ? `${path}.${s}` : s)
  const nodeIds = new Set<string>()
  f.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id)) issues.push({ code: 'spec.duplicate-id', path: p(`nodes[${i}].id`), message: `duplicate id "${n.id}"`, element_id: n.id })
    nodeIds.add(n.id)
  })
  const groupIds = new Set<string>()
  f.groups.forEach((g, i) => {
    if (nodeIds.has(g.id) || groupIds.has(g.id))
      issues.push({ code: 'spec.duplicate-id', path: p(`groups[${i}].id`), message: `duplicate id "${g.id}"`, element_id: g.id })
    groupIds.add(g.id)
  })
  const known = (id: string) => nodeIds.has(id) || groupIds.has(id)
  const hint = `known ids: ${[...nodeIds, ...groupIds].slice(0, 30).join(', ')}`
  f.edges.forEach((e, i) => {
    for (const end of ['from', 'to'] as const)
      if (!known(e[end])) issues.push({ code: 'spec.reference', path: p(`edges[${i}].${end}`), message: `"${e[end]}" is not a node or group id; ${hint}` })
  })
  const parent = new Map<string, string>()
  f.groups.forEach((g, i) =>
    g.members.forEach((m, j) => {
      const mp = p(`groups[${i}].members[${j}]`)
      if (!known(m)) issues.push({ code: 'spec.reference', path: mp, message: `"${m}" is not a node or group id; ${hint}`, element_id: g.id })
      else if (m === g.id) issues.push({ code: 'spec.reference', path: mp, message: `group "${g.id}" contains itself`, element_id: g.id })
      else if (parent.has(m)) issues.push({ code: 'spec.reference', path: mp, message: `"${m}" is already a member of group "${parent.get(m)}"`, element_id: g.id })
      else parent.set(m, g.id)
    }),
  )
  for (const g of f.groups) {
    const seen = new Set([g.id])
    for (let cur = parent.get(g.id); cur; cur = parent.get(cur)) {
      if (seen.has(cur)) {
        issues.push({ code: 'spec.reference', path: p('groups'), message: `groups form a cycle through "${cur}"`, element_id: cur })
        break
      }
      seen.add(cur)
    }
  }
  f.annotations.forEach((a, i) => {
    if (!nodeIds.has(a.target)) issues.push({ code: 'spec.reference', path: p(`annotations[${i}].target`), message: `"${a.target}" is not a node id; ${hint}` })
  })
}

/** Validate + normalize. Throws SpecError carrying every issue found. */
export function parseSpec(input: unknown): Spec {
  const r = Spec.safeParse(input)
  const issues: Issue[] = []
  if (!r.success) {
    flattenZod(r.error.issues, issues)
    throw new SpecError(issues)
  }
  const s = r.data
  if (s.diagram_type === 'flow') flowChecks(s, '', issues)
  else if (s.diagram_type === 'grid') {
    const ids = new Set<string>()
    s.panels.forEach((pn, i) => {
      if (ids.has(pn.id)) issues.push({ code: 'spec.duplicate-id', path: `panels[${i}].id`, message: `duplicate id "${pn.id}"`, element_id: pn.id })
      ids.add(pn.id)
      if (!pn.diagram && !pn.bullets?.length)
        issues.push({ code: 'spec.schema', path: `panels[${i}]`, message: 'a panel needs a diagram, bullets, or both', element_id: pn.id })
      if (pn.diagram?.diagram_type === 'flow') flowChecks(pn.diagram, `panels[${i}].diagram`, issues)
      else if (pn.diagram) branchChecks(pn.diagram.root, `panels[${i}].diagram.root`, issues)
    })
  } else if (s.diagram_type === 'sequence') {
    const ids = new Set<string>()
    s.actors.forEach((a, i) => {
      if (ids.has(a.id)) issues.push({ code: 'spec.duplicate-id', path: `actors[${i}].id`, message: `duplicate id "${a.id}"`, element_id: a.id })
      ids.add(a.id)
    })
    s.steps.forEach((st, i) => {
      if ('divider' in st) return
      for (const end of ['from', 'to'] as const)
        if (!ids.has(st[end])) issues.push({ code: 'spec.reference', path: `steps[${i}].${end}`, message: `"${st[end]}" is not an actor id; known ids: ${[...ids].join(', ')}` })
    })
    if (!s.steps.some((st) => !('divider' in st))) issues.push({ code: 'spec.schema', path: 'steps', message: 'a sequence needs at least one message' })
  } else if (s.diagram_type === 'table') {
    s.rows.forEach((r, i) => {
      if (r.cells.length !== s.columns.length) issues.push({ code: 'spec.schema', path: `rows[${i}].cells`, message: `row has ${r.cells.length} cells but the table has ${s.columns.length} columns` })
      if (!r.cells[0]!.trim()) issues.push({ code: 'spec.schema', path: `rows[${i}].cells[0]`, message: 'the first cell names the row and cannot be empty' })
    })
  } else branchChecks(s.root, 'root', issues)
  if (issues.length) throw new SpecError(issues)
  return s
}

export function jsonSchema(type?: keyof typeof VARIANTS) {
  return z.toJSONSchema(type ? VARIANTS[type] : Spec, { io: 'input' })
}
