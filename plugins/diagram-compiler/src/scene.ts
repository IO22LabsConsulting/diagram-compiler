// PositionedScene: what every layout engine returns and the only thing the renderer and lint see.
import type { FontKey } from './metrics.ts'

/** One line of text. x is the left edge (anchor start) or centre (anchor middle); y is the baseline. bg is the colour behind it. */
export type TextRun = { x: number; y: number; text: string; font: FontKey; size: number; fill: string; bg: string; anchor: 'start' | 'middle' }
export type Box = { x: number; y: number; w: number; h: number }

export type SNode = Box & {
  id: string
  shape: 'rect' | 'pill' | 'cylinder' | 'none'
  fill: string
  stroke: string
  strokeWidth: number
  dash?: string
  texts: TextRun[] // relative to the node origin
  dots: { x: number; y: number; fill: string }[]
  icon?: { x: number; y: number; size: number; body: string; color: string; tile?: { fill: string; stroke: string } }
  truncated?: boolean
  iconMissing?: string
}
export type SGroup = Box & { id: string; fill: string; stroke: string; dash?: string; radius: number; label?: TextRun }
export type SEdge = {
  id: string
  from: string
  to: string
  points: [number, number][]
  curve: 'ortho' | 'bezier'
  stroke: string
  strokeWidth: number
  dash?: string
  arrow: 'none' | 'end' | 'both'
  open: boolean
  /** `run2` is the second line when a long label was split to fit */
  label?: Box & { run: TextRun; run2?: TextRun; fill: string }
}
export type SPanel = Box & { id: string; fill: string; stroke: string; texts: TextRun[]; dots: SNode['dots']; badge?: { cx: number; cy: number; r: number; fill: string; run: TextRun } }

export type Scene = { w: number; h: number; nodes: SNode[]; groups: SGroup[]; edges: SEdge[]; panels: SPanel[]; texts: TextRun[]; /** set on single-direction flow candidates, read by the layout score */ flow?: 'LR' | 'TB'; /** ids of elements whose text was cut to fit (tables); lint reports them */ clipped?: string[]; /** plain strokes that carry no meaning to lint (lifelines, dividers) */ lines?: SLine[] }
export type SLine = { x1: number; y1: number; x2: number; y2: number; stroke: string; width: number; dash?: string }

export const emptyScene = (): Scene => ({ w: 0, h: 0, nodes: [], groups: [], edges: [], panels: [], texts: [] })

const moveRun = (r: TextRun, dx: number, dy: number): TextRun => ({ ...r, x: r.x + dx, y: r.y + dy })

/** Translate a scene and namespace its ids (used when a panel embeds a sub-diagram). */
export function shift(s: Scene, dx: number, dy: number, prefix = ''): Scene {
  const box = <T extends Box>(b: T): T => ({ ...b, x: b.x + dx, y: b.y + dy })
  return {
    w: s.w,
    h: s.h,
    nodes: s.nodes.map((n) => ({ ...box(n), id: prefix + n.id })),
    groups: s.groups.map((g) => ({ ...box(g), id: prefix + g.id, label: g.label && moveRun(g.label, dx, dy) })),
    edges: s.edges.map((e) => ({
      ...e,
      id: prefix + e.id,
      from: prefix + e.from,
      to: prefix + e.to,
      points: e.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      label: e.label && { ...box(e.label), run: moveRun(e.label.run, dx, dy), run2: e.label.run2 && moveRun(e.label.run2, dx, dy) },
    })),
    panels: s.panels.map((p) => ({
      ...box(p),
      texts: p.texts.map((r) => moveRun(r, dx, dy)),
      dots: p.dots.map((d) => ({ ...d, x: d.x + dx, y: d.y + dy })),
      badge: p.badge && { ...p.badge, cx: p.badge.cx + dx, cy: p.badge.cy + dy, run: moveRun(p.badge.run, dx, dy) },
    })),
    texts: s.texts.map((r) => moveRun(r, dx, dy)),
    clipped: s.clipped,
    lines: s.lines?.map((l) => ({ ...l, x1: l.x1 + dx, x2: l.x2 + dx, y1: l.y1 + dy, y2: l.y2 + dy })),
  }
}

export function merge(into: Scene, s: Scene) {
  into.nodes.push(...s.nodes)
  into.groups.push(...s.groups)
  into.edges.push(...s.edges)
  into.panels.push(...s.panels)
  into.texts.push(...s.texts)
  if (s.clipped) into.clipped = [...(into.clipped ?? []), ...s.clipped]
  if (s.lines) into.lines = [...(into.lines ?? []), ...s.lines]
}
