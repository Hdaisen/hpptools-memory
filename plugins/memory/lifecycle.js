/**
 * 生命周期 — 对应 pi 的 hooks.ts。
 *
 * 事件映射：
 *   agent/session-start → 建立会话短期记忆目录（turns/sessions/<id>）+ 索引刷新
 *   agent/turn-stopping → 提取管线：写 raw-<n>.md + 追加 dialogue-summary.md，每 5 轮触发固化子代理
 *   agent/disposed      → 会话结束补固化（剩余未固化节数 ≥ 3）
 *   tools/post-execute  → read 失败 + 二进制文件 → MarkItDown 自动转换
 *
 * 守卫：子代理（origin === 'subagent' 或 delegationDepth > 0）不参与提取/建目录。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PATHS } from './config.js'
import { countSections, lastSections } from './utils.js'
import { runExtraction } from './extract.js'
import { ensureProjectDir, refreshIndex } from './memory-ops.js'
import { spawnConsolidationSubagent } from './subagents.js'
import { setSessionDir, getSessionDir, dropSessionDir } from './prompt.js'
import { isBinaryFile, convertWithMarkitdown } from './markitdown.js'

const CONSOLIDATE_EVERY = 5

/** 会话锚点：DSH session id 去前缀取末 12 位（同一逻辑会话复用同一目录）。 */
function sessionAnchor(sessionId) {
  if (!sessionId) return ''
  return String(sessionId)
    .replace(/^session-/, '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(-12)
}

/** 查找 cwd 下已存在的同锚点会话目录（进程重启 / resume 恢复用），取最新一个。 */
function findExistingSessionDir(cwd, anchor) {
  if (!anchor) return ''
  const sessionsDir = path.join(PATHS.projectDir(cwd), 'turns', 'sessions')
  if (!fs.existsSync(sessionsDir)) return ''
  const matches = fs
    .readdirSync(sessionsDir)
    .filter((d) => d.endsWith('-' + anchor))
    .sort()
  return matches.length > 0 ? path.join(sessionsDir, matches[matches.length - 1]) : ''
}

/** 创建（或复用）会话短期记忆目录。 */
function createSessionDir(cwd, sessionId) {
  const anchor = sessionAnchor(sessionId)
  const existing = findExistingSessionDir(cwd, anchor)
  if (existing) return existing
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const rand = Math.random().toString(36).slice(2, 6)
  const dir = path.join(
    PATHS.projectDir(cwd),
    'turns',
    'sessions',
    anchor ? `${ts}-${rand}-${anchor}` : `${ts}-${rand}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 子代理守卫（对应 pi 的 PI_SUBAGENT=1）。 */
function isSubagent(agent) {
  const header = agent?.session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/**
 * DSH session 事件 → pi 风格消息（提取管线输入）。
 * 容错转换：只取叶字段，坏事件跳过。toolCall 并入 assistant 消息
 * （extract_key_actions 依赖），tool/result → role: toolResult。
 */
export function convertSessionToMessages(session) {
  const messages = []
  const events = session?.events ?? []
  for (const ev of events) {
    try {
      switch (ev.type) {
        case 'user/message': {
          const data = ev.data ?? {}
          // 只取真实用户消息；跳过插件注入的 context（instructions/time 等）
          if (data.source?.kind === 'user' && Array.isArray(data.content)) {
            messages.push({ role: 'user', content: data.content })
          }
          break
        }
        case 'agent/message': {
          const data = ev.data ?? {}
          const content = data.message?.content ?? data.content
          if (content) messages.push({ role: 'assistant', content })
          break
        }
        case 'tool/call': {
          const data = ev.data ?? {}
          const call = data.message ?? data
          const toolName = call.toolName ?? data.toolName ?? call.name ?? 'unknown'
          const arguments_ = call.arguments ?? data.arguments ?? {}
          messages.push({
            role: 'assistant',
            content: [{ type: 'toolCall', name: toolName, arguments: arguments_ }],
          })
          break
        }
        case 'tool/result': {
          const data = ev.data ?? {}
          const msg = data.message ?? {}
          const first = Array.isArray(msg.content) ? msg.content[0] : undefined
          messages.push({
            role: 'toolResult',
            toolName: msg.source?.toolName ?? data.toolName ?? 'unknown',
            content: first?.content ?? msg.content ?? [],
            isError: first?.isError === true,
          })
          break
        }
        default:
          break
      }
    } catch {
      /* skip malformed event — never break the pipeline */
    }
  }
  return messages
}

export function registerLifecycle(ctx) {
  // ============================================================
  // agent/session-start — 会话目录锚点 + 索引刷新
  // ============================================================
  ctx.on('agent/session-start', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || isSubagent(agent)) return
      const cwd = agent.session?.header?.cwd
      if (!cwd) return
      ensureProjectDir(cwd)
      refreshIndex(cwd, 'project')
      refreshIndex(cwd, 'global')
      const dir = createSessionDir(cwd, agent.session.id)
      setSessionDir(agent.session.id, dir)
    } catch (e) {
      console.error('[memory] session-start:', e)
    }
  })

  // ============================================================
  // agent/turn-stopping — 提取管线（序列监听，写文件很快；固化异步）
  // ============================================================
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || isSubagent(agent)) return
      const cwd = agent.session?.header?.cwd
      if (!cwd) return
      ensureProjectDir(cwd)

      let sessionDir = getSessionDir(agent.session.id)
      if (!sessionDir) {
        sessionDir = createSessionDir(cwd, agent.session.id)
        setSessionDir(agent.session.id, sessionDir)
      }

      const messages = convertSessionToMessages(agent.session)
      const nonSystem = messages.filter(
        (m) => m.role !== 'system' && m.role !== 'developer',
      )
      if (nonSystem.length < 2) return

      const result = runExtraction(messages, sessionDir)
      if (result.isConsolidation) {
        // 不阻塞回合关闭：延后到下一事件循环再启动固化子代理
        ctx.timeout(() => {
          void spawnConsolidationSubagent(ctx, agent, sessionDir)
        }, 0)
      }
    } catch (e) {
      console.error('[memory] extraction failed:', e)
    }
  })

  // ============================================================
  // agent/disposed — 会话结束补固化（余数 ≥ 3 才跑）
  // ============================================================
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    try {
      if (!agent || isSubagent(agent)) return
      const sessionDir = getSessionDir(sessionId)
      if (!sessionDir) return
      const summaryFile = path.join(sessionDir, 'dialogue-summary.md')
      const summary = fs.readFileSync(summaryFile, 'utf-8')
      const remainder = countSections(summary) % CONSOLIDATE_EVERY
      if (remainder >= 3) {
        fs.writeFileSync(
          path.join(sessionDir, 'consolidation-input.md'),
          lastSections(summary, remainder),
          'utf-8',
        )
        ctx.timeout(() => {
          void spawnConsolidationSubagent(ctx, agent, sessionDir).catch(() => {})
        }, 0)
      }
    } catch {
      /* non-fatal — 绝不阻塞会话结束 */
    } finally {
      dropSessionDir(sessionId)
    }
  })

  // ============================================================
  // tools/post-execute — read 失败且是二进制 → MarkItDown 自动转换
  // ============================================================
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (exec.name !== 'read' || !result.isError) return decision
    try {
      const filePath = exec.arguments?.path
      if (typeof filePath === 'string' && isBinaryFile(filePath)) {
        const md = convertWithMarkitdown(filePath)
        if (md !== null) {
          return { kind: 'accept', content: [{ type: 'text', text: md }] }
        }
      }
    } catch {
      /* 保持原始结果 */
    }
    return decision
  })
}
