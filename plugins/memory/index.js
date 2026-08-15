/**
 * hpptools-memory — Pi Memory System for DeepSeek Harness
 *
 * 三层 Markdown 记忆系统（从 pi-memory-system 迁移）：
 * - Core Prompt（core-prompt.md + rules.md + Memory Index）→ 每轮注入 system prompt
 * - Session Notebook（projects/<name>/notebook.md）→ 主 LLM 独家维护
 * - Long-term Memory（projects/<name>/memories/ + personal/）→ 固化子代理写入
 *
 * 存储：默认 <DSH_HOME>/memory（社区版规范化路径，不再借用 Pi 的 ~/.pi/agent/memory），
 * 可通过组合行 config.root 覆盖。首次启动自动把 ~/.pi/agent/memory 复制过来（非破坏）。
 *
 * 生命周期映射：
 *   pi before_agent_start  → systemPrompt.section（memory:core / memory:context）
 *   pi agent_end           → agent/turn-stopping（写 raw + dialogue-summary，每 5 轮固化）
 *   pi session_start       → agent/session-start（会话短期记忆目录锚点）
 *   pi session_shutdown    → agent/disposed（余数 ≥ 3 补固化）
 *   pi tool_result         → tools/post-execute（二进制 read 失败自动 MarkItDown）
 *   pi registerTool        → ctx.tools.register(defineTool(...))
 *   pi registerCommand     → ctx.commands.register(...)
 *
 * 可视化：webServer 同源路由 /hpptools-memory/（概览 / 模型配置 / 子代理运行状态），
 * 见 webui.js + webui.html。入口：/memory-ui 命令。
 */
import { configureMemory, detectLegacyMemory } from './config.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { registerLifecycle } from './lifecycle.js'
import { registerPromptSections } from './prompt.js'
import { registerRunEvents } from './runs.js'
import { registerWebUi } from './webui.js'

export const name = 'hpptools-memory'

export const inject = [
  'systemPrompt',
  'tools',
  'commands',
  'subagents',
  'userQuestions',
  'timer',
  'webServer',
]

export function apply(ctx, config = {}) {
  configureMemory(config)
  // 只检测不迁移：检测到旧 Pi 记忆时，由用户在可视化控制台（/memory-ui）手动触发迁移
  detectLegacyMemory()
  registerRunEvents(ctx)
  registerTools(ctx)
  registerCommands(ctx)
  registerLifecycle(ctx)
  registerPromptSections(ctx)
  registerWebUi(ctx)
}
