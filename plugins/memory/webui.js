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
 *   POST /hpptools-memory/api/migrate    → 手动触发 Pi 记忆迁移（检测到才可迁）
 *   GET  /hpptools-memory/api/files      → 文件树（核心文件/全局记忆/项目记忆/小本本）
 *   GET  /hpptools-memory/api/file?path= → 读取 root 内一个文件（path 为相对 root 的路径）
 *   POST /hpptools-memory/api/file       → 保存 root 内一个文件 { path, content }
 *   POST /hpptools-memory/api/settings   → 保存 UI 设置 { root?, copyData? }（重启生效）
 *
 * 打开方式：/memory-ui 命令打印 URL（或直接访问 http://127.0.0.1:<端口>/hpptools-memory/）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS, HOME, migrationInfo, detectLegacyMemory, migrateFromPi, getSettings, saveSettings, copyDir, getProjectName } from './config.js'
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

/** 统计一个记忆目录的文件数 / 条目数（## 条目）。skills 技能库单独统计。 */
function fileStats(dir) {
  const stats = { files: 0, entries: 0, skillFiles: 0 }
  if (!fs.existsSync(dir)) return stats
  const files = walkMarkdownFiles(dir) // walkMarkdownFiles 已排除 skills 目录
  for (const f of files) {
    const content = safeRead(f)
    if (content) stats.entries += parseMemoryEntries(content, path.basename(f)).length
  }
  stats.files = files.length
  // 技能库单独计数（不混入"记忆条目"口径）
  const skillsDir = path.join(dir, 'skills')
  if (fs.existsSync(skillsDir)) {
    const skills = walkMarkdownFiles(skillsDir)
    stats.skillFiles = skills.filter((f) => f.endsWith('SKILL.md')).length || skills.length
  }
  return stats
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

/**
 * 把前端传来的相对路径安全解析到 root 内（防路径穿越）。
 * @param {string} rel 相对 PATHS.root 的路径（正斜杠）。
 * @returns 绝对路径或 null。
 */
function safeResolve(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null
  const target = path.resolve(PATHS.root, rel)
  if (target !== PATHS.root && !target.startsWith(PATHS.root + path.sep)) return null
  return target
}

/** 一个文件的基本信息（供文件树）。 */
function fileInfo(fullPath) {
  try {
    const st = fs.statSync(fullPath)
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() }
  } catch {
    return { exists: false }
  }
}

/** 列出目录下所有 .md 文件 → 相对 root 的 rel 列表（排除 skills 技能库与 _index.md）。 */
function listMdRel(dir) {
  if (!fs.existsSync(dir)) return []
  return walkMarkdownFiles(dir)
    .map((f) => path.relative(PATHS.root, f).replace(/\\/g, '/'))
    .sort()
}

// ---------------------------------------------------------------- data

/** 列出 root 下所有项目（projects/ 的子目录，排除隐藏目录如 .obsidian）。 */
function projectList() {
  if (!fs.existsSync(PATHS.projectsRoot)) return []
  return fs.readdirSync(PATHS.projectsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/** 记忆概览数据（导出供测试/复用）。 */
export async function overviewData(ctx) {
  const cwd = firstAgentCwd(ctx)
  const projects = projectList()
  // 汇总所有项目的记忆（不再只统计当前会话项目）
  let totalFiles = 0
  let totalEntries = 0
  let skillFiles = 0
  for (const name of projects) {
    const s = fileStats(path.join(PATHS.projectsRoot, name, 'memories'))
    totalFiles += s.files
    totalEntries += s.entries
    skillFiles += s.skillFiles
  }
  const currentProject = cwd ? getProjectName(cwd) : null
  const migrated = migrationInfo()
  return {
    root: PATHS.root,
    settings: getSettings(),
    migrated,
    // 检测到 Pi 旧记忆且尚未迁移 → 提示用户手动迁移（只检测，不自动迁移）
    legacy: !migrated ? detectLegacyMemory() : null,
    core: fs.existsSync(PATHS.corePrompt),
    rules: fs.existsSync(PATHS.rules),
    notebook: cwd ? fs.existsSync(PATHS.notebook(cwd)) : false,
    projects: projects.map((name) => ({
      name,
      current: name === currentProject,
      ...fileStats(path.join(PATHS.projectsRoot, name, 'memories')),
    })),
    projectSummary: { count: projects.length, files: totalFiles, entries: totalEntries, skillFiles },
    currentProject,
    globalMem: fileStats(PATHS.personalDir),
    lastMaintenance: getLastMaintenance(),
    activeRuns: activeRunCount(),
    configured: { extractor: getExtractorModel(), cleaner: getCleanerModel() },
  }
}

/** 文件树：核心文件 / 会话小本本 / 全局记忆 / 所有项目记忆。 */
export function filesData(ctx) {
  const cwd = firstAgentCwd(ctx)
  const groups = []

  const coreFiles = ['core-prompt.md', 'rules.md', 'subagent-model.txt']
  groups.push({
    id: 'core',
    label: '核心文件',
    files: coreFiles.map((name) => {
      const full = path.join(PATHS.root, name)
      const content = safeRead(full)
      return {
        rel: name,
        name,
        ...fileInfo(full),
        entries: content ? parseMemoryEntries(content, name).length : 0,
      }
    }),
  })

  if (cwd) {
    const nbFull = PATHS.notebook(cwd)
    groups.push({
      id: 'notebook',
      label: '会话小本本（当前项目）',
      files: [{
        rel: path.relative(PATHS.root, nbFull).replace(/\\/g, '/'),
        name: 'notebook.md',
        ...fileInfo(nbFull),
        entries: 0,
      }],
    })
  }

  groups.push({
    id: 'personal',
    label: '全局记忆 · personal/',
    files: listMdRel(PATHS.personalDir).map((rel) => ({
      rel,
      name: rel.startsWith('personal/') ? rel.slice('personal/'.length) : rel,
      ...fileInfo(path.join(PATHS.root, rel)),
      entries: parseMemoryEntries(safeRead(path.join(PATHS.root, rel)) ?? '', rel).length,
    })),
  })

  // 所有项目的记忆（当前项目排在前面并标注）
  const currentProject = cwd ? getProjectName(cwd) : null
  const projects = projectList().sort((a, b) => {
    if (a === currentProject) return -1
    if (b === currentProject) return 1
    return a.localeCompare(b)
  })
  for (const name of projects) {
    const dir = path.join(PATHS.projectsRoot, name, 'memories')
    groups.push({
      id: 'project:' + name,
      label: `项目记忆 · ${name}${name === currentProject ? '（当前）' : ''}`,
      files: listMdRel(dir).map((rel) => ({
        rel,
        name: rel.replace(`projects/${name}/memories/`, ''),
        ...fileInfo(path.join(PATHS.root, rel)),
        entries: parseMemoryEntries(safeRead(path.join(PATHS.root, rel)) ?? '', rel).length,
      })),
    })
  }

  return { currentProject, groups }
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

  // 在系统文件管理器中打开目录（Obsidian 打开文件夹的 URI 不受支持，改用资源管理器；
  // 用户可把该目录添加为 Obsidian vault 后在 Obsidian 中浏览）
  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/open-folder`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://x')
        const rel = url.searchParams.get('path') ?? ''
        const full = safeResolve(rel)
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
          sendJson(res, 400, { error: 'path 必须解析到记忆存储目录内的一个文件夹。' })
          return
        }
        const { spawn } = await import('node:child_process')
        const platform = process.platform
        if (platform === 'win32') {
          spawn('explorer.exe', [full], { detached: true, stdio: 'ignore' }).unref()
        } else if (platform === 'darwin') {
          spawn('open', [full], { detached: true, stdio: 'ignore' }).unref()
        } else {
          spawn('xdg-open', [full], { detached: true, stdio: 'ignore' }).unref()
        }
        sendJson(res, 200, { ok: true, path: full })
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // 手动迁移：仅当检测到 Pi 旧记忆且未迁移时可执行
  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/migrate`,
    handler: async (_req, res) => {
      try {
        const result = migrateFromPi()
        if (result && result.error) {
          sendJson(res, 400, result)
          return
        }
        sendJson(res, 200, result)
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // 文件树
  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/files`,
    handler: (_req, res) => {
      try {
        sendJson(res, 200, filesData(ctx))
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // 读取/保存文件（path 为相对 root 的路径）。GET 读，POST 写。
  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/file`,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '', 'http://x')
          const rel = url.searchParams.get('path') ?? ''
          const full = safeResolve(rel)
          if (!full) {
            sendJson(res, 400, { error: 'path 必须解析到记忆存储目录内。' })
            return
          }
          const content = safeRead(full)
          if (content === null) {
            sendJson(res, 404, { error: `文件不存在：${rel}` })
            return
          }
          sendJson(res, 200, { path: rel, content })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
            sendJson(res, 400, { error: 'body 需为 { path, content }' })
            return
          }
          const full = safeResolve(body.path)
          if (!full) {
            sendJson(res, 400, { error: 'path 必须解析到记忆存储目录内。' })
            return
          }
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.writeFileSync(full, body.content, 'utf-8')
          sendJson(res, 200, { ok: true, path: body.path })
          return
        }
        sendJson(res, 405, { error: '仅支持 GET（读）与 POST（写）。' })
      } catch (e) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // 保存 UI 设置（root 修改重启生效；copyData 可选：把现有数据复制到新路径）
  register({
    kind: 'exact',
    path: `${API_PREFIX}/api/settings`,
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { error: 'body 需为 JSON 对象' })
          return
        }
        if (body.root === undefined) {
          sendJson(res, 200, { saved: false, settings: getSettings(), root: PATHS.root })
          return
        }
        if (typeof body.root !== 'string' || !body.root.trim()) {
          sendJson(res, 400, { error: 'root 必须是非空字符串' })
          return
        }
        let newRoot = body.root.trim()
        if (newRoot === '~' || newRoot.startsWith('~/') || newRoot.startsWith('~\\')) {
          newRoot = path.join(HOME, newRoot.slice(1))
        }
        newRoot = path.resolve(newRoot)
        if (fs.existsSync(newRoot) && !fs.statSync(newRoot).isDirectory()) {
          sendJson(res, 400, { error: '目标路径已存在且不是目录。' })
          return
        }
        let copied = 0
        if (body.copyData === true && fs.existsSync(PATHS.root) && PATHS.root !== newRoot) {
          copyDir(PATHS.root, newRoot)
          copied = fs.readdirSync(newRoot).length
        }
        saveSettings({ root: newRoot })
        sendJson(res, 200, { saved: true, root: newRoot, copied, restart: true })
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
