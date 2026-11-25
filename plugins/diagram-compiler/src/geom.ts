// Small geometry helpers shared by label placement, layout scoring and lint.
import type { Box, Scene, SEdge } from './scene.ts'

export const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
export type Seg = [[number, number], [number, number]]

/** Edge as straight segments (beziers are sampled). */
export function segments(e: SEdge): Seg[] {
  let pts = e.points
  if (e.curve === 'bezier' && pts.length === 4) {
    const [a, b, c, d] = pts as [[number, number], [number, number], [number, number], [number, number]]
    pts = Array.from({ length: 13 }, (_, i) => {
      const t = i / 12, u = 1 - t
      return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0], u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]] as [number, number]
    })
  }
  return pts.slice(1).map((p, i) => [pts[i]!, p])
}

export function segHitsBox([p, q]: Seg, b: Box): boolean {
  // Liang-Barsky clip of the segment against the box
  let [t0, t1] = [0, 1]
  const [dx, dy] = [q[0] - p[0], q[1] - p[1]]
  for (const [d, lo, hi] of [[dx, b.x - p[0], b.x + b.w - p[0]], [dy, b.y - p[1], b.y + b.h - p[1]]] as const) {
    if (d === 0) {
      if (lo > 0 || hi < 0) return false
    } else {
      const [a, c] = [lo / d, hi / d]
      t0 = Math.max(t0, Math.min(a, c))
      t1 = Math.min(t1, Math.max(a, c))
      if (t0 > t1) return false
    }
  }
  return true
}

export function segsCross([a, b]: Seg, [c, d]: Seg): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

export const sameEnds = (a: SEdge, b: SEdge) => a.from === b.from || a.to === b.to || a.from === b.to || a.to === b.from

/** Length two edges spend drawn on top of each other (collinear, overlapping, axis-aligned runs). */
export function sharedRun(a: Seg[], b: Seg[]): number {
  let total = 0
  for (const [p, q] of a)
    for (const [r, t] of b)
      for (const k of [0, 1] as const) {
        const o = (1 - k) as 0 | 1
        // both segments lie on the same line along axis k
        if (Math.abs(p[o] - q[o]) < 1 && Math.abs(r[o] - t[o]) < 1 && Math.abs(p[o] - r[o]) < 2)
          total += Math.max(0, Math.min(Math.max(p[k], q[k]), Math.max(r[k], t[k])) - Math.max(Math.min(p[k], q[k]), Math.min(r[k], t[k])))
      }
  return total
}

/** Groups an edge cuts straight through although neither of its ends is inside them. */
export function foreignGroups(s: Scene, e: SEdge, segs: Seg[]) {
  const within = (id: string, g: Box) => {
    const b = s.nodes.find((n) => n.id === id) ?? s.groups.find((x) => x.id === id)
    return !!b && b.x >= g.x - 1 && b.y >= g.y - 1 && b.x + b.w <= g.x + g.w + 1 && b.y + b.h <= g.y + g.h + 1
  }
  return s.groups.filter((g) => !within(e.from, g) && !within(e.to, g) && segs.some((sg) => segHitsBox(sg, { x: g.x + 8, y: g.y + 8, w: g.w - 16, h: g.h - 16 })))
}
