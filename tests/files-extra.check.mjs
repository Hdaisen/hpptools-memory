// Verification of the filesData new groups (current-session raw + subagent logs).
// Run: node tests/files-extra.check.mjs  (from repo root)
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'memory')
const mod = (name) => import(pathToFileURL(path.join(pkgDir, name)).href)

let failed = 0
const ok = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { failed++; console.error(`  ✗ ${label}`) } }

// temp memory root
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'files-extra-'))
const { configureMemory } = await mod('config.js')
configureMemory({ root: tmpRoot })
const { PATHS, setProjectName } = await mod('config.js')
setProjectName(tmpRoot, 'smoke-proj')

const projectDir = path.join(tmpRoot, 'projects', 'smoke-proj')
// create a session dir exactly like lifecycle does (ts-rand-anchor)
const anchor = 'abcd1234ef56'
const sessDir = path.join(projectDir, 'turns', 'sessions', `2026-08-16T10-00-00-xxxx-${anchor}`)
fs.mkdirSync(sessDir, { recursive: true })
fs.writeFileSync(path.join(sessDir, 'raw-1.md'), '# round 1\n')
fs.writeFileSync(path.join(sessDir, 'raw-2.md'), '# round 2\n')
fs.writeFileSync(path.join(sessDir, 'dialogue-summary.md'), '## 轮次 1\n')
// consolidation input (should NOT appear in session group)
fs.writeFileSync(path.join(sessDir, 'consolidation-input.md'), '## window\n')
// a consolidation log (should appear in subagent-logs group)
fs.writeFileSync(path.join(sessDir, 'consolidation-2026-08-16T10-00-00.log'), '# Consolidation\n')

// maintenance cleaner log
fs.mkdirSync(PATHS.maintenanceDir, { recursive: true })
fs.writeFileSync(path.join(PATHS.maintenanceDir, 'clean-2026-08-15T09-00-00.log'), '# Clean\n')

// copy of simple core + notebook for the other groups
fs.writeFileSync(path.join(tmpRoot, 'core-prompt.md'), 'core\n')
fs.writeFileSync(path.join(projectDir, 'notebook.md'), 'nb\n')

// mock ctx with a root agent (session.id + cwd) so getSessionDir(anchor) can resolve
const { setSessionDir } = await mod('prompt.js')
setSessionDir('session-' + anchor, sessDir)

const agents = { roots: () => [{ session: { id: 'session-' + anchor, header: { cwd: tmpRoot } } }] }
const ctx = { get: (k) => (k === 'agents' ? agents : undefined) }

const { filesData } = await mod('webui.js')
const data = filesData(ctx)

const labels = data.groups.map((g) => g.id)
console.log('\ngroups:', labels.join(', '))

// Session groups are split into dialogue-summary and raw (per 5c2e2d8):
// `session-summary:<anchor>` + `session-raw:<anchor>`.
const sessSummary = data.groups.find((g) => g.id === 'session-summary:' + anchor)
const sessRaw = data.groups.find((g) => g.id === 'session-raw:' + anchor)
ok(!!sessSummary, 'session-summary group present')
ok(!!sessRaw, 'session-raw group present')
if (sessSummary) {
  const names = sessSummary.files.map((f) => path.basename(f.rel))
  ok(JSON.stringify(names) === JSON.stringify(['dialogue-summary.md']), `summary group = dialogue-summary.md (got ${names.join(',')})`)
}
if (sessRaw) {
  const names = sessRaw.files.map((f) => path.basename(f.rel)).sort()
  ok(JSON.stringify(names) === JSON.stringify(['raw-1.md', 'raw-2.md']), `raw group = raw-1/raw-2 (got ${names.join(',')})`)
}
// consolidation-input.md must not leak into either session group
const sessAll = [...(sessSummary?.files ?? []), ...(sessRaw?.files ?? [])].map((f) => path.basename(f.rel))
ok(!sessAll.includes('consolidation-input.md'), 'consolidation-input.md not in session groups')

// subagent-logs group: consolidation (session) + clean (maintenance)
const logGroup = data.groups.find((g) => g.id === 'subagent-logs')
ok(!!logGroup, 'subagent-logs group present')
if (logGroup) {
  const basenames = logGroup.files.map((f) => path.basename(f.rel)).sort()
  ok(basenames.includes('consolidation-2026-08-16T10-00-00.log'), 'has consolidation log')
  ok(basenames.includes('clean-2026-08-15T09-00-00.log'), 'has maintenance clean log')
}

// notebook / core groups still present
ok(data.groups.some((g) => g.id === 'notebook'), 'notebook group present')
ok(data.groups.some((g) => g.id === 'core'), 'core group present')

// ---- empty session dir is skipped (a40b1d4): registered dir with no raw/summary
//      is a placeholder (e.g. fresh session right after GUI restart) → falls back
//      to the content-bearing session dir ----
const sessDir2 = path.join(projectDir, 'turns', 'sessions', `2026-08-17T00-00-00-yyyy-${anchor}`)
fs.mkdirSync(sessDir2, { recursive: true })
setSessionDir('session-' + anchor, sessDir2) // register the EMPTY dir as current
const data2 = filesData(ctx)
const sum2 = data2.groups.find((g) => g.id === 'session-summary:' + anchor)
const raw2 = data2.groups.find((g) => g.id === 'session-raw:' + anchor)
ok(!!sum2 && !!raw2, 'session groups emitted when registered dir is empty (falls back)')
if (sum2 && raw2) {
  const sNames = sum2.files.map((f) => path.basename(f.rel))
  const rNames = raw2.files.map((f) => path.basename(f.rel)).sort()
  ok(JSON.stringify(sNames) === JSON.stringify(['dialogue-summary.md']), 'empty registered dir → summary falls back to content dir')
  ok(JSON.stringify(rNames) === JSON.stringify(['raw-1.md', 'raw-2.md']), 'empty registered dir → raw falls back to content dir')
}

// ---- anchor fallback: no in-memory registration → matches dir by session-id anchor ----
const promptMod = await mod('prompt.js')
promptMod.dropSessionDir('session-' + anchor) // clear in-memory registration
const data3 = filesData(ctx)
const sum3 = data3.groups.find((g) => g.id === 'session-summary:' + anchor)
const raw3 = data3.groups.find((g) => g.id === 'session-raw:' + anchor)
ok(!!sum3 && !!raw3, 'anchor fallback emits session groups without in-memory registration')

console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
