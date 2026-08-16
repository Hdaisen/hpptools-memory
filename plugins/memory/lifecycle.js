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
 * DSH session 事件 → extract 管线消息（增量提取）。
 *
 * 与 pi 的差异（根因修复）：pi 的 agent_end 自带本轮 `messages`，DSH 的
 * `agent/turn-stopping` 只有累积的 `session`。这里用**增量 seq**（记录每会话
 * 已转换到的最大 event seq）只提取本轮新增事件，转为 extract 期望的消息格式：
 *   - `user/message`（source.kind==='user'）→ role 'user'
 *   - `assistant/message`（DSH 事件名！旧代码误用 pi 的 'agent/message'）→
 *     role 'assistant'，块映射：text / reasoning→thinking / tool-call→toolCall
 *   - `tool/result` → role 'toolResult'（toolName 由 assistant 的 tool-call
 *     callId→name 关联取回）
 * `tool/call` 是 trace 事件不再单独产出（assistant/message 已含 tool-call 块）。
 *
 * DSH 消息契约（packages/llm/llm/src/message.ts, types.ts）:
 *   - Message.role ∈ 'system'|'user'|'assistant'；tool result 也是 'user'
 *     （靠 source.kind==='tool' 区分）
 *   - ContentBlock.type ∈ 'text'|'reasoning'|'image'|'tool-call'|'tool-result'
 *   - ToolCallBlock.arguments 是 JSON 字符串；toolName 靠 callId 关联
 */
export function convertSessionToMessages(session, sessionId) {
  const messages = []
  const events = session?.events ?? []
  const lastSeq = sessionId ? extractedUpTo.get(sessionId) ?? -1 : -1
  if (typeof lastSeq !== 'number' || lastSeq < -1) return messages

  const callNames = new Map() // callId → toolName（本轮 assistant tool-call 登记）
  let maxSeq = lastSeq
  for (const ev of events) {
    if (typeof ev?.seq !== 'number' || ev.seq <= lastSeq) continue
    if (ev.seq > maxSeq) maxSeq = ev.seq
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
        case 'assistant/message': {
          const data = ev.data ?? {}
          const msg = data.message ?? {}
          const content = Array.isArray(msg.content) ? msg.content : []
          const mapped = []
          for (const b of content) {
            if (!b || typeof b !== 'object') continue
            switch (b.type) {
              case 'text':
                mapped.push({ type: 'text', text: b.text ?? '' })
                break
              case 'reasoning':
                // extract 对 thinking 块做工作记忆过滤 → 映射为 thinking
                mapped.push({ type: 'thinking', thinking: b.text ?? '' })
                break
              case 'tool-call': {
                mapped.push({ type: 'toolCall', name: b.name ?? '', arguments: parseToolArguments(b.arguments) })
                if (b.id) callNames.set(b.id, b.name)
                break
              }
              case 'image':
                mapped.push({ type: 'image', mimeType: b.attachment?.mimeType })
                break
              default:
                break
            }
          }
          if (mapped.length > 0) messages.push({ role: 'assistant', content: mapped })
          break
        }
        case 'tool/result': {
          const data = ev.data ?? {}
          const msg = data.message ?? {}
          const content = Array.isArray(msg.content) ? msg.content : []
          const block = content.find((b) => b && b.type === 'tool-result') ?? content[0]
          const callId = block?.toolCallId ?? msg.source?.callId
          const toolName =
            (callId && callNames.get(callId)) ||
            msg.source?.toolName ||
            data.toolName ||
            'unknown'
          messages.push({
            role: 'toolResult',
            toolName,
            content: Array.isArray(block?.content) ? block.content : content,
            isError: block?.isError === true,
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
  if (sessionId && maxSeq > lastSeq) extractedUpTo.set(sessionId, maxSeq)
  return messages
}

/** DSH 的 ToolCallBlock.arguments 是 JSON 字符串 → 解析为对象（供 extract_key_actions 用 path）；失败保留原串。 */
function parseToolArguments(raw) {
  if (typeof raw !== 'string') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : raw
  } catch {
    return raw
  }
}

/** 增量提取水位：sessionId → 已转换到的最大 event seq（进程内）。 */
const extractedUpTo = new Map()

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

      const sessionId = agent.session?.id
      const messages = convertSessionToMessages(agent.session, sessionId)
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
