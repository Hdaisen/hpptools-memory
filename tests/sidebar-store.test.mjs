// hpptools-memory 侧边栏分栏树 store 单元测试（纯 Node）
// 运行: node tests/sidebar-store.test.mjs
// 从 client.js 提取 STORE-START/STORE-END 标记间的纯函数段执行，
// 验证分栏树操作（拆分/合并/关闭/重排/调整大小）语义正确。
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'memory', 'client.js'), 'utf-8')

const start = clientSrc.indexOf('// ---- STORE-START')
const end = clientSrc.indexOf('// ---- STORE-END')
if (start === -1 || end === -1) {
  console.error('STORE markers not found in client.js — abort')
  process.exit(1)
}
const storeCode = clientSrc.slice(start, end)

const fn = new Function(storeCode + `
;return {
  genId, defaultStore, insertLeafAt, removeLeafAt, moveTabToEdge, moveTab,
  closeTab, activateTab, openView, resizeSplit, allLeaves, leafWithTab,
};`)
const S = fn()

const failures = []
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures.push(label); console.error(`  ✗ ${label}`) }
}
const leafIds = (node) => S.allLeaves(node).map((l) => l.id)
const tabsOf = (node, leafId) => S.allLeaves(node).find((l) => l.id === leafId)?.tabs ?? []
const activeOf = (node, leafId) => S.allLeaves(node).find((l) => l.id === leafId)?.active ?? null

// ---- 初始 + 打开视图（全局去重） ----
let st = S.defaultStore()
assert(st.root.kind === 'leaf' && st.root.tabs[0] === 'overview', 'default root = overview leaf')
st = S.openView(st, 'files')
assert(st.root.tabs.join(',') === 'overview,files', 'openView appends to same leaf')
assert(st.root.active === 'files', 'openView activates the new tab')
st = S.openView(st, 'files')
assert(st.root.tabs.length === 2, 'openView dedupes globally (no duplicate tab)')
assert(st.root.active === 'files', 'openView focuses existing tab')
st = S.openView(st, 'runs')
assert(st.root.tabs.join(',') === 'overview,files,runs', 'third tab appended')

// ---- 拖到边缘：拆分出分栏 ----
const leafA = st.root.id
const st2 = S.moveTabToEdge(st, leafA, 'files', leafA, 'right')
assert(st2.root.kind === 'split' && st2.root.dir === 'row', 'edge drop splits into row split')
assert(st2.root.children.length === 2, 'split has 2 children')
const leaves2 = S.allLeaves(st2.root)
assert(leaves2.length === 2, 'two leaves after split')
const filesLeaf = leaves2.find((l) => l.tabs.includes('files'))
const restLeaf = leaves2.find((l) => !l.tabs.includes('files'))
assert(filesLeaf && filesLeaf.tabs.join(',') === 'files', 'dragged tab sits alone in its fresh leaf')
assert(restLeaf && restLeaf.tabs.join(',') === 'overview,runs', 'source leaf keeps the rest')
assert(filesLeaf.active === 'files' && restLeaf.active === 'runs', 'active states preserved')

// ---- 拖到中心：合并回分栏 ----
const st3 = S.moveTabToEdge(st2, filesLeaf.id, 'files', restLeaf.id, 'center')
assert(st3.root.kind === 'leaf', 'center merge collapses the split')
assert(st3.root.tabs.join(',') === 'overview,runs,files', 'merged tab appended to target leaf')
assert(st3.root.active === 'files', 'merged tab activated')

// ---- 同 leaf 拖拽重排（moveTab before） ----
const st4 = S.moveTab(st3, st3.root.id, 'runs', st3.root.id, 'overview')
assert(st4.root.tabs.join(',') === 'runs,overview,files', 'moveTabBefore reorders')

// ---- closeTab：空 leaf 移除 / root 回落 ----
let st5 = S.openView(S.defaultStore(), 'models')
st5 = S.openView(st5, 'settings')
const leafB = st5.root.id
st5 = S.closeTab(st5, leafB, 'overview') // 先关默认的 overview，leafB 剩 [models, settings]
st5 = S.moveTabToEdge(st5, leafB, 'settings', leafB, 'down') // 上下分栏
assert(st5.root.dir === 'col', 'down edge splits into col split')
let l1 = S.allLeaves(st5.root)
st5 = S.closeTab(st5, l1[0].id, 'models') // 关掉 leaf1 的唯一 tab → leaf1 移除
assert(S.allLeaves(st5.root).length === 1, 'empty leaf removed after closeTab')
st5 = S.closeTab(st5, S.allLeaves(st5.root)[0].id, 'settings') // 唯一 leaf 空 → 回落
assert(st5.root.tabs.join(',') === 'overview', 'all closed → falls back to overview')

// ---- removeLeafAt：split 剩 1 子提升 ----
let st6 = S.openView(S.defaultStore(), 'files')
st6 = S.moveTabToEdge(st6, st6.root.id, 'files', st6.root.id, 'right')
const leaves6 = S.allLeaves(st6.root)
st6 = S.closeTab(st6, leaves6[0].id, 'overview')
assert(st6.root.kind === 'leaf' && st6.root.tabs.join(',') === 'files', 'split with 1 child promotes the child')

// ---- resizeSplit 比例调整 ----
let st7 = S.openView(S.defaultStore(), 'files')
st7 = S.moveTabToEdge(st7, st7.root.id, 'files', st7.root.id, 'right')
const split7 = st7.root
const before = [...split7.sizes]
st7 = S.resizeSplit(st7, split7.id, 0, 0.2)
const after = [...st7.root.sizes]
assert(Math.abs((after[0] - before[0]) - 0.2) < 1e-9, `resizeSplit grows first pane (${before[0].toFixed(2)} → ${after[0].toFixed(2)})`)
st7 = S.resizeSplit(st7, split7.id, 0, -2)
assert(st7.root.sizes[0] >= 0.12 - 1e-9 && st7.root.sizes[1] >= 0.12 - 1e-9, 'resizeSplit clamps minimum sizes')

// ---- activateTab ----
let st8 = S.openView(S.defaultStore(), 'files')
st8 = S.activateTab(st8, st8.root.id, 'overview')
assert(st8.root.active === 'overview', 'activateTab switches active tab')

// ---- 跨分栏 openView 聚焦既有 ----
let st9 = S.openView(S.defaultStore(), 'runs')
st9 = S.moveTabToEdge(st9, st9.root.id, 'runs', st9.root.id, 'left')
const leaves9 = S.allLeaves(st9.root)
assert(leaves9.length === 2, 'split into two leaves')
st9 = S.openView(st9, 'runs')
assert(S.allLeaves(st9.root).length === 2, 'openView of existing tab does not duplicate leaf')
const runsLeaf = S.leafWithTab(st9.root, 'runs')
assert(activeOf(st9.root, runsLeaf.id) === 'runs', 'openView focuses the leaf holding the tab')

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nSIDEBAR STORE TESTS PASSED ✓')
