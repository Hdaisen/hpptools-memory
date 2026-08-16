/**
 * 固化 / 海马体子代理启动 — 对应 pi 的 spawnConsolidationSubagent / runMemoryMaintenance。
 *
 * 用 DSH 的 ctx.subagents.start('fork', ...) 在进程内启动 one-shot 子代理，
 * 通过 toolFilter 限制其工具集（只读/写 + 记忆工具，禁止 shell）。
 * 子代理提示词来自 agents/*.md（随插件包分发，可独立编辑）。
 *
 * 模型：固化/海马体分开配置（models.json，见 models.js），UI 可视化可选。
 * 进度：runs.js 通过 session/event 观察子代理活动（UI 轮询显示"正在干嘛"）；
 *       终态最终报告写入日志文件（consolidation-*.log / clean-*.log）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS, getProjectName } from './config.js'
import { lastSections } from './utils.js'
import { getExtractorModel, getCleanerModel, modelAgentOptions } from './models.js'
import { trackRun, updateRun } from './runs.js'
import { buildNetworkHealthReport, updateMaintenanceRecords } from './memory-ops.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// agents/*.md 提示词目录：优先包内 agents/（复制式安装时随包分发）；
// 回退源码仓库布局 ../../agents（项目根）。安装副本缺 agents/ 时固化子代理会静默失败。
const AGENTS_DIR = (() => {
  const inPkg = path.resolve(__dirname, 'agents')
  if (fs.existsSync(inPkg)) return inPkg
  return path.resolve(__dirname, '..', '..', 'agents')
})()

/** 固化/海马体子代理允许的工具集（对应 pi 的 --tools read,write,edit,remember,recall,forget,supersede）。 */
const MEMORY_TOOLS = ['read', 'write', 'edit', 'remember', 'recall', 'forget', 'supersede']

/** 读取 agents/<name>.md 提示词。 */
export function subagentPromptFromFile(name) {
  try {
    return fs.readFileSync(path.join(AGENTS_DIR, name), 'utf-8')
  } catch {
    return ''
  }
}

function tsForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** 终态时把最终报告写入日志文件（持久化，UI 之外可追溯）。 */
function persistFinalReport(logPath, stopReason, lastAssistantMessage) {
  if (!logPath) return
  try {
    const text = Array.isArray(lastAssistantMessage)
      ? lastAssistantMessage.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
      : ''
    fs.appendFileSync(
      logPath,
      `\n---\n[${new Date().toISOString()}] ${stopReason === 'success' ? '✅ 完成' : `❌ ${stopReason}`}\n${text}\n`,
      'utf-8',
    )
  } catch {
    /* non-fatal */
  }
}

/**
 * 固化子代理：读 consolidation-input.md（增量窗口），沉淀长期记忆。
 * 返回 SubagentRun（或 null）。失败不抛 — 后台任务不阻塞主流程。
 */
export async function spawnConsolidationSubagent(ctx, parent, sessionDir) {
  const extractorPrompt = subagentPromptFromFile('memory-extractor.md')
  if (!extractorPrompt) return null

  // 增量输入：只喂本次固化窗口的最后 5 节（成本不随总轮次增长）
  const summaryFile = path.join(sessionDir, 'dialogue-summary.md')
  const inputFile = path.join(sessionDir, 'consolidation-input.md')
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf-8') : ''
  if (!summary.trim()) return null
  fs.writeFileSync(inputFile, lastSections(summary, 5), 'utf-8')

  const projectName = path.basename(path.dirname(path.dirname(path.dirname(sessionDir))))
  const model = getExtractorModel()
  const ts = tsForFilename()
  const logPath = path.join(sessionDir, `consolidation-${ts}.log`)
  fs.writeFileSync(logPath, `# Consolidation — ${new Date().toISOString()}\ncwd: ${sessionDir}\nmodel: ${model}\n\n`, 'utf-8')

  const promptText =
    `${extractorPrompt}\n\n---\n\n` +
    `当前任务：执行记忆固化。你的当前工作目录（cwd）是记忆会话目录：\n` +
    `- 读 consolidation-input.md（本次窗口的对话摘要，含关键动作行）\n` +
    `- 需要细节时 read raw-<n>.md 回查；写每条记忆前先对账（recall 当前主题，有则 supersede/merge，没有才新增）\n` +
    `- 只沉淀长期记忆（remember）。不写 notebook（主 LLM 独家维护），不清理记忆文件（海马体的活）\n` +
    `cwd: ${sessionDir}`

  try {
    const run = await ctx.subagents.start('fork', {
      label: `memory-extractor (${projectName})`,
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal: new AbortController().signal,
      toolFilter: { allow: MEMORY_TOOLS },
      agentOptions: modelAgentOptions(model),
    })
    trackRun(run.id, 'extractor', `固化子代理 (${projectName})`, logPath)
    run.result.then(
      (res) => {
        updateRun(run.id, { status: res.stopReason === 'success' ? 'done' : res.stopReason, stopReason: res.stopReason })
        persistFinalReport(logPath, res.stopReason, res.output)
      },
      () => updateRun(run.id, { status: 'error' }),
    )
    return run
  } catch (e) {
    console.error('[memory] consolidation spawn failed:', e)
    return null
  }
}

/**
 * 海马体（记忆整理）子代理：合并重复、修复污染、supersede 过期、补链、报告。
 * 手动 /memory-clean 触发（或 UI 按钮）。返回 SubagentRun（或 null）。
 */
export async function spawnCleanerSubagent(ctx, parent, cwd) {
  const cleanerPrompt = subagentPromptFromFile('memory-cleaner.md')
  if (!cleanerPrompt) return null

  // 网络健康报告（机械统计由代码算，子代理据此补链/报告）
  const networkHealthPath = path.join(PATHS.maintenanceDir, 'network-health.md')
  try {
    fs.mkdirSync(PATHS.maintenanceDir, { recursive: true })
    fs.writeFileSync(networkHealthPath, buildNetworkHealthReport(cwd), 'utf-8')
  } catch {
    /* best effort */
  }

  const projectName = getProjectName(cwd)
  const model = getCleanerModel()
  const ts = tsForFilename()
  const logPath = path.join(PATHS.maintenanceDir, `clean-${ts}.log`)
  fs.writeFileSync(logPath, `# Memory cleaner — ${new Date().toISOString()}\ncwd: ${cwd}\nmodel: ${model}\n\n`, 'utf-8')

  const promptText =
    `${cleanerPrompt}\n\n---\n\n` +
    `当前任务：记忆维护（海马体整理）。项目：${projectName}（记忆在 ${PATHS.projectDir(cwd)}）\n` +
    (fs.existsSync(networkHealthPath)
      ? `先 read ${networkHealthPath} 了解记忆网络健康（孤立条目/枢纽节点），据此为孤立条目补 Related 链接（明确相关才补）或报告。\n`
      : '') +
    `不碰 notebook.md（主 LLM 独家维护），不碰 turns/ 短期记忆。最后输出清理报告。`

  try {
    const run = await ctx.subagents.start('fork', {
      label: `memory-cleaner (${projectName})`,
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal: new AbortController().signal,
      toolFilter: { allow: MEMORY_TOOLS },
      agentOptions: modelAgentOptions(model),
    })
    trackRun(run.id, 'cleaner', `海马体整理 (${projectName})`, logPath)
    updateMaintenanceRecords(logPath, projectName)
    run.result.then(
      (res) => {
        updateRun(run.id, { status: res.stopReason === 'success' ? 'done' : res.stopReason, stopReason: res.stopReason })
        persistFinalReport(logPath, res.stopReason, res.output)
      },
      () => updateRun(run.id, { status: 'error' }),
    )
    return run
  } catch (e) {
    console.error('[memory] cleaner spawn failed:', e)
    return null
  }
}
