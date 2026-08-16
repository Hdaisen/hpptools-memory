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

// The session group should exist with the two raw files + dialogue-summary, but NOT consolidation-input/log
const sessGroup = data.groups.find((g) => g.id === 'session:' + anchor)
ok(!!sessGroup, 'current-session group present')
if (sessGroup) {
  const names = sessGroup.files.map((f) => path.basename(f.rel)).sort()
  ok(JSON.stringify(names) === JSON.stringify(['dialogue-summary.md', 'raw-1.md', 'raw-2.md']), `session group files = raw-1/raw-2/dialogue-summary (got ${names.join(',')})`)
}

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

// ---- empty session dir still emits the group (dir exists even without raw yet) ----
const sessDir2 = path.join(projectDir, 'turns', 'sessions', `2026-08-17T00-00-00-yyyy-${anchor}`)
fs.mkdirSync(sessDir2, { recursive: true })
setSessionDir('session-' + anchor, sessDir2) // register the EMPTY dir as current
const data2 = filesData(ctx)
const sess2 = data2.groups.find((g) => g.id === 'session:' + anchor)
ok(!!sess2, 'empty session dir still emits current-session group')
if (sess2) ok(sess2.files.length === 0, 'empty session dir → empty files list')

// ---- anchor fallback: no in-memory registration → matches dir by session-id anchor ----
const promptMod = await mod('prompt.js')
promptMod.dropSessionDir('session-' + anchor) // clear in-memory registration
const data3 = filesData(ctx)
const sess3 = data3.groups.find((g) => g.id === 'session:' + anchor)
ok(!!sess3, 'anchor fallback emits group without in-memory registration')

console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
