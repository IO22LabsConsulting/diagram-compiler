// Mind map (two-sided, horizontal) and tree (top-down) layout. Each subtree reserves the span its
// children need and the parent sits centred on them, so nodes cannot overlap by construction.
import { emptyScene, type Scene, type SEdge, type SNode } from '../scene.ts'
import type { Branch, ColorName } from '../spec.ts'
import { COLOR_CYCLE, type Theme } from '../theme.ts'
import { measureNode } from './measure.ts'

type TN = { node: SNode; kids: TN[]; span: number; color?: ColorName; depth: number; stack: boolean }
const INDENT = 24

export function layoutTree(root: Branch, th: Theme, bg: string, mode: 'mindmap' | 'tree', nested = false): Scene {
  const horizontal = mode === 'mindmap'
  const GAP_DEPTH = horizontal ? 48 : 40
  const GAP_CROSS = horizontal ? 12 : 20
  const D = (n: SNode) => (horizontal ? n.w : n.h) // size along the depth axis
  const C = (n: SNode) => (horizontal ? n.h : n.w) // size across it
  let seq = 0

  const build = (b: Branch, depth: number, color: ColorName | undefined, index: number): TN => {
    const c = b.color ?? color ?? (horizontal && depth === 1 ? COLOR_CYCLE[index % COLOR_CYCLE.length] : undefined)
    const id = `b${++seq}`
    const node =
      depth === 0
        ? measureNode({ id, kind: horizontal ? 'actor' : 'box', label: b.label, sublabel: b.sublabel, icon: b.icon, ...(nested ? { color: b.color ?? ('green' as const) } : { emphasis: 'primary' as const, color: b.color }) }, th, { bg, labelFont: 'sans-700', labelSize: 16, wrapWidth: 200 })
        : depth === 1
          ? measureNode({ id, kind: 'box', label: b.label, sublabel: b.sublabel, icon: b.icon, color: c }, th, { bg, labelSize: 13 })
          : measureNode({ id, kind: 'box', label: b.label, sublabel: b.sublabel, icon: b.icon }, th, { bg, labelFont: 'sans-400', labelSize: 12, wrapWidth: 184 })
    if (depth > 1 && c) node.stroke = th.colors[c].stroke
    const kids = (b.children ?? []).map((k, i) => build(k, depth + 1, c, i))
    const kidsSpan = kids.reduce((s, k) => s + k.span, 0) + GAP_CROSS * Math.max(0, kids.length - 1)
    // a top-down tree hangs three or more leaves in a column under their parent, so wide levels do not become ribbons
    const stack = !horizontal && depth >= 1 && kids.length >= 3 && kids.every((k) => !k.kids.length)
    const span = stack ? Math.max(node.w, INDENT + Math.max(...kids.map((k) => k.node.w))) : Math.max(C(node), kidsSpan)
    return { node, kids, span, color: c, depth, stack }
  }
  const tree = build(root, 0, undefined, 0)
  const scene = emptyScene()
  const edges: SEdge[] = []

  const side = (kids: TN[], sign: 1 | -1) => {
    // column offsets: every node at one depth starts at the same distance from the root
    const colSize: number[] = []
    const scan = (t: TN) => {
      colSize[t.depth] = Math.max(colSize[t.depth] ?? 0, D(t.node))
      if (!t.stack) t.kids.forEach(scan)
    }
    kids.forEach(scan)
    const colAt: number[] = []
    colAt[1] = D(tree.node) / 2 + GAP_DEPTH
    for (let d = 2; d < colSize.length; d++) colAt[d] = colAt[d - 1]! + colSize[d - 1]! + GAP_DEPTH

    const place = (t: TN, crossStart: number, parent: TN) => {
      const dpos = sign > 0 ? colAt[t.depth]! : -colAt[t.depth]! - D(t.node)
      const cpos = t.stack ? crossStart : crossStart + (t.span - C(t.node)) / 2
      t.node.x = horizontal ? dpos : cpos
      t.node.y = horizontal ? cpos : dpos
      scene.nodes.push(t.node)
      const p = parent.node
      const stroke = horizontal && t.color ? th.colors[t.color].stroke : th.edge
      const base = { id: `e-${t.node.id}`, from: p.id, to: t.node.id, stroke, strokeWidth: 1.5, arrow: 'none' as const, open: false }
      if (horizontal) {
        const x1 = sign > 0 ? p.x + p.w : p.x
        const x2 = sign > 0 ? t.node.x : t.node.x + t.node.w
        const [y1, y2] = [p.y + p.h / 2, t.node.y + t.node.h / 2]
        const mx = (x1 + x2) / 2
        edges.push({ ...base, curve: 'bezier', points: [[x1, y1], [mx, y1], [mx, y2], [x2, y2]] })
      } else {
        const [x1, x2] = [p.x + p.w / 2, t.node.x + t.node.w / 2]
        const busY = t.node.y - GAP_DEPTH / 2
        edges.push({ ...base, curve: 'ortho', points: x1 === x2 ? [[x1, p.y + p.h], [x2, t.node.y]] : [[x1, p.y + p.h], [x1, busY], [x2, busY], [x2, t.node.y]] })
      }
      if (t.stack) {
        let y = t.node.y + t.node.h + 14
        const railX = t.node.x + 10
        for (const k of t.kids) {
          k.node.x = t.node.x + INDENT
          k.node.y = y
          scene.nodes.push(k.node)
          const cy = y + k.node.h / 2
          edges.push({ id: `e-${k.node.id}`, from: t.node.id, to: k.node.id, stroke: th.edge, strokeWidth: 1.5, arrow: 'none', open: false, curve: 'ortho', points: [[railX, t.node.y + t.node.h], [railX, cy], [k.node.x, cy]] })
          y += k.node.h + 10
        }
        return
      }
      const kidsSpan = t.kids.reduce((s, k) => s + k.span, 0) + GAP_CROSS * Math.max(0, t.kids.length - 1)
      let c = crossStart + (t.span - kidsSpan) / 2
      for (const k of t.kids) {
        place(k, c, t)
        c += k.span + GAP_CROSS
      }
    }
    const total = kids.reduce((s, k) => s + k.span, 0) + GAP_CROSS * Math.max(0, kids.length - 1)
    let c = -total / 2
    for (const k of kids) {
      place(k, c, tree)
      c += k.span + GAP_CROSS
    }
  }

  tree.node.x = -tree.node.w / 2
  tree.node.y = -tree.node.h / 2
  scene.nodes.push(tree.node)
  if (horizontal && tree.kids.length > 3) {
    // split where the two sides come out closest in height, keeping spec order
    const total = tree.kids.reduce((s, k) => s + k.span, 0)
    let half = 1
    for (let i = 1, acc = 0, best = Infinity; i < tree.kids.length; i++) {
      acc += tree.kids[i - 1]!.span
      if (Math.abs(total - 2 * acc) < best) {
        best = Math.abs(total - 2 * acc)
        half = i
      }
    }
    side(tree.kids.slice(0, half), 1)
    // the left side runs bottom to top, so the branches read clockwise in spec order
    side(tree.kids.slice(half).reverse(), -1)
  } else side(tree.kids, 1)
  scene.edges = edges

  const minX = Math.min(...scene.nodes.map((n) => n.x))
  const minY = Math.min(...scene.nodes.map((n) => n.y))
  for (const n of scene.nodes) {
    n.x -= minX
    n.y -= minY
  }
  for (const e of scene.edges) e.points = e.points.map(([x, y]) => [x - minX, y - minY])
  scene.w = Math.max(...scene.nodes.map((n) => n.x + n.w))
  scene.h = Math.max(...scene.nodes.map((n) => n.y + n.h))
  return scene
}
