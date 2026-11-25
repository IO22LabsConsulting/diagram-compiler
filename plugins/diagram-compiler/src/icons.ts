// Icon registry: semantic name -> Lucide glyph (ISC licence), bundled offline via @iconify-json/lucide.
// Only bodies from the bundled set are ever emitted; a spec can name an icon but never supply one.
import { createRequire } from 'node:module'

const set = createRequire(import.meta.url)('@iconify-json/lucide/icons.json') as {
  icons: Record<string, { body: string }>
  aliases?: Record<string, { parent: string }>
}

// Concepts an LLM reaches for that are not Lucide names.
export const ALIASES: Record<string, string> = {
  db: 'database', sql: 'database', postgres: 'database', sqlite: 'database', 'vector-db': 'database-zap', warehouse: 'warehouse',
  llm: 'brain', model: 'brain', ai: 'sparkles', agent: 'bot', robot: 'bot', embedding: 'binary',
  api: 'plug', gateway: 'door-open', queue: 'list-ordered', stream: 'waves', cache: 'zap', worker: 'cog', job: 'cog', cron: 'clock',
  web: 'globe', browser: 'app-window', frontend: 'app-window', ui: 'layout-dashboard', dashboard: 'layout-dashboard',
  mobile: 'smartphone', phone: 'smartphone', ios: 'smartphone', desktop: 'monitor', cli: 'terminal', shell: 'terminal',
  doc: 'file-text', document: 'file-text', file: 'file', files: 'files', storage: 'hard-drive', disk: 'hard-drive', bucket: 'archive',
  external: 'cloud', service: 'server', person: 'user', auth: 'lock', security: 'shield', secret: 'key-round', email: 'mail', notification: 'bell', chat: 'message-square',
  git: 'git-branch', repo: 'folder-git-2', ci: 'circle-play', pipeline: 'workflow', deploy: 'rocket', test: 'flask-conical',
  chart: 'chart-column', analytics: 'chart-line', metrics: 'activity', logs: 'scroll-text', monitoring: 'activity',
  tool: 'wrench', config: 'settings', plugin: 'puzzle', package: 'package', library: 'library', code: 'code',
  money: 'banknote', payment: 'credit-card', trade: 'trending-up', market: 'candlestick-chart', report: 'file-chart-column',
  video: 'video', audio: 'audio-lines', image: 'image', camera: 'camera', gpu: 'cpu', train: 'dumbbell', data: 'table',
  spreadsheet: 'sheet', excel: 'sheet', graph: 'network', memory: 'memory-stick', team: 'users',
  check: 'circle-check', error: 'circle-x', warning: 'triangle-alert', idea: 'lightbulb', time: 'clock', event: 'calendar',
}

export type Icon = { name: string; body: string }

export function resolveIcon(name: string): Icon | null {
  let n = ALIASES[name] ?? name
  n = set.aliases?.[n]?.parent ?? n
  const icon = Object.hasOwn(set.icons, n) ? set.icons[n] : undefined
  return icon ? { name: n, body: icon.body } : null
}

export function searchIcons(term = ''): string[] {
  const t = term.toLowerCase()
  const names = [...Object.keys(ALIASES).map((a) => `${a} -> ${ALIASES[a]}`), ...Object.keys(set.icons)]
  return names.filter((n) => n.includes(t)).sort()
}
