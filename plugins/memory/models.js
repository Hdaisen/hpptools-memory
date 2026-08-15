/**
 * 子代理模型配置 — 固化（extractor）与海马体（cleaner）分开配置。
 *
 * 存储：<root>/models.json  { extractor?: 'provider/model', cleaner?: 'provider/model' }
 * 兼容：旧 subagent-model.txt（Pi 时代）在 models.json 缺失时作为两者的回退。
 * 值 '(default)' 或缺失 = 用 DSH 默认模型（不传 agentOptions）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PATHS } from './config.js'

function modelsFile() {
  return path.join(PATHS.root, 'models.json')
}

function readModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeModels(models) {
  fs.mkdirSync(PATHS.root, { recursive: true })
  fs.writeFileSync(modelsFile(), JSON.stringify(models, null, 2), 'utf-8')
}

/** 旧 Pi 时代的统一 subagent-model.txt 回退。 */
function legacyModel() {
  try {
    const v = fs.readFileSync(PATHS.subagentModelFile, 'utf-8').trim()
    return v && v !== '(default)' ? v : null
  } catch {
    return null
  }
}

/** 当前固化子代理模型（'provider/model' 或 '(default)'）。 */
export function getExtractorModel() {
  return readModels().extractor ?? legacyModel() ?? '(default)'
}

/** 当前海马体子代理模型（'provider/model' 或 '(default)'）。 */
export function getCleanerModel() {
  return readModels().cleaner ?? legacyModel() ?? '(default)'
}

/**
 * 设置子代理模型。kind: 'extractor' | 'cleaner'；value: 'provider/model' | '(default)'。
 * @returns { ok: true, kind, value }
 */
export function setModel(kind, value) {
  if (kind !== 'extractor' && kind !== 'cleaner') {
    throw new Error(`unknown model kind: ${kind}`)
  }
  const models = readModels()
  const v = String(value ?? '(default)').trim()
  if (!v || v === '(default)') {
    delete models[kind]
  } else {
    models[kind] = v
  }
  writeModels(models)
  return { ok: true, kind, value: v === '(default)' ? '(default)' : v }
}

/**
 * 'provider/model' 字符串 → DSH AgentOptions { provider?, model? }。
 * 无 '/' 时只当 model。'(default)'/空 → undefined（用 DSH 默认）。
 */
export function modelAgentOptions(model) {
  if (!model || model === '(default)') return undefined
  const idx = model.indexOf('/')
  if (idx > 0) return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
  return { model }
}
