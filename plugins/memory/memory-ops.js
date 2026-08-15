// memory-ops.js — 由 pi-memory-system 的 extensions/memory/memory-ops.ts 移植的 ESM JavaScript 版本。
// 业务逻辑与原注释(中文注释保留)1:1 移植,仅移除子代理启动相关函数(已移到别处)。

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, getProjectName } from "./config.js";
import {
  safeRead,
  walkMarkdownFiles,
  parseMemoryEntries,
  extractLinks,
  extractRelatedLinks,
} from "./utils.js";

/**
 * Refresh _index.md by scanning all .md files in the memory directory.
 * Scans entries (## sections) from each file and builds a navigable TOC.
 */
export function refreshIndex(cwd, scope) {
  const targetDir = scope === "global" ? PATHS.personalDir : PATHS.memoriesDir(cwd);
  if (!fs.existsSync(targetDir)) return;

  const entries = [];

  const files = walkMarkdownFiles(targetDir);
  for (const filePath of files) {
    const relativePath = path.relative(targetDir, filePath).replace(/\\/g, "/");
    const content = safeRead(filePath);
    if (!content) continue;

    for (const entry of parseMemoryEntries(content, relativePath)) {
      entries.push({
        relativePath,
        section: entry.section,
        date: entry.date,
        confidence: entry.confidence,
        tags: entry.tags,
        superseded: entry.superseded,
      });
    }
  }

  // Group by directory (category)
  const byCategory = new Map();
  for (const entry of entries) {
    const dir = path.dirname(entry.relativePath);
    const cat = dir === "." ? "uncategorized" : dir;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(entry);
  }

  let index = "# Memory Index\n\n";

  // Sort: uncategorized first, then alphabetical
  const sortedCats = Array.from(byCategory.keys()).sort((a, b) => {
    if (a === "uncategorized") return -1;
    if (b === "uncategorized") return 1;
    return a.localeCompare(b);
  });

  for (const category of sortedCats) {
    const items = byCategory.get(category);
    const catLabel =
      category === "uncategorized"
        ? "Uncategorized"
        : category.charAt(0).toUpperCase() + category.slice(1);
    index += `## ${catLabel}\n\n`;
    for (const item of items) {
      const confidence = item.confidence ? ` | \`[${item.confidence}]\`` : "";
      const date = item.date ? ` | ${item.date}` : "";
      const tags = item.tags.length > 0 ? ` | tags: ${item.tags.join(", ")}` : "";
      const fullLink = `memories/${item.relativePath}`;
      if (item.superseded) {
        index += `- ~~[[${fullLink}#${item.section}|${item.section}]]~~${date}${confidence} (superseded)\n`;
      } else {
        index += `- [[${fullLink}#${item.section}|${item.section}]]${date}${confidence}${tags}\n`;
      }
    }
    index += "\n";
  }

  const indexPath = path.join(targetDir, "_index.md");
  fs.writeFileSync(indexPath, index.trim() + "\n", "utf-8");
}

/** Get a summary of the memory system state. */
export function getMemoryStatus(cwd) {
  const projectDir = PATHS.projectDir(cwd);
  const memoriesDir = PATHS.memoriesDir(cwd);

  let summary = `## Memory System Status\n\n`;

  const coreExists = fs.existsSync(PATHS.corePrompt);
  const rulesExist = fs.existsSync(PATHS.rules);
  summary += `- Core Prompt: ${coreExists ? "✅" : "❌"}\n`;
  summary += `- Behavioral Rules: ${rulesExist ? "✅" : "❌"}\n`;

  const notebookExists = fs.existsSync(PATHS.notebook(cwd));
  summary += `- Session Notebook: ${notebookExists ? "✅" : "❌"}\n`;

  if (fs.existsSync(memoriesDir)) {
    const files = walkMarkdownFiles(memoriesDir);
    summary += `- Long-term Memory Files: ${files.length}\n`;
    // Group by subdirectory for tree-like display
    const tree = new Map();
    for (const filePath of files) {
      const relative = path.relative(memoriesDir, filePath).replace(/\\/g, "/");
      const dir = path.dirname(relative);
      if (!tree.has(dir)) tree.set(dir, []);
      const content = safeRead(filePath);
      const entries = content ? content.split("\n## ").length - 1 : 0;
      tree.get(dir).push(entries);
    }
    for (const [dir, entryCounts] of tree) {
      if (dir === ".") {
        // Flat files at root
        for (const filePath of files) {
          const relative = path.relative(memoriesDir, filePath).replace(/\\/g, "/");
          if (path.dirname(relative) !== ".") continue;
          const content = safeRead(filePath);
          const entries = content ? content.split("\n## ").length - 1 : 0;
          summary += `  - ${path.basename(filePath)}: ${entries} entries\n`;
        }
      } else {
        const total = entryCounts.reduce((a, b) => a + b, 0);
        summary += `  📁 ${dir}/ — ${entryCounts.length} files, ${total} entries\n`;
        for (const filePath of files) {
          const relative = path.relative(memoriesDir, filePath).replace(/\\/g, "/");
          if (path.dirname(relative) !== dir) continue;
          const content = safeRead(filePath);
          const entries = content ? content.split("\n## ").length - 1 : 0;
          summary += `    - ${path.basename(filePath)}: ${entries} entries\n`;
        }
      }
    }
  } else {
    summary += `- Long-term Memory Directory: ❌ Not found\n`;
  }

  return summary;
}

/**
 * Ensure a project's memory directory and notebook exist.
 * Creates them with default template if missing.
 */
export function ensureProjectDir(cwd) {
  const dir = PATHS.projectDir(cwd);
  if (fs.existsSync(dir)) return;

  // Create project directory and memories subdirectory
  fs.mkdirSync(PATHS.memoriesDir(cwd), { recursive: true });

  // Create turns directory
  const turnsDir = path.join(PATHS.projectDir(cwd), "turns");
  fs.mkdirSync(turnsDir, { recursive: true });

  // Create notebook.md with template
  const notebookPath = PATHS.notebook(cwd);
  const projectName = getProjectName(cwd);
  const template = `---
project: ${projectName}
last_maintenance: ${new Date().toISOString()}
---

# 会话小本本 — ${projectName}

> 由主 LLM 每轮主动维护的活动白板。子代理只读不写。

## 当前任务

## 本阶段完成

## 待办

## 跨轮约束

## 项目常识
`;
  fs.writeFileSync(notebookPath, template, "utf-8");
}

// ============================================================
// Memory maintenance (海马体) — 会话结束自动整理长期记忆
// ============================================================

// MAINTENANCE_DIR/LAST_RUN_FILE 改为基于 PATHS.maintenanceDir(布局与 pi 完全一致)。
const MAINTENANCE_DIR = PATHS.maintenanceDir;
const LAST_RUN_FILE = path.join(MAINTENANCE_DIR, "last-run.json");

// 会话结束补固化阈值:剩余未固化节数 ≥ 3 才补跑(短会话不触发,避免频繁/浪费)
export const CONSOLIDATE_AT_SESSION_END = 3;

export function getLastMaintenance() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Build a network-health report for memory: isolated entries, link density,
 * hub nodes. Mechanical graph stats are computed in code (LLM unreliable at
 * counting links); the hippocampus (cleaner) then uses the report to link
 * isolated entries or report them. Written to maintenance/network-health.md.
 */
export function buildNetworkHealthReport(cwd) {
  const scopes = [
    ["项目记忆", PATHS.memoriesDir(cwd)],
    ["全局记忆", PATHS.personalDir],
  ];

  const nodes = [];
  const fileLinks = [];

  for (const [scopeLabel, dir] of scopes) {
    if (!fs.existsSync(dir)) continue;
    for (const f of walkMarkdownFiles(dir)) {
      const rel = path.relative(dir, f).replace(/\\/g, "/");
      const content = safeRead(f);
      if (!content) continue;

      const sections = content.split(/(?=^## )/m);
      for (const sec of sections) {
        const titleMatch = sec.match(/^## (.+)/m);
        if (!titleMatch) continue;
        const title = titleMatch[1].trim();
        if (/↗\s*\*\*Superseded|↗\s*\*\*被取代/i.test(sec)) continue; // 跳过 superseded

        const outLinks = [...extractRelatedLinks(sec), ...extractLinks(sec)]
          .map((l) => l.split("#")[0].trim())
          .filter((l) => l && !l.includes("_index"));
        nodes.push({ scope: scopeLabel, file: rel, section: title, outLinks: [...new Set(outLinks)], inCount: 0 });
        for (const t of outLinks) fileLinks.push({ file: rel, target: t });
      }
    }
  }

  // 入链:指向本条目所在文件的**不同来源文件数**(去重,避免同文件多链接重复计数)
  for (const n of nodes) {
    const f = n.file.replace(/^memories\//, "").replace(/\.md$/, "");
    const sources = new Set();
    for (const fl of fileLinks) {
      if (fl.file === n.file) continue; // 不自链
      const t = fl.target.replace(/^memories\//, "").replace(/\.md$/, "");
      if (t === f) sources.add(fl.file);
    }
    n.inCount = sources.size;
  }

  const totalEntries = nodes.length;
  const totalLinks = fileLinks.length;
  const density = totalEntries > 0 ? (totalLinks / totalEntries).toFixed(2) : "0";
  const isolated = nodes.filter((n) => n.outLinks.length === 0 && n.inCount === 0);
  const hubs = [...nodes].sort((a, b) => b.inCount - a.inCount).slice(0, 5).filter((n) => n.inCount > 0);

  const lines = [
    `## 记忆网络健康报告 (${new Date().toISOString().slice(0, 10)})`,
    ``,
    `- 条目总数: ${totalEntries} | 链接总数: ${totalLinks} | 密度: ${density}`,
    `- 孤立条目(零出链且零入链,不会被联想触达): ${isolated.length} 个`,
  ];
  for (const n of isolated.slice(0, 30)) {
    lines.push(`  - [[${n.file}#${n.section}|${n.scope}]]`);
  }
  if (isolated.length > 30) lines.push(`  …(共 ${isolated.length} 个)`);

  if (hubs.length > 0) {
    lines.push(`- 枢纽节点(被链接最多):`);
    for (const h of hubs) {
      lines.push(`  - [[${h.file}#${h.section}]] × ${h.inCount}`);
    }
  }
  return lines.join("\n");
}

/**
 * 更新维护记录(last-run.json + maintenance/index.md)。
 * /memory-clean 命令不走 runMemoryMaintenance,完成时需同步记录,
 * 否则 maintenanceSection() 注入的"最近整理"滞后。
 */
export function updateMaintenanceRecords(logPath, project) {
  try {
    fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
    fs.writeFileSync(
      LAST_RUN_FILE,
      JSON.stringify(
        { lastRun: new Date().toISOString(), logFile: logPath, project },
        null,
        2,
      ),
      "utf-8",
    );
    const logs = fs
      .readdirSync(MAINTENANCE_DIR)
      .filter((f) => f.startsWith("clean-") && f.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 20);
    fs.writeFileSync(
      path.join(MAINTENANCE_DIR, "index.md"),
      `# 记忆维护日志\n\n${logs.map((l) => `- [[${l}]]`).join("\n")}\n`,
      "utf-8",
    );
  } catch { /* non-fatal */ }
}

export function getSubagentModel() {
  try {
    return fs
      .readFileSync(PATHS.subagentModelFile, "utf-8")
      .trim();
  } catch {
    return "(default)";
  }
}

/** Render the maintenance section for before_agent_start injection. */
export function maintenanceSection() {
  const last = getLastMaintenance();
  if (!last?.logFile) return "";
  const t = last.lastRun || "";
  return (
    `\n\n---\n\n## 记忆维护日志\n` +
    `最近整理: ${t} (${last.project || "?"})\n` +
    `日志文件: ${last.logFile}\n` +
    `全部日志: ${MAINTENANCE_DIR}\\index.md\n`
  );
}
