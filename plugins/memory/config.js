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

/** 递归复制目录（迁移用）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dst, item.name);
    if (item.isDirectory()) copyDir(s, d);
    else if (item.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 一次性迁移：把 Pi agent 的记忆（~/.pi/agent/memory）复制到新 root。
 * - 只在新 root 为空且无迁移标记时执行（幂等）；
 * - 复制而非移动——Pi agent 的数据保持原样，两个 agent 各自独立演进；
 * - 完成后写 <root>/.migrated-from-pi.json 标记。
 * @param {string=} legacyOverride 测试缝隙：指定旧存储路径（默认 ~/.pi/agent/memory）。
 * @returns 迁移信息或 null（无需迁移）。
 */
export function migrateFromPiIfNeeded(legacyOverride) {
  const legacy = legacyOverride || path.join(HOME, ".pi", "agent", "memory");
  const marker = path.join(root, ".migrated-from-pi.json");
  try {
    if (fs.existsSync(marker)) return null;
    if (!fs.existsSync(legacy)) return null;
    if (fs.existsSync(root) && fs.readdirSync(root).length > 0) return null; // 非空且无标记 → 手动管理

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
  } catch {
    return null; // 迁移失败不阻断启动
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
 * 社区版默认 = <DSH_HOME>/memory（DSH 自有存储，不再借用 Pi 的 ~/.pi/agent/memory），
 * 可通过 configureMemory() 覆盖（组合行 config.root）。
 */
function defaultRoot() {
  const dshHome = process.env.DSH_HOME || path.join(HOME, ".dsh");
  return path.join(dshHome, "memory");
}

let root = defaultRoot();

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
 * Configure the memory root directory. config 形如 `{ root?: string }`；
 * 设置 root 后重新计算 PATHS（PATHS 的属性会被替换为基于新 root 的布局）。
 * 默认 root 保持 ~/.pi/agent/memory。
 * @param {{ root?: string }} config
 */
export function configureMemory(config) {
  if (
    config &&
    typeof config === "object" &&
    typeof config.root === "string" &&
    config.root.trim()
  ) {
    // Expand a leading '~' (e.g. '~/.pi/agent/memory' from cordis.yml config)
    let p = config.root.trim();
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = path.join(HOME, p.slice(1));
    }
    root = path.resolve(p);
  }
  // PATHS 的对象引用可被整体替换（Object.assign 保持导出引用稳定）
  Object.assign(PATHS, buildPaths());
}
