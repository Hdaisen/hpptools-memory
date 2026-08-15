/**
 * 命令 — 对应 pi 的 commands.ts。
 *   /memory-clean            手动触发海马体整理子代理
 *   /memory-subagent-model   设置固化/海马体子代理的模型（provider/model 或 (default)）——命令形式；
 *                             推荐用可视化控制台（/memory-ui）下拉选择
 *   /memory-ui               打印记忆可视化控制台的 URL
 */
import * as path from 'node:path'
import { PATHS } from './config.js'
import { getExtractorModel, getCleanerModel, setModel } from './models.js'
import { spawnCleanerSubagent } from './subagents.js'
import { webUiUrl } from './webui.js'

export function registerCommands(ctx) {
  ctx.commands.register({
    name: 'memory-clean',
    description:
      'Run the memory cleaner subagent (hippocampus) — dedupe, fix pollution, supersede stale entries, report dead links',
    handler: async (inv) => {
      const cwd = inv.agent?.session?.header?.cwd
      if (!cwd) return { kind: 'error', text: 'No session cwd available.' }

      const run = await spawnCleanerSubagent(ctx, inv.agent, cwd)
      if (!run) {
        return {
          kind: 'error',
          text: '❌ Failed to start memory cleaner (agents/memory-cleaner.md missing or spawn error).',
        }
      }
      return {
        kind: 'success',
        text: `🧠 Memory cleaner started (child ${run.id}).\nLog index: ${path.join(PATHS.maintenanceDir, 'index.md')}`,
      }
    },
  })

  ctx.commands.register({
    name: 'memory-subagent-model',
    description:
      'Set the model for memory subagents. Usage: /memory-subagent-model extractor|cleaner <provider/model> | (default)',
    handler: async (inv) => {
      const parts = inv.rawInput.trim().split(/\s+/)
      const kind = parts[0]
      if (kind !== 'extractor' && kind !== 'cleaner') {
        return {
          kind: 'error',
          text: `Usage: /memory-subagent-model extractor|cleaner <provider/model> | (default)\nCurrent: extractor=${getExtractorModel()}, cleaner=${getCleanerModel()}`,
        }
      }
      const value = parts.slice(1).join(' ') || '(default)'
      const result = setModel(kind, value)
      return { kind: 'success', text: `✅ ${result.kind} model: ${result.value}` }
    },
  })

  ctx.commands.register({
    name: 'memory-ui',
    description: 'Print the URL of the memory visualization console (model config, subagent runs, overview)',
    handler: async () => {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) return { kind: 'error', text: 'webServer service unavailable.' }
      return { kind: 'success', text: `🧠 Memory console: ${webUiUrl(webServer)}` }
    },
  })
}
