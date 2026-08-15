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

// ---- cleanup ------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n== temp root cleaned: ${tmpRoot}`)

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nALL INTEGRATION CHECKS PASSED ✓')
