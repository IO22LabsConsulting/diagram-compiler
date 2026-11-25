// Themes: a hairline house style. One green accent,
// six categoricals, IBM Plex. Every colour a diagram uses comes from here.
import type { ColorName } from './spec.ts'

export type Swatch = { stroke: string; fill: string; ink: string }
export type Theme = {
  name: string
  bg: string
  surface: string
  surface2: string
  border: string
  ink: string
  muted: string
  faint: string
  edge: string
  onSolid: string
  note: Swatch
  colors: Record<ColorName, Swatch>
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number]
/** Mix a into b: t=0 gives a, t=1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [hex(a), hex(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}
const lum = (c: string) => {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const NAMES: ColorName[] = ['green', 'blue', 'amber', 'pink', 'violet', 'cyan']

function build(name: string, t: Omit<Theme, 'name' | 'colors' | 'note' | 'edge' | 'onSolid'>, cats: string[], warn: string, dark: boolean): Theme {
  // text in a category colour must clear 4.5:1 on both the surface and its own tint
  const swatch = (c: string): Swatch => {
    const fill = mix(c, t.surface, dark ? 0.84 : 0.9)
    let ink = c
    for (let i = 0; i < 20 && contrast(ink, fill) < 4.6; i++) ink = mix(ink, t.ink, 0.12)
    return { stroke: c, fill, ink }
  }
  return {
    name,
    ...t,
    edge: mix(t.muted, t.faint, 0.5),
    onSolid: dark ? t.bg : '#FFFFFF',
    note: swatch(warn),
    colors: Object.fromEntries(NAMES.map((n, i) => [n, swatch(cats[i]!)])) as Record<ColorName, Swatch>,
  }
}

export const THEMES: Record<string, Theme> = {
  'clean-light': build(
    'clean-light',
    { bg: '#FBFAF8', surface: '#FFFFFF', surface2: '#F4F2ED', border: '#D9D6CF', ink: '#17191C', muted: '#5B5F66', faint: '#8A9097' },
    ['#0BA47E', '#2F6BEB', '#C77A16', '#C43C8E', '#6B54E0', '#0A97AD'],
    '#C77A16',
    false,
  ),
  'clean-dark': build(
    'clean-dark',
    { bg: '#0D1014', surface: '#14181D', surface2: '#1B2027', border: '#343A42', ink: '#E7EAED', muted: '#9AA1A9', faint: '#6C737B' },
    ['#2DD4A7', '#5B9CFF', '#F0B45C', '#F074C0', '#9E86FF', '#33C4D6'],
    '#F0B45C',
    true,
  ),
}
export const COLOR_CYCLE = NAMES
