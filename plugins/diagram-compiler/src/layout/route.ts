// Edge router: orthogonal A* over a grid laid on the positioned nodes. ELK decides where nodes go;
// this decides how edges travel. It exists because a layered router cannot do three things a
// reader needs: leave a node on the side that faces its target, keep two unrelated edges off the
// same line, and bring many edges into one node without circling the diagram.
import { shift, type Box, type Scene, type SEdge } from '../scene.ts'

const STEP = 12 // grid pitch: also the minimum gap between parallel edges
const CLEAR = 14 // edges keep this far from nodes they do not touch
const BEND = 30 // a corner costs as much as this many pixels of travel
const CROSS = 60 // crossing another edge
const SHARE = 9 // per pixel, for running along another edge's line
const FOREIGN = 0.8 // per pixel, inside a group the edge has no business in
const AWAY = 90 // leaving or arriving on the side that faces away from the other end
const PASSES = 3 // one greedy pass, then this many minus one re-routes of every edge

type Dir = 0 | 1 | 2 | 3 // right, down, left, up
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/** Sorted grid lines: an even pitch, plus every box centre so aligned nodes get a straight edge. */
function lines(lo: number, hi: number, centres: number[]): number[] {
  const out: number[] = []
  // centres closer than the pitch would let two edges run almost on top of each other: keep the first
  const cs: number[] = []
  for (const c of [...new Set(centres.map((v) => Math.round(v)))].sort((a, b) => a - b)) if (!cs.some((k) => Math.abs(k - c) < STEP)) cs.push(c)
  for (let v = Math.floor(lo / STEP) * STEP; v <= hi; v += STEP) if (!cs.some((c) => Math.abs(c - v) < STEP * 0.75)) out.push(v)
  return [...out, ...cs].sort((a, b) => a - b)
}

class Heap {
  private a: number[] = [] // pairs: priority, value
  get size() {
    return this.a.length >> 1
  }
  push(p: number, v: number) {
    const a = this.a
    let i = a.length
    a.push(p, v)
    while (i > 0) {
      const up = ((i >> 1) - 1) & ~1
      if (a[up]! <= a[i]!) break
      ;[a[up], a[up + 1], a[i], a[i + 1]] = [a[i]!, a[i + 1]!, a[up]!, a[up + 1]!]
      i = up
    }
  }
  pop(): [number, number] {
    const a = this.a
    const top: [number, number] = [a[0]!, a[1]!]
    const v = a.pop()!
    const p = a.pop()!
    if (a.length) {
      a[0] = p
      a[1] = v
      for (let i = 0; ; ) {
        const l = 2 * i + 2
        const r = l + 2
        let m = i
        if (l < a.length && a[l]! < a[m]!) m = l
        if (r < a.length && a[r]! < a[m]!) m = r
        if (m === i) break
        ;[a[m], a[m + 1], a[i], a[i + 1]] = [a[i]!, a[i + 1]!, a[m]!, a[m + 1]!]
        i = m
      }
    }
    return top
  }
}

const inside = (b: Box, x: number, y: number, pad = 0) => x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad
const onLine = (v: number, start: number, size: number) => Math.abs(v - start) < 9 || Math.abs(v - start - size) < 9
const contains = (outer: Box, b: Box) => b.x >= outer.x - 1 && b.y >= outer.y - 1 && b.x + b.w <= outer.x + outer.w + 1 && b.y + b.h <= outer.y + outer.h + 1

/** Re-route every edge of a flow scene in place and re-fit the scene bounds. Deterministic. */
export function routeEdges(scene: Scene, labelled: Set<string> = new Set()): Scene {
  const { nodes, groups } = scene
  if (!scene.edges.length) return scene
  const boxOf = new Map<string, Box>([...groups, ...nodes].map((b) => [b.id, b]))
  const M = 48
  const xs = lines(-M, scene.w + M, [...nodes, ...groups].map((b) => b.x + b.w / 2))
  const ys = lines(-M, scene.h + M, [...nodes, ...groups].map((b) => b.y + b.h / 2))
  const [nx, ny] = [xs.length, ys.length]
  const cell = (ix: number, iy: number) => ix * ny + iy

  // -1 free, otherwise the node whose body (hard) or margin (soft) covers the cell
  const hard = new Int32Array(nx * ny).fill(-1)
  const soft = new Int32Array(nx * ny).fill(-1)
  nodes.forEach((n, k) => {
    for (let ix = 0; ix < nx; ix++) {
      if (xs[ix]! <= n.x - CLEAR || xs[ix]! >= n.x + n.w + CLEAR) continue
      for (let iy = 0; iy < ny; iy++) {
        if (!inside(n, xs[ix]!, ys[iy]!, CLEAR)) continue
        soft[cell(ix, iy)] = k
        if (inside(n, xs[ix]!, ys[iy]!, -0.5) || inside(n, xs[ix]!, ys[iy]!)) hard[cell(ix, iy)] = k
      }
    }
  })
  // a group's title is text: an edge drawn through it strikes it out
  const titles = groups.flatMap((g) => (g.label ? [{ x: g.x + 6, y: g.y + 2, w: g.label.text.length * 6.8 + 16, h: 26 }] : []))
  const onTitle = new Uint8Array(nx * ny)
  for (const t of titles) for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) if (inside(t, xs[ix]!, ys[iy]!)) onTitle[cell(ix, iy)] = 1
  // which edges already run horizontally / vertically through each cell
  const horiz: number[][] = Array.from({ length: nx * ny }, () => [])
  const vert: number[][] = Array.from({ length: nx * ny }, () => [])

  const used: number[][] = [] // cells each edge occupies, so a re-route can lift it off the map
  // re-enter a kept route into the occupancy map (its points lie on grid lines)
  const mark = (p: [number, number], q: [number, number], i: number) => {
    const [ix0, ix1] = [xs.indexOf(Math.min(p[0], q[0])), xs.indexOf(Math.max(p[0], q[0]))]
    const [iy0, iy1] = [ys.indexOf(Math.min(p[1], q[1])), ys.indexOf(Math.max(p[1], q[1]))]
    if (ix0 < 0 || ix1 < 0 || iy0 < 0 || iy1 < 0) return
    for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) (p[1] === q[1] ? horiz : vert)[cell(ix, iy)]!.push(i)
  }
  const centre = (id: string) => {
    const b = boxOf.get(id)!
    return [b.x + b.w / 2, b.y + b.h / 2] as const
  }
  const order = scene.edges
    .map((e, i) => ({ e, i, d: boxOf.has(e.from) && boxOf.has(e.to) ? Math.abs(centre(e.from)[0] - centre(e.to)[0]) + Math.abs(centre(e.from)[1] - centre(e.to)[1]) : 0 }))
    .sort((a, b) => a.d - b.d || a.i - b.i)

  // First pass: shortest edges first, each avoiding those already drawn. Later passes: take one edge out and route it
  // again now that every other edge is known, so an early edge no longer forces a late one the long way round.
  for (let pass = 0; pass < PASSES; pass++)
  for (const { e, i } of order) {
    const [A, B] = [boxOf.get(e.from), boxOf.get(e.to)]
    if (!A || !B) continue
    if (e.from === e.to) {
      const [r, cy] = [A.x + A.w, A.y + A.h / 2]
      e.points = [[r, cy - 10], [r + 24, cy - 10], [r + 24, cy + 10], [r, cy + 10]]
      continue
    }
    if (pass) for (const occ of [horiz, vert]) for (const c of used[i] ?? []) occ[c] = occ[c]!.filter((k) => k !== i)
    const [ka, kb] = [nodes.findIndex((n) => n.id === e.from), nodes.findIndex((n) => n.id === e.to)]
    const foreign = groups.filter((g) => g !== A && g !== B && !contains(g, A) && !contains(g, B))
    // only unlabelled edges of the same kind arriving at the same node may merge into one line (a fan-in);
    // two labelled edges on one line read as one edge with two names
    const friendly = (o: SEdge) => o.to === e.to && o.dash === e.dash && o.from !== e.to && !labelled.has(o.id) && !labelled.has(e.id)
    const blocked = (c: number) => hard[c] !== -1 || (soft[c] !== -1 && soft[c] !== ka && soft[c] !== kb)

    // ports: any grid line that meets a side of the box, cheapest at the middle of the side
    type Port = { c: number; dir: Dir; at: [number, number]; cost: number }
    const ports = (b: Box, isGroup: boolean, other: Box): Port[] => {
      const out: Port[] = []
      // a side that faces directly away from the other end is a last resort: the edge would start by walking backwards
      const away = [other.x + other.w <= b.x, other.y + other.h <= b.y, other.x >= b.x + b.w, other.y >= b.y + b.h].map((v) => (v ? AWAY : 0)) // by Dir: right, down, left, up
      const edgeIn = isGroup ? 14 : Math.min(10, b.w / 4, b.h / 4)
      const first = (arr: number[], v: number, up: boolean) => {
        // nearest grid index strictly beyond v
        if (up) for (let k = 0; k < arr.length; k++) if (arr[k]! > v + 0.5) return k
        if (!up) for (let k = arr.length - 1; k >= 0; k--) if (arr[k]! < v - 0.5) return k
        return -1
      }
      for (let ix = 0; ix < nx; ix++) {
        const x = xs[ix]!
        if (x < b.x + edgeIn || x > b.x + b.w - edgeIn) continue
        const off = (Math.abs(x - (b.x + b.w / 2)) / Math.max(1, b.w)) * 40
        const [up, down] = [first(ys, b.y, false), first(ys, b.y + b.h, true)]
        if (up >= 0) out.push({ c: cell(ix, up), dir: 3, at: [x, b.y], cost: off + (b.y - ys[up]!) + away[3]! })
        if (down >= 0) out.push({ c: cell(ix, down), dir: 1, at: [x, b.y + b.h], cost: off + (ys[down]! - b.y - b.h) + away[1]! })
      }
      for (let iy = 0; iy < ny; iy++) {
        const y = ys[iy]!
        if (y < b.y + edgeIn || y > b.y + b.h - edgeIn) continue
        const off = (Math.abs(y - (b.y + b.h / 2)) / Math.max(1, b.h)) * 40
        const [left, right] = [first(xs, b.x, false), first(xs, b.x + b.w, true)]
        if (left >= 0) out.push({ c: cell(left, iy), dir: 2, at: [b.x, y], cost: off + (b.x - xs[left]!) + away[2]! })
        if (right >= 0) out.push({ c: cell(right, iy), dir: 0, at: [b.x + b.w, y], cost: off + (xs[right]! - b.x - b.w) + away[0]! })
      }
      return out.filter((p) => !blocked(p.c))
    }
    const starts = ports(A, ka < 0, B)
    // arrive moving opposite to the port's outward direction
    const goals = new Map<number, Port>(ports(B, kb < 0, A).map((p) => [p.c * 4 + ((p.dir + 2) % 4), p]))
    if (!starts.length || !goals.size) continue // boxed in: keep the route ELK gave

    const [tx, ty] = centre(e.to)
    const h = (c: number) => {
      const [x, y] = [xs[Math.floor(c / ny)]!, ys[c % ny]!]
      return Math.max(0, Math.abs(x - tx) - B.w / 2) + Math.max(0, Math.abs(y - ty) - B.h / 2)
    }
    const dist = new Float64Array(nx * ny * 4).fill(Infinity)
    const prev = new Int32Array(nx * ny * 4).fill(-1)
    const heap = new Heap()
    for (const p of starts) {
      const s = p.c * 4 + p.dir
      if (p.cost < dist[s]!) {
        dist[s] = p.cost
        prev[s] = -2 - starts.indexOf(p)
        heap.push(p.cost + h(p.c), s)
      }
    }
    let end = -1
    let best = Infinity
    while (heap.size) {
      const [f, s] = heap.pop()
      if (f >= best) break
      const c = Math.floor(s / 4)
      const d = (s % 4) as Dir
      const g = dist[s]!
      if (f > g + h(c) + 1e-6) continue // stale entry
      const goal = goals.get(s)
      if (goal && g + goal.cost < best) {
        best = g + goal.cost
        end = s
      }
      const [ix, iy] = [Math.floor(c / ny), c % ny]
      for (const nd of [d, (d + 1) % 4, (d + 3) % 4] as Dir[]) {
        const [jx, jy] = [ix + DX[nd]!, iy + DY[nd]!]
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue
        const t = cell(jx, jy)
        if (blocked(t)) continue
        const len = Math.abs(xs[jx]! - xs[ix]!) + Math.abs(ys[jy]! - ys[iy]!)
        const along = nd % 2 === 0 ? horiz : vert
        const across = nd % 2 === 0 ? vert : horiz
        let cost = len + (nd === d ? 0 : BEND)
        // sharing a line with an unrelated edge is what makes two edges read as one
        if (along[t]!.some((k) => !friendly(scene.edges[k]!)) || along[c]!.some((k) => !friendly(scene.edges[k]!))) cost += len * SHARE
        if (across[t]!.some((k) => !friendly(scene.edges[k]!))) cost += CROSS
        if (foreign.some((gr) => inside(gr, xs[jx]!, ys[jy]!))) cost += len * FOREIGN
        if (onTitle[t]) cost += 200
        // an edge drawn along a group's border hides the border and reads as part of it
        if (groups.some((gr) => (nd % 2 === 0 ? onLine(ys[jy]!, gr.y, gr.h) && xs[jx]! > gr.x - 6 && xs[jx]! < gr.x + gr.w + 6 : onLine(xs[jx]!, gr.x, gr.w) && ys[jy]! > gr.y - 6 && ys[jy]! < gr.y + gr.h + 6))) cost += len * 3
        const ns = t * 4 + nd
        if (g + cost < dist[ns]!) {
          dist[ns] = g + cost
          prev[ns] = s
          heap.push(g + cost + h(t), ns)
        }
      }
    }
    if (end < 0) {
      // no route this time: put the previous one back on the map
      if (pass) for (let k = 1; k < e.points.length; k++) mark(e.points[k - 1]!, e.points[k]!, i)
      continue
    }

    const path: [number, number][] = [goals.get(end)!.at]
    let s = end
    used[i] = []
    for (;;) {
      const c = Math.floor(s / 4)
      used[i]!.push(c)
      path.push([xs[Math.floor(c / ny)]!, ys[c % ny]!])
      ;(s % 2 === 0 ? horiz : vert)[c]!.push(i)
      const p = prev[s]!
      if (p <= -2) {
        path.push(starts[-2 - p]!.at)
        break
      }
      // the cell where a corner sits is used in both directions
      if (p % 4 !== s % 4) (p % 2 === 0 ? horiz : vert)[c]!.push(i)
      s = p
    }
    path.reverse()
    // drop points that lie on a straight run
    e.points = path.filter((p, k) => k === 0 || k === path.length - 1 || !((path[k - 1]![0] === p[0] && p[0] === path[k + 1]![0]) || (path[k - 1]![1] === p[1] && p[1] === path[k + 1]![1])))
  }

  // edges may now leave the old bounds: re-fit
  const pts = scene.edges.flatMap((e) => e.points)
  const minX = Math.min(0, ...pts.map((p) => p[0]))
  const minY = Math.min(0, ...pts.map((p) => p[1]))
  const out = minX < 0 || minY < 0 ? shift(scene, -minX, -minY) : scene
  out.w = Math.max(scene.w - minX, ...pts.map((p) => p[0] - minX))
  out.h = Math.max(scene.h - minY, ...pts.map((p) => p[1] - minY))
  return out
}
