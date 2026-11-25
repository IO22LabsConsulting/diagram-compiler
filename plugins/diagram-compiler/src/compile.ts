// The pipeline: spec -> validate -> layout -> lint -> SVG (-> PNG). Pure apart from reading bundled fonts/icons.
import { Resvg } from '@resvg/resvg-js'
import { layout } from './layout/index.ts'
import { lint, type LintReport } from './qa.ts'
import { renderSvg } from './render.ts'
import { parseSpec, type Spec } from './spec.ts'
import { THEMES } from './theme.ts'

export type Compiled = { spec: Spec; svg: string; lint: LintReport; width: number; height: number }

export async function compile(input: unknown, opts: { debug?: boolean } = {}): Promise<Compiled> {
  const spec = parseSpec(input)
  const th = THEMES[spec.theme]!
  const page = await layout(spec, th)
  return { spec, svg: renderSvg(page, th, spec.title, opts.debug), lint: lint(page, spec), width: page.w, height: page.h }
}

/** Text is already outlines, so the rasteriser needs no fonts and loads nothing from disk or network. */
export function toPng(svg: string, scale = 2): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: false } }).render().asPng()
}
