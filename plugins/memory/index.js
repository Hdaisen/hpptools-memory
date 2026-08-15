/**
 * hpptools-memory — Pi Memory System for DeepSeek Harness
 *
 * 三层 Markdown 记忆系统（从 pi-memory-system 迁移）：
 * - Core Prompt（core-prompt.md + rules.md + Memory Index）→ 每轮注入 system prompt
 * - Session Notebook（projects/<name>/notebook.md）→ 主 LLM 独家维护
 * - Long-term Memory（projects/<name>/memories/ + personal/）→ 固化子代理写入
 *
 * 默认复用 ~/.pi/agent/memory 存储（与 Pi Coding Agent 共享记忆数据），
 * 可通过组合行 config.root 覆盖。
 *
 * 生命周期映射：
 *   pi before_agent_start  → systemPrompt.section（memory:core / memory:context）
 *   pi agent_end           → agent/turn-stopping（写 raw + dialogue-summary，每 5 轮固化）
 *   pi session_start       → agent/session-start（会话短期记忆目录锚点）
 *   pi session_shutdown    → agent/disposed（余数 ≥ 3 补固化）
 *   pi tool_result         → tools/post-execute（二进制 read 失败自动 MarkItDown）
 *   pi registerTool        → ctx.tools.register(defineTool(...))
 *   pi registerCommand     → ctx.commands.register(...)
 */
import { configureMemory } from './config.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { registerLifecycle } from './lifecycle.js'
import { registerPromptSections } from './prompt.js'

export const name = 'hpptools-memory'

export const inject = ['systemPrompt', 'tools', 'commands', 'subagents', 'userQuestions', 'timer']

export function apply(ctx, config = {}) {
  configureMemory(config)
  registerTools(ctx)
  registerCommands(ctx)
  registerLifecycle(ctx)
  registerPromptSections(ctx)
}
