// hpptools-memory 集成冒烟测试（纯 Node，mock Cordis ctx）
// 运行: node tests/integration.test.mjs
// 验证: 模块可加载、9 工具/2 提示段/2 命令注册、remember/recall/notebook 真实读写、
//       runExtraction 写出 raw-<n>.md + dialogue-summary.md
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(__dirname, '..', 'plugins', 'memory')

// Windows 上 ESM import() 需要 file:// URL
const mod = (name) => import(pathToFileURL(path.join(pkgDir, name)).href)

const failures = []
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures.push(label); console.error(`  ✗ ${label}`) }
}

// ---- mock ctx -------------------------------------------------------------
const registered = { tools: [], sections: [], commands: [], events: [] }
const ctx = {
  tools: { register: (def) => registered.tools.push(def) },
  systemPrompt: { section: (s) => registered.sections.push(s) },
  commands: { register: (d) => registered.commands.push(d) },
  on: (name, fn) => { registered.events.push({ name, fn }); return () => {} },
  timeout: (fn) => { fn(); return () => {} },
  subagents: { start: async () => ({ ok: true }) },
  userQuestions: { ask: async () => ({ answers: [{ id: 'confirm', selected: ['Yes'] }] }) },
}

// ---- temp memory root ------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpptools-smoke-'))
console.log(`\n== temp memory root: ${tmpRoot}`)

const { configureMemory } = await mod('config.js')
configureMemory({ root: tmpRoot })
const { PATHS, setProjectName, getProjectName } = await mod('config.js')

// 项目名：用 .dsh-project 标记
setProjectName(tmpRoot, 'smoke-proj')
assert(getProjectName(tmpRoot) === 'smoke-proj', 'getProjectName reads .dsh-project')

// ---- register everything -----------------------------------------------------
const { registerTools } = await mod('tools.js')
const { registerCommands } = await mod('commands.js')
const { registerPromptSections } = await mod('prompt.js')
const { registerLifecycle } = await mod('lifecycle.js')

registerTools(ctx)
registerCommands(ctx)
registerPromptSections(ctx)
registerLifecycle(ctx)

const toolNames = registered.tools.map((t) => t.name)
console.log(`\n== tools (${toolNames.length}): ${toolNames.join(', ')}`)
const expectedTools = ['remember', 'recall', 'forget', 'supersede', 'notebook', 'memory_status', 'convert_file', 'confirm', 'set_project']
assert(expectedTools.every((n) => toolNames.includes(n)), 'all 9 tools registered')
assert(registered.tools.every((t) => t.output && t.output.schema && t.output.render && typeof t.execute === 'function'), 'every tool has output/render/execute')

console.log(`\n== prompt sections (${registered.sections.length})`)
assert(registered.sections.some((s) => s.name === 'memory:core' && s.order === -90), 'memory:core section (order -90)')
assert(registered.sections.some((s) => s.name === 'memory:context' && s.order === 65), 'memory:context section (order 65)')

console.log(`\n== commands (${registered.commands.length})`)
assert(registered.commands.some((c) => c.name === 'memory-clean'), '/memory-clean registered')
assert(registered.commands.some((c) => c.name === 'memory-subagent-model'), '/memory-subagent-model registered')

console.log(`\n== lifecycle events (${registered.events.length})`)
const evNames = registered.events.map((e) => e.name)
for (const want of ['agent/session-start', 'agent/turn-stopping', 'agent/disposed', 'tools/post-execute']) {
  assert(evNames.includes(want), `${want} listener registered`)
}

// ---- tool execution end-to-end ---------------------------------------------
const exec = { agent: { session: { id: 'session-abc123', header: { cwd: tmpRoot } } }, signal: new AbortController().signal }
const remember = registered.tools.find((t) => t.name === 'remember')
const recall = registered.tools.find((t) => t.name === 'recall')
const notebook = registered.tools.find((t) => t.name === 'notebook')

const stored = await remember.execute({ content: '集成测试记忆条目：DSH 插件迁移验证', category: 'fact', scope: 'project', tags: 'test, migration' }, exec)
assert(stored.text.startsWith('✅'), `remember works (${stored.text.slice(0, 30)}…)`)

const memFile = path.join(PATHS.memoriesDir(tmpRoot), 'facts.md')
assert(fs.existsSync(memFile) && fs.readFileSync(memFile, 'utf-8').includes('DSH 插件迁移验证'), 'facts.md written')

const idxFile = path.join(PATHS.memoriesDir(tmpRoot), '_index.md')
assert(fs.existsSync(idxFile) && fs.readFileSync(idxFile, 'utf-8').includes('集成测试记忆条目'), '_index.md refreshed')

const found = await recall.execute({ query: '插件迁移', scope: 'project' }, exec)
assert(found.text.includes('集成测试记忆条目'), `recall finds entry (${found.text.slice(0, 40)}…)`)

const nb = await notebook.execute({ action: 'read' }, exec)
assert(nb.text.includes('Notebook'), 'notebook read works')

// ---- prompt section content --------------------------------------------------
const coreSection = registered.sections.find((s) => s.name === 'memory:core')
const ctxText = registered.sections.find((s) => s.name === 'memory:context')
const coreText = coreSection.text({ agent: exec.agent })
const contextText = ctxText.text({ agent: exec.agent })
assert(typeof coreText === 'string' && coreText.includes('Memory Index'), 'memory:core text renders')
assert(typeof contextText === 'string' && contextText.includes('Session Notebook'), 'memory:context text renders')

// ---- extraction pipeline ------------------------------------------------------
const { runExtraction, countRounds } = await mod('extract.js')
// 直接构造会话目录
const sessionDir = path.join(PATHS.turnsDir(tmpRoot), 'sessions', '2026-01-01-0000-test-smoke')
fs.mkdirSync(sessionDir, { recursive: true })
const msgs = [
  { role: 'user', content: '帮我看看这个迁移项目' },
  { role: 'assistant', content: [{ type: 'text', text: '好的，我来分析 hpptools_memory 的结构。' }, { type: 'toolCall', name: 'read', arguments: { path: 'package.json' } }] },
  { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: '{"name":"hpptools-memory"}' }], isError: false },
  { role: 'assistant', content: [{ type: 'text', text: '结构清楚了。' }] },
]
const r1 = runExtraction(msgs, sessionDir)
assert(r1.roundNo === 1 && r1.isConsolidation === false, `runExtraction round 1 (${JSON.stringify(r1)})`)
const raw1 = path.join(sessionDir, 'raw-1.md')
const summary = path.join(sessionDir, 'dialogue-summary.md')
assert(fs.existsSync(raw1) && fs.readFileSync(raw1, 'utf-8').includes('## User'), 'raw-1.md written with User section')
assert(fs.existsSync(summary) && fs.readFileSync(summary, 'utf-8').includes('### 轮次 1'), 'dialogue-summary.md appended')
assert(countRounds(sessionDir) === 1, 'countRounds = 1')

// 再跑一轮验证 round 2 + 关键动作行
const r2 = runExtraction(msgs, sessionDir)
assert(r2.roundNo === 2, `round advances (${r2.roundNo})`)
assert(fs.readFileSync(summary, 'utf-8').includes('**关键动作**'), 'dialogue-summary has 关键动作 line')
const raw2 = path.join(sessionDir, 'raw-2.md')
assert(fs.existsSync(raw2), 'raw-2.md written')

// ---- models.js --------------------------------------------------------------
const { getExtractorModel, getCleanerModel, setModel, modelAgentOptions } = await mod('models.js')
assert(getExtractorModel() === '(default)' && getCleanerModel() === '(default)', 'models default to (default)')
setModel('extractor', 'deepseek/deepseek-v4-flash')
setModel('cleaner', '(default)')
assert(getExtractorModel() === 'deepseek/deepseek-v4-flash', 'extractor model persisted')
assert(getCleanerModel() === '(default)', 'cleaner model cleared to (default)')
assert(JSON.stringify(modelAgentOptions('deepseek/deepseek-v4-flash')) === '{"provider":"deepseek","model":"deepseek-v4-flash"}', 'modelAgentOptions parses provider/model')
assert(modelAgentOptions('(default)') === undefined, 'modelAgentOptions (default) → undefined')

// ---- migration ---------------------------------------------------------------
const { migrateFromPiIfNeeded, migrationInfo } = await mod('config.js')
const legacyPi = path.join(tmpRoot, 'fake-pi', 'agent', 'memory')
fs.mkdirSync(path.join(legacyPi, 'personal'), { recursive: true })
fs.writeFileSync(path.join(legacyPi, 'core-prompt.md'), '# Core', 'utf-8')
fs.writeFileSync(path.join(legacyPi, 'personal', 'facts.md'), '## F', 'utf-8')
fs.writeFileSync(path.join(legacyPi, 'rules.md'), '## Rules', 'utf-8')
// 空壳判断：只有目录结构、无任何 .md → 不迁移（99% 无 Pi 记忆的用户零打扰）
const emptyLegacy = path.join(tmpRoot, 'fake-pi-empty', 'agent', 'memory')
fs.mkdirSync(path.join(emptyLegacy, 'personal'), { recursive: true })
fs.mkdirSync(path.join(emptyLegacy, 'projects'), { recursive: true })
// 迁移目标：临时把 PATHS.root 指到独立目录
const migratedRoot = path.join(tmpRoot, 'migrated-store')
const { configureMemory: reconfigure } = await mod('config.js')
reconfigure({ root: migratedRoot })
assert(migrateFromPiIfNeeded(emptyLegacy) === null, 'empty legacy (no md) → no migration')
assert(fs.existsSync(path.join(migratedRoot, 'core-prompt.md')) === false, 'empty legacy copied nothing')
const mig = migrateFromPiIfNeeded(legacyPi)
assert(mig !== null && mig.copiedItems === 3, `migration copied items (${mig && mig.copiedItems})`)
assert(fs.existsSync(path.join(migratedRoot, 'core-prompt.md')), 'core-prompt.md migrated')
assert(fs.existsSync(path.join(migratedRoot, 'personal', 'facts.md')), 'personal/facts.md migrated')
assert(migrationInfo() !== null, 'migration marker written')
assert(migrateFromPiIfNeeded(legacyPi) === null, 'migration idempotent (marker blocks re-run)')
// 恢复原 tmpRoot 配置
reconfigure({ root: tmpRoot })

// ---- walkMarkdownFiles 排除 skills 目录 ----------------------------------------
const { walkMarkdownFiles } = await mod('utils.js')
const memTree = path.join(tmpRoot, 'mem-tree')
fs.mkdirSync(path.join(memTree, 'memories'), { recursive: true })
fs.mkdirSync(path.join(memTree, 'skills'), { recursive: true })
fs.writeFileSync(path.join(memTree, 'memories', 'facts.md'), '## F', 'utf-8')
fs.writeFileSync(path.join(memTree, 'skills', 'SKILL.md'), '## Steps', 'utf-8')
fs.writeFileSync(path.join(memTree, 'skills', 'extra.md'), '## X', 'utf-8')
const walked = walkMarkdownFiles(memTree)
assert(walked.length === 1 && walked[0].endsWith('facts.md'), `walkMarkdownFiles excludes skills (${walked.map(f => f.slice(-12)).join(',')})`)

// ---- runs.js ------------------------------------------------------------------
const { trackRun, updateRun, runEntries, registerRunEvents } = await mod('runs.js')
const runId = 'session-run-1'
trackRun(runId, 'extractor', '固化子代理 (demo)', '/tmp/x.log')
assert(runEntries().length === 1 && runEntries()[0].status === 'running', 'trackRun registers running entry')
updateRun(runId, { status: 'done', stopReason: 'success' })
assert(runEntries()[0].status === 'done', 'updateRun transitions status')
const runCtx = { on: (name, fn) => { registered.events.push({ name, fn }); return () => {} } }
registerRunEvents(runCtx)
assert(registered.events.some((e) => e.name === 'subagent/end'), 'subagent/end listener registered')
assert(registered.events.some((e) => e.name === 'session/event'), 'session/event listener registered')

// ---- webui.js -------------------------------------------------------------------
const { registerWebUi } = await mod('webui.js')
const routes = []
const webCtx = {
  get: (name) => name === 'webServer' ? { register: (r) => routes.push(r), port: 12345 } : undefined,
  effect: (fn) => { const d = fn(); return d },
}
registerWebUi(webCtx)
const routePaths = routes.map((r) => r.path)
for (const want of ['/hpptools-memory', '/hpptools-memory/', '/hpptools-memory/api/overview', '/hpptools-memory/api/models', '/hpptools-memory/api/runs', '/hpptools-memory/api/model', '/hpptools-memory/api/clean']) {
  assert(routePaths.includes(want), `webui route ${want}`)
}

// ---- cleanup ------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n== temp root cleaned: ${tmpRoot}`)

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nALL INTEGRATION CHECKS PASSED ✓')
