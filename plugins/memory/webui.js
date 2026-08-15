/**
 * Web 可视化界面 — webServer 同源路由 + 自包含页面。
 *
 * 路由（全部 JSON / HTML，同源 127.0.0.1）：
 *   GET  /hpptools-memory/               → 控制台页面（webui.html，自包含）
 *   GET  /hpptools-memory/api/overview   → 记忆概览（存储/状态/统计/维护/迁移/模型）
 *   GET  /hpptools-memory/api/models     → 已配置模型列表（llm service）+ 当前配置
 *   POST /hpptools-memory/api/model      → 设置固化/海马体模型 { kind, value }
 *   GET  /hpptools-memory/api/runs       → 运行中的记忆子代理（含活动日志尾部）
 *   POST /hpptools-memory/api/clean      → 触发海马体整理（当前会话）
 *
 * 打开方式：/memory-ui 命令打印 URL（或直接访问 http://127.0.0.1:<端口>/hpptools-memory/）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS, migrationInfo } from './config.js'
import { safeRead, walkMarkdownFiles, parseMemoryEntries } from './utils.js'
import { getExtractorModel, getCleanerModel, setModel } from './models.js'
import { runEntries, activeRunCount } from './runs.js'
import { getLastMaintenance } from './memory-ops.js'
import { spawnCleanerSubagent } from './subagents.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = path.join(__dirname, 'webui.html')
const API_PREFIX = '/hpptools-memory'

// ---------------------------------------------------------------- helpers

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 统计一个记忆目录的文件数 / 条目数（## 条目）。 */
function fileStats(dir) {
  if (!fs.existsSync(dir)) return { files: 0, entries: 0 }
  const files = walkMarkdownFiles(dir)
  let entries = 0
  for (const f of files) {
    const content = safeRead(f)
    if (content) entries += parseMemoryEntries(content, path.basename(f)).length
  }
  return { files: files.length, entries }
}

/** 当前活动根 agent 的 cwd（UI 面板是根级，取第一个根会话）。 */
function firstAgentCwd(ctx) {
  try {
    const roots = ctx.get('agents')?.roots?.() ?? []
    return roots[0]?.session?.header?.cwd
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- data

/** 记忆概览数据（导出供测试/复用）。 */
export async function overviewData(ctx) {
  const cwd = firstAgentCwd(ctx)
  const projectDir = cwd ? PATHS.memoriesDir(cwd) : null
  return {
    root: PATHS.root,
    migrated: migrationInfo(),
    core: fs.existsSync(PATHS.corePrompt),
    rules: fs.existsSync(PATHS.rules),
    notebook: cwd ? fs.existsSync(PATHS.notebook(cwd)) : false,
    currentProject: cwd ? undefined : undefined,
    projectMem: projectDir ? fileStats(projectDir) : null,
    globalMem: fileStats(PATHS.personalDir),
    lastMaintenance: getLastMaintenance(),
    activeRuns: activeRunCount(),
    configured: { extractor: getExtractorModel(), cleaner: getCleanerModel() },
  }
}

/** 已配置模型列表（导出供测试/复用）。 */
export async function modelsData(ctx) {
  const providers = []
  const llm = ctx.get('llm')
  if (llm !== undefined) {
    try {
      for (const p of llm.listProviders()) {
        const models = []
        try {
          for (const m of await llm.listModels(p.id)) {
            models.push({ id: m.id, name: m.name ?? m.id })
          }
        } catch {
          /* 该 provider 不可列举（如需要网络）— 留空 */
        }
        providers.push({ id: p.id, name: p.name, models })
      }
    } catch {
      /* llm 服务异常 */
    }
  }
  return {
    configured: { extractor: getExtractorModel(), cleaner: getCleanerModel() },
    providers,
  }
}

// ---------------------------------------------------------------- routes

export function registerWebUi(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const servePage = (_req, res) => {
    try {
      const html = fs.readFileSync(PAGE_PATH, 'utf-8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(html)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('hpptools-memory: webui.html not found')
    }
  }

  // 注册必须走 ctx.effect：disposer 交给插件 fiber，stop/update 时自动释放路由
  const register = (route) => ctx.effect(() => webServer.register(route), `webui:${route.path}`)

  register({ kind: 'exact', path: API_PREFIX, handler: servePage })
  register({ kind: 'exact', path: `${API_PREFIX}/`, handler: servePage })

  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/overview`,
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await overviewData(ctx))
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/models`,
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await modelsData(ctx))
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/runs`,
    handler: (_req, res) => {
      try {
        sendJson(res, 200, { runs: runEntries(12) })
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/model`,
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (!body || (body.kind !== 'extractor' && body.kind !== 'cleaner')) {
          sendJson(res, 400, { error: 'body 需为 { kind: "extractor"|"cleaner", value: "provider/model"|"(default)" }' })
          return
        }
        sendJson(res, 200, setModel(body.kind, body.value))
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/clean`,
    handler: async (_req, res) => {
      try {
        const agent = (ctx.get('agents')?.roots?.() ?? [])[0]
        if (!agent) {
          sendJson(res, 400, { error: '没有活动会话，无法确定项目。请先在 DSH 中打开一个会话。' })
          return
        }
        const cwd = agent.session?.header?.cwd
        if (!cwd) {
          sendJson(res, 400, { error: '当前会话没有工作目录。' })
          return
        }
        const run = await spawnCleanerSubagent(ctx, agent, cwd)
        if (!run) {
          sendJson(res, 500, { error: '海马体子代理启动失败（agents/memory-cleaner.md 缺失或 spawn 错误）。' })
          return
        }
        sendJson(res, 200, { ok: true, runId: run.id })
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })
}

/** 控制台页面的可访问 URL（/memory-ui 命令用）。 */
export function webUiUrl(webServer) {
  return `http://127.0.0.1:${webServer.port}${API_PREFIX}/`
}
