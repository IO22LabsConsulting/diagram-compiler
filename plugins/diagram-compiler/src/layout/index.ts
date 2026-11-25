// Layout dispatcher: routes a spec to its engine, packs grid panels, then composes the page
// (title, subtitle, footer, margins) and fits it to the requested aspect.
import { baseline, lineHeight, textWidth, wrap, type FontKey } from '../metrics.ts'
import { emptyScene, merge, shift, type Scene, type SPanel, type TextRun } from '../scene.ts'
import type { PanelDiagram, Spec, SpecPanel } from '../spec.ts'
import type { Theme } from '../theme.ts'
import { layoutFlow } from './flow.ts'
import { layoutSequence } from './sequence.ts'
import { solid, up8 } from './measure.ts'
import { layoutTree } from './tree.ts'

export const ASPECTS: Record<string, number | null> = { auto: null, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9, A4: 210 / 297 }
export type Page = Scene & { contentArea: number; naturalW: number; naturalH: number }

async function layoutDiagram(d: PanelDiagram | Spec, th: Theme, bg: string, ratio: number, fixed = false, nested = false): Promise<Scene> {
  if (d.diagram_type === 'flow') return layoutFlow(d, th, bg, ratio, fixed)
  if (d.diagram_type === 'grid') return layoutGrid(d.panels, d.columns, th, ratio, fixed)
  if (d.diagram_type === 'table') return layoutTable(d, th)
  if (d.diagram_type === 'sequence') return layoutSequence(d, th)
  return layoutTree(d.root, th, bg, d.diagram_type, nested)
}

function lines(s: Scene, text: string, font: FontKey, size: number, x: number, top: number, maxW: number, fill: string, bg: string, maxLines: number) {
  const w = wrap(text, font, size, maxW, maxLines)
  const runs: TextRun[] = w.lines.map((l, i) => ({ x, y: top + i * lineHeight(size) + baseline(font, size), text: l, font, size, fill, bg, anchor: 'start' }))
  s.texts.push(...runs)
  return { height: w.lines.length * lineHeight(size), width: w.width, truncated: w.truncated }
}

/** Rows by columns in one framed panel: hairlines between rows, a heavier rule under the header, no fills. */
function layoutTable(t: Extract<Spec, { diagram_type: 'table' }>, th: Theme): Scene {
  const [PX, PY, BUDGET] = [14, 10, 1120]
  const cols = t.columns.length
  const font = (j: number): FontKey => (j === 0 ? 'sans-600' : 'sans-400')
  // each column starts as wide as its longest line, then the widest give way until the table fits
  const w = t.columns.map((h, j) => Math.max(72, Math.ceil(Math.max(textWidth(h.toUpperCase(), 'mono-500', 11), ...t.rows.map((r) => textWidth(r.cells[j] ?? '', font(j), 13))))))
  const cap = (j: number) => (j === 0 ? 200 : 340)
  w.forEach((v, j) => (w[j] = Math.min(v, cap(j))))
  while (w.reduce((a, b) => a + b, 0) + cols * 2 * PX > BUDGET) {
    const widest = w.indexOf(Math.max(...w))
    if (w[widest]! <= 120) break
    w[widest]! -= 8
  }
  const x = w.map((_, j) => w.slice(0, j).reduce((a, b) => a + b + 2 * PX, 0))
  const W = up8(w.reduce((a, b) => a + b + 2 * PX, 0))
  const s = emptyScene()
  const frame: SPanel = { id: 'table', x: 0, y: 0, w: W, h: 0, fill: th.surface, stroke: th.border, texts: [], dots: [] }
  const rule = (y: number, h: number, fill: string) => s.groups.push({ id: `rule-${s.groups.length}`, x: 0.75, y, w: W - 1.5, h, fill, stroke: 'none', radius: 0 })
  let y = PY
  const head = Math.max(...t.columns.map((h, j) => lines(s, h.toUpperCase(), 'mono-500', 11, x[j]! + PX, y, w[j]!, th.muted, th.surface, 2).height))
  y += head + PY
  rule(y, 1.5, th.ink)
  t.rows.forEach((r, i) => {
    if (i) rule(y, 1, th.border)
    const top = y + PY
    const hs = r.cells.map((c, j) => {
      if (!c) return 0
      const cell = lines(s, c, font(j), 13, x[j]! + PX, top, w[j]!, j === 0 && r.color ? solid(th, th.colors[r.color].stroke) : th.ink, th.surface, 6)
      if (cell.truncated) (s.clipped ??= []).push(`rows[${i}].cells[${j}]`)
      return cell.height
    })
    y = top + Math.max(lineHeight(13), ...hs) + PY
  })
  frame.h = up8(y)
  frame.texts = s.texts
  s.texts = []
  s.panels.push(frame)
  s.w = W
  s.h = frame.h
  return s
}

async function layoutGrid(panels: SpecPanel[], columns: number | undefined, th: Theme, ratio: number, fixed: boolean): Promise<Scene> {
  const PAD = 16
  const GAP = 20
  const subs = await Promise.all(panels.map((p) => (p.diagram ? layoutDiagram(p.diagram, th, th.surface, 1.2, false, true) : null)))
  const baseW = up8(Math.max(232, ...subs.map((s) => s?.w ?? 0)))

  const build = (innerW: number) => (p: SpecPanel, i: number) => {
    // panels are neutral unless the spec gives them a colour; the badge carries the accent
    const sw = p.color ? th.colors[p.color] : null
    const accent = solid(th, sw ? sw.stroke : th.colors.green.stroke)
    const s = emptyScene()
    const panel: SPanel = { id: p.id, x: 0, y: 0, w: innerW + 2 * PAD, h: 0, fill: th.surface, stroke: sw ? sw.stroke : th.border, texts: [], dots: [] }
    let y = PAD
    let titleX = PAD
    if (p.badge) {
      const r = 11
      panel.badge = { cx: PAD + r, cy: y + r, r, fill: accent, run: { x: PAD + r, y: y + r - 8 + baseline('mono-600', 11), text: p.badge, font: 'mono-600', size: 11, fill: th.onSolid, bg: accent, anchor: 'middle' } }
      titleX += 2 * r + 8
    }
    const t = lines(s, p.title, 'sans-600', 15, titleX, y, innerW - (titleX - PAD), th.ink, th.surface, 2)
    y += Math.max(t.height, p.badge ? 22 : 0) + 4
    // the caption introduces the panel, so it sits under the title
    if (p.caption) y += lines(s, p.caption, 'sans-400', 12, PAD, y, innerW, th.muted, th.surface, 3).height
    y += 12
    const titleRuns = s.texts.length
    const sub = subs[i]
    if (sub) {
      merge(s, shift(sub, PAD + (innerW - sub.w) / 2, y, `${p.id}/`))
      y += sub.h + 12
    }
    for (const b of p.bullets ?? []) {
      panel.dots.push({ x: PAD + 3, y: y + lineHeight(12) / 2, fill: th.muted })
      y += lines(s, b, 'sans-400', 12, PAD + 12, y, innerW - 12, th.ink, th.surface, 3).height + 4
    }
    if (p.bullets?.length) y += 8
    panel.texts = s.texts
    s.texts = []
    panel.h = up8(y - 12 + PAD)
    s.panels.push(panel)
    return { s, titleRuns }
  }

  const pack = (cols: number, innerW = baseW, tall = 1): Scene => {
    const built = panels.map(build(innerW))
    const scene = emptyScene()
    let y = 0
    for (let r = 0; r * cols < built.length; r++) {
      const row = built.slice(r * cols, r * cols + cols)
      const h = up8(Math.max(...row.map((b) => b.s.panels[0]!.h)) * tall)
      row.forEach((b, c) => {
        // equal heights along a row; contents stay top-aligned so bullets line up across the row
        const panel = b.s.panels[0]!
        panel.h = h
        merge(scene, shift(b.s, c * (innerW + 2 * PAD + GAP), y))
      })
      y += h + GAP
    }
    scene.w = cols * (innerW + 2 * PAD) + (cols - 1) * GAP
    scene.h = y - GAP
    return scene
  }
  // no column count given: take the one whose shape is closest to the canvas
  const off = (s: Scene) => Math.abs(Math.log(s.w / s.h / ratio))
  const counts = columns ? [Math.min(columns, panels.length)] : Array.from({ length: Math.min(4, panels.length) }, (_, i) => i + 1)
  const cols = counts.reduce((best, n) => (off(pack(n)) < off(pack(best)) ? n : best))
  const s = pack(cols)
  if (!fixed) return s
  // a fixed canvas: panels may grow up to 1.6x wider or 1.5x taller to fill it instead of leaving padding
  const r = s.w / s.h / ratio
  return r < 1 ? pack(cols, up8(Math.min(baseW * 1.6, baseW / r))) : pack(cols, baseW, Math.min(1.5, r))
}

export async function layout(spec: Spec, th: Theme): Promise<Page> {
  const M = 40
  const ratio = ASPECTS[spec.canvas.aspect] ?? null
  const content = await layoutDiagram(spec, th, th.bg, ratio ?? 1.4, ratio !== null)

  const page = emptyScene()
  const wrapW = Math.max(content.w, 560)
  let y = 0
  const title = lines(page, spec.title, 'sans-700', 26, 0, y, wrapW, th.ink, th.bg, 3)
  y += title.height
  let headW = title.width
  if (spec.subtitle) {
    const st = lines(page, spec.subtitle, 'sans-400', 14, 0, y + 6, wrapW, th.muted, th.bg, 3)
    y += 6 + st.height
    headW = Math.max(headW, st.width)
  }
  const headH = y + 28
  const footH = spec.footer ? 24 + lineHeight(11) : 0
  const blockW = Math.max(content.w, headW, spec.footer ? textWidth(spec.footer, 'mono-400', 11) : 0)
  const naturalW = blockW + 2 * M
  const naturalH = headH + content.h + footH + 2 * M
  let [W, H] = [naturalW, naturalH]
  if (ratio) {
    if (W / H > ratio) H = W / ratio
    else W = H * ratio
  }
  W = Math.ceil(W)
  H = Math.ceil(H)
  const bx = Math.round((W - blockW) / 2)
  const extraY = H - naturalH
  const out = shift(page, bx, M)
  merge(out, shift(content, bx + Math.round((blockW - content.w) / 2), M + headH + Math.round(extraY / 2)))
  if (spec.footer)
    out.texts.push({ x: bx, y: H - M - lineHeight(11) + baseline('mono-400', 11), text: spec.footer, font: 'mono-400', size: 11, fill: th.muted, bg: th.bg, anchor: 'start' })
  return { ...out, w: W, h: H, contentArea: naturalW * naturalH, naturalW, naturalH }
}
