// Node measurement: turns a spec node into a sized box with its text already laid out inside.
import { baseline, lineHeight, wrap, type FontKey } from '../metrics.ts'
import { resolveIcon } from '../icons.ts'
import { contrast, mix, type Theme } from '../theme.ts'
import type { SNode, TextRun } from '../scene.ts'
import type { SpecNode } from '../spec.ts'

export const up8 = (v: number) => Math.ceil(v / 8) * 8

/** A solid fill in a category colour that white (or the dark canvas) text can sit on at 4.5:1. */
export function solid(th: Theme, color: string): string {
  let c = color
  for (let i = 0; i < 20 && contrast(th.onSolid, c) < 4.6; i++) c = mix(c, th.name.endsWith('dark') ? '#FFFFFF' : '#000000', 0.08)
  return c
}

export type NodeInput = Pick<SpecNode, 'id' | 'kind' | 'label'> & Partial<Pick<SpecNode, 'sublabel' | 'bullets' | 'icon' | 'emphasis' | 'color'>>
export type MeasureOpts = { bg: string; labelFont?: FontKey; labelSize?: number; wrapWidth?: number }

const DEFAULT_ICON: Partial<Record<SpecNode['kind'], string>> = { model: 'sparkles' }

export function measureNode(n: NodeInput, th: Theme, o: MeasureOpts): SNode {
  const kind = n.kind
  const sw = n.color ? th.colors[n.color] : kind === 'note' ? th.note : null
  let fill = sw ? sw.fill : th.surface
  let stroke = sw ? sw.stroke : mix(th.border, th.muted, 0.35)
  let ink = th.ink
  let sub = th.muted
  // a model is marked by its green sparkle only: the green fill is reserved for the one primary node
  let iconColor = sw ? sw.ink : kind === 'model' ? th.colors.green.ink : th.muted
  if (n.emphasis === 'primary') {
    fill = stroke = solid(th, sw ? sw.stroke : th.colors.green.stroke)
    ink = sub = iconColor = th.onSolid
  } else if (n.emphasis === 'muted') {
    fill = th.surface2
    stroke = th.border
    ink = sub = iconColor = th.muted
  }
  const bare = kind === 'icon'
  const textBg = bare ? o.bg : fill
  if (bare) ink = n.emphasis === 'muted' ? th.muted : th.ink

  const chip = kind === 'chip'
  const note = kind === 'note'
  const labelFont: FontKey = o.labelFont ?? (note ? 'sans-400' : 'sans-600')
  const labelSize = o.labelSize ?? (chip || note ? 12 : 14)
  const wrapW = o.wrapWidth ?? (bare ? 128 : 168)
  const padX = chip ? 12 : kind === 'actor' ? 18 : 14
  const padY = chip ? 6 : 10

  const iconName = n.icon ?? DEFAULT_ICON[kind] ?? (bare ? 'box' : undefined)
  const icon = iconName ? resolveIcon(iconName) : null
  const iconMissing = n.icon && !icon ? n.icon : undefined

  const label = wrap(n.label, labelFont, labelSize, chip ? 1e4 : wrapW, note ? 4 : 3)
  const subl = n.sublabel ? wrap(n.sublabel, 'sans-400', 12, Math.max(wrapW, label.width), 2) : null
  const bullets = (n.bullets ?? []).map((b) => wrap(b, 'sans-400', 12, Math.max(wrapW, label.width) - 12, 2))
  let truncated = label.truncated || !!subl?.truncated || bullets.some((b) => b.truncated)

  const texts: TextRun[] = []
  const dots: SNode['dots'] = []
  const run = (text: string, x: number, top: number, font: FontKey, size: number, fillc: string, anchor: TextRun['anchor']) =>
    texts.push({ x, y: top + baseline(font, size), text, font, size, fill: fillc, bg: textBg, anchor })

  if (bare) {
    // icon tile on top, text centred beneath
    const tile = 44
    const w = up8(Math.max(tile, label.width, subl?.width ?? 0) + 8)
    let y = tile + 8
    for (const l of label.lines) {
      run(l, w / 2, y, labelFont, labelSize, ink, 'middle')
      y += lineHeight(labelSize)
    }
    for (const l of subl?.lines ?? []) {
      run(l, w / 2, y, 'sans-400', 12, sub, 'middle')
      y += lineHeight(12)
    }
    const body = (icon ?? resolveIcon('box')!).body
    return {
      id: n.id, x: 0, y: 0, w, h: up8(y), shape: 'none', fill: 'none', stroke: 'none', strokeWidth: 0, texts, dots, truncated, iconMissing,
      icon: { x: w / 2 - 12, y: 10, size: 24, body, color: sw ? sw.ink : th.ink, tile: { fill: sw ? sw.fill : th.surface2, stroke: sw ? sw.stroke : th.border } },
    }
  }

  const iconSize = chip ? 14 : 18
  const iconW = icon ? iconSize + (chip ? 6 : 8) : 0
  const colW = Math.max(label.width, subl?.width ?? 0, ...bullets.map((b) => b.width + 12))
  const leftAlign = bullets.length > 0 || !!icon
  const w = Math.max(up8(iconW + colW + 2 * padX), chip ? 48 : 88)
  const x0 = (w - (iconW + colW)) / 2 + iconW // left edge of the text column
  const cx = x0 + colW / 2
  const capTop = kind === 'store' ? 10 : 0

  const lh = lineHeight(labelSize)
  const contentH =
    label.lines.length * lh +
    (subl ? 2 + subl.lines.length * lineHeight(12) : 0) +
    (bullets.length ? 6 + bullets.reduce((s, b) => s + b.lines.length * lineHeight(12) + 2, -2) : 0)
  const h = Math.max(up8(contentH + 2 * padY + capTop), chip ? 32 : 40)
  let y = capTop + (h - capTop - contentH) / 2
  const iconY = y + (lh - iconSize) / 2
  for (const l of label.lines) {
    run(l, leftAlign ? x0 : cx, y, labelFont, labelSize, ink, leftAlign ? 'start' : 'middle')
    y += lh
  }
  if (subl) {
    y += 2
    for (const l of subl.lines) {
      run(l, leftAlign ? x0 : cx, y, 'sans-400', 12, sub, leftAlign ? 'start' : 'middle')
      y += lineHeight(12)
    }
  }
  if (bullets.length) {
    y += 6
    for (const b of bullets) {
      dots.push({ x: x0 + 3, y: y + lineHeight(12) / 2, fill: sub })
      for (const l of b.lines) {
        run(l, x0 + 12, y, 'sans-400', 12, sub, 'start')
        y += lineHeight(12)
      }
      y += 2
    }
  }
  return {
    id: n.id, x: 0, y: 0, w, h, texts, dots, truncated, iconMissing,
    shape: kind === 'store' ? 'cylinder' : chip || kind === 'actor' ? 'pill' : 'rect',
    fill, stroke, strokeWidth: n.emphasis === 'primary' ? 0 : 1.25, dash: note ? '4 3' : undefined,
    icon: icon ? { x: x0 - iconW, y: iconY, size: iconSize, body: icon.body, color: iconColor } : undefined,
  }
}
