// Incremental update: given a diagram stamped at one state of a repository and what has changed since,
// say which citations still hold, which can be repaired without reading anything, and which few places
// someone must read again. Pure: the caller supplies file contents and the diff.
import { citable } from './verify.ts'
import type { Spec, Src } from './spec.ts'

export type Lock = { lock_version: 1; commit: string | null; files: Record<string, string>; scope: string[]; /** per cited definition (`file#name`): lines elsewhere in the tracked files that mention the name */ uses?: Record<string, number> }
/** New-side line ranges [first, last] that differ from the stamped state, per file. An empty list with the file present = changed, ranges unknown. */
/**
 * The lines an element's meaning depends on: the block its cited line opens, or, when that line opens nothing (a call,
 * a route, an assignment), the block it sits in: the function around a call, the scope around a route. So an edit
 * elsewhere in that function, or a new sibling route, counts as touching the element.
 */
export function extent(lines: string[], line: number): [number, number] {
  const own = blockEnd(lines, line)
  if (own > line) return [line, own]
  const ind = indent(lines[line - 1] ?? '')
  let up = line
  for (let i = line - 2; i >= Math.max(0, line - 1 - BODY); i--) {
    const l = lines[i]!
    if (l.trim() && indent(l) < ind) {
      up = i + 1
      break
    }
  }
  if (up === line) return [line, line]
  // landed on the `) -> None:` that ends a multi-line signature: the block really starts where that signature does
  while (up > 1 && /^\s*[}\])]/.test(lines[up - 1]!)) {
    const at = indent(lines[up - 1]!)
    let j = up - 2
    while (j >= 0 && (!lines[j]!.trim() || indent(lines[j]!) > at)) j--
    if (j < 0) break
    up = j + 1
  }
  return [up, Math.min(blockEnd(lines, up), up + BODY)]
}

// A named definition at the start of a line (after modifiers such as pub, export, async), so the word "class" or
// "function" inside prose or a docstring does not count. A bare `fn x ->` is an anonymous function: `fn` only counts
// when a parameter list follows the name.
const DEF = /^\s*(?:(?:pub(?:\([a-z]+\))?|export|default|async|static|private|public|protected|unsafe|extern|abstract|final|override)\s+)*(?:(?:defp?|defmacrop?|function\*?|func|class|sub)\s+(?:self\.)?([A-Za-z_][\w]*[?!]?)|fn\s+([A-Za-z_]\w*)\s*[(<])/
/** Named definitions (def, function, fn, func, class ...) that contain an edited range: name -> where. One file. */
function editedDefinitions(lines: string[], edits: [number, number][]): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>()
  for (const [a, b] of edits) {
    // the nearest definition line at or above the edit whose block reaches it
    for (let i = Math.min(a, lines.length); i >= Math.max(1, a - BODY); i--) {
      const m = DEF.exec(lines[i - 1] ?? '')
      const name = m?.[1] ?? m?.[2]
      if (!name) continue
      if (blockEnd(lines, i) >= a || i === a) out.set(name, [...(out.get(name) ?? []), [a, b]])
      break
    }
  }
  return out
}

export type Changes = {
  changed: Map<string, [number, number][]>
  added: Map<string, [number, number][]>
  deleted: Set<string>
  /** old path -> new path */
  renamed: Map<string, string>
  /** per file (new path), each hunk as [old start, old count, new start, new count]: lets an old line number be carried forward exactly */
  hunks?: Map<string, [number, number, number, number][]>
}
export type Fix = { element: string; index: number; file?: string; line?: number }
export type Reread = { element: string; label?: string; reason: 'text-gone' | 'file-gone' | 'block-changed' | 'line-changed' | 'callee-changed' | 'no-longer-used' | 'text-moved-ambiguous'; file: string; line?: number; text?: string; read: [number, number][]; /** for callee-changed: the function the element's block calls that was edited */ via?: string }
export type StaleReport = {
  status: 'fresh' | 'auto-fixable' | 'needs-review'
  citations: number
  untouched: number
  fixes: (Fix & { was: string; now: string })[]
  reread: Reread[]
  new_in_scope: { file: string; change: 'added' | 'modified'; read: [number, number][]; /** an added file's first lines, to judge it without opening it */ preview?: string[] }[]
  /** uncited files inside the scope that were deleted: a count or a list in the diagram may now be wrong */
  removed_in_scope: string[]
  /** edits in files the diagram cites that fall inside no cited block: skim them for something the diagram should show */
  elsewhere_in_cited_files: { file: string; read: [number, number][]; lines: number }[]
  /** definitions added or rewritten in cited files, outside every cited block: judge each from its own line, open it only if it belongs in the diagram */
  new_definitions: { file: string; line: number; text: string }[]
  /** every range to read, merged per file, with the elements each file's ranges concern */
  read_plan: { file: string; read: [number, number][]; elements: string[] }[]
  /** cited files the stamp does not cover (a source was added after stamping): check them with render --root, then stamp */
  unstamped: string[]
  /** lines someone has to read to bring the diagram up to date */
  lines_to_read: number
  /** set when so much changed that updating costs more than drawing again */
  advice?: string
}

const flat = (x: string) => x.replace(/[_\W]/g, '').toLowerCase()
/** Where an old line number lands after the hunks: exact when the line itself was not edited, null when it was. */
export function carry(hunks: [number, number, number, number][] | undefined, line: number): number | null {
  if (!hunks) return null
  let delta = 0
  for (const [os, oc, , nc] of hunks) {
    // `-a,0` inserts after old line a; otherwise old lines os .. os+oc-1 were replaced
    if (oc === 0 ? os < line : os + oc <= line) delta += nc - oc
    else if (oc > 0 && os <= line && line < os + oc) return null
  }
  return line + delta
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const NEAR = 10 // same tolerance as the source check
const BODY = 150 // never look further than this from a cited line
const indent = (l: string) => l.length - l.trimStart().length
/**
 * Last line of the block a cited line opens, by indentation: everything below it that is indented deeper, plus a
 * closing line (`end`, `}`, `)`) at its own level. No parser, so it works the same in any language that indents.
 * A line that opens nothing (a call, a route, an assignment) is its own block.
 */
export function blockEnd(lines: string[], line: number): number {
  const own = indent(lines[line - 1] ?? '')
  let last = line
  for (let i = line; i < Math.min(lines.length, line + BODY); i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    if (indent(l) > own) last = i + 1
    else {
      if (indent(l) === own && /^\s*(end\b|[}\])]|else\b|elif\b|rescue\b|catch\b|after\b|except\b|finally\b)/.test(l)) {
        last = i + 1
        // `) -> None:` or `) {` closes a signature and opens the body: keep going
        if (/^\s*(end\b|[}\])])/.test(l) && !/([:{(\[]|\bdo|->|=>)\s*$/.test(l)) break
        continue
      }
      break
    }
  }
  return last
}
const span = (r: [number, number][]) => r.reduce((t, [a, b]) => t + (b - a + 1), 0)
const overlaps = (r: [number, number][], lo: number, hi: number) => r.filter(([a, b]) => a <= hi && b >= lo)

export const citedFiles = (spec: Spec): string[] => [...new Set(citable(spec).flatMap((it) => (it.source ? [it.source].flat() : [])).map((s) => s.file))].sort()

/**
 * For every citation that points at a named definition: how many other lines in the tracked files mention that name.
 * Stored at stamp time; a count that later falls to zero means the code the diagram cites is no longer used.
 */
export function usageCounts(spec: Spec, files: string[], read: (file: string) => string | null | false): Record<string, number> {
  const wanted = new Map<string, { file: string; name: string }>()
  for (const it of citable(spec))
    for (const src of it.source ? [it.source].flat() : []) {
      if (!src.line) continue
      const text = read(src.file)
      if (typeof text !== 'string') continue
      const m = DEF.exec(text.split('\n')[src.line - 1] ?? '')
      const name = m?.[1] ?? m?.[2]
      if (name && name.length >= 4) wanted.set(`${src.file}#${name}`, { file: src.file, name })
    }
  const out: Record<string, number> = {}
  if (!wanted.size) return out
  const bodies = files.map((f) => [f, read(f)] as const).filter((x): x is readonly [string, string] => typeof x[1] === 'string')
  for (const [key, { file, name }] of wanted) {
    // `Other.name(` is another module's function of the same name: a qualifier only counts when it is this file's own
    const stem = flat(file.split('/').pop()!.replace(/\.[^.]+$/, ''))
    const re = new RegExp(`(?:([A-Za-z_]\\w*)\\s*\\.\\s*)?(?<![\\w])${name.replace(/[?!]/g, '\\$&')}(?![\\w])`, 'g')
    let n = 0
    for (const [f, body] of bodies)
      for (const l of body.split('\n')) {
        if (DEF.test(l)) continue
        for (const m of l.matchAll(re)) {
          const q = m[1]
          if (!q || (['self', 'this', 'cls', '__MODULE__'].includes(q) ? f === file : flat(q) === stem)) n++
        }
      }
    out[key] = n
  }
  return out
}

/** The folders a diagram covers when it does not say: wherever its citations point. */
export const defaultScope = (spec: Spec): string[] =>
  [...new Set(citable(spec).flatMap((it) => (it.source ? [it.source].flat() : [])).map((s) => s.file.split('/').slice(0, -1).join('/')))].filter(Boolean).sort()

export function staleness(spec: Spec, lock: Lock, read: (file: string) => string | null | false, ch: Changes): StaleReport {
  const r: StaleReport = { status: 'fresh', citations: 0, untouched: 0, fixes: [], reread: [], new_in_scope: [], elsewhere_in_cited_files: [], new_definitions: [], read_plan: [], unstamped: [], removed_in_scope: [], lines_to_read: 0 }
  const covered = new Map<string, [number, number][]>() // blocks that cited lines open, per file
  const uses: { element: string; label?: string; file: string; line: number; from: number; end: number }[] = []
  const cited = new Set<string>()
  const citedBefore = new Set<string>()
  const lines = new Map<string, string[] | null>()
  const body = (f: string) => {
    if (!lines.has(f)) {
      const t = read(f)
      lines.set(f, typeof t === 'string' ? t.split('\n') : null)
    }
    return lines.get(f)!
  }
  for (const it of citable(spec)) {
    const label = (it as { label?: string }).label
    ;(it.source ? [it.source].flat() : []).forEach((src: Src, index) => {
      r.citations++
      const now = ch.renamed.get(src.file) ?? src.file
      cited.add(now)
      citedBefore.add(src.file)
      // a source added after the last stamp: nothing is known about how its file has changed
      if (!(src.file in lock.files) && !r.unstamped.includes(src.file)) r.unstamped.push(src.file)
      const moved = now !== src.file
      const edits = ch.changed.get(now) ?? ch.added.get(now)
      if (!moved && !edits && !ch.deleted.has(src.file)) return void r.untouched++
      const text = body(now)
      const at = `${src.file}${src.line ? ':' + src.line : ''}`
      if (!text) return void r.reread.push({ element: it.id, label, reason: 'file-gone', file: src.file, line: src.line, text: src.text, read: [] })
      let line = src.line
      if (src.text) {
        const want = squash(src.text)
        const hits = text.flatMap((l, i) => (squash(l).includes(want) ? [i + 1] : []))
        if (!hits.length) {
          // the words are gone: read what replaced them, or the whole file's changes when the place is unknown
          const near = src.line ? overlaps(edits ?? [], src.line - NEAR, src.line + NEAR) : []
          return void r.reread.push({ element: it.id, label, reason: 'text-gone', file: now, line: src.line, text: src.text, read: near.length ? near : (edits ?? []) })
        }
        // the same words can sit in several places (an install and an uninstall path): follow the diff to the right one,
        // and when there is no diff to follow and more than one candidate, ask instead of guessing
        const expect = src.line ? carry(ch.hunks?.get(now), src.line) : null
        if (expect !== null && hits.some((h) => Math.abs(h - expect) <= 2)) line = hits.reduce((a, b) => (Math.abs(b - expect) < Math.abs(a - expect) ? b : a))
        else if (src.line && hits.includes(src.line)) line = src.line
        else if (hits.length === 1) line = hits[0]
        else return void r.reread.push({ element: it.id, label, reason: 'text-moved-ambiguous', file: now, line: src.line, text: src.text, read: hits.map((h) => [h, h] as [number, number]) })
      } else if (src.line && edits && (overlaps(edits, src.line, src.line).length || src.line > text.length)) {
        return void r.reread.push({ element: it.id, label, reason: 'line-changed', file: now, line: src.line, read: overlaps(edits, src.line - NEAR, src.line + NEAR) })
      }
      const fix: Fix = { element: it.id, index }
      if (moved) fix.file = now
      if (src.line && line && line !== src.line) fix.line = line
      if (fix.file || fix.line) r.fixes.push({ ...fix, was: at, now: `${now}${line ? ':' + line : ''}` })
      // the cited line survives, but the block it opens was edited: the element may now do something else
      const [from, end] = line ? extent(text, line) : [0, 0]
      if (line) covered.set(now, [...(covered.get(now) ?? []), [from, end]])
      if (line) uses.push({ element: it.id, label, file: now, line, from, end })
      const below = line && edits ? overlaps(edits, from, end).filter(([a, b]) => !(a === line && b === line)) : []
      if (below.length) r.reread.push({ element: it.id, label, reason: 'block-changed', file: now, line, text: src.text, read: below })
    })
  }
  // one hop out: a cited block that calls a function edited elsewhere in a file this diagram cites
  const defs = new Map<string, { file: string; read: [number, number][] }[]>()
  for (const file of cited) {
    const edits = ch.changed.get(file)
    const text = edits && body(file)
    if (!edits || !text) continue
    for (const [name, read] of editedDefinitions(text, edits)) defs.set(name, [...(defs.get(name) ?? []), { file, read }])
  }
  if (defs.size)
    for (const u of uses) {
      const text = body(u.file)
      if (!text) continue
      const called = new Set((text.slice(u.from - 1, u.end).join('\n').match(/[A-Za-z_][\w]*[?!]?(?=\s*\()/g) ?? []).filter((n) => n.length >= 4))
      // a block names its own function on its opening line: other clauses of that name are siblings, not callees
      {
        const own = DEF.exec(text[u.from - 1] ?? '')
        called.delete(own?.[1] ?? own?.[2] ?? '')
      }
      for (const name of called)
        for (const d of defs.get(name) ?? []) {
          // an edit inside the element's own block is already reported
          if (d.file !== u.file && !flat(text.slice(u.from - 1, u.end).join(' ')).includes(flat(d.file.split('/').pop()!.replace(/\.[^.]+$/, '')))) continue
          const outside = d.read.filter(([a, b]) => !(d.file === u.file && a <= u.end && b >= u.from))
          if (outside.length && !r.reread.some((x) => x.element === u.element && x.via === name)) r.reread.push({ element: u.element, label: u.label, reason: 'callee-changed', file: d.file, line: u.line, read: outside, via: name })
        }
    }
  // a cited definition that something used to call and nothing calls now: the citation still passes, the claim may not
  if (lock.uses) {
    const now = usageCounts(spec, Object.keys(lock.files), read)
    for (const [key, was] of Object.entries(lock.uses)) {
      if (!(was > 0) || now[key] !== 0) continue
      const [file, name] = key.split('#') as [string, string]
      // the definition's own file may be untouched, so look the citing elements up afresh
      for (const it of citable(spec))
        for (const src of it.source ? [it.source].flat() : [])
          if (src.file === file && src.line && DEF.exec(body(file)?.[src.line - 1] ?? '')?.slice(1).includes(name))
            r.reread.push({ element: it.id, label: (it as { label?: string }).label, reason: 'no-longer-used', file, line: src.line, read: [], via: name })
    }
  }
  const inScope = (f: string) => lock.scope.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'))
  for (const [kind, files] of [['added', ch.added], ['modified', ch.changed]] as const)
    for (const [file, ranges] of files)
      if (!cited.has(file) && inScope(file))
        r.new_in_scope.push({ file, change: kind, read: ranges, ...(kind === 'added' ? { preview: (body(file) ?? []).filter((l) => l.trim()).slice(0, 4).map((l) => l.trim().slice(0, 110)) } : {}) })
  r.removed_in_scope = [...ch.deleted].filter((f) => !citedBefore.has(f) && inScope(f)).sort()
  r.new_in_scope.sort((a, b) => a.file.localeCompare(b.file))
  // edits in a cited file that no cited block contains
  const asked = new Map<string, [number, number][]>()
  for (const x of r.reread) asked.set(x.file, [...(asked.get(x.file) ?? []), ...x.read])
  for (const file of [...cited].sort()) {
    const edits = ch.changed.get(file)
    if (!edits) continue
    const known = [...(covered.get(file) ?? []), ...(asked.get(file) ?? [])]
    const loose = edits.filter(([a, b]) => !known.some(([c, d]) => a <= d && b >= c))
    const flatFile = !(body(file) ?? []).some((l) => DEF.test(l))
    if (loose.length && flatFile) r.new_in_scope.push({ file, change: 'modified', read: loose })
    else if (loose.length) r.elsewhere_in_cited_files.push({ file, read: loose, lines: span(loose) })
    const text = body(file)
    for (const [a, b] of text ? loose : []) for (let l = a; l <= Math.min(b, text!.length); l++) if (DEF.test(text![l - 1]!) && r.new_definitions.length < 60) r.new_definitions.push({ file, line: l, text: (/\($/.test(text![l - 1]!.trim()) ? `${text![l - 1]!.trim()} ${(text![l] ?? '').trim()} ${(text![l + 1] ?? '').trim()}` : text![l - 1]!.trim()).slice(0, 120) })
  }
  // one merged list per file: what to open, and for whom
  const plan = new Map<string, { ranges: [number, number][]; elements: Set<string> }>()
  const put = (file: string, ranges: [number, number][], element: string) => {
    const e = plan.get(file) ?? { ranges: [], elements: new Set<string>() }
    e.ranges.push(...ranges)
    e.elements.add(element)
    plan.set(file, e)
  }
  for (const x of r.reread) put(x.file, x.read, x.element)
  for (const x of r.new_in_scope) put(x.file, x.read, '(new in scope)')
  for (const [file, e] of [...plan].sort((a, b) => a[0].localeCompare(b[0]))) {
    const merged: [number, number][] = []
    for (const [a, b] of e.ranges.sort((p, q) => p[0] - q[0])) {
      const top = merged[merged.length - 1]
      if (top && a <= top[1] + 3) top[1] = Math.max(top[1], b)
      else merged.push([a, b])
    }
    r.read_plan.push({ file, read: merged, elements: [...e.elements] })
  }
  // one range read once, however many elements point at it
  const seen = new Set<string>()
  for (const x of [...r.reread, ...r.new_in_scope]) for (const [a, b] of x.read) for (let l = a; l <= b; l++) seen.add(`${x.file}:${l}`)
  r.lines_to_read = seen.size
  // edits outside every cited block are advice, not work: they do not make a diagram stale
  r.status = r.reread.length || r.new_in_scope.length || r.new_definitions.length || r.unstamped.length || r.removed_in_scope.length ? 'needs-review' : r.fixes.length ? 'auto-fixable' : 'fresh'
  const hard = new Set(r.reread.filter((x) => ['text-gone', 'file-gone', 'line-changed'].includes(x.reason)).map((x) => x.element)).size
  const total = citable(spec).filter((it) => it.source).length
  if (total && hard / total > 0.4) r.advice = `${hard} of ${total} cited elements lost their source: treat this as a new first pass, not an update`
  else if (r.lines_to_read > 1500) r.advice = `${r.lines_to_read} changed lines, mostly code nothing cites yet: judge new files by name and new_definitions by signature before opening anything; if little of it belongs here the scope is too wide, and if much of it does it may deserve its own diagram`
  return r
}

/** Apply line and path repairs to a raw (unvalidated-shape) spec object in place. */
export function applyFixes(raw: unknown, fixes: Fix[]) {
  const items = new Map(citable(raw as Spec).map((it) => [it.id, it]))
  for (const f of fixes) {
    const src = [items.get(f.element)?.source].flat()[f.index] as Src | undefined
    if (!src) continue
    if (f.file) src.file = f.file
    if (f.line) src.line = f.line
  }
}

/** Parse `git diff --unified=0` into new-side changed ranges per file. A pure deletion marks the line before it. */
export function parseHunks(diff: string, raw?: Map<string, [number, number, number, number][]>): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>()
  let file: string | null = null
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(4) === '/dev/null' ? null : l.slice(4).replace(/^b\//, '').replace(/\t.*$/, '')
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (m && file) {
      const [start, count] = [Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
      raw?.set(file, [...(raw.get(file) ?? []), [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), start, count]])
      const range: [number, number] = count === 0 ? [Math.max(1, start), Math.max(1, start)] : [start, start + count - 1]
      out.set(file, [...(out.get(file) ?? []), range])
    }
  }
  return out
}
