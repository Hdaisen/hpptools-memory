/**
 * 提示词注入 — 对应 pi 的 before_agent_start hook。
 *
 * 策略：稳定优先（DeepSeek 前缀缓存友好）——
 * - memory:core（order -90）：core-prompt.md + rules.md + Memory Index（稳定/追加式）
 * - memory:context（order 65）：notebook + 最近 5 轮对话摘要 + 关联记忆 + 维护日志（动态）
 *
 * 与 pi 的差异：section provider 拿不到当前用户 prompt，
 * 因此"按 prompt 自动搜索相关记忆"不注入（用 recall 工具代替）；
 * notebook [[wiki-links]] 的关联记忆仍然注入。
 */
import * as path from 'node:path'
import { PATHS } from './config.js'
import {
  safeRead,
  lastSections,
  readMemoryIndex,
  extractLinks,
  readLinkedContent,
} from './utils.js'
import { maintenanceSection } from './memory-ops.js'

const SUMMARY_WINDOW = 5

/** sessionId → 会话短期记忆目录（turns/sessions/<id>），由 lifecycle 维护。 */
const sessionDirs = new Map()

export function setSessionDir(sessionId, dir) {
  if (sessionId) sessionDirs.set(sessionId, dir)
}

export function getSessionDir(sessionId) {
  return sessionId ? sessionDirs.get(sessionId) : undefined
}

export function dropSessionDir(sessionId) {
  if (sessionId) sessionDirs.delete(sessionId)
}

/** 稳定段：core-prompt + rules + memory index。 */
export function buildCoreSection(cwd) {
  const corePrompt = safeRead(PATHS.corePrompt)
  const coreSection =
    corePrompt || '# Core Prompt\n（Not initialized — create core-prompt.md or run the setup script）\n'
  const rules = safeRead(PATHS.rules)
  const indexContent = readMemoryIndex(cwd)

  let out = `${coreSection.trim()}\n`
  if (rules) out += `\n${rules.trim()}\n`
  out += `\n---\n\n## Memory Index\n${indexContent || '（暂无记忆条目）'}\n`
  return out
}

/** 动态段：notebook + 最近对话摘要（滑动窗口）+ 关联记忆 + 维护日志。 */
export function buildContextSection(cwd, sessionId) {
  const notebookContent = safeRead(PATHS.notebook(cwd))
  const notebookSection = notebookContent || '# Session Notebook\n（Not initialized）\n'

  // 会话隔离：优先当前会话目录；兼容旧布局回退 turns/（单会话）
  const sessionDir = getSessionDir(sessionId)
  const legacyTurns = PATHS.turnsDir(cwd)
  const dialogueSummary =
    (sessionDir ? safeRead(path.join(sessionDir, 'dialogue-summary.md')) : null) ||
    safeRead(path.join(legacyTurns, 'dialogue-summary.md'))
  const summaryContent = dialogueSummary
    ? lastSections(dialogueSummary, SUMMARY_WINDOW)
    : safeRead(path.join(legacyTurns, 'turn-summary.md'))

  // notebook [[wiki-links]] → 关联记忆
  let linkedSection = ''
  if (notebookContent) {
    const links = extractLinks(notebookContent)
    if (links.length > 0) {
      const linkedContent = readLinkedContent(links, cwd, [])
      if (linkedContent.length > 0) {
        linkedSection = '\n\n---\n\n## Related Memories\n' + linkedContent.join('\n\n')
      }
    }
  }

  let out = `## Session Notebook\n\n${notebookSection.trim()}\n`
  if (summaryContent) {
    out += `\n\n---\n\n## 最近对话摘要\n\n${summaryContent.trim()}\n`
  }
  out += linkedSection
  out += maintenanceSection()
  return out
}

/** 注册两个提示段。AssembleContext 运行时带 agent（由 dsh-agent 注入）。 */
export function registerPromptSections(ctx) {
  ctx.systemPrompt.section({
    name: 'memory:core',
    order: -90,
    text: (ac) => {
      const cwd = ac.agent?.session?.header?.cwd
      if (!cwd) return ''
      return buildCoreSection(cwd)
    },
  })

  ctx.systemPrompt.section({
    name: 'memory:context',
    order: 65,
    text: (ac) => {
      const agent = ac.agent
      const cwd = agent?.session?.header?.cwd
      if (!cwd) return ''
      return buildContextSection(cwd, agent.session.id)
    },
  })
}
