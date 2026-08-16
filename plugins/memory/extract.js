// extract.js — 对话提取管线(JS 移植版 run_extraction.py)。
// 由 memory-ops/hooks 的 agent_end 调用:将本轮消息格式化 → raw-<n>.md 每轮备份,
// 并 append 一节到 dialogue-summary.md(工作记忆)。本模块**不启动任何子代理**——
// 固化判定(isConsolidation)由调用方决定是否启动固化子代理。
//
// ESM JavaScript,Node ≥ 20,零外部依赖(仅 node:fs / node:path / node:crypto)。

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// ============================================================
// 常量 — 和 memory.ts 的 PATHS 保持同步
// ============================================================

const LARGE_OUTPUT_THRESHOLD = 5120;
// 键名含 token/apiKey/key/password/secret/authorization → 值替换为 '***'(大小写不敏感,递归)。
// 注:除 py 的精确集合匹配外,补充"键名包含"(如 apiKey、x-access-token)以保证脱敏契约完整。
const REDACTED_TAGS = ["token", "apikey", "key", "password", "secret", "authorization"];
function shouldRedact(key) {
  const lower = key.toLowerCase();
  return REDACTED_TAGS.some((tag) => lower === tag || lower.includes(tag));
}
const CONSOLIDATE_EVERY = 5; // 每 5 轮跑一次完整子代理(essence+notebook+remember)

// 关键动作提取:白名单工具 + 容错解析(失败降级,不影响摘要主体)
const ACTION_TOOLS = new Set(["edit", "write", "read", "bash", "delete", "move"]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function hashContent(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12);
}

/** UTC 时间戳:YYYY-MM-DD HH:MM:SS(对应 py 的 strftime)。 */
function utcNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function redactArgs(args) {
  if (!isPlainObject(args)) return args;
  const result = {};
  for (const [k, v] of Object.entries(args)) {
    if (shouldRedact(k)) {
      result[k] = "***";
    } else if (isPlainObject(v)) {
      result[k] = redactArgs(v);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) => (isPlainObject(item) ? redactArgs(item) : item));
    } else {
      result[k] = v;
    }
  }
  return result;
}

function extractText(content, includeThinking = true) {
  /** 提取消息的纯文本。

      include_thinking=false 时跳过 thinking 块(对话摘要用——
      工作记忆只保留实际回复文本,thinking 不注入下一轮上下文)。
  */
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (!isPlainObject(block)) {
        texts.push(String(block));
        continue;
      }
      const bt = block.type || "";
      if (bt === "text") {
        texts.push(block.text ?? "");
      } else if (bt === "thinking") {
        if (includeThinking) {
          texts.push(`[thinking]\n${block.thinking ?? ""}\n[/thinking]`);
        }
      } else if (bt === "toolCall") {
        continue;
      } else if (bt === "image") {
        texts.push(`[image: ${block.mimeType ?? "unknown"}]`);
      } else {
        texts.push(String(block));
      }
    }
    return texts.join("\n");
  }
  return String(content);
}

function extractToolCalls(content) {
  const calls = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isPlainObject(block) && block.type === "toolCall") {
        calls.push(block);
      }
    }
  }
  return calls;
}

function formatContentBlock(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (isPlainObject(block)) {
        const bt = block.type || "";
        if (bt === "text") {
          parts.push(block.text ?? "");
        } else if (bt === "thinking") {
          // Strip thinking content — too verbose, not useful for memory
          parts.push("[thinking block — filtered]");
        } else if (bt === "toolCall") {
          continue;
        } else if (bt === "image") {
          parts.push(`[image: ${block.mimeType ?? "unknown"}]`);
        } else {
          parts.push(String(block));
        }
      } else {
        parts.push(String(block));
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function formatSystem(msg) {
  const text = extractText(msg.content ?? "");
  return `## System\n> [System prompt, ${text.length} bytes - 已过滤]\n\n`;
}

function formatUser(msg) {
  const text = extractText(msg.content ?? "");
  return `## User\n${text}\n\n`;
}

function formatAssistant(msg) {
  const content = msg.content ?? [];
  const parts = [];
  const textContent = formatContentBlock(content);
  if (textContent.trim()) {
    parts.push(`## Assistant\n${textContent.trim()}`);
  }
  for (const tc of extractToolCalls(content)) {
    const toolName = tc.name ?? "unknown";
    let toolArgs = tc.arguments ?? {};
    if (isPlainObject(toolArgs)) {
      toolArgs = redactArgs(toolArgs);
    }
    parts.push(`## Tool Call: ${toolName}\n\`\`\`json\n${JSON.stringify(toolArgs, null, 2)}\n\`\`\``);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}

function formatToolResult(msg, rawDir) {
  const toolName = msg.toolName || msg.name || "";
  const content = msg.content ?? [];
  const isError = msg.isError ?? false;
  const text = extractText(content);
  const errorTag = isError ? " ⚠️ ERROR" : "";

  // read 工具的结果：只留路径和大小
  if (toolName === "read" || toolName === "read_file" || toolName === "file_read") {
    return `## Tool Result: ${toolName}${errorTag}\n> [read result, ${text.length} bytes - 已截断]\n\n`;
  }

  let result = `## Tool Result: ${toolName}${errorTag}\n`;
  if (text.length > LARGE_OUTPUT_THRESHOLD || toolName === "bash" || toolName === "grep" || toolName === "find") {
    const lines = text.split("\n");
    const totalLines = lines.length;
    const head = lines.slice(0, 50).join("\n");
    const tail = totalLines > 70 ? lines.slice(-20).join("\n") : "";
    const truncated = totalLines > 70 ? totalLines - 70 : 0;
    const cHash = hashContent(text);
    const fullPath = path.join(rawDir, `${cHash}.txt`);
    fs.writeFileSync(fullPath, text, "utf-8");
    result += `> (截断, full → raw/${cHash}.txt) 共 ${text.length} bytes\n\n\`\`\`\n${head}\n`;
    if (truncated > 0) {
      result += `\n... (${truncated} 行截断) ...\n\n${tail}\n`;
    }
    result += "\`\`\`\n\n";
  } else {
    result += `\`\`\`\n${text}\n\`\`\`\n\n`;
  }
  return result;
}

function formatBashExecution(msg, rawDir) {
  const command = msg.command ?? "";
  const output = msg.output ?? "";
  const exitCode = msg.exitCode;
  const cancelled = msg.cancelled ?? false;
  const flags = [];
  if (cancelled) flags.push("cancelled");
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) flags.push(`exit=${exitCode}`);
  const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";

  let result = `## Bash Execution${flagStr}\n\n\`\`\`bash\n${command}\n\`\`\`\n\n`;
  if (output) {
    if (output.length > LARGE_OUTPUT_THRESHOLD) {
      const lines = output.split("\n");
      const head = lines.slice(0, 50).join("\n");
      const tail = lines.length > 70 ? lines.slice(-20).join("\n") : "";
      const truncated = lines.length > 70 ? lines.length - 70 : 0;
      const cHash = hashContent(output);
      fs.writeFileSync(path.join(rawDir, `${cHash}.txt`), output, "utf-8");
      result += `> (截断, full → raw/${cHash}.txt) 共 ${output.length} bytes\n\n\`\`\`\n${head}\n`;
      if (truncated > 0) {
        result += `\n... (${truncated} 行截断) ...\n\n${tail}\n`;
      }
      result += "\`\`\`\n\n";
    } else {
      result += `\`\`\`\n${output}\n\`\`\`\n\n`;
    }
  }
  return result;
}

function formatCustom(msg) {
  const customType = msg.customType ?? "unknown";
  const text = extractText(msg.content ?? "");
  return `## Custom: ${customType}\n${text}\n\n`;
}

function formatBranchSummary(msg) {
  return `## Branch Summary\nFrom: ${msg.fromId ?? ""}\n\n${msg.summary ?? ""}\n\n`;
}

function formatCompaction(msg) {
  return `## Compaction Summary\nTokens before: ${msg.tokensBefore ?? 0}\n\n${msg.summary ?? ""}\n\n`;
}

function formatMessage(msg, rawDir) {
  const role = msg.role ?? "unknown";
  switch (role) {
    case "system":
    case "developer":
      return formatSystem(msg);
    case "user":
      return formatUser(msg);
    case "assistant":
      return formatAssistant(msg);
    case "toolResult":
      return formatToolResult(msg, rawDir);
    case "bashExecution":
      return formatBashExecution(msg, rawDir);
    case "custom":
      return formatCustom(msg);
    case "branchSummary":
      return formatBranchSummary(msg);
    case "compactionSummary":
      return formatCompaction(msg);
    default: {
      const text = msg.content
        ? extractText(msg.content)
        : JSON.stringify(msg);
      return `## ${role}\n${text}\n\n`;
    }
  }
}

/**
 * 格式化消息 → raw-<round_no>.md(每轮完整备份,不覆盖)。
 *
 * 超长工具输出(>5KB)仍截断并存 hash 到 raw/ 目录。
 * @returns {string} 写入的路径
 */
export function writeRawMarkdown(messages, turnsDir, roundNo) {
  const rawDir = path.join(turnsDir, "raw");
  ensureDir(rawDir);

  const timestamp = new Date().toISOString(); // UTC,末尾 Z(对应 py 的 isoformat Z)
  const parts = [`# Turn ${roundNo} — ${timestamp}\n\n`];
  for (const msg of messages) {
    parts.push(formatMessage(msg, rawDir));
  }

  const md = parts.join("");
  const outPath = path.join(turnsDir, `raw-${roundNo}.md`);
  fs.writeFileSync(outPath, md, "utf-8");
  return outPath;
}

// ============================================================
// 对话摘要累积(工作记忆) + 固化轮次控制
// ============================================================

/**
 * 当前轮次 = dialogue-summary.md 已有的节数。文件即状态,无额外计数器。
 * 统计 '### 轮次' 出现次数(与 py 版 count("### 轮次") 保持一致)。
 */
export function countRounds(turnsDir) {
  const f = path.join(turnsDir, "dialogue-summary.md");
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf-8").split("### 轮次").length - 1;
}

/**
 * 从 messages 的 toolCall 块提取关键动作,返回 ['📝 edit src/a.ts', ...]。
 *
 * 容错:参数缺失/非 dict → 跳过该动作;宁缺毋滥,绝不产生错误信息。
 * 白名单工具 {edit, write, read, bash, delete, move},最多 6 条。
 */
export function extractKeyActions(messages) {
  const actions = [];
  for (const msg of messages) {
    const content = msg.content ?? [];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isPlainObject(block) || block.type !== "toolCall") continue;
      const name = block.name ?? "";
      if (!ACTION_TOOLS.has(name)) continue;
      const args = block.arguments;
      if (!isPlainObject(args)) continue;
      const target = args.path || args.file || args.from;
      if (name === "bash") {
        const cmd = String(args.command ?? "").replace("\n", " ").trim().slice(0, 80); // 与 py 一致:仅替换首个换行
        if (cmd) actions.push(`🖥️ ${cmd}`);
      } else if (target) {
        const icon = { edit: "📝", write: "➕", read: "📖", delete: "🗑️", move: "↔️" }[name] ?? "⚙️";
        actions.push(`${icon} ${name} ${target}`);
      }
      // 其余缺失参数的动作直接跳过
    }
  }
  return actions.slice(0, 6); // 每轮最多 6 个,避免过长
}

/**
 * 追加本轮完整对话摘要一节(带轮次序号)到 dialogue-summary.md。
 *
 * 收录本轮**所有**用户消息与**助手最终答复**——不收录工具调用间隙的
 * 中间叙述(如"现在看 X"、"需求都理清了"这类过程性文本,用户视为
 * 思考过程不应进入工作记忆;2026-08-16 修复)。区分方式:assistant
 * 消息含 tool-call 块 = 工具调用前的过渡叙述 → 跳过;纯文本消息 =
 * 最终答复 → 收录。每轮 append,永久保留(不归档不覆盖);
 * 轮次 = 节数,固化点由节数判定。无助手最终答复则跳过。
 */
export function appendDialogueSummary(messages, turnsDir, roundNo) {
  // 只取 text 块,过滤 thinking(工作记忆不注入思考内容);
  // 含 tool-call 的 assistant 消息是工具间隙叙述,不收录。
  const userTexts = messages
    .filter((m) => m.role === "user")
    .map((m) => extractText(m.content ?? "", false).trim());
  const asstTexts = messages
    .filter((m) => m.role === "assistant")
    .filter((m) => extractToolCalls(m.content ?? []).length === 0)
    .map((m) => extractText(m.content ?? "", false).trim())
    .filter((t) => t);
  if (asstTexts.length === 0) return;

  const userBlock = userTexts
    .filter((t) => t)
    .map((t) => `- ${t}`)
    .join("\n") || "(空)";
  const asstBlock = asstTexts.join("\n\n");

  ensureDir(turnsDir);
  const ts = utcNow();
  // 节标题带 raw 回查链接 + 关键动作行(容错:无动作则省略)
  const actions = extractKeyActions(messages);
  const actionLine = actions.length > 0 ? `\n**关键动作**: ${actions.join(" | ")}\n` : "";
  const block =
    `### 轮次 ${roundNo} ${ts} → 📄 raw-${roundNo}.md\n\n` +
    `**用户**:\n${userBlock}\n\n` +
    `**助手**:\n${asstBlock}\n` +
    `${actionLine}`;

  const out = path.join(turnsDir, "dialogue-summary.md");
  fs.appendFileSync(out, block + "\n", "utf-8");
}

// ============================================================
// 主入口
// ============================================================

/**
 * 对话提取主入口(对应 py main):
 * - messages 不是数组则包装;空或非 system 消息 < 2 → 返回 { skipped: true, reason: 'trivial' }
 * - roundNo = countRounds + 1;依次执行 writeRawMarkdown + appendDialogueSummary
 * - 返回 { roundNo, isConsolidation: roundNo % 5 === 0, rawPath }
 *   (isConsolidation 供调用方决定是否启动固化子代理——**本模块不启动任何子代理**)
 * - 出错时向 turnsDir/extraction-error.log 写入错误(含时间戳与 stack)后抛出错误
 */
export function runExtraction(messages, turnsDir, options = {}) {
  if (!Array.isArray(messages)) messages = [messages];

  // Defense-in-depth: skip if messages are incomplete (only system or < 2 total).
  // 与 py 版一致:过滤 system/developer 后不足 2 条 → trivial。
  const nonSystem = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  if (nonSystem.length < 2) {
    return { skipped: true, reason: "trivial" };
  }

  ensureDir(turnsDir);

  try {
    // 1+2. 依次写 raw-<n>.md(每轮备份) + 追加对话摘要(工作记忆,含全部用户/助手消息)。
    //      py 版用双线程并行;JS 单线程顺序执行,效果一致(无共享可变依赖)。
    const roundNo = countRounds(turnsDir) + 1; // 本轮轮次 = 已有节数 + 1
    const rawPath = writeRawMarkdown(messages, turnsDir, roundNo);
    appendDialogueSummary(messages, turnsDir, roundNo);

    // 3. 固化判定:节数即轮次,每 CONSOLIDATE_EVERY 轮由调用方启动固化子代理。
    //    (isConsolidation 只作判定;本模块不 spawn 子代理)
    return { roundNo, isConsolidation: roundNo % CONSOLIDATE_EVERY === 0, rawPath };
  } catch (e) {
    // Log any unhandled error to file
    const errorLog = path.join(turnsDir, "extraction-error.log");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const stack = e instanceof Error ? e.stack : String(e);
    const errorMsg = `# Extraction Error — ${ts}\n\n${e instanceof Error ? e.message : String(e)}\n${stack ? `\nStack:\n${stack}` : ""}\n`;
    try {
      fs.writeFileSync(errorLog, errorMsg, "utf-8");
    } catch { /* best effort */ }
    throw e;
  }
}
