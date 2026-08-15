/**
 * 命令 — 对应 pi 的 commands.ts。
 *   /memory-clean            手动触发海马体整理子代理
 *   /memory-subagent-model   设置固化/海马体子代理的模型（provider/model 或 (default)）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PATHS, getProjectName } from './config.js'
import { getSubagentModel, updateMaintenanceRecords } from './memory-ops.js'
import { spawnCleanerSubagent } from './subagents.js'

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

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const logPath = path.join(PATHS.maintenanceDir, `clean-${ts}.log`)
      updateMaintenanceRecords(logPath, getProjectName(cwd))
      return {
        kind: 'success',
        text: `🧠 Memory cleaner started (session child).\nLog index: ${path.join(PATHS.maintenanceDir, 'index.md')}`,
      }
    },
  })

  ctx.commands.register({
    name: 'memory-subagent-model',
    description:
      'Set the model for memory subagents. Usage: /memory-subagent-model <provider/model> | (default)',
    handler: async (inv) => {
      const input = inv.rawInput.trim()
      if (!input) {
        return {
          kind: 'error',
          text: `Usage: /memory-subagent-model <provider/model> | (default)\nCurrent: ${getSubagentModel()}`,
        }
      }
      if (input === '(default)') {
        fs.rmSync(PATHS.subagentModelFile, { force: true })
      } else {
        fs.mkdirSync(path.dirname(PATHS.subagentModelFile), { recursive: true })
        fs.writeFileSync(PATHS.subagentModelFile, input, 'utf-8')
      }
      return { kind: 'success', text: `✅ Subagent model: ${input}` }
    },
  })
}
