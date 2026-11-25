// Flow / architecture layout: ELK layered, orthogonal routing, groups as compound nodes.
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js'
import { foreignGroups, hit, sameEnds, segHitsBox, segments, segsCross, sharedRun } from '../geom.ts'
import { baseline, textWidth } from '../metrics.ts'
import { emptyScene, merge, shift, type Box, type Scene, type SEdge, type SNode, type TextRun } from '../scene.ts'
import type { FlowBody } from '../spec.ts'
import type { Theme } from '../theme.ts'
import { measureNode } from './measure.ts'
import { routeEdges } from './route.ts'

// elkjs is CommonJS; under NodeNext its types put the class on .default while the runtime default import is the class
const elk = new (ELK as unknown as typeof ELK.default)()

export class LayoutError extends Error {
  element_ids: string[]
  constructor(message: string, element_ids: string[] = []) {
    super(message)
    this.element_ids = element_ids
  }
}

const LABEL_SIZE = 11
const GROUP_SIZE = 11

/** inner: direction inside top-level groups when it differs from the root (bands of layers, each laid out across the flow). */
export type Variant = { dir: 'LR' | 'TB'; inner?: 'LR' | 'TB'; opts: Record<string, string>; top?: Record<string, string>; flush?: boolean; route?: boolean; wrap?: number; cols?: boolean }
type Dir = 'LR' | 'TB'
type FlowEdge = { from: string; to: string; label?: string; style: 'solid' | 'dashed' | 'dotted'; arrow: 'none' | 'end' | 'both'; kind: 'flow' | 'loop' | 'async' }
type Ctx = {
  f: FlowBody
  th: Theme
  bg: string
  edges: FlowEdge[]
  parentOf: Map<string, string>
  measured: Map<string, SNode>
  groupBg: (id: string | undefined) => string
  order: string[] // node and group ids in story order
}

const SPACING = {
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.edgeLabel': '2',
  'elk.spacing.nodeNode': '32',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
  'elk.spacing.componentComponent': '40',
}

function mkEdge(c: Ctx, i: number, points: [number, number][]): SEdge {
  const e = c.edges[i]!
  const note = e.to.startsWith('note-')
  return {
    id: `e${i + 1}`, from: e.from, to: e.to, points, curve: 'ortho', strokeWidth: note ? 1.25 : 1.5,
    // an annotation's tie line is drawn in the note colour so it never reads as part of the flow
    stroke: note ? c.th.note.stroke : c.th.edge,
    dash: e.style === 'dashed' ? '6 4' : e.style === 'dotted' ? '1.5 4' : undefined,
    arrow: e.arrow, open: e.kind === 'async',
  }
}

/**
 * One ELK run over the elements in `ids`. A group listed in `collapsed` is a fixed box that was laid out
 * earlier: edges to things inside it attach through a port lined up with the inner element.
 */
async function elkPass(c: Ctx, dir: Dir, opts: Record<string, string>, ids: Set<string>, edgeIdx: number[], collapsed: Map<string, Scene>, pin?: Map<string, { x: number; y: number }>): Promise<Scene> {
  const { f, th } = c
  const elkNodes = new Map<string, ElkNode>()
  for (const id of c.order) {
    if (!ids.has(id)) continue
    const m = c.measured.get(id)
    const inner = collapsed.get(id)
    if (m) elkNodes.set(id, { id, width: m.w, height: m.h })
    else if (inner) elkNodes.set(id, { id, width: inner.w, height: inner.h })
    else {
      // the title is drawn in the top padding; handing it to ELK as a label pushes the members sideways by its width
      // ... so the group is only told how wide its title is, and grows to hold it
      const title = c.f.groups.find((g) => g.id === id)?.label
      const minW = title ? Math.ceil(textWidth(title.toUpperCase(), 'mono-500', GROUP_SIZE)) + 32 : 0
      elkNodes.set(id, { id, children: [], layoutOptions: { 'elk.padding': '[top=38,left=16,bottom=16,right=16]', 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${minW},0)`, ...SPACING, ...(opts[LAYERING] ? { [LAYERING]: opts[LAYERING] } : {}) } })
    }
  }
  const root: ElkNode = {
    id: '__root',
    children: [],
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      ...SPACING,
      'elk.layered.feedbackEdges': 'true',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      ...opts,
    },
  }
  // pinned positions (second pass of a flush band layout): ELK keeps them and only routes around
  if (pin) for (const [id, at] of pin) Object.assign(elkNodes.get(id) ?? {}, at)
  // children in story order: a group sits where its first member appears, so model-order layering follows the spec
  const placed = new Set<string>()
  const place = (id: string) => {
    if (placed.has(id) || !elkNodes.has(id)) return
    placed.add(id)
    const parent = c.parentOf.get(id)
    if (parent) place(parent)
    ;(elkNodes.get(parent ?? '')?.children ?? root.children!).push(elkNodes.get(id)!)
  }
  for (const id of c.order) place(id)

  // an endpoint inside a collapsed group is, for placement, that group; the router finds the real ends later
  const resolve = (id: string): string => {
    let top = id
    while (!ids.has(top) && c.parentOf.has(top)) top = c.parentOf.get(top)!
    return top
  }
  root.edges = edgeIdx.map((i) => {
    const e = c.edges[i]!
    // a loop edge points backwards by definition: lay it out reversed so it cannot reorder the main flow
    const [src, dst] = e.kind === 'loop' ? [e.to, e.from] : [e.from, e.to]
    return {
      id: `e${i + 1}`,
      sources: [resolve(src)],
      targets: [resolve(dst)],
      // ELK only reserves room for the label; placeLabels() decides where it actually sits
      labels: e.label && dir === 'LR' ? [{ text: e.label, width: Math.ceil(textWidth(e.label, 'mono-500', LABEL_SIZE)) + 12, height: 18, layoutOptions: { 'elk.edgeLabels.inline': 'true' } }] : [],
    }
  })

  let out: ElkNode
  try {
    // ponytail: no hard timeout; ELK runs in-thread and the 500-node cap bounds it. Move to a worker with a kill timer if specs get denser.
    out = await elk.layout(root)
  } catch (err) {
    throw new LayoutError(`graph layout failed: ${(err as Error).message}`)
  }

  const scene = emptyScene()
  const abs = new Map<string, { x: number; y: number }>([['__root', { x: 0, y: 0 }]])
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const ch of n.children ?? []) {
      const x = ox + (ch.x ?? 0)
      const y = oy + (ch.y ?? 0)
      abs.set(ch.id, { x, y })
      const m = c.measured.get(ch.id)
      const inner = collapsed.get(ch.id)
      if (m) scene.nodes.push({ ...m, x, y })
      else if (inner) merge(scene, shift(inner, x, y))
      else {
        const g = f.groups.find((gg) => gg.id === ch.id)!
        const sw = g.color ? th.colors[g.color] : null
        const dashed = g.style === 'dashed-box'
        const fill = dashed ? 'none' : sw ? sw.fill : th.surface2
        const label: TextRun = {
          x: x + 14, y: y + 9 + baseline('mono-500', GROUP_SIZE), text: g.label.toUpperCase(), font: 'mono-500', size: GROUP_SIZE,
          fill: sw ? sw.ink : th.muted, bg: dashed ? c.groupBg(c.parentOf.get(g.id)) : fill, anchor: 'start',
        }
        scene.groups.push({ id: g.id, x, y, w: ch.width!, h: ch.height!, fill, stroke: dashed ? (sw ? sw.stroke : th.faint) : sw ? sw.stroke : th.border, dash: dashed ? '6 4' : undefined, radius: g.style === 'lane' ? 2 : 8, label })
        walk(ch, x, y)
      }
    }
  }
  walk(out, 0, 0)

  ;(out.edges as (ElkExtendedEdge & { container?: string })[]).forEach((ee, k) => {
    const i = edgeIdx[k]!
    const e = c.edges[i]!
    const o = abs.get(ee.container ?? '__root') ?? { x: 0, y: 0 }
    const sec = ee.sections?.[0]
    // never draw a diagram with an edge silently missing
    if (!sec) throw new LayoutError(`edge ${e.from} -> ${e.to} could not be routed`, [e.from, e.to])
    const points = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => [p.x + o.x, p.y + o.y] as [number, number])
    if (e.kind === 'loop') points.reverse()
    scene.edges.push(mkEdge(c, i, points))
  })
  scene.w = out.width ?? 0
  scene.h = out.height ?? 0
  return scene
}

async function run(f: FlowBody, th: Theme, bg: string, v: Variant): Promise<Scene> {
  // annotations are notes tied to their target with a dotted line
  const nodes = [...f.nodes, ...f.annotations.map((a, i) => ({ id: `note-${i + 1}`, kind: 'note' as const, label: a.text }))]
  const edges: FlowEdge[] = [...f.edges, ...f.annotations.map((a, i) => ({ from: a.target, to: `note-${i + 1}`, style: 'dotted' as const, arrow: 'none' as const, kind: 'flow' as const }))]
  const parentOf = new Map<string, string>()
  for (const g of f.groups) for (const m of g.members) parentOf.set(m, g.id)
  const groupBg = (id: string | undefined): string => {
    const g = id ? f.groups.find((x) => x.id === id) : undefined
    if (!g) return bg
    return g.style === 'dashed-box' ? groupBg(parentOf.get(g.id)) : g.color ? th.colors[g.color].fill : th.surface2
  }
  const c: Ctx = {
    f, th, bg, edges, parentOf, groupBg,
    measured: new Map(nodes.map((n) => [n.id, measureNode(n, th, { bg: groupBg(parentOf.get(n.id)) })])),
    order: [...nodes.map((n) => n.id), ...f.groups.map((g) => g.id)],
  }
  const all = edges.map((_, i) => i)
  const labelled = new Set(edges.flatMap((e, i) => (e.label ? [`e${i + 1}`] : [])))
  let scene: Scene
  if (!v.inner) scene = await elkPass(c, v.dir, v.opts, new Set(c.order), all, new Map())
  else {
    // bands: lay out each top-level group on its own across the flow, then place the groups as fixed boxes
    const topOf = (id: string) => {
      let t = id
      while (parentOf.has(t)) t = parentOf.get(t)!
      return t
    }
    const tops = f.groups.filter((g) => !parentOf.has(g.id)).map((g) => g.id)
    const inside = (i: number) => {
      const [a, b] = [topOf(edges[i]!.from), topOf(edges[i]!.to)]
      return a === b && tops.includes(a) ? a : null
    }
    const inner = new Map<string, Scene>()
    for (const g of tops)
      // unconnected members line up across the flow instead of stacking along it
      inner.set(g, await elkPass(c, v.inner, { ...v.opts, 'elk.aspectRatio': v.inner === 'LR' ? '6' : '0.17' }, new Set(c.order.filter((id) => topOf(id) === g)), all.filter((i) => inside(i) === g), new Map()))
    /** Grow a band's box to w x h and centre its contents in it. */
    const resize = (g: string, sc: Scene, w: number, h: number): Scene => {
      const [dx, dy] = [(w - sc.w) / 2, (h - sc.h) / 2]
      const moved = shift(sc, dx, dy)
      const box = moved.groups.find((x) => x.id === g)!
      Object.assign(box, { x: 0, y: 0, w, h })
      if (box.label) Object.assign(box.label, { x: box.label.x - dx, y: box.label.y - dy })
      return { ...moved, w, h }
    }
    if (v.wrap) {
      // bands in reading order, v.wrap to a line: the shape between one tall stack and one long ribbon.
      // Lines are rows (m = across the page) or, with v.cols, columns (m = down the page).
      const cols = !!v.cols
      // story order: a band sits where its first member appears in the spec, a note right after what it annotates
      const story: string[] = []
      for (const n of nodes) {
        const at = n.id.startsWith('note-') ? topOf(f.annotations[Number(n.id.slice(5)) - 1]!.target) : null
        const t = topOf(n.id)
        if (story.includes(t)) continue
        if (at && story.includes(at)) story.splice(story.indexOf(at) + 1, 0, t)
        else story.push(t)
      }
      // keep the first band first, then try every order of the rest and keep the one whose connected bands sit closest
      // (in grid steps); ties go to story order. Bounded: at most 7 bands, 720 orders.
      if (story.length >= 3 && story.length <= 7) {
        const links = all.filter((k) => inside(k) === null).map((k) => [topOf(edges[k]!.from), topOf(edges[k]!.to)] as const)
        const spread = (o: string[]): number => {
          const at = new Map(o.map((id, k) => [id, [Math.floor(k / v.wrap!), k % v.wrap!] as const]))
          const apart = links.reduce((t, [a, b]) => t + Math.abs(at.get(a)![0] - at.get(b)![0]) + Math.abs(at.get(a)![1] - at.get(b)![1]), 0)
          // reading order is worth more than adjacency: a band that only receives must not sit before what feeds it,
          // and every pair moved out of spec order costs
          const backward = links.filter(([a, b]) => o.indexOf(b) < o.indexOf(a)).length
          let swaps = 0
          for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) if (original.indexOf(o[i]!) > original.indexOf(o[j]!)) swaps++
          return apart + 2 * backward + swaps
        }
        const original = story.slice()
        let best = story.slice()
        const walk = (head: string[], rest: string[]) => {
          if (!rest.length) return void (spread(head) < spread(best) && (best = head))
          for (const id of rest) walk([...head, id], rest.filter((x) => x !== id))
        }
        walk([story[0]!], story.slice(1))
        story.splice(0, story.length, ...best)
      }
      const items = story.map((id) => {
        const [w, h] = [inner.get(id)?.w ?? c.measured.get(id)!.w, inner.get(id)?.h ?? c.measured.get(id)!.h]
        return { id, sc: inner.get(id), m: cols ? h : w, x: cols ? w : h } // m: size along the line, x: size across it
      })
      const [GM, GX] = cols ? [64, 72] : [72, 64]
      const lines = Array.from({ length: Math.ceil(items.length / v.wrap) }, (_, r) => items.slice(r * v.wrap!, (r + 1) * v.wrap!))
      const natural = (line: typeof items) => line.reduce((t, it) => t + it.m, 0) + GM * (line.length - 1)
      const M = Math.max(...lines.map(natural))
      scene = emptyScene()
      let across = 0
      for (const line of lines) {
        const thick = Math.max(...line.map((it) => it.x))
        // bands share the line's spare length in proportion, but never grow past 1.5x: a band should not be mostly air
        const bandM = line.filter((it) => it.sc).reduce((t, it) => t + it.m, 0)
        const grow = bandM ? Math.min(1.5, 1 + (M - natural(line)) / bandM) : 1
        let along = (M - (natural(line) + bandM * (grow - 1))) / 2
        for (const it of line) {
          const [m, x] = it.sc ? [it.m * grow, Math.min(thick, it.x * 1.5)] : [it.m, it.x]
          const [px, py] = cols ? [across + (thick - x) / 2, along] : [along, across + (thick - x) / 2]
          if (it.sc) merge(scene, shift(resize(it.id, it.sc, cols ? x : m, cols ? m : x), px, py))
          else scene.nodes.push({ ...c.measured.get(it.id)!, x: px, y: py })
          along += m + GM
        }
        across += thick + GX
      }
      const [W, y, GY] = cols ? [across - GX, M + 0, 0] : [M, across, GX]
      scene.w = W
      scene.h = y - GY
      // the router finds every route that leaves a band; start it from a straight line so nothing is ever dropped
      const boxes = new Map<string, Box>([...scene.groups, ...scene.nodes].map((b) => [b.id, b]))
      for (const i of all.filter((k) => inside(k) === null)) {
        const [a, b] = [boxes.get(edges[i]!.from)!, boxes.get(edges[i]!.to)!]
        scene.edges.push(mkEdge(c, i, [[a.x + a.w / 2, a.y + a.h / 2], [b.x + b.w / 2, b.y + b.h / 2]]))
      }
      scene = routeEdges(scene, labelled)
    } else {
    // flush: every band gets the same extent across the flow (up to 1.5x its own), contents centred, so bands stack flush
    const across = Math.max(...[...inner.values()].map((sc) => (v.dir === 'TB' ? sc.w : sc.h)))
    for (const [g, sc] of v.flush ? inner : []) {
      const to = Math.min(across, (v.dir === 'TB' ? sc.w : sc.h) * 1.5)
      inner.set(g, v.dir === 'TB' ? resize(g, sc, to, sc.h) : resize(g, sc, sc.w, to))
    }
    const topIds = new Set(c.order.filter((id) => !parentOf.has(id)))
    const cross = all.filter((i) => inside(i) === null)
    scene = await elkPass(c, v.dir, { ...v.opts, ...v.top }, topIds, cross, inner)
    if (v.flush) {
      // second pass: keep ELK's order, but line every band up on one edge and let it re-route
      const at = new Map([...scene.nodes, ...scene.groups].filter((b) => topIds.has(b.id)).map((b) => [b.id, { x: b.x, y: b.y }]))
      const edge = Math.min(...tops.map((g) => (v.dir === 'TB' ? at.get(g)!.x : at.get(g)!.y)))
      for (const g of tops) Object.assign(at.get(g)!, v.dir === 'TB' ? { x: edge } : { y: edge })
      scene = await elkPass(c, v.dir, { ...v.opts, ...v.top, 'elk.layered.nodePlacement.strategy': 'INTERACTIVE', 'elk.layered.crossingMinimization.semiInteractive': 'true' }, topIds, cross, inner, at)
    }
    }
  }
  if (v.route && !v.wrap) scene = routeEdges(scene, labelled)
  const labelOf = new Map(edges.map((e, i) => [`e${i + 1}`, e.label]))
  placeLabels(scene, scene.edges.map((e) => labelOf.get(e.id)), (x, y) => {
    // the plate takes the colour of whatever filled group it lands in
    const inside = scene.groups.filter((g) => g.fill !== 'none' && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h)
    return inside.length ? inside[inside.length - 1]!.fill : bg
  }, th)
  // a label may sit beyond the nodes and edges: the picture must still contain it
  const lb = scene.edges.flatMap((e) => (e.label ? [e.label] : []))
  const [x0, y0] = [Math.min(0, ...lb.map((l) => l.x - 4)), Math.min(0, ...lb.map((l) => l.y - 4))]
  if (x0 < 0 || y0 < 0) scene = { ...shift(scene, -x0, -y0), w: scene.w - x0, h: scene.h - y0 }
  scene.w = Math.max(scene.w, ...lb.map((l) => l.x - x0 + l.w + 4))
  scene.h = Math.max(scene.h, ...lb.map((l) => l.y - y0 + l.h + 4))
  if (!v.inner) scene.flow = v.dir
  return scene
}

/** Put each edge label on its own edge: centred on the longest free stretch, clear of nodes and other labels. */
function placeLabels(scene: Scene, labels: (string | undefined)[], bgAt: (x: number, y: number) => string, th: Theme) {
  const taken: Box[] = []
  scene.edges.forEach((edge, i) => {
    const text = labels[i]
    if (!text) return
    const width = (t: string) => Math.ceil(textWidth(t, 'mono-500', LABEL_SIZE)) + 12
    // one line first; a long label may also be split at the space nearest its middle, which fits gaps one line cannot
    const words = text.split(' ')
    const cut = words.map((_, k) => k).slice(1).sort((a, b) => Math.abs(words.slice(0, a).join(' ').length - text.length / 2) - Math.abs(words.slice(0, b).join(' ').length - text.length / 2))[0]
    const split = cut && width(text) > 96 ? [words.slice(0, cut).join(' '), words.slice(cut).join(' ')] : undefined
    const shapes = [{ lines: [text], w: width(text), h: 18 }, ...(split ? [{ lines: split, w: Math.max(...split.map(width)), h: 34 }] : [])]
    const tip = (p: [number, number]) => ({ x: p[0] - 12, y: p[1] - 12, w: 24, h: 24 })
    const tips = scene.edges.flatMap((e) => (e.arrow === 'none' ? [] : e.arrow === 'both' ? [tip(e.points[0]!), tip(e.points[e.points.length - 1]!)] : [tip(e.points[e.points.length - 1]!)]))
    const titles = scene.groups.flatMap((g) => (g.label ? [{ x: g.x + 8, y: g.y + 4, w: textWidth(g.label.text, g.label.font, g.label.size) + 12, h: 24 }] : []))
    const onBorder = (b: Box) => scene.groups.some((g) => hit(b, g) && !(b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h))
    const segs = edge.points.slice(1).map((q, k) => [edge.points[k]!, q] as const).sort((a, b) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) - Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]))
    let best: (Box & { lines: string[] }) | undefined
    let bestCost = Infinity
    for (const { lines, w, h } of shapes)
     for (const [p, q] of segs)
      for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9])
       // on a horizontal run the label sits on the line; beside a vertical run it sits to one side, because a label
       // centred on a vertical line reads as crossed out at normal size
       for (const side of p[0] === q[0] ? [1, -1, 0] : [0]) {
        const cx = p[0] + (q[0] - p[0]) * t + side * (w / 2 + 4)
        const box = { x: Math.round(cx - w / 2), y: Math.round(p[1] + (q[1] - p[1]) * t - h / 2), w, h, lines }
        // a label wider than its horizontal stretch would cover the corners: prefer segments that hold it
        const len = Math.hypot(q[0] - p[0], q[1] - p[1])
        const cost = (scene.nodes.some((n) => hit(box, n, 3)) ? 100 : 0) + (taken.some((o) => hit(box, o, 4)) ? 100 : 0) + (p[1] === q[1] && len < w + 16 ? 10 : 0) + (best ? 1 : 0) + (lines.length > 1 ? 5 : 0) + (side ? 6 : p[0] === q[0] ? 16 : 0) + (titles.some((t) => hit(box, t, 2)) ? 80 : 0) + (tips.some((t) => hit(box, t)) ? 40 : 0) + (onBorder(box) ? 45 : 0) +
          40 * scene.edges.filter((o) => o !== edge && o.points.slice(1).some((r, k) => segHitsBox([o.points[k]!, r], box))).length +
          // a label hugging someone else's line reads as that line's label
          14 * scene.edges.filter((o) => o !== edge && o.points.slice(1).some((r, k) => segHitsBox([o.points[k]!, r], { x: box.x - 12, y: box.y - 8, w: box.w + 24, h: box.h + 16 }))).length +
          5 * scene.edges.filter((o) => o !== edge && o.points.slice(1).some((r, k) => segHitsBox([o.points[k]!, r], { x: box.x - 30, y: box.y - 14, w: box.w + 60, h: box.h + 28 }))).length
        if (cost < bestCost) {
          best = box
          bestCost = cost
        }
        if (cost === 0) break
       }
    if (!best) return
    taken.push(best)
    const { lines, ...at } = best
    const fill = bgAt(at.x + at.w / 2, at.y + at.h / 2)
    const run = (line: string, k: number): TextRun => ({ x: at.x + at.w / 2, y: at.y + 1 + 16 * k + baseline('mono-500', LABEL_SIZE), text: line, font: 'mono-500', size: LABEL_SIZE, fill: th.muted, bg: fill, anchor: 'middle' })
    edge.label = { ...at, fill, run: run(lines[0]!, 0), run2: lines[1] === undefined ? undefined : run(lines[1], 1) }
  })
}

/** Lower is better: how far a layout is from the wanted shape, plus what makes a flow hard to read. */
export function cost(s: Scene, wantRatio: number, fixed: boolean): number
export function cost(s: Scene, wantRatio: number, fixed: boolean, parts: true): object
export function cost(s: Scene, wantRatio: number, fixed: boolean, parts = false): number | object {
  // with no fixed canvas, anything from square to widescreen is a good shape
  const ratio = fixed ? wantRatio : Math.min(1.8, Math.max(1, s.w / Math.max(1, s.h)))
  const centre = new Map<string, [number, number]>([...s.nodes, ...s.groups].map((b) => [b.id, [b.x + b.w / 2, b.y + b.h / 2]]))
  const segs = s.edges.map(segments)
  let detour = 0
  let bad = 0
  s.edges.forEach((e, i) => {
    const len = segs[i]!.reduce((t, [p, q]) => t + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), 0)
    const [a, b] = [centre.get(e.from), centre.get(e.to)]
    if (a && b) detour += Math.max(0, len - (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])))
    for (let j = i + 1; j < s.edges.length; j++) {
      const o = s.edges[j]!
      // edges that share an end fan out from one point; that is not a crossing
      if (o.from === e.from || o.to === e.to || o.from === e.to || o.to === e.from) continue
      if (segs[i]!.some((p) => segs[j]!.some((q) => segsCross(p, q)))) bad += 4
    }
    s.edges.forEach((o, j) => {
      if (i !== j && o.label && segs[i]!.some((p) => segHitsBox(p, o.label!))) bad++
    })
    bad += 5 * foreignGroups(s, e, segs[i]!).length
    for (let j = i + 1; j < s.edges.length; j++) if (sharedRun(segs[i]!, segs[j]!) > 24 && !sameEnds(e, s.edges[j]!)) bad += 4
    for (const n of s.nodes) if (n.id !== e.from && n.id !== e.to && segs[i]!.some((p) => segHitsBox(p, { x: n.x + 2, y: n.y + 2, w: n.w - 4, h: n.h - 4 }))) bad += 6
  })
  // size after padding out to the wanted shape: a ribbon on a 4:5 page costs what the page costs
  const fitW = Math.max(s.w, s.h * ratio)
  // empty padding is paid for twice: once as area, once as the share of the page it wastes
  const size = Math.sqrt((fitW * fitW) / ratio) * (2 - (s.w * s.h) / ((fitW * fitW) / ratio))
  // staggered bands leave corners empty: charge for the share of the picture nothing occupies
  const inGroup = new Set(s.groups.flatMap((g) => s.nodes.filter((n) => n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h).map((n) => n.id)))
  const filled = s.groups.reduce((t, g) => t + g.w * g.h, 0) + s.nodes.filter((n) => !inGroup.has(n.id)).reduce((t, n) => t + n.w * n.h, 0)
  const empty = s.groups.length ? Math.max(0, 0.6 - filled / Math.max(1, s.w * s.h)) : 0
  // a step nothing leads into starts a story: it belongs at the start of its group, not part-way down beside its target
  let late = 0
  if (s.flow) {
    const along = (b: Box) => (s.flow === 'TB' ? b.y : b.x)
    const home = (n: Box) => s.groups.filter((g) => n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h).sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id
    const fed = new Set(s.edges.map((e) => e.to))
    for (const n of s.nodes) if (!fed.has(n.id) && s.edges.some((e) => e.from === n.id)) late += along(n) - Math.min(...s.nodes.filter((o) => home(o) === home(n)).map(along))
  }
  // nodes the author listed in order, sitting side by side in one group, should read in that order
  let swaps = 0
  const homeOf = (n: Box) => s.groups.filter((g) => n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h).sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id
  const homes = s.nodes.map(homeOf)
  for (let i = 0; i < s.nodes.length; i++)
    for (let j = i + 1; j < s.nodes.length; j++) {
      const [a, b] = [s.nodes[i]!, s.nodes[j]!]
      if (homes[i] !== homes[j]) continue
      const sameRow = a.y < b.y + b.h && b.y < a.y + a.h
      const sameCol = a.x < b.x + b.w && b.x < a.x + a.w
      if ((sameRow && !sameCol && b.x < a.x) || (sameCol && !sameRow && b.y < a.y)) swaps++
    }
  const total = size * (1 + 2 * empty) + bad * 30 + detour / 5 + late / 3 + swaps * 12
  return parts ? { size: Math.round(size), bad, detour: Math.round(detour), total: Math.round(total) } : total
}

// ELK does not inherit this one: each group needs it set on itself
const LAYERING = 'elk.layered.layering.strategy'
const BASE = { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' }
// how the bands themselves are placed against each other
const BANDS: Record<string, string>[] = [
  {},
  { 'elk.layered.nodePlacement.strategy': 'SIMPLE' },
  { 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.bk.fixedAlignment': 'LEFTUP' },
  { 'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS' },
  { 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' },
]
const TUNINGS: Record<string, string>[] = [
  { ...BASE, 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED' },
  { ...BASE, 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' },
  { 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED' },
  { ...BASE, 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER' },
  // spec order wins ties outright
  { ...BASE, 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' },
  // every starting step in the first layer
  { ...BASE, 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', [LAYERING]: 'LONGEST_PATH_SOURCE' },
]

function variants(f: FlowBody): (Variant & { name: string })[] {
  const dirs = f.hints.direction ? [f.hints.direction] : (['LR', 'TB'] as const)
  return dirs.flatMap((dir) => [
    ...TUNINGS.map((opts, i) => ({ name: `${dir}${i}`, dir, opts })),
    // groups as bands: the flow runs one way, each group lays its members out the other way
    // wrapped bands: 2 or 3 groups to a row, members laid out either way
    ...(f.groups.filter((g) => !f.groups.some((o) => o.members.includes(g.id))).length >= 3 && dir === dirs[0]
      ? [2, 3].flatMap((wrap) => [false, true].flatMap((cols) => (f.hints.direction ? [f.hints.direction] : (['LR', 'TB'] as const)).map((inner) => ({ name: `${cols ? 'C' : 'W'}${wrap}${inner}`, dir: 'TB' as const, inner, opts: TUNINGS[0]!, wrap, cols }))))
      : []),
    ...(f.groups.length ? [false, true].flatMap((flush) => BANDS.map((top, i) => ({ name: `${dir}${flush ? 'f' : 'x'}${i || ''}`, dir, inner: dir === 'LR' ? ('TB' as const) : ('LR' as const), opts: TUNINGS[0]!, top, flush }))) : []),
  ])
}

/** Every candidate layout. route=false keeps ELK's own edge routes (fast, used to shortlist). */
export async function candidates(f: FlowBody, th: Theme, bg: string, route = true, only?: string[]) {
  const vs = variants(f).filter((v) => !only || only.includes(v.name))
  // a candidate ELK rejects is simply dropped
  const tried = await Promise.allSettled(vs.map((v) => run(f, th, bg, { ...v, route })))
  return vs.map((v, i) => ({ name: v.name, scene: tried[i]!.status === 'fulfilled' ? (tried[i] as PromiseFulfilledResult<Scene>).value : null, error: (tried[i] as PromiseRejectedResult).reason as unknown }))
}

/** Lay out a flow many ways, shortlist by a quick score, route the shortlist properly and keep the cheapest. Deterministic. */
export async function layoutFlow(f: FlowBody, th: Theme, bg: string, wantRatio: number, fixed = false): Promise<Scene> {
  const quick = await candidates(f, th, bg, false)
  const ok = quick.filter((c) => c.scene)
  if (!ok.length) throw quick[0]!.error
  // distinct shapes only: many tunings produce the same picture
  const seen = new Set<string>()
  const short = ok
    .sort((a, b) => cost(a.scene!, wantRatio, fixed) - cost(b.scene!, wantRatio, fixed))
    .filter((c) => {
      const key = `${Math.round(c.scene!.w / 24)}x${Math.round(c.scene!.h / 24)}`
      return !seen.has(key) && !!seen.add(key)
    })
    .slice(0, 5)
  const routed = (await candidates(f, th, bg, true, short.map((c) => c.name))).flatMap((c) => (c.scene ? [c.scene] : []))
  return routed.reduce((best, sc) => (cost(sc, wantRatio, fixed) < cost(best, wantRatio, fixed) ? sc : best))
}
