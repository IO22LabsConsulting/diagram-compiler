// Sequence layout: actors across the top, a lifeline under each, one message per row, time running down.
// Nothing to search for here: columns are as far apart as their longest label needs, rows are as tall as their text.
import { baseline, textWidth } from '../metrics.ts'
import { emptyScene, type Scene, type SEdge } from '../scene.ts'
import type { Spec } from '../spec.ts'
import { mix, type Theme } from '../theme.ts'
import { measureNode, up8 } from './measure.ts'

const GUTTER = 32 // step numbers live here
const [LABEL, DETAIL, NUM] = [13, 11.5, 10]

export function layoutSequence(q: Extract<Spec, { diagram_type: 'sequence' }>, th: Theme): Scene {
  const s = emptyScene()
  const heads = q.actors.map((a) => measureNode({ id: a.id, kind: a.kind, label: a.label, sublabel: a.sublabel, icon: a.icon, color: a.color }, th, { bg: th.bg }))
  const col = new Map(q.actors.map((a, i) => [a.id, i]))
  const msgs = q.steps.flatMap((st) => ('divider' in st ? [] : [st]))
  const labelW = (m: (typeof msgs)[number]) => Math.ceil(Math.max(textWidth(m.label, 'sans-400', LABEL), m.detail ? textWidth(m.detail, 'sans-400', DETAIL) : 0)) + 12

  // columns: wide enough for the two headers, then for every label that has to fit between its two lifelines
  const gap = heads.slice(1).map((h, i) => Math.max(128, (heads[i]!.w + h.w) / 2 + 32))
  let extraRight = 0
  const spans = msgs.map((m) => ({ m, a: Math.min(col.get(m.from)!, col.get(m.to)!), b: Math.max(col.get(m.from)!, col.get(m.to)!) })).sort((x, y) => x.b - x.a - (y.b - y.a))
  for (const { m, a, b } of spans) {
    if (a === b) {
      const need = 40 + labelW(m) + 12
      if (a < gap.length) gap[a] = Math.max(gap[a]!, need)
      else extraRight = Math.max(extraRight, need)
      continue
    }
    const have = gap.slice(a, b).reduce((t, v) => t + v, 0)
    const need = labelW(m) + 32
    if (need > have) for (let k = a; k < b; k++) gap[k]! += (need - have) / (b - a)
  }
  const x = heads.map((_, i) => Math.round(GUTTER + heads[0]!.w / 2 + gap.slice(0, i).reduce((t, v) => t + v, 0)))
  const headH = Math.max(...heads.map((h) => h.h))
  heads.forEach((h, i) => s.nodes.push({ ...h, x: x[i]! - h.w / 2, y: (headH - h.h) / 2 }))
  const W = up8(x[x.length - 1]! + Math.max(heads[heads.length - 1]!.w / 2, extraRight) + 8)

  const rule = mix(th.border, th.muted, 0.35)
  s.lines = []
  let y = headH + 24
  let n = 0
  q.steps.forEach((st, k) => {
    if ('divider' in st) {
      y += 6
      s.lines!.push({ x1: 0, y1: y, x2: W, y2: y, stroke: th.border, width: 1 })
      const text = st.divider.toUpperCase()
      // the caption sits on a plate so the lifelines do not run through it
      s.groups.push({ id: `divider-${k}`, x: GUTTER - 6, y: y + 6, w: Math.ceil(textWidth(text, 'mono-500', 11)) + 12, h: 18, fill: th.bg, stroke: 'none', radius: 0 })
      s.texts.push({ x: GUTTER, y: y + 8 + baseline('mono-500', 11), text, font: 'mono-500', size: 11, fill: th.muted, bg: th.bg, anchor: 'start' })
      y += 36
      return
    }
    n++
    const [xa, xb] = [x[col.get(st.from)!]!, x[col.get(st.to)!]!]
    const [w, h] = [labelW(st), st.detail ? 34 : 19]
    const self = xa === xb
    // a message to itself has its text beside the loop, so it needs no room above the line
    const ay = self ? y + 6 : y + h + 5
    const lx = self ? xa + 40 : Math.round((xa + xb) / 2 - w / 2)
    const ly = self ? ay - 4 : y
    const run = (text: string, size: number, fill: string, dy: number) => ({ x: lx + 6, y: ly + dy + baseline('sans-400', size), text, font: 'sans-400' as const, size, fill, bg: th.bg, anchor: 'start' as const })
    const e: SEdge = {
      id: `m${n}`, from: st.from, to: st.to, curve: 'ortho', stroke: th.edge, strokeWidth: 1.5,
      points: self ? [[xa, ay], [xa + 28, ay], [xa + 28, ay + 22], [xa, ay + 22]] : [[xa, ay], [xb, ay]],
      dash: st.kind === 'reply' ? '6 4' : undefined, arrow: 'end', open: st.kind === 'async',
      label: { x: lx, y: ly, w, h, fill: th.bg, run: run(st.label, LABEL, th.ink, 1), run2: st.detail ? run(st.detail, DETAIL, th.muted, 18) : undefined },
    }
    s.edges.push(e)
    s.texts.push({ x: 0, y: ly + 3 + baseline('mono-500', NUM), text: String(n).padStart(2, '0'), font: 'mono-500', size: NUM, fill: th.muted, bg: th.bg, anchor: 'start' })
    y = (self ? Math.max(ay + 22, ly + h) : ay) + 20
  })
  const H = up8(y + 4)
  x.forEach((cx, i) => s.lines!.unshift({ x1: cx, y1: (headH + heads[i]!.h) / 2, x2: cx, y2: H, stroke: rule, width: 1.25, dash: '2 5' }))
  s.w = W
  s.h = H
  return s
}
