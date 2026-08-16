// hpptools-memory WebUI 静态验证（纯 Node，不依赖宿主）
// 运行: node tests/verify-webui.mjs
// 验证: webui.js 路由注册、webui.html 结构/API 引用/i18n/错误兜底/现场恢复、
//       client.js 关键结构
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(__dirname, '..', 'plugins', 'memory')
const mod = (name) => import(pathToFileURL(path.join(pkgDir, name)).href)

const failures = []
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures.push(label); console.error(`  ✗ ${label}`) }
}

// ---- webui.js 路由注册 ----
const { registerWebUi } = await mod('webui.js')
const routes = []
const webCtx = {
  get: (name) => name === 'webServer' ? { register: (r) => routes.push(r), port: 12345 } : undefined,
  effect: (fn) => { const d = fn(); return d },
}
registerWebUi(webCtx)
const routePaths = routes.map((r) => r.path)
for (const want of ['/hpptools-memory', '/hpptools-memory/', '/hpptools-memory/api/overview', '/hpptools-memory/api/models', '/hpptools-memory/api/runs', '/hpptools-memory/api/model', '/hpptools-memory/api/clean', '/hpptools-memory/api/files', '/hpptools-memory/api/file', '/hpptools-memory/api/settings', '/hpptools-memory/api/migrate', '/hpptools-memory/api/open-folder']) {
  assert(routePaths.includes(want), `webui route ${want}`)
}

// ---- webui.html 完整性 ----
const html = fs.readFileSync(path.join(pkgDir, 'webui.html'), 'utf-8')
assert(html.includes('<section id="tab-overview"'), 'tab-overview section')
assert(html.includes('<section id="tab-files"'), 'tab-files section')
assert(html.includes('<section id="tab-models"'), 'tab-models section')
assert(html.includes('<section id="tab-runs"'), 'tab-runs section')
assert(html.includes('<section id="tab-settings"'), 'tab-settings section')
for (const id of ['cards', 'fileTree', 'filePane', 'modelExtractor', 'modelCleaner', 'runsBody', 'migrateZone', 'bannerFatal', 'bannerApi', 'bannerMigrated']) {
  assert(html.includes(`id="${id}"`), `html has #${id}`)
}
// 关键 API 端点引用
for (const api of ['api/overview', 'api/models', 'api/runs', 'api/model', 'api/clean', 'api/migrate', 'api/files', 'api/file', 'api/settings', 'api/open-folder']) {
  assert(html.includes(api), `html references ${api}`)
}
// i18n 结构
assert(html.includes('const I18N'), 'i18n dictionary present')
assert(html.includes('hpptools-locale'), 'locale sync handler present')
assert(html.includes('hpptools-theme'), 'theme sync handler present')
// 错误兜底
assert(html.includes('window.addEventListener("error"'), 'global error handler')
assert(html.includes('unhandledrejection'), 'unhandledrejection handler')
// 现场恢复
assert(html.includes('hpptools-ui-tab'), 'tab persistence')
assert(html.includes('hpptools-ui-file'), 'file persistence')
assert(html.includes('hpptools-ui-tree-width'), 'tree width persistence')
assert(html.includes('hpptools-ui-nav-width'), 'nav width persistence')
assert(html.includes('hpptools-ui-focus'), 'focus persistence')
// 轮询节流
assert(html.includes('visibilitychange'), 'visibility-based polling throttle')
// 宿主侧边栏嵌入定位（?view= / ?embed=1）
assert(html.includes('urlParams.get("view")'), 'view query param handling')
assert(html.includes('body.dataset.embed'), 'embed query param handling')
assert(html.includes('body[data-embed] .tabbar'), 'embed hides inner tabbar')

// ---- client.js 关键结构 ----
const client = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf-8')
// 2026-08-16：侧边栏底部按钮已按用户要求移除，client 半边降级为 no-op 入口
// （记忆面板全部由 dsh-better-sidebar fork 内置 tab 承载）。
assert(client.includes('__ModuleLoader__.load'), 'client.js has __ModuleLoader__.load wrapper')
assert(client.includes('exports.inject'), 'client.js has exports.inject')
assert(client.includes('exports.apply'), 'client.js has exports.apply')
assert(client.includes('no-op'), 'client.js documents the no-op entry')
// 旧结构全部移除：不再注册任何 UI/服务/样式
for (const gone of ['sidebar.footer.action', 'registerTab', 'waitForService', 'TAB_ID', 'openConsole',
  'hpptools-memory:console', 'ctx.get("betterSidebar")', 'hpptools-memory-console',
  'hpptools-pulse', 'PanelBoundary', 'data-hpptools-memory']) {
  assert(!client.includes(gone), `client.js no longer has ${gone}`)
}

if (failures.length > 0) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\nWEBUI VERIFICATION PASSED ✓')
