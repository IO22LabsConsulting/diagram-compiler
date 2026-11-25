// Text metrics: exact widths from the bundled font files. The renderer draws text as glyph
// outlines from the same fonts, so what is measured is what is drawn, in every viewer.
import { readFileSync } from 'node:fs'
import opentype from 'opentype.js'

export type FontKey = 'sans-400' | 'sans-600' | 'sans-700' | 'mono-400' | 'mono-500' | 'mono-600'

const fonts = new Map<FontKey, opentype.Font>()
function font(key: FontKey): opentype.Font {
  let f = fonts.get(key)
  if (!f) {
    const b = readFileSync(new URL(`../fonts/${key}.woff`, import.meta.url))
    f = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    fonts.set(key, f)
  }
  return f
}

// ponytail: unbounded memo; a diagram is capped at 500 nodes so this stays small. LRU if it ever serves long-lived.
const widths = new Map<string, number>()
export function textWidth(s: string, key: FontKey, size: number): number {
  const k = `${key}|${size}|${s}`
  let w = widths.get(k)
  if (w === undefined) widths.set(k, (w = font(key).getAdvanceWidth(s, size)))
  return w
}

export const lineHeight = (size: number) => Math.round(size * 1.4)
/** Baseline offset from the top of a line box, so cap-height sits centred in the line. */
export const baseline = (key: FontKey, size: number) => {
  const f = font(key)
  const cap = ((f.tables.os2?.sCapHeight || 700) / f.unitsPerEm) * size
  return (lineHeight(size) + cap) / 2
}

export type Wrapped = { lines: string[]; width: number; truncated: boolean }

/** Greedy word wrap. A single over-long word keeps its own line (the box grows instead). */
export function wrap(s: string, key: FontKey, size: number, maxWidth: number, maxLines: number): Wrapped {
  // a word wider than the line (a path, an identifier) is cut into pieces, after a separator where there is one
  const pieces = (w: string): string[] => {
    const out: string[] = []
    let rest = w
    while (rest.length > 1 && textWidth(rest, key, size) > maxWidth) {
      let n = rest.length - 1
      while (n > 1 && textWidth(rest.slice(0, n), key, size) > maxWidth) n--
      const soft = Math.max(...['/', '_', '.', ':', '-', ','].map((c) => rest.lastIndexOf(c, n - 1))) + 1
      const cut = soft > n / 2 ? soft : n
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    return [...out, rest]
  }
  const words = s.split(/\s+/).filter(Boolean).flatMap(pieces)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (cur && textWidth(next, key, size) > maxWidth) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  const truncated = lines.length > maxLines
  if (truncated) {
    lines.length = maxLines
    let last = lines[maxLines - 1]!
    while (last.length > 1 && textWidth(`${last}…`, key, size) > maxWidth) last = last.slice(0, -1)
    lines[maxLines - 1] = `${last.trimEnd()}…`
  }
  return { lines, width: Math.max(0, ...lines.map((l) => textWidth(l, key, size))), truncated }
}

/** Characters the bundled fonts cannot draw (they would render as empty boxes). */
export function missingGlyphs(s: string, key: FontKey): string[] {
  const f = font(key)
  return [...new Set([...s].filter((c) => c !== ' ' && f.charToGlyphIndex(c) === 0))]
}

/** SVG path data for a string with its baseline origin at (x, y). */
export function textPath(s: string, key: FontKey, size: number, x: number, y: number): string {
  return font(key).getPath(s, x, y, size).toPathData(2)
}
