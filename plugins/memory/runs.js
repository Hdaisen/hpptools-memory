/**
 * 运行中的记忆子代理登记（可视化用）。
 *
 * - trackRun：spawn 成功后登记（status: 'running'）
 * - session/event 监听：子代理的 tool 调用 / 回复文本 → 内存日志尾部（"正在干嘛"）
 * - subagent/end：终态 + 最终报告写入日志尾部
 *
 * 日志只在内存中保留（UI 轮询消费）；最终报告同时由调用方落盘（consolidation-*.log / clean-*.log）。
 */
const runs = new Map() // childSessionId -> RunEntry

/**
 * @typedef {Object} RunEntry
 * @property {string} id     子代理 session id
 * @property {string} kind   'extractor' | 'cleaner'
 * @property {string} label  展示名
 * @property {string} status 'running' | 'done' | 'failed' | 'error' | 'cancelled' | 'timeout'
 * @property {string} startedAt ISO
 * @property {string=} endedAt ISO
 * @property {string=} stopReason
 * @property {string=} logPath 最终报告落盘路径
 * @property {string[]} log  活动日志尾部（≤60 行）
 */

export function trackRun(id, kind, label, logPath) {
  const entry = {
    id,
    kind,
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
    log: [],
    ...(logPath ? { logPath } : {}),
  }
  runs.set(id, entry)
  appendLog(entry, '▶ 子代理已启动')
  return entry
}

export function updateRun(id, patch) {
  const entry = runs.get(id)
  if (!entry) return
  Object.assign(entry, patch)
}

function appendLog(entry, line) {
  if (!line) return
  entry.log.push(`[${new Date().toTimeString().slice(0, 8)}] ${line}`)
  if (entry.log.length > 60) entry.log.splice(0, entry.log.length - 60)
}

/** 最近 N 条运行记录（新的在前），带活动日志。 */
export function runEntries(limit = 10) {
  return [...runs.values()]
    .sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1))
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      status: e.status,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      stopReason: e.stopReason,
      logPath: e.logPath,
      log: e.log,
    }))
}

/** 活动（未结束）的运行数。 */
export function activeRunCount() {
  let n = 0
  for (const e of runs.values()) if (e.status === 'running') n++
  return n
}

function lineForEvent(event) {
  try {
    const data = event.data ?? {}
    switch (event.type) {
      case 'tool/call': {
        const call = data.message ?? data
        const name = call.toolName ?? data.toolName ?? call.name ?? 'tool'
        const target = call.arguments?.path ?? call.arguments?.file_path ?? call.arguments?.file ?? ''
        return `🔧 ${name}${target ? ' ' + target : ''}`
      }
      case 'agent/message': {
        const content = data.message?.content ?? data.content
        const text = Array.isArray(content)
          ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim()
          : ''
        return text ? `💬 ${text.slice(0, 140)}` : null
      }
      case 'user/message':
        return '📥 收到任务输入'
      case 'tool/result':
        return '📦 工具完成'
      default:
        return null
    }
  } catch {
    return null
  }
}

/** 注册 subagent/end 与 session/event 监听（插件 apply 时调用一次）。 */
export function registerRunEvents(ctx) {
  ctx.on('subagent/end', (info) => {
    const entry = runs.get(info.id)
    if (!entry) return
    const status = info.stopReason === 'success' ? 'done' : info.stopReason
    entry.status = status
    entry.endedAt = new Date().toISOString()
    entry.stopReason = info.stopReason
    if (info.lastAssistantMessage) {
      const text = Array.isArray(info.lastAssistantMessage)
        ? info.lastAssistantMessage.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
        : ''
      if (text) appendLog(entry, `🏁 ${text.slice(0, 300)}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    const entry = session?.id ? runs.get(session.id) : undefined
    if (!entry || entry.status !== 'running') return
    appendLog(entry, lineForEvent(event))
  })
}
