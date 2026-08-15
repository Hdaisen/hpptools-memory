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
 * Set or correct the project name. Writes BOTH a .dsh-project and a
 * .pi-project marker, so Pi agent 和 DSH 共享同一项目名。The marker is found
 * by the walk-up detection in getProjectName() — writing to any directory
 * above the marker-less zone is sufficient.
 */
export function setProjectName(cwd, name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  // Write both markers to cwd (walk-up starts from cwd, so nearest wins)
  fs.writeFileSync(path.join(cwd, ".dsh-project"), trimmed, "utf-8");
  fs.writeFileSync(path.join(cwd, ".pi-project"), trimmed, "utf-8");
  // Clear cache so next getProjectName re-computes with new state
  _projNameCache = null;
}

/**
 * 内存存储根目录，默认 ~/.pi/agent/memory。可通过 configureMemory() 重设。
 */
let root = path.join(HOME, ".pi", "agent", "memory");

/**
 * Build the PATHS object from the current root. 每次 configureMemory() 重设
 * root 后都会重新计算，因此 PATHS 的属性始终指向最新的布局。
 * 布局与 pi 版完全一致，但根目录可配置。
 */
function buildPaths() {
  return {
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
