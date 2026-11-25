import { readdirSync, readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compile, toPng } from '../plugins/diagram-compiler/src/compile.ts'
import { candidates } from '../plugins/diagram-compiler/src/layout/flow.ts'
import { ALIASES, resolveIcon } from '../plugins/diagram-compiler/src/icons.ts'
import { textWidth, wrap } from '../plugins/diagram-compiler/src/metrics.ts'
import { COLORS, jsonSchema, parseSpec, SpecError } from '../plugins/diagram-compiler/src/spec.ts'
import { contrast, THEMES } from '../plugins/diagram-compiler/src/theme.ts'

const EX = new URL('../plugins/diagram-compiler/examples/', import.meta.url)
const examples = readdirSync(EX).filter((f) => f.endsWith('.json'))
const load = (f: string) => JSON.parse(readFileSync(new URL(f, EX), 'utf8'))
const flow = (over: object = {}) => ({ spec_version: '1.0', diagram_type: 'flow', title: 'T', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }], ...over })
const issues = (input: unknown) => {
  try {
    parseSpec(input)
    return []
  } catch (e) {
    return (e as SpecError).issues
  }
}

describe('spec', () => {
  it('accepts every example and applies defaults', () => {
    for (const f of examples) expect(parseSpec(load(f)).theme).toMatch(/^clean-/)
  })
  it('reports dangling references with the path and known ids', () => {
    const i = issues(flow({ edges: [{ from: 'a', to: 'zz' }], groups: [{ id: 'g', label: 'G', members: ['nope'] }] }))
    expect(i.map((x) => x.path)).toEqual(['edges[0].to', 'groups[0].members[0]'])
    expect(i[0]!.message).toContain('known ids: a, b')
  })
  it('rejects duplicate ids, group cycles, unknown keys, long labels, control chars', () => {
    expect(issues(flow({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] }))[0]!.code).toBe('spec.duplicate-id')
    expect(issues(flow({ groups: [{ id: 'g1', label: 'G', members: ['g2'] }, { id: 'g2', label: 'G', members: ['g1'] }] })).some((x) => x.message.includes('cycle'))).toBe(true)
    expect(issues(flow({ x: 1 }))[0]!.code).toBe('spec.schema')
    expect(issues(flow({ nodes: [{ id: 'a', label: 'x'.repeat(41) }] }))[0]!.path).toBe('nodes[0].label')
    expect(issues(flow({ title: 'a‮b' }))[0]!.path).toBe('title')
  })
  it('names the nested problem instead of a bare union error', () => {
    expect(issues({ ...flow(), diagram_type: 'pie' })[0]!.message).toContain('flow, mindmap, tree, grid')
    const g = { spec_version: '1.0', diagram_type: 'grid', title: 'T', panels: [{ id: 'p', title: 'P', diagram: { diagram_type: 'flow', nodes: [{ id: 'a', label: 'A', kind: 'blob' }] } }] }
    expect(issues(g)[0]!.path).toBe('panels[0].diagram.nodes[0].kind')
  })
  it('exports a JSON Schema', () => {
    expect(JSON.stringify(jsonSchema())).toContain('spec_version')
  })
})

describe('metrics and theme', () => {
  it('wraps greedily, never exceeds max width for multi-word lines, flags truncation', () => {
    const w = wrap('the quick brown fox jumps over the lazy dog', 'sans-600', 14, 100, 3)
    expect(w.truncated).toBe(true)
    expect(w.lines).toHaveLength(3)
    for (const l of w.lines) expect(textWidth(l, 'sans-600', 14)).toBeLessThanOrEqual(100)
    expect(wrap('short', 'sans-600', 14, 100, 3)).toMatchObject({ lines: ['short'], truncated: false })
  })
  it('every theme colour pairing used for text clears 4.5:1', () => {
    for (const th of Object.values(THEMES)) {
      for (const c of COLORS) expect(contrast(th.colors[c].ink, th.colors[c].fill)).toBeGreaterThanOrEqual(4.5)
      for (const bg of [th.bg, th.surface, th.surface2]) expect(contrast(th.muted, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('every icon alias resolves to a bundled glyph', () => {
    for (const a of Object.keys(ALIASES)) expect(resolveIcon(a), a).not.toBeNull()
    expect(resolveIcon('constructor')).toBeNull()
  })
})

describe('compile', () => {
  it.each(examples.flatMap((f) => ['clean-light', 'clean-dark'].map((t) => [f, t] as const)))('%s in %s is lint-clean, deterministic and matches its golden', async (f, theme) => {
    const spec = { ...load(f), theme }
    const a = await compile(spec)
    const b = await compile(spec)
    expect(a.svg).toBe(b.svg)
    expect(a.lint.findings).toEqual([])
    await expect(a.svg).toMatchFileSnapshot(`golden/${f.replace('.json', '')}.${theme}.svg`)
  })
  it('rasterises to a PNG of the scaled size', async () => {
    const c = await compile(load('flow.json'))
    const png = toPng(c.svg, 2)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(c.width * 2)
  })
  it('lint: truncated text, missing icon, missing glyph, suspicious label, unreferenced node', async () => {
    const c = await compile(flow({
      nodes: [
        { id: 'a', label: 'A', bullets: ['mmmmmm '.repeat(7).trim()], icon: 'no-such-icon' },
        { id: 'b', label: '数据 store' },
        { id: 'c', label: 'see https://x.io' },
      ],
    }))
    const rules = c.lint.findings.map((x) => `${x.rule}:${x.elements[0]}`)
    expect(rules).toEqual(expect.arrayContaining(['overflow.text:a', 'icon.missing:a', 'text.missing-glyph:b', 'label.suspicious:c', 'spec.unreferenced:c']))
    expect(c.lint.ok).toBe(false)
  })
  it('band layouts keep every edge, including ones that cross group borders', async () => {
    const ids = 'abcdefgh'.split('')
    const spec = flow({
      nodes: ids.map((id) => ({ id, label: `Node ${id}` })),
      edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'g'], ['g', 'h'], ['a', 'h'], ['h', 'a'], ['b', 'g2'], ['g1', 'f']].map(([from, to]) => ({ from, to, label: 'x' })),
      groups: [{ id: 'g1', label: 'One', members: ['a', 'b', 'c'] }, { id: 'g2', label: 'Two', members: ['d', 'e', 'inner'] }, { id: 'inner', label: 'Inner', members: ['f', 'g'] }],
    })
    const th = THEMES['clean-light']!
    const all = await candidates(parseSpec(spec) as never, th, th.bg)
    expect(all.map((c) => c.name)).toEqual(expect.arrayContaining(['LRx', 'TBx']))
    for (const c of all) if (c.scene) expect(c.scene.edges, c.name).toHaveLength(11)
    expect(all.filter((c) => c.scene).length).toBeGreaterThan(0)
    expect((await compile(spec)).svg).toContain('<svg')
  })
  it('lint: a long ungrouped chain is flagged as an extreme aspect', async () => {
    const nodes = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }))
    const c = await compile(flow({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id })) }))
    expect(c.lint.findings.map((x) => x.rule)).toContain('aspect.extreme')
  })
  it('grid picks its own column count to suit the canvas', async () => {
    const panels = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `Panel ${i}`, bullets: ['one', 'two'] }))
    const g = (aspect: string) => compile({ spec_version: '1.0', diagram_type: 'grid', title: 'T', canvas: { aspect }, panels })
    const [tall, wide] = [await g('4:5'), await g('16:9')]
    expect(tall.lint.findings).toEqual([])
    expect(wide.lint.findings).toEqual([])
  })
  it('a wide tree hangs its leaves in columns instead of becoming a ribbon', async () => {
    const kids = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Leaf number ${i}` }))
    const c = await compile({ spec_version: '1.0', diagram_type: 'tree', title: 'T', root: { label: 'Root', children: 'ABCD'.split('').map((l) => ({ label: `Module ${l}`, children: kids(6) })) } })
    expect(c.width / c.height).toBeLessThan(2.4)
    expect(c.lint.findings).toEqual([])
  })
  it('every edge label lies inside the canvas, whatever the layout', async () => {
    // labels at the limit, on edges that leave every side of a grouped flow, in both directions and when wrapped
    const label = 'a label at the length limit.'
    const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }))
    const edges = [[0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [8, 0], [6, 2]].map(([a, b]) => ({ from: `n${a}`, to: `n${b}`, label }))
    const groups = [0, 1, 2].map((g) => ({ id: `g${g}`, label: `Group ${g}`, members: [0, 1, 2].map((k) => `n${g * 3 + k}`) }))
    const specs = [flow({ nodes, edges, groups }), flow({ nodes, edges, groups, hints: { direction: 'LR' } }), flow({ nodes, edges, groups, hints: { direction: 'TB' } }), JSON.parse(readFileSync(new URL('./fixtures/crowded-label.json', import.meta.url), 'utf8'))]
    for (const [i, spec] of specs.entries()) {
      const c = await compile(spec)
      expect(c.lint.findings.filter((x) => x.rule === 'overflow.label'), `spec ${i}`).toEqual([])
    }
  })
  it('lint advice never suggests a setting the spec already uses', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }))
    const edges = nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id }))
    const hinted = await compile(flow({ nodes, edges, canvas: { aspect: '4:5' }, hints: { direction: 'LR' } }))
    expect(hinted.lint.findings.find((x) => x.rule === 'density.canvas')!.fix).toContain('remove hints.direction')
    const plain = await compile(flow({ nodes, edges, canvas: { aspect: '16:9' } }))
    const fix = plain.lint.findings.find((x) => x.rule === 'density.canvas')?.fix ?? ''
    expect(fix).not.toContain('hints.direction')
  })
  it('lint: padding to a mismatched aspect is flagged', async () => {
    const c = await compile(flow({ canvas: { aspect: '4:5' }, hints: { direction: 'LR' }, nodes: 'abcdef'.split('').map((id) => ({ id, label: id })), edges: 'abcde'.split('').map((id, i) => ({ from: id, to: 'bcdef'[i] })) }))
    expect(c.lint.findings.map((x) => x.rule)).toContain('density.canvas')
    expect(c.width / c.height).toBeCloseTo(0.8, 1)
  })
})

describe('security: hostile text renders as inert outlines', () => {
  it.each(['<script>alert(1)</script>', '</svg><svg onload=alert(1)>', '" onload="alert(1)', "javascript:alert('x')", '&lt;&amp;]]>', '<foreignObject>'])('%s', async (evil) => {
    const c = await compile(flow({ title: evil, nodes: [{ id: 'a', label: evil.slice(0, 40), sublabel: evil, bullets: [evil.slice(0, 48)] }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: evil.slice(0, 28) }], groups: [{ id: 'g', label: evil.slice(0, 40), members: ['a'] }] }))
    const tags = new Set([...c.svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]))
    for (const t of tags) expect(['svg', 'title', 'rect', 'path', 'circle', 'g', 'ellipse', 'line', 'polyline', 'polygon']).toContain(t)
    // the title is the only place spec text survives as text: it must be escaped there and absent everywhere else
    const rest = c.svg.replace(/<title>[^<]*<\/title>/, '').replace(/aria-label="[^"]*"/, '')
    expect(rest).not.toMatch(/\son[a-z]+=|href|javascript:|script|alert/i)
    expect(c.svg.match(/<\/svg>/g)).toHaveLength(1)
  })
  it('an icon name can never inject markup', () => {
    expect(issues(flow({ nodes: [{ id: 'a', label: 'A', icon: '"><script>' }] }))[0]!.path).toBe('nodes[0].icon')
  })
})

// Random valid flows: the pipeline never throws and never produces overlapping nodes.
const ids = 'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `n${c}`)
const flowArb = fc.integer({ min: 1, max: 14 }).chain((n) => {
  const pick = fc.integer({ min: 0, max: n - 1 })
  const words = fc.array(fc.constantFrom('API', 'cache', 'user', 'queue', 'LLM', 'store', 'worker', 'a', 'gateway', 'x'), { minLength: 1, maxLength: 5 }).map((w) => w.join(' '))
  return fc.record({
    nodes: fc.tuple(...ids.slice(0, n).map((id) => fc.record({ id: fc.constant(id), label: words, kind: fc.constantFrom('box', 'icon', 'store', 'actor', 'model', 'note', 'chip'), bullets: fc.option(fc.array(words, { maxLength: 4 }), { nil: undefined }), emphasis: fc.constantFrom('primary', 'secondary', 'muted') }))),
    edges: fc.array(fc.record({ from: pick, to: pick, label: fc.option(fc.constantFrom('yes', 'retry on fail', 'p99'), { nil: undefined }), kind: fc.constantFrom('flow', 'loop', 'async'), arrow: fc.constantFrom('none', 'end', 'both') }), { maxLength: 18 }),
    grouped: fc.array(pick, { maxLength: 6 }),
    direction: fc.constantFrom('LR', 'TB', undefined),
  }).map(({ nodes, edges, grouped, direction }) => {
    const members = [...new Set(grouped)].map((i) => ids[i]!)
    return flow({
      nodes, edges: edges.map((e) => ({ ...e, from: ids[e.from], to: ids[e.to] })), hints: direction ? { direction } : {},
      groups: members.length ? [{ id: 'g1', label: 'Group', members, style: 'filled', color: 'blue' }] : [],
    })
  })
})
describe('property', () => {
  it('random valid flows compile without overlaps: nodes, edges through nodes, edges on one line', async () => {
    await fc.assert(fc.asyncProperty(flowArb, async (spec) => {
      const c = await compile(spec)
      // the router's promises: no edge through a node it does not touch, no two unrelated edges on one line
      const bad = c.lint.findings.filter((x) => ['overlap.node', 'contrast.text', 'overlap.edge-node', 'overlap.edge-edge'].includes(x.rule))
      expect(bad).toEqual([])
    }), { numRuns: 60, seed: 22 })
  }, 60_000)
  it('a 200-node chain stays inside the time budget', async () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }))
    const t = performance.now()
    await compile(flow({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id })), hints: { direction: 'TB' } }))
    expect(performance.now() - t).toBeLessThan(5000)
  }, 20_000)
})

describe('crowded flows', () => {
  const spec = JSON.parse(readFileSync(new URL('./fixtures/crowded-label.json', import.meta.url), 'utf8'))

  it('keeps a long label off other edges, splitting it onto two lines when one cannot fit', async () => {
    const { layout } = await import('../plugins/diagram-compiler/src/layout/index.ts')
    const page = await layout(parseSpec(spec), THEMES['clean-light']!)
    expect((await compile(spec)).lint.findings.filter((f) => f.rule.startsWith('overlap.'))).toEqual([])
    for (const l of page.edges.flatMap((e) => (e.label ? [e.label] : [])))
      for (const r of [l.run, ...(l.run2 ? [l.run2] : [])]) expect(textWidth(r.text, r.font, r.size)).toBeLessThanOrEqual(l.w)
  })

  it('puts every step that nothing leads into at the start of its group', async () => {
    const { layout } = await import('../plugins/diagram-compiler/src/layout/index.ts')
    const page = await layout(parseSpec(spec), THEMES['clean-light']!)
    const y = (id: string) => page.nodes.find((n) => n.id === id)!.y
    expect(y('check')).toBe(y('watch'))
  })
})

describe('table', () => {
  const table = (over: object = {}) => ({ spec_version: '1.0', diagram_type: 'table', title: 'T', columns: ['Name', 'What', 'Why'], rows: [{ cells: ['One', 'First thing', 'Because'] }, { cells: ['Two', 'Second thing', ''] }], ...over })

  it('renders, and wraps a long cell instead of widening the page without limit', async () => {
    const long = 'A sentence that is long enough that it has to wrap onto more than one line inside its cell, twice over.'
    const c = await compile(table({ columns: ['Name', 'A', 'B', 'C', 'D'], rows: [{ cells: ['One', long, long, long, long] }] }))
    expect(c.lint.ok).toBe(true)
    expect(c.width).toBeLessThan(1300)
  })

  it('rejects a row whose cell count differs from the columns, naming the row', () => {
    expect(issues(table({ rows: [{ cells: ['One', 'only two'] }] }))).toEqual([expect.objectContaining({ path: 'rows[0].cells' })])
  })

  it('reports a cell too long to fit as overflow.text, never silently', async () => {
    const c = await compile(table({ columns: ['Name', 'A', 'B', 'C', 'D', 'E', 'F'], rows: [{ cells: ['One', ...Array(6).fill('word '.repeat(27).trim())] }] }))
    expect(c.lint.findings.map((f) => f.rule)).toContain('overflow.text')
  })
})

describe('sequence', () => {
  const seq = (over: object = {}) => ({ spec_version: '1.0', diagram_type: 'sequence', title: 'T', actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], steps: [{ from: 'a', to: 'b', label: 'ask' }, { from: 'b', to: 'a', label: 'answer', kind: 'reply' }], ...over })

  it('draws one row per message, in order, and is lint-clean', async () => {
    const { layout } = await import('../plugins/diagram-compiler/src/layout/index.ts')
    const spec = parseSpec(seq({ steps: [{ from: 'a', to: 'c', label: 'one' }, { divider: 'later' }, { from: 'c', to: 'c', label: 'two', detail: 'to itself' }, { from: 'c', to: 'a', label: 'three', kind: 'reply' }] }))
    const page = await layout(spec, THEMES['clean-light']!)
    const ys = page.edges.map((e) => e.points[0]![1])
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
    expect(new Set(ys).size).toBe(3)
    expect((await compile(spec)).lint.findings).toEqual([])
  })

  it('widens the columns until the longest label fits between its two lifelines', async () => {
    const { layout } = await import('../plugins/diagram-compiler/src/layout/index.ts')
    const label = 'a label that is close to the forty-eight limit'
    const page = await layout(parseSpec(seq({ steps: [{ from: 'a', to: 'b', label }] })), THEMES['clean-light']!)
    const e = page.edges[0]!
    expect(Math.abs(e.points[1]![0] - e.points[0]![0])).toBeGreaterThan(textWidth(label, 'sans-400', 13))
  })

  it('rejects a message to an unknown actor, naming the step', () => {
    expect(issues(seq({ steps: [{ from: 'a', to: 'zz', label: 'x' }] }))).toEqual([expect.objectContaining({ path: 'steps[0].to' })])
  })
})

describe('source check', () => {
  const files: Record<string, string> = { 'lib/a.ex': 'defmodule A do\n  def run(x), do: x\nend\n' }
  const read = (f: string) => files[f] ?? null
  const spec = (source: unknown, extra: object[] = []) => parseSpec(flow({ nodes: [{ id: 'a', label: 'A', source }, { id: 'b', label: 'B', source: { file: 'lib/a.ex' } }, ...extra], edges: [] }))
  const rules = async (source: unknown, extra: object[] = [], strict = false) => (await import('../plugins/diagram-compiler/src/verify.ts')).verifySources(spec(source, extra), read, strict).findings.map((f) => `${f.severity} ${f.rule}`)

  it('passes a citation whose file, line and quoted text are all there', async () => {
    expect(await rules({ file: 'lib/a.ex', line: 2, text: 'def run(x)' })).toEqual([])
  })
  it('fails a missing file, a line past the end, text that is not in the file, and a path outside the root', async () => {
    expect(await rules({ file: 'lib/b.ex' })).toEqual(['error source.missing-file'])
    expect(await rules({ file: 'lib/a.ex', line: 99 })).toEqual(['error source.line-out-of-range'])
    expect(await rules({ file: 'lib/a.ex', text: 'def walk' })).toEqual(['error source.text-not-found'])
    expect(await rules({ file: '../secrets.txt' })).toEqual(['error source.outside-root'])
    expect(await rules({ file: '/etc/passwd' })).toEqual(['error source.outside-root'])
  })
  it('never reads a path outside the root', async () => {
    const seen: string[] = []
    const { verifySources } = await import('../plugins/diagram-compiler/src/verify.ts')
    verifySources(spec([{ file: '../x' }, { file: '/abs' }, { file: 'a/../../x' }]), (f) => (seen.push(f), null))
    expect(seen).toEqual(['lib/a.ex'])
  })
  it('warns, with the right line, when the quoted text has moved', async () => {
    files['lib/long.ex'] = Array.from({ length: 60 }, (_, i) => (i === 49 ? '  def moved(), do: :ok' : '')).join('\n')
    const { verifySources } = await import('../plugins/diagram-compiler/src/verify.ts')
    const f = verifySources(spec({ file: 'lib/long.ex', line: 3, text: 'def moved()' }), read).findings
    expect(f.map((x) => x.rule)).toEqual(['source.moved'])
    expect(f[0]!.fix).toContain('50')
  })
  it('reports elements with no source as a warning, or an error when strict', async () => {
    expect(await rules({ file: 'lib/a.ex' }, [{ id: 'c', label: 'C' }])).toEqual(['warn source.uncited'])
    expect(await rules({ file: 'lib/a.ex' }, [{ id: 'c', label: 'C' }], true)).toEqual(['error source.uncited'])
  })
  it('does not change the picture: a spec renders the same with and without sources', async () => {
    const [a, b] = [await compile(flow()), await compile(flow({ nodes: [{ id: 'a', label: 'A', source: { file: 'x', line: 1 } }, { id: 'b', label: 'B' }] }))]
    expect(b.svg).toBe(a.svg)
  })
})

describe('sequence edges of the page', () => {
  it('leaves room for the label of a message the last actor sends to itself', async () => {
    const c = await compile({ spec_version: '1.0', diagram_type: 'sequence', title: 'T', actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], steps: [{ from: 'a', to: 'b', label: 'go' }, { from: 'b', to: 'b', label: 'a long note about what b does on its own here', detail: 'and a second line that is longer than the first one is' }] })
    expect(c.lint.findings).toEqual([])
  })
})

describe('round 9 fixes', () => {
  it('breaks a long path inside its table column instead of spilling into the next', async () => {
    const { layout } = await import('../plugins/diagram-compiler/src/layout/index.ts')
    const long = '/api/simulation/some_identifier/profiles/realtime/and/more/segments/still/going/on/and/on/further'
    const spec = parseSpec({ spec_version: '1.0', diagram_type: 'table', title: 'T', columns: ['Endpoint', 'Caller', 'A', 'B', 'C', 'D'], rows: [{ cells: [long, 'getSimulationProfilesRealtimeWithAVeryLongFunctionNameThatGoesOnAndOnAndOnWithoutAnySpaces', long, long, long, long] }] })
    const page = await layout(spec, THEMES['clean-light']!)
    const runs = page.panels[0]!.texts
    const starts = [...new Set(runs.map((r) => r.x))].sort((a, b) => a - b)
    for (const r of runs) {
      const next = starts.find((x) => x > r.x) ?? page.panels[0]!.x + page.panels[0]!.w
      expect(r.x + textWidth(r.text, r.font, r.size)).toBeLessThanOrEqual(next)
    }
  })

  it('accepts placeholders and paths as labels but still flags markup and shell', async () => {
    const rules = async (label: string) => (await compile(flow({ nodes: [{ id: 'a', label }, { id: 'b', label: 'B' }] }))).lint.findings.map((f) => f.rule)
    expect(await rules('GET /api/task/<task_id>')).not.toContain('label.suspicious')
    expect(await rules('<script>x</script>')).toContain('label.suspicious')
    expect(await rules('run $(whoami)')).toContain('label.suspicious')
  })

  it('source check: a folder, a quote from a binary file, and steps cited out of order', async () => {
    const { verifySources } = await import('../plugins/diagram-compiler/src/verify.ts')
    const read = (f: string) => (f === 'data' ? false : f === 'book.xlsx' ? 'PK\u0000\u0003' : f === 'main.py' ? Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') : null)
    const of = (nodes: object[]) => verifySources(parseSpec(flow({ nodes, edges: [] })), read).findings.map((f) => f.rule)
    expect(of([{ id: 'a', label: 'A', source: { file: 'data' } }])).toEqual(['source.not-a-file'])
    expect(of([{ id: 'a', label: 'A', source: { file: 'book.xlsx', text: 'Revenue' } }])).toEqual(['source.binary'])
    expect(of([{ id: 'a', label: 'A', source: { file: 'book.xlsx' } }])).toEqual([])
    const seq = parseSpec({ spec_version: '1.0', diagram_type: 'sequence', title: 'T', actors: [{ id: 'a', label: 'A', source: { file: 'main.py' } }, { id: 'b', label: 'B', source: { file: 'main.py' } }], steps: [{ from: 'a', to: 'b', label: 'close', source: { file: 'main.py', line: 20 } }, { from: 'a', to: 'b', label: 'print', source: { file: 'main.py', line: 5 } }] })
    const r = verifySources(seq, read)
    expect(r.findings.map((f) => `${f.severity} ${f.rule}`)).toEqual(['info source.order'])
    expect(r.distinct).toBe(3)
  })
})

describe('incremental update', () => {
  const base = ['import b', '', '', 'def start(x):', '    y = b.work(x)', '    return y', '', '', 'def stop():', '    return 0']
  const spec = () => parseSpec(flow({ nodes: [
    { id: 'start', label: 'Start', source: { file: 'a.py', line: 4, text: 'def start(x):' } },
    { id: 'stop', label: 'Stop', source: { file: 'a.py', line: 9, text: 'def stop():' } },
    { id: 'other', label: 'Other', source: { file: 'z.py', line: 1, text: 'def z' } },
  ], edges: [] }))
  const lock = { lock_version: 1 as const, commit: null, files: { 'a.py': 'h', 'z.py': 'h' }, scope: ['lib'] }
  const none = () => ({ changed: new Map(), added: new Map(), deleted: new Set<string>(), renamed: new Map() })
  const run = async (files: Record<string, string[]>, ch: object) => (await import('../plugins/diagram-compiler/src/stale.ts')).staleness(spec(), lock, (f) => files[f]?.join('\n') ?? null, { ...none(), ...ch })

  it('reads nothing when no cited file changed', async () => {
    const r = await run({ 'a.py': base }, {})
    expect([r.status, r.untouched, r.lines_to_read]).toEqual(['fresh', 3, 0])
  })
  it('repairs a moved line without asking for a read', async () => {
    const r = await run({ 'a.py': ['# new', '# new', ...base] }, { changed: new Map([['a.py', [[1, 2]]]]) })
    expect(r.status).toBe('auto-fixable')
    expect(r.fixes.map((f) => [f.element, f.line])).toEqual([['start', 6], ['stop', 11]])
    expect(r.reread).toEqual([])
    // the new header lines sit in no cited block: reported as advice, without making the diagram stale
    expect(r.elsewhere_in_cited_files).toEqual([{ file: 'a.py', read: [[1, 2]], lines: 2 }])
  })
  it('follows a renamed file', async () => {
    const r = await run({ 'b.py': base }, { renamed: new Map([['a.py', 'b.py']]) })
    expect(r.fixes.map((f) => f.file)).toEqual(['b.py', 'b.py'])
    expect(r.status).toBe('auto-fixable')
  })
  it('asks for a read, with the changed range, when the quoted words are gone or the code under them changed', async () => {
    const edited = base.map((l) => (l === 'def stop():' ? 'def halt():' : l === '    return y' ? '    return y * 2' : l))
    const r = await run({ 'a.py': edited }, { changed: new Map([['a.py', [[6, 6], [9, 9]]]]) })
    expect(r.reread.map((x) => [x.element, x.reason])).toEqual([['start', 'block-changed'], ['stop', 'text-gone']])
    expect(r.reread[0]!.read).toEqual([[6, 6]])
    expect(r.lines_to_read).toBe(2)
    expect(r.status).toBe('needs-review')
  })
  it('reports a deleted file and a new uncited file inside the scope, and ignores one outside it', async () => {
    const r = await run({ 'a.py': base }, { deleted: new Set(['z.py']), added: new Map([['lib/new.py', [[1, 4]]], ['elsewhere/x.py', [[1, 9]]]]) })
    expect(r.reread.map((x) => [x.element, x.reason])).toEqual([['other', 'file-gone']])
    expect(r.new_in_scope.map((x) => x.file)).toEqual(['lib/new.py'])
  })
  it('applies repairs to the raw spec and leaves everything else alone', async () => {
    const { applyFixes } = await import('../plugins/diagram-compiler/src/stale.ts')
    const raw = flow({ nodes: [{ id: 'a', label: 'A', source: [{ file: 'x.py', line: 1 }, { file: 'y.py', line: 5, text: 'k' }] }, { id: 'b', label: 'B' }] })
    const before = JSON.stringify(raw)
    applyFixes(raw, [{ element: 'a', index: 1, file: 'z.py', line: 9 }])
    expect(JSON.stringify(raw)).toBe(before.replace('"file":"y.py","line":5', '"file":"z.py","line":9'))
  })
  it('reads changed line ranges out of a unified diff, including a pure deletion and a rename', async () => {
    const { parseHunks } = await import('../plugins/diagram-compiler/src/stale.ts')
    const d = ['--- a/x.py', '+++ b/x.py', '@@ -1,0 +2,3 @@', '+a', '@@ -9 +12 @@', '-b', '+c', '@@ -20,2 +22,0 @@', '-d', '--- a/old.py', '+++ b/new.py', '@@ -3 +3 @@'].join('\n')
    expect([...parseHunks(d)]).toEqual([['x.py', [[2, 4], [12, 12], [22, 22]]], ['new.py', [[3, 3]]]])
  })
  it('a spec with a scope draws exactly as one without', async () => {
    expect((await compile(flow({ scope: ['lib', 'apps/web'] }))).svg).toBe((await compile(flow())).svg)
  })
})

describe('what a cited line depends on', () => {
  const ex = ['defmodule Shop do', '  def place(basket) do', '    total = sum(basket)', '    charge(total)', '    :ok', '  end', '', '  def cancel(id) do', '    refund(id)', '  end', 'end']
  const py = ['def start(x):', '    y = work(x)', '    return y', '', '', 'def stop():', '    return 0']
  const router = ['scope "/", Web do', '  pipe_through :browser', '  get "/", PageController, :home', '  live "/support", SupportLive', 'end']
  it('is the block a definition opens, the function around a call, and the scope around a route', async () => {
    const { extent } = await import('../plugins/diagram-compiler/src/stale.ts')
    expect(extent(ex, 2)).toEqual([2, 6])
    expect(extent(ex, 4)).toEqual([2, 6])
    expect(extent(ex, 9)).toEqual([8, 10])
    expect(extent(py, 1)).toEqual([1, 3])
    expect(extent(py, 2)).toEqual([1, 3])
    expect(extent(router, 3)).toEqual([1, 5])
  })
})

describe('a change in a function the cited block calls', () => {
  it('flags the element, pointing at the edited helper, not at unrelated edits', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const file = ['def check(state):', '    total = current_balance(state)', '    return total < limit(state)', '', '', 'def current_balance(state):', '    return state.cash + state.pending', '', '', 'def unrelated():', '    return 1']
    const spec = parseSpec(flow({ nodes: [{ id: 'check', label: 'Balance check', source: { file: 'r.py', line: 1, text: 'def check(state):' } }, { id: 'b', label: 'B', source: { file: 'r.py', line: 1 } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 'r.py': 'h' }, scope: [] }, () => file.join('\n'), { changed: new Map([['r.py', [[7, 7], [11, 11]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.reread.filter((x) => x.element === 'check').map((x) => [x.reason, x.via, x.read])).toEqual([['callee-changed', 'current_balance', [[7, 7]]]])
    expect(r.elsewhere_in_cited_files).toEqual([{ file: 'r.py', read: [[11, 11]], lines: 1 }])
  })
})

describe('a cited function that nothing calls any more', () => {
  it('is flagged even though its own lines did not change', async () => {
    const { staleness, usageCounts } = await import('../plugins/diagram-compiler/src/stale.ts')
    const lib = ['def create_email(attrs):', '    return insert(attrs)']
    const before: Record<string, string> = { 'lib/emails.py': lib.join('\n'), 'lib/router.py': 'def route(m):\n    return create_email(m)' }
    const after: Record<string, string> = { ...before, 'lib/router.py': 'def route(m):\n    return intake.accept(m)' }
    const spec = parseSpec(flow({ nodes: [{ id: 'ctx', label: 'Emails context', source: { file: 'lib/emails.py', line: 1, text: 'def create_email(attrs):' } }, { id: 'b', label: 'B', source: { file: 'lib/router.py', line: 1 } }], edges: [] }))
    const uses = usageCounts(spec, Object.keys(before), (f) => before[f] ?? null)
    expect(uses).toEqual({ 'lib/emails.py#create_email': 1, 'lib/router.py#route': 0 })
    const lock = { lock_version: 1 as const, commit: null, files: { 'lib/emails.py': 'x', 'lib/router.py': 'y' }, scope: ['lib'], uses }
    const r = staleness(spec, lock, (f) => after[f] ?? null, { changed: new Map([['lib/router.py', [[2, 2]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.reread.filter((x) => x.element === 'ctx').map((x) => [x.reason, x.via])).toEqual([['no-longer-used', 'create_email']])
  })
})

describe('a source added after the last stamp', () => {
  it('is reported, because nothing is known about how its file changed', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const spec = parseSpec(flow({ nodes: [{ id: 'a', label: 'A', source: { file: 'old.py', line: 1 } }, { id: 'b', label: 'B', source: { file: 'added-later.py', line: 1 } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 'old.py': 'h' }, scope: [] }, () => 'x', { changed: new Map(), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect([r.status, r.unstamped]).toEqual(['needs-review', ['added-later.py']])
  })
})

describe('definitions and blocks in real code shapes', () => {
  it('follows a signature spread over several lines into its body', async () => {
    const { blockEnd, extent } = await import('../plugins/diagram-compiler/src/stale.ts')
    const py = ['def record(', '    self,', '    items,', ') -> None:', '    if not items:', '        return', '    self.store(items)', '', 'def other():', '    pass']
    expect(blockEnd(py, 1)).toBe(7)
    expect(extent(py, 7)).toEqual([1, 7])
    const rs = ['pub fn crush(', '    input: &str,', ') -> Result<String> {', '    let out = inner(input)?;', '    Ok(out)', '}', '', 'fn inner(x: &str) -> Result<String> {', '    todo!()', '}']
    expect(blockEnd(rs, 1)).toBe(6)
  })
  it('flags a step whose called helper has a multi-line signature and an edited body', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const py = ['def crush(self, x):', '    out = self.work(x)', '    self.record(out)', '    return out', '', 'def record(', '    self,', '    items,', ') -> None:', '    if self.gated:', '        return', '    self.store(items)']
    const spec = parseSpec(flow({ nodes: [{ id: 'step', label: 'Record', source: { file: 's.py', line: 3, text: 'self.record(out)' } }, { id: 'b', label: 'B', source: { file: 's.py', line: 1 } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 's.py': 'h' }, scope: [] }, () => py.join('\n'), { changed: new Map([['s.py', [[10, 11]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.reread.filter((x) => x.element === 'step').map((x) => [x.reason, x.via])).toEqual([['callee-changed', 'record']])
  })
  it('does not take prose, a docstring or an anonymous function for a definition', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const src = ['# Notes', 'This class of problem needs a function that retries.', '    """Each class handles one function."""', 'items.map(fn x -> x end)', 'export async function load(id) {', '  return id', '}']
    const spec = parseSpec(flow({ nodes: [{ id: 'a', label: 'A', source: { file: 'other.js', line: 1 } }, { id: 'b', label: 'B', source: { file: 'n.js', line: 1, text: '# Notes' } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 'n.js': 'h', 'other.js': 'h' }, scope: [] }, (f) => (f === 'n.js' ? src.join('\n') : 'x'), { changed: new Map([['n.js', [[2, 7]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.new_definitions.map((d) => d.line)).toEqual([5])
  })
  it('treats an edit anywhere in a cited prose file as work, and reports a deleted uncited file in scope', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const md = ['# Plan phase', 'Spawn the planner.', '', 'Then spawn the checker with the context inlined.']
    const spec = parseSpec(flow({ nodes: [{ id: 'a', label: 'A', source: { file: 'commands/plan.md', line: 2, text: 'Spawn the planner.' } }, { id: 'b', label: 'B', source: { file: 'commands/plan.md', line: 1 } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 'commands/plan.md': 'h', 'commands/old.md': 'h' }, scope: ['commands'] }, (f) => (f === 'commands/plan.md' ? md.join('\n') : null), { changed: new Map([['commands/plan.md', [[4, 4]]]]), added: new Map(), deleted: new Set(['commands/old.md']), renamed: new Map() })
    expect(r.new_in_scope).toEqual([{ file: 'commands/plan.md', change: 'modified', read: [[4, 4]] }])
    expect(r.removed_in_scope).toEqual(['commands/old.md'])
    expect(r.status).toBe('needs-review')
  })
  it('does not link a call to a same-named function in an unrelated file', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const a = ['def build(self):', '    return self.graph.to_dict()']
    const b = ['class Report:', '    def to_dict(self):', '        return {"a": 1}']
    const spec = parseSpec(flow({ nodes: [{ id: 'g', label: 'Graph', source: { file: 'graph.py', line: 1, text: 'def build(self):' } }, { id: 'r', label: 'Report', source: { file: 'report_agent.py', line: 1, text: 'class Report:' } }], edges: [] }))
    const r = staleness(spec, { lock_version: 1, commit: null, files: { 'graph.py': 'h', 'report_agent.py': 'h' }, scope: [] }, (f) => (f === 'graph.py' ? a : b).join('\n'), { changed: new Map([['report_agent.py', [[3, 3]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.reread.filter((x) => x.element === 'g')).toEqual([])
  })
})

describe('carrying a citation forward when the same words appear twice', () => {
  const body = (extraTop: number) => [...Array(extraTop).fill('// added'), 'function uninstall() {', '  writeSettings(path, settings)', '}', '', 'function install() {', '  prepare()', '  writeSettings(path, settings)', '}']
  const spec = () => parseSpec(flow({ nodes: [{ id: 'reg', label: 'Registers hooks', source: { file: 'i.js', line: 7, text: 'writeSettings(path, settings)' } }, { id: 'b', label: 'B', source: { file: 'i.js', line: 5 } }], edges: [] }))
  const lock = { lock_version: 1 as const, commit: 'abc', files: { 'i.js': 'h' }, scope: [] }

  it('follows the diff to the right copy, not the nearest one', async () => {
    const { staleness, carry } = await import('../plugins/diagram-compiler/src/stale.ts')
    expect(carry([[0, 0, 1, 4]], 7)).toBe(11)
    expect(carry([[7, 1, 7, 3]], 7)).toBeNull()
    const r = staleness(spec(), lock, () => body(4).join('\n'), { changed: new Map([['i.js', [[1, 4]]]]), added: new Map(), deleted: new Set(), renamed: new Map(), hunks: new Map([['i.js', [[0, 0, 1, 4]]]]) })
    expect(r.fixes.filter((f) => f.element === 'reg').map((f) => f.line)).toEqual([11])
  })
  it('asks instead of guessing when there is no diff to follow', async () => {
    const { staleness } = await import('../plugins/diagram-compiler/src/stale.ts')
    const r = staleness(spec(), lock, () => body(4).join('\n'), { changed: new Map([['i.js', [[1, 4]]]]), added: new Map(), deleted: new Set(), renamed: new Map() })
    expect(r.reread.filter((x) => x.element === 'reg').map((x) => [x.reason, x.read])).toEqual([['text-moved-ambiguous', [[6, 6], [11, 11]]]])
    expect(r.fixes.filter((f) => f.element === 'reg')).toEqual([])
  })
})

describe('packaging', () => {
  it('ships the same dependency versions as the development setup', () => {
    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const plugin = JSON.parse(readFileSync(new URL('../plugins/diagram-compiler/package.json', import.meta.url), 'utf8'))
    for (const [name, version] of Object.entries(plugin.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
      expect(root.dependencies[name], name).toBe(version)
    }
    expect(plugin.devDependencies).toBeUndefined()
  })
})
