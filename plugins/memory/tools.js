// tools.js — Port of pi-memory-system extensions/memory/tools.ts
// 9 LLM tools registered as DSH ToolDefinitions via ctx.tools.register(defineTool({...})).
// Business logic and comments are preserved from the pi original.
//
// defineTool 来自本地 ./tool-schema.js（把参数 DSL 编译成标准 JSON Schema），
// 不用 @deepseek-ai/dsh-tools：junction 装载后 ESM 解析会命中项目根目录的测试 stub，
// 其 defineTool 原样返回导致 parameters 里的 per-property `required: true` 泄漏给上游
// provider（Invalid schema for function 'confirm' ...）。详见 tool-schema.js 头部注释。
import * as fs from "node:fs";
import * as path from "node:path";
import { defineTool } from "./tool-schema.js";
import { PATHS, setProjectName } from "./config.js";
import { safeRead, extractLinks, walkMarkdownFiles, extractKeywords } from "./utils.js";
import { diversitySort } from "./diversity.js";
import { convertWithMarkitdown } from "./markitdown.js";
import { refreshIndex, getMemoryStatus } from "./memory-ops.js";

/**
 * Resolve the current working directory for a tool execution.
 * Falls back to process.cwd() when the agent/session header doesn't provide one.
 */
export function agentCwd(exec) {
  return exec?.agent?.session?.header?.cwd || process.cwd();
}

/**
 * Register all 9 memory tools on the Cordis context.
 * ctx: Cordis Context — captured in closures for use inside execute.
 */
export function registerTools(ctx) {
  // ============================================================
  // Tool: remember — store info into long-term memory
  // ============================================================
  ctx.tools.register(defineTool({
    name: "remember",
    description:
      "Store a piece of key information into long-term memory. Automatically sorted into facts / preferences / decisions / events. Use scope=global for cross-project knowledge (preferences, technical knowledge, dev env). Use scope=project (default) for project-specific info.",
    parameters: {
      content: { type: "string", required: true, description: "Content to remember" },
      category: {
        type: "string",
        required: true,
        enum: ["fact", "preference", "decision", "event"],
        description:
          "Memory type. fact=objective fact, preference=work style/taste, decision=design decision + reasoning, event=experience summary",
      },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description:
          "Scope. project=specific to current project, global=cross-project general",
      },
      tags: {
        type: "string",
        description: "Comma-separated tags, e.g. 'typescript, architecture'",
      },
      confidence: {
        type: "string",
        enum: ["confirmed", "inferred", "intuition"],
        description:
          "Confidence level. confirmed=verified by evidence, inferred=logical deduction, intuition=gut feeling / preliminary. Default: no annotation.",
      },
      trigger: {
        type: "string",
        description:
          "What triggered this memory. Prefix with type, e.g. 'conversation — user suggested X', 'debugging — found root cause of Y', 'code-review — noticed pattern Z'. Common types: conversation, debugging, code-review, refactoring, experiment, reading, user-feedback, contradiction, external.",
      },
      file: {
        type: "string",
        description:
          "Optional: target file name within the category directory, WITHOUT .md suffix. " +
          "Examples: 'debugging' → events/debugging.md, 'architecture' → decisions/architecture.md. " +
          "Check the Memory Index ([[_index.md]]) for existing categories. " +
          "If content doesn't fit any existing category, propose a new file name and ASK THE USER FOR CONFIRMATION before using it. " +
          "If omitted, falls back to a single general file (e.g., events.md).",
      },
      title: {
        type: "string",
        description:
          "Optional: explicit title for the entry. If omitted, the first line of content is used. " +
          "Use this when the first line of content is too long or generic.",
      },
      related: {
        type: "string",
        description: "Related [[Wiki-links]], comma separated",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec);
      const category = args.category;
      const scope = args.scope || "project";
      const tags = args.tags
        ? args.tags.split(",").map((t) => t.trim())
        : [];
      const related = args.related || "";

      const targetDir =
        scope === "global" ? PATHS.personalDir : PATHS.memoriesDir(cwd);

      // Determine target file: if `file` param is provided, write to subdirectory
      const fileParam = args.file;
      let fileName;
      let targetFile;
      if (fileParam) {
        // Guard: prevent nested dirs like events/events/implementation.md
        const categoryDir = `${category}s`;
        let normalizedFile = fileParam.replace(/\.md$/i, "");
        // Strip leading categoryDir/ or category/ prefix to prevent nesting
        if (normalizedFile.startsWith(`${categoryDir}/`)) {
          normalizedFile = normalizedFile.slice(`${categoryDir}/`.length);
        } else if (normalizedFile.startsWith(`${category}/`)) {
          normalizedFile = normalizedFile.slice(`${category}/`.length);
        }
        // Security: only allow a plain file name — strip path separators and
        // traversal sequences so remember can never write outside the memory dir.
        normalizedFile = normalizedFile
          .replace(/[/\\]/g, "")
          .replace(/\.\./g, "")
          .trim();
        if (normalizedFile === category || normalizedFile === categoryDir) {
          // File param is redundant — write to flat {category}s.md instead
          fileName = `${category}s.md`;
          targetFile = path.join(targetDir, fileName);
        } else if (!normalizedFile) {
          // File param was only separators/traversal — fall back to flat file
          fileName = `${category}s.md`;
          targetFile = path.join(targetDir, fileName);
        } else {
          fileName = `${categoryDir}/${normalizedFile}.md`;
          targetFile = path.join(targetDir, categoryDir, `${normalizedFile}.md`);
        }
      } else {
        fileName = `${category}s.md`;
        targetFile = path.join(targetDir, fileName);
      }
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });

      const timestamp = new Date().toISOString().slice(0, 10);
      const tagLine = tags.length > 0 ? `tags: [${tags.join(", ")}]` : "";
      const relatedLine = related ? `\nRelated: ${related}` : "";
      const confidence = args.confidence;
      const trigger = args.trigger;

      const existing = safeRead(targetFile);
      // Title: use explicit title if provided, otherwise derive from content
      // WITHOUT auto-truncation — no more '...' surprise
      let entryTitle;
      if (args.title) {
        entryTitle = args.title.trim();
      } else if (category === "event") {
        const firstLine = args.content.split("\n")[0].trim();
        entryTitle = `${timestamp}: ${firstLine.slice(0, 60)}`;
      } else {
        entryTitle = args.content.split("\n")[0].trim();
      }

      const metaLines = [];
      if (confidence) metaLines.push(`- **置信度**: \`[${confidence}]\``);
      if (trigger) metaLines.push(`- **触发器**: ${trigger}`);
      if (tagLine) metaLines.push(`- ${tagLine}`);
      metaLines.push(`- Date: ${timestamp}`);
      const metaBlock = metaLines.join("\n");

      const entry = `
## ${entryTitle}
${metaBlock}

${args.content}${relatedLine}
`;

      fs.appendFileSync(targetFile, entry, "utf-8");

      // Refresh index to include the new entry
      refreshIndex(cwd, scope);

      return {
        text: `✅ Stored in ${
          scope === "global" ? "global" : "project"
        } [[memories/${fileName}#${entryTitle}]]`,
      };
    },
  }));

  // ============================================================
  // Tool: recall — search long-term memory
  // ============================================================
  ctx.tools.register(defineTool({
    name: "recall",
    description:
      "Search long-term memory for relevant information. Returns matching snippets and related links. Supports fuzzy matching.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description:
          "Search query. Multiple keywords separated by space (any match is sufficient).",
      },
      scope: {
        type: "string",
        enum: ["project", "global", "all"],
        description:
          "Search scope. project=current project only, global=personal only, all=everywhere",
      },
      confidence: {
        type: "string",
        enum: ["confirmed", "inferred", "intuition"],
        description:
          "Only return entries with this confidence level (optional filter).",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return (default: 5)",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec);
      const scope = args.scope || "all";
      const maxResults = args.maxResults || 5;
      const confidenceFilter = args.confidence;

      // ExtractKeywords: English words + CJK 2-grams, so Chinese queries
      // like "缓存优化" match lines containing "缓存" or "优化" individually.
      const keywords = extractKeywords(args.query);
      const results = [];

      const searchDirs = [];
      if (scope === "project" || scope === "all") {
        const projDir = PATHS.memoriesDir(cwd);
        if (fs.existsSync(projDir)) searchDirs.push(projDir);
      }
      if (scope === "global" || scope === "all") {
        if (fs.existsSync(PATHS.personalDir)) searchDirs.push(PATHS.personalDir);
      }

      for (const dir of searchDirs) {
        const filePaths = walkMarkdownFiles(dir);
        for (const filePath of filePaths) {
          const file = path.relative(dir, filePath).replace(/\\/g, "/");
          const content = safeRead(filePath);
          if (!content) continue;

          const lines = content.split("\n");
          let currentSection = "";
          let sectionLines = [];
          let matchCount = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith("## ")) {
              if (matchCount > 0) {
                results.push(
                  `📄 [[memories/${file}#${currentSection}]]\n${sectionLines.join(
                    "\n",
                  )}\n---`,
                );
                matchCount = 0;
              }
              currentSection = line.replace("## ", "").trim();
              sectionLines = [line];
              continue;
            }

            if (currentSection) {
              sectionLines.push(line);
              const lower = line.toLowerCase();
              if (keywords.length === 0 || keywords.some((k) => lower.includes(k))) {
                // Apply confidence filter — only match metadata lines, not body content
                const matchesConfidence =
                  !confidenceFilter ||
                  (lower.includes(`[${confidenceFilter}]`) &&
                   (lower.includes("置信度") || lower.includes("confidence")));
                if (matchesConfidence) {
                  matchCount++;
                }
              }
            }
          }

          if (matchCount > 0 && currentSection) {
            results.push(
              `📄 [[memories/${file}#${currentSection}]]\n${sectionLines.join(
                "\n",
              )}\n---`,
            );
          }
        }
      }

      if (results.length === 0) {
        return {
          text: `No results found in ${scope} memory for "${args.query}".\n\nUse \`remember\` to save this information for future retrieval.`,
        };
      }

      // Diversity sort: most unique results first, no results removed
      const sorted = results.length > maxResults
        ? diversitySort(results, (r) => r.replace(/^.*?\n/, ""))
        : results;
      const limited = sorted.slice(0, maxResults);
      const total = results.length;

      let output = `Found ${total} result(s)${total > maxResults ? ` (showing first ${maxResults})` : ""}:\n\n`;
      output += limited.join("\n\n");

      const allLinks = new Set();
      for (const r of limited) {
        for (const link of extractLinks(r)) {
          allLinks.add(link);
        }
      }
      if (allLinks.size > 0) {
        output += `\n\n**Related links**: ${Array.from(allLinks)
          .map((l) => `[[${l}]]`)
          .join(", ")}`;
      }

      return { text: output };
    },
  }));

  // ============================================================
  // Tool: forget — delete a memory entry
  // ============================================================
  ctx.tools.register(defineTool({
    name: "forget",
    description:
      "Delete a memory entry permanently. ⚠️ Prefer `supersede` instead — it keeps the old entry for traceability and just marks it as superseded.",
    parameters: {
      file: {
        type: "string",
        required: true,
        description:
          "Target filename, e.g. facts.md, preferences.md, decisions.md, events.md",
      },
      section: {
        type: "string",
        required: true,
        description: "Section title to delete (after ##)",
      },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Scope of the memory",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec);
      const file = args.file;
      const section = args.section;
      const scope = args.scope || "project";

      const targetDir =
        scope === "global" ? PATHS.personalDir : PATHS.memoriesDir(cwd);
      const targetFile = path.join(targetDir, file);
      const content = safeRead(targetFile);

      if (!content) {
        return { text: `❌ File [[${file}]] not found.` };
      }

      const sections = content.split(/(?=^## )/m);
      const sectionHeader = `## ${section}`;
      const filtered = sections.filter((s) => {
        const firstLine = s.trim().split(/\r?\n/)[0];
        return firstLine !== sectionHeader;
      });

      if (filtered.length === sections.length) {
        return { text: `❌ Section "${section}" not found in [[${file}]].` };
      }

      fs.writeFileSync(targetFile, filtered.join("").trim() + "\n", "utf-8");
      return { text: `🗑️ Permanently deleted "${section}" from [[${file}]].` };
    },
  }));

  // ============================================================
  // Tool: supersede — mark an entry as superseded by new understanding
  // ============================================================
  ctx.tools.register(defineTool({
    name: "supersede",
    description:
      "Mark an existing memory entry as superseded by new understanding. Appends a superseded-by annotation to the old entry without deleting it. Returns the old content so you can create the replacement entry separately (via `remember` or `edit`).",
    parameters: {
      file: {
        type: "string",
        required: true,
        description: "Target filename, e.g. decisions.md, events.md",
      },
      section: {
        type: "string",
        required: true,
        description: "Section title of the entry to supersede (after ##)",
      },
      reason: {
        type: "string",
        required: true,
        description:
          "Why this entry is being superseded. Be specific: what was wrong or incomplete.",
      },
      newReference: {
        type: "string",
        description:
          "Wiki-link to the new entry that supersedes this one, e.g. [[decisions.md#New Decision Title]]",
      },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Scope of the memory",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec);
      const file = args.file;
      const section = args.section;
      const reason = args.reason;
      const newReference = args.newReference;
      const scope = args.scope || "project";

      const targetDir =
        scope === "global" ? PATHS.personalDir : PATHS.memoriesDir(cwd);
      const targetFile = path.join(targetDir, file);
      const content = safeRead(targetFile);

      if (!content) {
        return { text: `❌ File [[${file}]] not found.` };
      }

      const timestamp = new Date().toISOString().slice(0, 10);
      const supersedeLine = newReference
        ? `\n\n↗ **Superseded by** ${newReference} (${timestamp}) — ${reason}`
        : `\n\n↗ **Superseded** (${timestamp}) — ${reason}`;

      // Find the section in the file
      const sectionRegex = new RegExp(
        `(^## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?)(?=\\n## |$)`,
        "m",
      );

      if (!sectionRegex.test(content)) {
        return { text: `❌ Section "${section}" not found in [[${file}]].` };
      }

      const updated = content.replace(sectionRegex, `$1${supersedeLine}`);
      fs.writeFileSync(targetFile, updated, "utf-8");

      return {
        text: `🔄 Marked "${section}" in [[${file}]] as superseded${newReference ? ` by ${newReference}` : ""}.\n\nOld entry content:\n${content.match(sectionRegex)?.[0]?.trim() || "(could not extract)"}\n\n---\n\nNow create the replacement entry using \`remember\` or \`edit\`.`,
      };
    },
  }));

  // ============================================================
  // Tool: notebook — view/update session notebook
  // ============================================================
  ctx.tools.register(defineTool({
    name: "notebook",
    description:
      "View or update the session notebook. Use action=read to view, action=update with section and content to update.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["read", "update"],
        description: "read=view current content, update=edit a section",
      },
      section: {
        type: "string",
        description:
          "Section title to update: 当前任务, 本阶段完成, 待办, 跨轮约束, 项目常识",
      },
      content: {
        type: "string",
        description: "New content (for update action only)",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec);
      const notebookPath = PATHS.notebook(cwd);
      const action = args.action;

      if (action === "read") {
        const content = safeRead(notebookPath) || "（Notebook not initialized）";
        return { text: `📓 Current Notebook:\n\n${content}` };
      }

      if (action === "update") {
        const section = args.section;
        const content = args.content;
        const existing = safeRead(notebookPath);

        if (!existing) {
          return { text: "❌ Notebook not found. Initialize it first." };
        }

        const sectionRegex = new RegExp(
          `(## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n)([\\s\\S]*?)(?=\\n## |$)`,
          "m",
        );
        const updated = existing.replace(sectionRegex, `$1${content}\n`);

        if (updated === existing) {
          return { text: `⚠️ Section "${section}" not found. Available sections: 当前任务, 本阶段完成, 待办, 跨轮约束, 项目常识` };
        }

        fs.writeFileSync(notebookPath, updated, "utf-8");
        // NOTE: pi called updateTaskWidget(cwd, ctx) here to refresh the TUI
        // widget. DSH has no TUI widget, so that call is intentionally dropped.
        return { text: `✅ Updated notebook section "${section}".` };
      }

      return { text: "⚠️ Unknown action. Use read or update." };
    },
  }));

  // ============================================================
  // Tool: memory_status — memory system overview
  // ============================================================
  ctx.tools.register(defineTool({
    name: "memory_status",
    description: "View the current memory system file status and entry counts.",
    parameters: {},
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(_args, exec) {
      const cwd = agentCwd(exec);
      const status = getMemoryStatus(cwd);
      return { text: status };
    },
  }));

  // ============================================================
  // Tool: convert_file — convert binary files to Markdown via MarkItDown
  // ============================================================
  ctx.tools.register(defineTool({
    name: "convert_file",
    description:
      "Convert binary files (PDF, Word, Excel, PowerPoint, ePub, etc.) " +
      "to Markdown text using MarkItDown. Use this when you receive a " +
      "file format that the read tool cannot handle.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description:
          "Path to the file to convert. Supports PDF, DOCX, " +
          "PPTX, XLSX, XLS, EPUB, MSG, and HTML formats.",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const filePath = args.path;

      if (!fs.existsSync(filePath)) {
        return { text: `❌ File not found: ${filePath}` };
      }

      const ext = path.extname(filePath).toLowerCase();
      const md = convertWithMarkitdown(filePath);

      if (md === null) {
        const platform = process.platform;
        let errorMsg = `❌ Conversion failed.`;

        if (platform === "win32") {
          errorMsg += ` Make sure MarkItDown is installed in WSL:\n  ~/.markitdown-venv/bin/markitdown\n\nOr install it: pip install markitdown (in WSL venv at ~/.markitdown-venv/)`;
        } else {
          errorMsg += ` Make sure MarkItDown is installed:\n  pip install markitdown\n\nOr install it in a virtual environment: python3 -m venv ~/.markitdown-venv && ~/.markitdown-venv/bin/pip install markitdown`;
        }

        return { text: errorMsg };
      }

      return { text: md };
    },
  }));

  // ============================================================
  // Tool: confirm — interactive user confirmation
  // ============================================================
  ctx.tools.register(defineTool({
    name: "confirm",
    description:
      "Show an interactive yes/no prompt to the user. " +
      "Use this when you need user confirmation before proceeding.",
    parameters: {
      title: {
        type: "string",
        required: true,
        description: "Short title for the confirmation dialog.",
      },
      message: {
        type: "string",
        required: true,
        description: "Detailed message explaining what the user is confirming.",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const title = args.title;
      const message = args.message;

      if (!ctx.userQuestions || typeof ctx.userQuestions.ask !== "function") {
        return {
          text: "⚠️ No interactive confirmation UI available — treat as declined.",
        };
      }

      const answer = await ctx.userQuestions.ask({
        questions: [
          {
            id: "confirm",
            question: `${title}\n\n${message}`,
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
        agent: exec.agent,
        signal: exec.signal,
      });
      const confirmed = answer?.answers?.[0]?.selected?.includes("Yes");
      return { text: confirmed ? "✅ User confirmed." : "❌ User declined." };
    },
  }));

  // ============================================================
  // Tool: set_project — set or correct the project name
  // ============================================================
  ctx.tools.register(defineTool({
    name: "set_project",
    description:
      "Set or correct the current project name. Use this when the system " +
      "detected the wrong project (e.g. from a subdirectory) and you know " +
      "which project you're working on. The name is persisted in a .dsh-project " +
      "marker (and .pi-project for Pi agent compatibility) and used for all " +
      "subsequent memory operations.",
    parameters: {
      name: {
        type: "string",
        required: true,
        description:
          "The correct project name. Should be short and match the project " +
          "directory name, e.g. 'jason', 'memory-system'.",
      },
    },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      const name = args.name;
      const cwd = agentCwd(exec);

      setProjectName(cwd, name);

      return { text: `✅ Project name set to "${name}". Notebook and memories will now resolve under projects/${name}/.` };
    },
  }));
}
