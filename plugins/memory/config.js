import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * 用户主目录。用 os.homedir() 而非 process.env.HOME(Windows 上没有该变量)。
 * 所有记忆数据默认落在 ~/.pi/agent/memory(复用既有 pi 记忆数据)。
 */
export const HOME = os.homedir();

/**
 * Detect project name by walking up from cwd looking for a marker.
 * Priority: .dsh-project file > .pi-project file (兼容旧项目) > .git directory
 *            > cwd basename
 * Result is cached to avoid repeated filesystem lookups.
 */
let _projNameCache = null; // { cwd: string; name: string } | null
export function getProjectName(cwd) {
  // 子代理(固化/海马体)的 cwd 是会话目录,向上找不到 .git/.pi-project →
  // 会 fallback 成 session id 导致记忆写入 projects/<session-id>/ 假目录。
  // 主进程 spawn 时显式传 PI_PROJECT_NAME 覆盖推导。
  if (process.env.PI_PROJECT_NAME) return process.env.PI_PROJECT_NAME;
  if (_projNameCache && _projNameCache.cwd === cwd) return _projNameCache.name;

  let dir = path.resolve(cwd);
  const markers = [".dsh-project", ".pi-project"];
  while (true) {
    // Marker file with explicit project name（.dsh-project 优先，.pi-project 兼容旧项目）
    for (const markerName of markers) {
      const marker = path.join(dir, markerName);
      if (fs.existsSync(marker)) {
        const name = fs.readFileSync(marker, "utf-8").trim();
        if (name) {
          _projNameCache = { cwd, name };
          return name;
        }
      }
    }
    // Git repo → use parent dir name
    if (fs.existsSync(path.join(dir, ".git"))) {
      _projNameCache = { cwd, name: path.basename(dir) };
      return path.basename(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }

  // Fallback: use cwd basename
  _projNameCache = { cwd, name: path.basename(cwd) };
  return path.basename(cwd);
}

/**
 * Set or correct the project name. Writes a .dsh-project marker
 * (社区版只写 DSH 自己的标记；读取时兼容 .pi-project，方便从 Pi 迁移的用户)。
 */
export function setProjectName(cwd, name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  fs.writeFileSync(path.join(cwd, ".dsh-project"), trimmed, "utf-8");
  // Clear cache so next getProjectName re-computes with new state
  _projNameCache = null;
}

/** 递归复制目录（迁移/设置改路径用）。跳过符号链接/junction（避免把链接目标整个复制进来）。 */
export function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue; // 链接不跟随
    const s = path.join(src, item.name);
    const d = path.join(dst, item.name);
    if (item.isDirectory()) copyDir(s, d);
    else if (item.isFile()) fs.copyFileSync(s, d);
  }
}

/** 旧 Pi 记忆是否"有实质内容"（99% 用户没有 Pi 记忆系统——空壳/不存在的路径一律不迁移）。 */
function legacyHasRealContent(legacy) {
  try {
    if (!fs.existsSync(legacy)) return false;
    if (fs.existsSync(path.join(legacy, "core-prompt.md"))) return true;
    for (const sub of ["personal", "projects"]) {
      const dir = path.join(legacy, sub);
      if (!fs.existsSync(dir)) continue;
      // 至少有一个 .md 记忆文件才算实质内容（空目录/只有目录结构不算）
      const hasMd = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .some((e) => e.isFile() && e.name.endsWith(".md"));
      if (hasMd) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 检测 Pi agent 的旧记忆（~/.pi/agent/memory）是否存在实质内容。
 * **只检测、不迁移**——是否迁移由用户在 UI 里手动触发（见 migrateFromPi）。
 * 结果缓存（undefined=未检测，null=无，string=路径）——UI 每 5 秒轮询时不重复扫盘。
 * @returns 旧记忆路径（有实质内容）或 null。
 */
let legacyDetected = undefined;
export function detectLegacyMemory() {
  if (legacyDetected !== undefined) return legacyDetected;
  const legacy = path.join(HOME, ".pi", "agent", "memory");
  legacyDetected = fs.existsSync(legacy) && legacyHasRealContent(legacy) ? legacy : null;
  return legacyDetected;
}

/**
 * 手动迁移：把 Pi agent 的记忆（~/.pi/agent/memory）复制到当前 root。
 * - 仅在旧路径存在且含实质记忆内容时执行；
 * - 只在新 root 为空且无迁移标记时执行（幂等，目标非空一律拒绝）；
 * - 复制而非移动——Pi agent 的数据保持原样，两个 agent 各自独立演进；
 * - 跳过符号链接；完成后写 <root>/.migrated-from-pi.json 标记。
 * @returns 迁移信息；{ already: true } 表示此前已迁移过；{ error } 表示拒绝。
 */
export function migrateFromPi() {
  const legacy = detectLegacyMemory();
  if (!legacy) return { error: "未检测到 Pi agent 记忆（" + legacy + " 不存在或无实质内容）。" };
  const marker = path.join(root, ".migrated-from-pi.json");
  try {
    if (fs.existsSync(marker)) return { ...migrationInfo(), already: true };
    if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
      return { error: "目标目录非空且无迁移标记——为避免覆盖现有数据已跳过。请清空 <root> 后重试，或手动合并。" };
    }

    fs.mkdirSync(root, { recursive: true });
    let copied = 0;
    for (const name of ["core-prompt.md", "rules.md", "subagent-model.txt", "_index.md"]) {
      const s = path.join(legacy, name);
      if (fs.existsSync(s)) {
        fs.copyFileSync(s, path.join(root, name));
        copied++;
      }
    }
    for (const dir of ["personal", "projects", "maintenance"]) {
      const s = path.join(legacy, dir);
      if (fs.existsSync(s)) {
        copyDir(s, path.join(root, dir));
        copied++;
      }
    }
    const info = { from: legacy, at: new Date().toISOString(), copiedItems: copied };
    fs.writeFileSync(marker, JSON.stringify(info, null, 2), "utf-8");
    return info;
  } catch (e) {
    return { error: "迁移失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 读取迁移标记（供 UI/状态展示）。 */
export function migrationInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".migrated-from-pi.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 内存存储根目录。
 * 优先级：UI 设置（<DSH_HOME>/hpptools-memory.settings.json 的 root，用户最新意图）
 *        > 组合行 config.root（部署配置） > 默认 <DSH_HOME>/memory。
 */
function defaultRoot() {
  const dshHome = process.env.DSH_HOME || path.join(HOME, ".dsh");
  return path.join(dshHome, "memory");
}

let root = defaultRoot();

// ---------------------------------------------------------------- settings

function settingsPath() {
  const dshHome = process.env.DSH_HOME || path.join(HOME, ".dsh");
  return path.join(dshHome, "hpptools-memory.settings.json");
}

function loadSettingsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let settings = loadSettingsFile();

/** 读取 UI 设置（存储路径等）。 */
export function getSettings() {
  return { ...settings };
}

/** 保存 UI 设置（写 <DSH_HOME>/hpptools-memory.settings.json）。root 修改重启后生效。 */
export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  return { ...settings };
}

/**
 * Build the PATHS object from the current root. 每次 configureMemory() 重设
 * root 后都会重新计算，因此 PATHS 的属性始终指向最新的布局。
 * 布局与 pi 版完全一致，但根目录可配置。
 */
function buildPaths() {
  return {
    root,
    // Global (agent-level)
    corePrompt: path.join(root, "core-prompt.md"),
    rules: path.join(root, "rules.md"),
    personalDir: path.join(root, "personal"),
    personalSkillsDir: path.join(root, "personal", "skills"),

    // Project-level — centralized under <root>/projects/<name>/
    projectsRoot: path.join(root, "projects"),
    projectDir: (cwd) => path.join(root, "projects", getProjectName(cwd)),
    notebook: (cwd) =>
      path.join(root, "projects", getProjectName(cwd), "notebook.md"),
    memoriesDir: (cwd) =>
      path.join(root, "projects", getProjectName(cwd), "memories"),
    skillsDir: (cwd) =>
      path.join(root, "projects", getProjectName(cwd), "skills"),
    turnsDir: (cwd) =>
      path.join(root, "projects", getProjectName(cwd), "turns"),

    // Maintenance & subagent model (agent-level)
    maintenanceDir: path.join(root, "maintenance"),
    subagentModelFile: path.join(root, "subagent-model.txt"),
  };
}

export const PATHS = buildPaths();

/**
 * Configure the memory root directory. config 形如 `{ root?: string }`。
 * root 优先级：UI 设置（settings.root，用户最新意图） > 组合行 config.root > 默认。
 * 设置 root 后重新计算 PATHS（PATHS 的属性会被替换为基于新 root 的布局）。
 * @param {{ root?: string }} config
 */
export function configureMemory(config) {
  // UI 设置优先于组合行 config（用户最新意图）；组合行是兜底
  const chosen = settings.root || config?.root;
  if (typeof chosen === "string" && chosen.trim()) {
    // Expand a leading '~' (e.g. '~/.pi/agent/memory' from cordis.yml config)
    let p = chosen.trim();
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = path.join(HOME, p.slice(1));
    }
    root = path.resolve(p);
  }
  // PATHS 的对象引用可被整体替换（Object.assign 保持导出引用稳定）
  Object.assign(PATHS, buildPaths());
}
