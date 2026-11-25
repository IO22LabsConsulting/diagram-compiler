// `diagram` CLI. All file and process I/O lives here. Exit codes: 0 ok, 1 validation error, 2 lint errors, 3 render failure,
// 4 a diagram needs review (stale, or stamp refused).
// Results print as JSON on stdout; failures print as JSON on stderr, so a model can parse both.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { compile, toPng } from './compile.ts'
import { searchIcons } from './icons.ts'
import { DIAGRAM_TYPES, jsonSchema, parseSpec, SpecError } from './spec.ts'
import { THEMES } from './theme.ts'
import { applyFixes, citedFiles, defaultScope, parseHunks, staleness, usageCounts, type Changes, type Lock } from './stale.ts'
import { verifySources, type Reader } from './verify.ts'

const USAGE = `diagram <command>

  validate <spec.json>                      schema + reference checks
  render   <spec.json> [-o dir] [--format svg,png] [--scale 2] [--debug] [--root dir] [--strict]
                                            with --root, also checks every "source" against that folder
  verify   <spec.json> --root <dir> [--strict]
                                            check that cited files, lines and quoted text exist; --strict makes
                                            an element with no source an error
  lint     <spec.json> [--json]             LintReport
  stamp    <spec.json ...> --root <dir>      record the repository state a checked diagram was drawn from
                                            (writes <spec>.lock.json; refuses if the source check fails)
  stale    <spec.json|dir ...> --root <dir> [--fix]
                                            what changed since the stamp: citations repaired without reading
                                            (applied with --fix), and the line ranges that must be read again
  hook                                      print a git post-commit hook that keeps docs/diagrams current
                                            (save it as .git/hooks/post-commit and make it executable)
  schema   [--type ${DIAGRAM_TYPES.join('|')}] [--example]
                                            a working example then the JSON Schema; --example prints the example only
  themes                                    list themes
  icons    [--search term]                  list icon names and aliases

Use - as the spec path to read stdin.`

// written synchronously: process.exit() right after an async write cut long reports off at the pipe buffer
const out = (v: unknown) => writeSync(1, JSON.stringify(v, null, 2) + '\n')
const fail = (code: number, v: unknown): never => {
  writeSync(2, JSON.stringify(v, null, 2) + '\n')
  process.exit(code)
}

function readSpec(path: string | undefined): unknown {
  if (!path) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '', message: 'missing spec path' }] })
  let raw: string
  try {
    raw = readFileSync(path === '-' ? 0 : path!, 'utf8')
  } catch (e) {
    return fail(1, { ok: false, errors: [{ code: 'cli.read', path: path!, message: (e as Error).message }] })
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    return fail(1, { ok: false, errors: [{ code: 'spec.json', path: '', message: `not valid JSON: ${(e as Error).message}` }] })
  }
}

/** Reads files for the source check: only regular files under `root`, at most 4 MB, never following a link out of it. */
function reader(root: string): Reader {
  const base = realpathSync(resolve(root))
  return (file) => {
    try {
      const p = realpathSync(resolve(base, file))
      if (p !== base && !p.startsWith(base + sep)) return null
      const st = statSync(p)
      if (!st.isFile() || st.size > 4_000_000) return false
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const git = (root: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}
const SKIP = new Set(['node_modules', '_build', 'deps', 'dist', 'build', 'target', 'vendor', '.git', '.venv', '__pycache__'])
/** Every file under the scope folders: tracked files when the root is a git repository, otherwise a plain walk. */
function listScope(root: string, scope: string[]): string[] {
  const tracked = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scope)
  if (tracked !== null) return tracked.split('\0').filter(Boolean).slice(0, 6000)
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[]
    try { names = readdirSync(join(root, dir)).sort() } catch { return }
    for (const n of names) {
      if (out.length >= 6000 || SKIP.has(n) || n.startsWith('.')) continue
      const rel = dir ? `${dir}/${n}` : n
      const st = statSync(join(root, rel), { throwIfNoEntry: false })
      if (st?.isDirectory()) walk(rel)
      else if (st?.isFile()) out.push(rel)
    }
  }
  for (const p of scope) walk(p)
  return out
}
const hashFile = (root: string, f: string): string | null => {
  try {
    const st = statSync(join(root, f))
    return st.isFile() && st.size <= 4_000_000 ? sha(readFileSync(join(root, f))) : null
  } catch {
    return null
  }
}
function buildLock(root: string, spec: Parameters<typeof defaultScope>[0], citedFiles: string[]): Lock {
  const scope = (spec as { scope?: string[] }).scope ?? defaultScope(spec)
  const files: Record<string, string> = {}
  for (const f of [...new Set([...citedFiles, ...listScope(root, scope)])].sort()) {
    const h = hashFile(root, f)
    if (h) files[f] = h
  }
  return { lock_version: 1, commit: git(root, 'rev-parse', 'HEAD')?.trim() ?? null, scope, files, uses: usageCounts(spec, Object.keys(files), reader(root)) }
}
const specFiles = (paths: string[]): string[] =>
  paths.flatMap((p) => (statSync(p, { throwIfNoEntry: false })?.isDirectory() ? (readdirSync(p, { recursive: true }) as string[]).filter((f) => f.endsWith('.json') && !f.endsWith('.lock.json')).sort().map((f) => join(p, f)) : [p]))
const lockPath = (spec: string) => spec.replace(/\.json$/, '') + '.lock.json'

/** What differs between the stamped state and the folder now. Hashes decide what changed; git, when there, says where. */
function changesSince(root: string, lock: Lock): Changes {
  const now = new Set(listScope(root, lock.scope))
  const ch: Changes = { changed: new Map(), added: new Map(), deleted: new Set(), renamed: new Map() }
  const whole = (f: string): [number, number][] => {
    try { return [[1, Math.max(1, readFileSync(join(root, f), 'utf8').split('\n').length)]] } catch { return [] }
  }
  for (const [f, h] of Object.entries(lock.files)) {
    const cur = hashFile(root, f)
    if (cur === null) ch.deleted.add(f)
    else if (cur !== h) ch.changed.set(f, whole(f))
  }
  for (const f of now) if (!(f in lock.files) && hashFile(root, f)) ch.added.set(f, whole(f))
  if (lock.commit) {
    for (const l of (git(root, 'diff', '--name-status', '-M', lock.commit) ?? '').split('\n')) {
      const [st, a, b] = l.split('\t')
      if (st?.startsWith('R') && a && b && ch.deleted.has(a)) {
        ch.renamed.set(a, b)
        ch.deleted.delete(a)
        const edits = ch.added.get(b)
        ch.added.delete(b)
        if (edits && lock.files[a] !== hashFile(root, b)) ch.changed.set(b, edits)
      }
    }
    const paths = [...ch.changed.keys()]
    ch.hunks = new Map()
    const hunks = paths.length ? parseHunks(git(root, 'diff', '--unified=0', '-M', lock.commit, '--', ...paths, ...ch.renamed.keys()) ?? '', ch.hunks) : new Map()
    for (const f of paths) if (hunks.has(f)) ch.changed.set(f, hunks.get(f)!)
  }
  return ch
}

const HOOK = `#!/bin/sh
# Keeps this repository's diagrams current after every commit. Generated by \`diagram hook\`; generate it again after
# updating the diagram-compiler plugin, because the path below points at one installed version.
# Diagrams are expected in docs/diagrams (override with DIAGRAM_DIR). Repairs that need no reading are applied at
# once. When something has to be read again the work list is saved and a one-line notice is printed. Only if
# DIAGRAM_AUTO=1 is set, and the \`claude\` command exists, is Claude Code started in the background to do the update;
# it is told not to commit.
bin='__DIAGRAM__'
dir=\${DIAGRAM_DIR:-docs/diagrams}
root=$(git rev-parse --show-toplevel) || exit 0
[ -d "$root/$dir" ] || exit 0
[ -f "$bin" ] || { echo "diagrams: the diagram tool has moved; run 'diagram hook' again"; exit 0; }
[ -n "$DIAGRAM_HOOK_RUNNING" ] && exit 0
out="$root/.git/diagram-stale.json"
node "$bin" stale "$root/$dir" --root "$root" --fix > "$out" 2>/dev/null && exit 0
if [ "$DIAGRAM_AUTO" = "1" ] && command -v claude >/dev/null 2>&1; then
  ( cd "$root" && DIAGRAM_HOOK_RUNNING=1 claude -p "Use the diagram skill. The diagrams in $dir are stale; the work list is in .git/diagram-stale.json. Follow the skill's 'Keeping diagrams current' steps: read only the listed line ranges, update the specs, render with --root . --strict, then stamp. Do not commit. End with one line per diagram saying what changed." --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node:*),Bash(diagram:*)" >> "$root/.git/diagram-update.log" 2>&1 ) &
  echo "diagrams: update started in the background (log: .git/diagram-update.log)"
else
  echo "diagrams: some need review after this commit (work list: .git/diagram-stale.json). Ask Claude to update the diagrams."
fi
exit 0`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o', default: '.' },
      format: { type: 'string', default: 'svg,png' },
      scale: { type: 'string', default: '2' },
      debug: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      type: { type: 'string' },
      example: { type: 'boolean', default: false },
      search: { type: 'string' },
      root: { type: 'string' },
      fix: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [cmd, file] = positionals
  if (values.help || !cmd) return void console.log(USAGE)

  try {
    if (cmd === 'validate') {
      const s = parseSpec(readSpec(file))
      return out({ ok: true, diagram_type: s.diagram_type })
    }
    if (cmd === 'stamp' || cmd === 'stale') {
      if (!values.root) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '--root', message: `${cmd} needs --root <dir>: the repository the diagrams describe` }] })
      const root = realpathSync(resolve(values.root!))
      const results: unknown[] = []
      let review = false
      for (const file of specFiles(positionals.slice(1))) {
        let raw: unknown
        try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
        if (!(raw as { spec_version?: string })?.spec_version) continue
        const spec = parseSpec(raw)
        const cited = () => citedFiles(parseSpec(raw))
        if (cmd === 'stamp') {
          const v = verifySources(spec, reader(root), values.strict)
          if (!v.ok) {
            review = true
            results.push({ spec: file, stamped: false, reason: 'the source check fails; fix it first', findings: v.findings.filter((x) => x.severity === 'error') })
            continue
          }
          const lock = buildLock(root, spec, cited())
          writeFileSync(lockPath(file), JSON.stringify(lock, null, 2) + '\n')
          results.push({ spec: file, stamped: true, commit: lock.commit, files_tracked: Object.keys(lock.files).length, scope: lock.scope })
          continue
        }
        if (!existsSync(lockPath(file))) {
          review = true
          results.push({ spec: file, status: 'unstamped', fix: 'check it with render --root --strict, then run stamp' })
          continue
        }
        const lock = JSON.parse(readFileSync(lockPath(file), 'utf8')) as Lock
        const rep = staleness(spec, lock, reader(root), changesSince(root, lock))
        let status: string = rep.status
        if (values.fix && rep.fixes.length) {
          applyFixes(raw, rep.fixes)
          writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
        }
        if (rep.status === 'fresh' || (rep.status === 'auto-fixable' && values.fix)) {
          // nothing for a reader to do: move the stamp forward so the next run starts from here
          if (rep.status === 'auto-fixable' || lock.commit !== (git(root, 'rev-parse', 'HEAD')?.trim() ?? null)) writeFileSync(lockPath(file), JSON.stringify(buildLock(root, parseSpec(raw), cited()), null, 2) + '\n')
          status = rep.status === 'fresh' ? 'fresh' : 'auto-fixed'
        } else review = true
        results.push({ spec: file, since: lock.commit, ...rep, status, fixes_applied: !!values.fix && rep.fixes.length > 0 })
      }
      out({ ok: !review, diagrams: results.length, needs_review: results.filter((x) => ['needs-review', 'auto-fixable', 'unstamped'].includes((x as { status?: string }).status ?? '') || (x as { stamped?: boolean }).stamped === false).length, results })
      return process.exit(review ? 4 : 0)
    }
    if (cmd === 'verify') {
      if (!values.root) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '--root', message: 'verify needs --root <dir>: the folder the cited paths are relative to' }] })
      const r = verifySources(parseSpec(readSpec(file)), reader(values.root!), values.strict)
      out(r)
      return process.exit(r.ok ? 0 : 2)
    }
    if (cmd === 'render' || cmd === 'lint') {
      const t0 = performance.now()
      const c = await compile(readSpec(file), { debug: values.debug })
      // with --root the source check is part of lint: one command, one list of things to fix
      const src = values.root ? verifySources(c.spec, reader(values.root), values.strict) : null
      if (src) {
        c.lint.findings.push(...src.findings)
        c.lint.errors += src.errors
        c.lint.warnings += src.warnings
        c.lint.ok = c.lint.errors === 0
      }
      if (cmd === 'lint') {
        if (values.json) out(c.lint)
        else {
          for (const x of c.lint.findings) console.log(`${x.severity.padEnd(5)} ${x.rule}  ${x.message}\n      fix: ${x.fix}`)
          console.log(c.lint.ok ? `lint ok (${c.lint.warnings} warning(s))` : `lint failed: ${c.lint.errors} error(s), ${c.lint.warnings} warning(s)`)
        }
        return process.exit(c.lint.ok ? 0 : 2)
      }
      const formats = values.format.split(',').map((x) => x.trim())
      const bad = formats.find((x) => x !== 'svg' && x !== 'png')
      if (bad) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '--format', message: `unknown format "${bad}"; use svg, png or both` }] })
      const scale = Number(values.scale)
      if (!(scale >= 0.25 && scale <= 4)) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '--scale', message: 'scale must be between 0.25 and 4' }] })
      mkdirSync(values.out, { recursive: true })
      const stem = join(values.out, file === '-' ? 'diagram' : basename(file!).replace(/(\.spec)?\.json$/, ''))
      const files: string[] = []
      if (formats.includes('svg')) {
        writeFileSync(`${stem}.svg`, c.svg)
        files.push(`${stem}.svg`)
      }
      if (formats.includes('png')) {
        writeFileSync(`${stem}.png`, toPng(c.svg, scale))
        files.push(`${stem}.png`)
      }
      out({ ok: c.lint.ok, files, width: c.width, height: c.height, ms: Math.round(performance.now() - t0), ...(src ? { sources: { elements: src.elements, cited: src.cited, citations: src.citations, distinct: src.distinct } } : {}), lint: c.lint })
      return process.exit(c.lint.ok ? 0 : 2)
    }
    if (cmd === 'schema') {
      const t = values.type as (typeof DIAGRAM_TYPES)[number] | undefined
      if (t && !DIAGRAM_TYPES.includes(t)) fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '--type', message: `unknown type "${t}"; one of ${DIAGRAM_TYPES.join(', ')}` }] })
      if (!t) return out(jsonSchema())
      const example = JSON.parse(readFileSync(new URL(`../examples/${t}.json`, import.meta.url), 'utf8'))
      return out(values.example ? example : { example, schema: jsonSchema(t) })
    }
    if (cmd === 'hook') {
      // the hook runs outside Claude Code, so it carries the absolute path of this installation
      const self = realpathSync(process.argv[1]!)
      return void console.log(HOOK.replaceAll('__DIAGRAM__', self.replaceAll("'", "'\\''")))
    }
    if (cmd === 'themes') return void console.log(Object.keys(THEMES).join('\n'))
    if (cmd === 'icons') return void console.log(searchIcons(values.search).join('\n'))
    fail(1, { ok: false, errors: [{ code: 'cli.usage', path: '', message: `unknown command "${cmd}"` }], usage: USAGE })
  } catch (e) {
    if (e instanceof SpecError) fail(1, { ok: false, errors: e.issues })
    fail(3, { ok: false, errors: [{ code: 'render.failure', path: '', message: (e as Error).message, element_ids: (e as { element_ids?: string[] }).element_ids ?? [] }] })
  }
}

main()
