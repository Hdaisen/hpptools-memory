// Verification of convertSessionToMessages — DSH event → extract-message mapping.
// Run: node tests/convert.check.mjs  (from repo root)
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as path from 'node:path'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'memory')
const mod = (name) => import(pathToFileURL(path.join(pkgDir, name)).href)

let failed = 0
const ok = (cond, label) => { if (cond) console.log(`  ✓ ${label}`); else { failed++; console.error(`  ✗ ${label}`) } }

const { convertSessionToMessages } = await mod('lifecycle.js')

// Build a realistic DSH SessionEvent[] (matching SessionEventMap in
// packages/core/session/src/types.ts + message types in packages/llm/llm).
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '修复某 bug' }], source: { kind: 'user' } } },
  { type: 'user/message', seq: 2, time: 3, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin', plugin: 'x', form: 'instructions' } } },
  { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '我来修复' },
    { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{"path":"a.ts"}' },
  ], source: { kind: 'model', provider: 'x', model: 'y' } } } },
  { type: 'tool/result', seq: 4, time: 5, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [
    { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
  ], source: { kind: 'tool', callId: 'c1' } } } },
  { type: 'assistant/message', seq: 5, time: 6, data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [
    { type: 'text', text: '完成' },
  ], source: { kind: 'model', provider: 'x', model: 'y' } } } },
  { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]

const session = { events }
const msgs = convertSessionToMessages(session, 'session-test')

console.log('\nrules:', msgs.map((m) => m.role).join(', '))
ok(msgs.length === 4, `expected 4 messages (user, assistant, toolResult, assistant), got ${msgs.length}`)

const roles = msgs.map((m) => m.role)
ok(roles[0] === 'user' && roles[0] === 'user', 'first is user')
ok(roles[1] === 'assistant', 'assistant present (root-cause: agent/message wrong event name)')
ok(roles[2] === 'toolResult', 'toolResult present')
ok(roles[3] === 'assistant', 'second assistant present')

// assistant message blocks: reasoning→thinking, text, tool-call
const asst = msgs[1]
ok(asst.content[0].type === 'thinking', 'reasoning mapped to thinking block')
ok(asst.content[1].type === 'text' && asst.content[1].text === '我来修复', 'text block passthrough')
ok(asst.content[2].type === 'toolCall' && asst.content[2].name === 'edit', 'tool-call mapped to toolCall with name')
ok(JSON.stringify(asst.content[2].arguments) === JSON.stringify({ path: 'a.ts' }), 'tool-call arguments parsed from JSON string to object')

// toolResult: toolName resolved via callId, content from tool-result block
const tr = msgs[2]
ok(tr.toolName === 'edit', `toolName resolved via callId → 'edit' (got ${tr.toolName})`)
ok(tr.content?.[0]?.text === 'ok', 'toolResult content unwrapped from tool-result block')
ok(tr.isError === false, 'toolResult isError propagated')

// key actions uses tool-call — run extractKeyActions to confirm it works
const { extractKeyActions } = await mod('extract.js')
const actions = extractKeyActions(msgs)
ok(actions.some((a) => a.includes('edit a.ts')), `extractKeyActions picks up edit a.ts (got ${JSON.stringify(actions)})`)

// ---- incremental extraction: second call only returns NEW events ----
const moreEvents = [
  { type: 'assistant/message', seq: 7, time: 8, data: { turn: 2, step: 1, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '第二轮的回复' }], source: { kind: 'model', provider: 'x', model: 'y' } } } },
]
const msgs2 = convertSessionToMessages({ events: [...events, ...moreEvents] }, 'session-test')
ok(msgs2.length === 1 && msgs2[0].role === 'assistant' && msgs2[0].content[0].text === '第二轮的回复', 'incremental: second call returns only the new turn')

// ---- a fresh session id (no watermark) re-processes all ----
const msgs3 = convertSessionToMessages({ events }, 'session-fresh')
console.log('fresh sid rules:', msgs3.map((m) => m.role).join(', '))
ok(msgs3.length === 4, 'fresh session id reprocesses full history')

console.log(failed === 0 ? '\nALL OK' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
