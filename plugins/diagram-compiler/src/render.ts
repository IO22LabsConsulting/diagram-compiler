// SVG emitter: PositionedScene -> SVG string. No DOM. Emits only: svg, title, rect, path, circle, g.
// Spec strings reach the output in exactly two ways: as glyph outlines, or XML-escaped in <title>.
import { textPath, textWidth } from './metrics.ts'
import type { Page } from './layout/index.ts'
import type { SEdge, SNode, TextRun } from './scene.ts'
import type { Theme } from './theme.ts'

export class RenderError extends Error {}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const n = (v: number) => String(Math.round(v * 100) / 100)

function text(r: TextRun, dx = 0, dy = 0): string {
  const x = r.x + dx - (r.anchor === 'middle' ? textWidth(r.text, r.font, r.size) / 2 : 0)
  return `<path fill="${r.fill}" d="${textPath(r.text, r.font, r.size, x, r.y + dy)}"/>`
}

function nodeShape(s: SNode): string {
  const paint = `fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}`
  if (s.shape === 'none') return ''
  if (s.shape === 'cylinder') {
    const ry = 7
    const [l, r, t, b] = [s.x, s.x + s.w, s.y + ry, s.y + s.h - ry]
    const rx = s.w / 2
    return (
      `<path ${paint} d="M${n(l)} ${n(t)}A${n(rx)} ${ry} 0 0 1 ${n(r)} ${n(t)}V${n(b)}A${n(rx)} ${ry} 0 0 1 ${n(l)} ${n(b)}Z"/>` +
      `<path fill="none" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" d="M${n(l)} ${n(t)}A${n(rx)} ${ry} 0 0 0 ${n(r)} ${n(t)}"/>`
    )
  }
  const rad = s.shape === 'pill' ? s.h / 2 : 6
  return `<rect ${paint} x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" rx="${n(rad)}"/>`
}

function node(s: SNode): string {
  let o = nodeShape(s)
  if (s.icon) {
    const i = s.icon
    if (i.tile) o += `<rect fill="${i.tile.fill}" stroke="${i.tile.stroke}" stroke-width="1" x="${n(s.x + i.x - 10)}" y="${n(s.y + i.y - 10)}" width="${i.size + 20}" height="${i.size + 20}" rx="8"/>`
    o += `<g color="${i.color}" transform="translate(${n(s.x + i.x)} ${n(s.y + i.y)}) scale(${n(i.size / 24)})">${i.body}</g>`
  }
  for (const d of s.dots) o += `<circle fill="${d.fill}" cx="${n(s.x + d.x)}" cy="${n(s.y + d.y)}" r="1.75"/>`
  for (const t of s.texts) o += text(t, s.x, s.y)
  return o
}

function arrowHead(tip: [number, number], from: [number, number], color: string, open: boolean): string {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  const [L, Wd] = [8, 3.5]
  const p = (d: number, side: number): string => `${n(tip[0] - d * Math.cos(a) + side * Math.sin(a))} ${n(tip[1] - d * Math.sin(a) - side * Math.cos(a))}`
  return open
    ? `<path fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M${p(L, Wd)}L${n(tip[0])} ${n(tip[1])}L${p(L, -Wd)}"/>`
    : `<path fill="${color}" d="M${n(tip[0])} ${n(tip[1])}L${p(L, Wd)}L${p(L, -Wd)}Z"/>`
}

/** Pull an endpoint back along its segment so the stroke ends inside the arrowhead, not past its tip. */
function trim(pts: [number, number][], atEnd: boolean, by: number): [number, number][] {
  const out = pts.map((p) => [...p] as [number, number])
  const [i, j] = atEnd ? [out.length - 1, out.length - 2] : [0, 1]
  const [dx, dy] = [out[i]![0] - out[j]![0], out[i]![1] - out[j]![1]]
  const len = Math.hypot(dx, dy)
  if (len > by + 1) out[i] = [out[i]![0] - (dx / len) * by, out[i]![1] - (dy / len) * by]
  return out
}

function edge(e: SEdge): string {
  const P = e.points
  if (P.length < 2) return ''
  let o = ''
  let d: string
  if (e.curve === 'bezier' && P.length === 4) {
    d = `M${n(P[0]![0])} ${n(P[0]![1])}C${P.slice(1).map((p) => `${n(p[0])} ${n(p[1])}`).join(' ')}`
  } else {
    let pts = P
    if (e.arrow !== 'none' && !e.open) pts = trim(pts, true, 5)
    if (e.arrow === 'both' && !e.open) pts = trim(pts, false, 5)
    d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`
    for (let i = 1; i < pts.length - 1; i++) {
      // rounded corner
      const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!]
      const r = Math.min(6, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2)
      const toward = (p: [number, number], q: [number, number]) => {
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
        return [p[0] + ((q[0] - p[0]) / l) * r, p[1] + ((q[1] - p[1]) / l) * r] as const
      }
      const [s1, s2] = [toward(b, a), toward(b, c)]
      d += `L${n(s1[0])} ${n(s1[1])}Q${n(b[0])} ${n(b[1])} ${n(s2[0])} ${n(s2[1])}`
    }
    const last = pts[pts.length - 1]!
    d += `L${n(last[0])} ${n(last[1])}`
  }
  o += `<path fill="none" stroke="${e.stroke}" stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${e.dash ? ` stroke-dasharray="${e.dash}"` : ''} d="${d}"/>`
  if (e.arrow !== 'none') o += arrowHead(P[P.length - 1]!, P[P.length - 2]!, e.stroke, e.open)
  if (e.arrow === 'both') o += arrowHead(P[0]!, P[1]!, e.stroke, e.open)
  return o
}

export function renderSvg(page: Page, th: Theme, title: string, debug = false): string {
  const o: string[] = []
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${page.w}" height="${page.h}" viewBox="0 0 ${page.w} ${page.h}" role="img" aria-label="${esc(title)}">`)
  o.push(`<title>${esc(title)}</title>`)
  o.push(`<rect width="${page.w}" height="${page.h}" fill="${th.bg}"/>`)
  for (const p of page.panels) o.push(`<rect fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.25" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" rx="8"/>`)
  // plain strokes go under everything else, so a caption plate can interrupt a lifeline
  for (const l of page.lines ?? []) o.push(`<path fill="none" stroke="${l.stroke}" stroke-width="${l.width}"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''} d="M${n(l.x1)} ${n(l.y1)}L${n(l.x2)} ${n(l.y2)}"/>`)
  for (const g of page.groups)
    o.push(`<rect fill="${g.fill}" stroke="${g.stroke}" stroke-width="1.25"${g.dash ? ` stroke-dasharray="${g.dash}"` : ''} x="${n(g.x)}" y="${n(g.y)}" width="${n(g.w)}" height="${n(g.h)}" rx="${g.radius}"/>`)
  for (const g of page.groups) if (g.label) o.push(text(g.label))
  for (const e of page.edges) o.push(edge(e))
  for (const s of page.nodes) o.push(node(s))
  for (const e of page.edges)
    if (e.label) o.push(`<rect fill="${e.label.fill}" x="${n(e.label.x)}" y="${n(e.label.y)}" width="${n(e.label.w)}" height="${n(e.label.h)}" rx="3"/>` + text(e.label.run) + (e.label.run2 ? text(e.label.run2) : ''))
  for (const p of page.panels) {
    if (p.badge) o.push(`<circle fill="${p.badge.fill}" cx="${n(p.badge.cx)}" cy="${n(p.badge.cy)}" r="${p.badge.r}"/>` + text(p.badge.run))
    for (const d of p.dots) o.push(`<circle fill="${d.fill}" cx="${n(d.x)}" cy="${n(d.y)}" r="2"/>`)
    for (const t of p.texts) o.push(text(t))
  }
  for (const t of page.texts) o.push(text(t))
  if (debug) {
    const box = (b: { x: number; y: number; w: number; h: number }, c: string) => `<rect fill="none" stroke="${c}" stroke-width="0.75" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"/>`
    for (const s of page.nodes) o.push(box(s, '#FF00AA'))
    for (const g of page.groups) o.push(box(g, '#00AAFF'))
    for (const e of page.edges) if (e.label) o.push(box(e.label, '#FF8800'))
  }
  o.push('</svg>')
  return o.join('\n')
}
