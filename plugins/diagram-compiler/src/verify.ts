// Source check: every element may cite where it comes from (`source`), and this confirms the citation is real.
// Pure: the caller supplies `read`, which returns a file's text or null. It proves a cited line exists and says
// what the spec quotes; it cannot prove the label is a fair summary of that line.
import type { Finding } from './qa.ts'
import type { Branch, PanelDiagram, Spec, Src } from './spec.ts'

/** A file's text; null when nothing is there; false when something is there that cannot be read as a file (a folder, too large). */
export type Reader = (file: string) => string | null | false
export type SourceReport = { ok: boolean; errors: number; warnings: number; elements: number; cited: number; citations: number; /** different file:line places cited; far below `citations` means many elements lean on the same lines */ distinct: number; findings: Finding[] }
type Item = { id: string; label?: string; source?: Src | Src[] }

/** Every element that can carry a `source`, with the id a finding should name. */
export function citable(spec: Spec): Item[] {
  const out: Item[] = []
  const flow = (f: Extract<PanelDiagram, { diagram_type: 'flow' }>, pre = '') => {
    for (const n of f.nodes) out.push({ id: pre + n.id, label: n.label, source: n.source })
    for (const e of f.edges ?? []) out.push({ id: `${pre}${e.from}->${e.to}`, label: e.label, source: e.source })
  }
  const tree = (b: Branch, path: string) => {
    out.push({ id: path, label: b.label, source: b.source })
    b.children?.forEach((c, i) => tree(c, `${path}.children[${i}]`))
  }
  if (spec.diagram_type === 'flow') flow(spec)
  else if (spec.diagram_type === 'grid')
    for (const p of spec.panels) {
      out.push({ id: p.id, label: p.title, source: p.source })
      if (p.diagram?.diagram_type === 'flow') flow(p.diagram, `${p.id}/`)
      else if (p.diagram) tree(p.diagram.root, `${p.id}/root`)
    }
  else if (spec.diagram_type === 'table') spec.rows.forEach((r, i) => out.push({ id: `rows[${i}]`, label: r.cells[0], source: r.source }))
  else if (spec.diagram_type === 'sequence') {
    for (const a of spec.actors) out.push({ id: a.id, label: a.label, source: a.source })
    spec.steps.forEach((st, i) => 'divider' in st || out.push({ id: `steps[${i}]`, label: st.label, source: st.source }))
  } else tree(spec.root, 'root')
  return out
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const NEAR = 10 // lines either side of the cited line where the quoted text still counts as "there"

export function verifySources(spec: Spec, read: Reader, strict = false): SourceReport {
  const f: Finding[] = []
  const add = (rule: string, severity: Finding['severity'], id: string, message: string, fix: string) => f.push({ rule, severity, elements: [id], message, fix })
  const items = citable(spec)
  const files = new Map<string, string[] | null | false>()
  const binary = new Set<string>()
  const seen = new Set<string>()
  let citations = 0
  for (const it of items)
    for (const src of it.source ? [it.source].flat() : []) {
      citations++
      const at = `${src.file}${src.line ? ':' + src.line : ''}`
      if (/^([/\\]|[A-Za-z]:)/.test(src.file) || src.file.split(/[/\\]/).includes('..')) {
        add('source.outside-root', 'error', it.id, `"${it.id}" cites ${src.file}, which is not a path inside the checked folder`, 'give the path relative to the repository root, with no ".."')
        continue
      }
      if (!files.has(src.file)) {
        const body = read(src.file)
        if (typeof body === 'string' && body.includes('\u0000')) binary.add(src.file)
        files.set(src.file, typeof body === 'string' ? body.split('\n') : body)
      }
      const lines = files.get(src.file)
      seen.add(at)
      if (lines === false) {
        add('source.not-a-file', 'error', it.id, `"${it.id}" cites ${src.file}, which is a folder or is too large to read`, 'cite a file inside it')
        continue
      }
      if (binary.has(src.file)) {
        // a spreadsheet or image: the citation can say it exists, never what is in it
        if (src.line || src.text) add('source.binary', 'error', it.id, `"${it.id}" quotes from ${src.file}, which is not a text file`, 'cite the file alone (no line or text), and do not claim what is inside it unless a text file says so')
        continue
      }
      if (!lines) {
        add('source.missing-file', 'error', it.id, `"${it.id}" cites ${src.file}, which does not exist`, 'correct the path, or remove the element if its source cannot be found')
        continue
      }
      if (src.line && src.line > lines.length) {
        add('source.line-out-of-range', 'error', it.id, `"${it.id}" cites ${at}, but the file has ${lines.length} lines`, 'correct the line number')
        continue
      }
      if (!src.text) continue
      const want = squash(src.text)
      const hits = lines.flatMap((l, i) => (squash(l).includes(want) ? [i + 1] : []))
      if (!hits.length) add('source.text-not-found', 'error', it.id, `"${it.id}" quotes "${src.text}" from ${src.file}, but that text is not in the file`, 'quote text that is really on the cited line (one line, copied exactly), or correct the file')
      else if (src.line && !hits.some((h) => Math.abs(h - src.line!) <= NEAR)) {
        const nearest = hits.reduce((a, b) => (Math.abs(b - src.line!) < Math.abs(a - src.line!) ? b : a))
        add('source.moved', 'warn', it.id, `"${it.id}" quotes "${src.text}" at ${at}, but it is on line ${nearest}`, `set the line to ${nearest}`)
      }
    }
  // steps that cite the same file should usually run down it: a later step on an earlier line deserves a second look
  if (spec.diagram_type === 'sequence') {
    let prev: { id: string; file: string; line: number; from: string } | undefined
    spec.steps.forEach((st, i) => {
      if ('divider' in st) return
      const s0 = st.source ? [st.source].flat()[0] : undefined
      if (!s0?.line || st.kind === 'reply') return
      if (prev && prev.file === s0.file && prev.from === st.from && s0.line < prev.line)
        add('source.order', 'info', `steps[${i}]`, `step ${i + 1} cites ${s0.file}:${s0.line}, earlier in the file than the step before it (line ${prev.line})`, 'check the two steps are in the order the code runs them; ignore this if the earlier line is a helper called later')
      prev = { id: `steps[${i}]`, file: s0.file, line: s0.line, from: st.from }
    })
  }
  const bare = items.filter((it) => !it.source).map((it) => it.id)
  if (bare.length)
    f.push({
      rule: 'source.uncited', severity: strict ? 'error' : 'warn', elements: bare.slice(0, 40),
      message: `${bare.length} of ${items.length} elements cite no source: ${bare.slice(0, 8).join(', ')}${bare.length > 8 ? ', ...' : ''}`,
      fix: 'add a `source` (file, line and a few quoted words) to each, or remove elements you cannot point to in the code',
    })
  const errors = f.filter((x) => x.severity === 'error').length
  return { ok: errors === 0, errors, warnings: f.filter((x) => x.severity === 'warn').length, elements: items.length, cited: items.length - bare.length, citations, distinct: seen.size, findings: f }
}
