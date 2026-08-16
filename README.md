# hpptools-memory

**DeepSeek Harness 的 Markdown 记忆系统插件**——为 agent 提供跨会话的长期记忆能力。

核心信念：*大脑是用来思考的，不是用来记忆的。* 把每次会话产生的知识沉淀为可检索、可维护的 Markdown 文件，让 agent 在下一轮对话、下一次会话中仍然记得住。

## 它解决什么问题

大模型对话是无状态的——每次会话结束，上下文就清空了。hpptools-memory 在 DeepSeek Harness 的 agent 生命周期中接入三层记忆，让「记忆」成为持久化的基础设施：

| 层 | 载体 | 作用 |
|---|---|---|
| **Core Prompt** | `core-prompt.md` + `rules.md` + Memory Index | 每轮注入 system prompt 的稳定前缀（缓存友好），定义身份、行为规则与记忆目录 |
| **Session Notebook** | `projects/<name>/notebook.md` | 主 LLM 每轮主动维护的活动白板：当前任务、待办、跨轮约束 |
| **Long-term Memory** | `projects/<name>/memories/` + `personal/` | 固化子代理沉淀的事实 / 偏好 / 决策 / 事件，跨会话长期有效 |

## 功能特性

- **9 个记忆工具**：`remember` / `recall` / `forget` / `supersede` / `notebook` / `memory_status` / `convert_file` / `confirm` / `set_project`——读写记忆、按项目隔离、Wiki 链接关联检索
- **提示词注入**：`memory:core`（稳定段，-90 优先级）+ `memory:context`（动态段，65 优先级）两个 system prompt section，自动注入当前会话的 notebook、最近对话摘要与关联记忆
- **生命周期管线**：
  - 会话开始 → 建立会话短期记忆目录（`turns/sessions/<id>`，按 sessionId 锚点跨重启复用）
  - 每轮结束 → 写 `raw-<n>.md` 备份 + 追加 `dialogue-summary.md` 摘要
  - 每 5 轮 → 触发固化子代理，把对话沉淀进长期记忆
  - 会话结束 → 余数 ≥ 3 时补固化
  - 二进制文件读取失败 → 自动 MarkItDown 转换
- **两个记忆子代理**（进程内 `fork`，工具白名单限制，无 shell 权限）：
  - **固化子代理**：把增量对话提炼为事实 / 偏好 / 决策 / 事件写入记忆库
  - **海马体子代理**：手动触发（`/memory-clean`），去重、修复污染、supersede 过期条目、报告死链
- **可视化控制台**（Web UI + 侧边栏面板）：
  - **概览**：存储根路径、core-prompt/rules/notebook 状态、项目与全局记忆统计（排除技能库）、最近整理时间、活动子代理数、当前模型配置
  - **文件**：记忆库文件树（核心文件 / 会话小本本 / 全局记忆 / 当前项目记忆）+ Markdown 预览 / 编辑 / 保存 + 条目导航
  - **模型**：固化 / 海马体子代理模型下拉选择——选项直接来自 DeepSeek Harness 已配置的模型
  - **运行**：子代理运行列表（类型 / 状态 / 耗时 / 终态原因）+ 实时活动日志
  - **设置**：存储路径修改（可复制现有数据）、打开存储文件夹

## 架构

📊 **[架构与机制图（中文版）](docs/architecture.zh.html)** — 组件结构 + 运行时机制：每轮注入什么、每轮落盘什么、每 5 轮固化、短期/长期记忆分层

> 架构图是交互式 HTML（可缩放、聚焦、切换明暗主题），由 archify 生成。

## 致谢

记忆管理面板（右侧栏 🧠 记忆管理 tab）的 UI 基于 **[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)** 开发（fork 并内置了 memory tab 与记忆控制台五视图），感谢其作者与社区。后端记忆管线（工具 / 生命周期 / 子代理）为独立实现。

### 一轮对话的记忆机制

1. **会话开始**（`agent/session-start`）→ 建立会话短期记忆目录 `turns/sessions/<id>`，刷新记忆索引
2. **每轮调用前注入两段 system prompt**：
   - **Core 段**（稳定，-90 优先级）：`core-prompt.md` + `rules.md` + Memory Index——缓存友好
   - **Context 段**（动态，65 优先级）：`notebook.md` + 最近 5 轮对话摘要 + 关联记忆 + 维护日志
3. **LLM 回复期间**可主动调用 9 个记忆工具：`remember` / `recall` / `forget` / `supersede` / `notebook` / `memory_status` / `convert_file` / `confirm` / `set_project`
4. **每轮结束**（`agent/turn-stopping`）产生两个文件：
   - `raw-<n>.md`：本轮完整对话备份（密钥脱敏、大输出哈希截断）
   - `dialogue-summary.md`：追加本轮摘要与关键动作行——**下一轮只注入它的最后 5 节**（成本不随轮次增长）
5. **每 5 轮**异步触发固化子代理（不阻塞回合关闭）；会话结束时摘要余数 ≥ 3 也补固化
6. **固化子代理**读最近 5 节摘要、需要细节时回查 `raw-<n>.md`，用 `remember` 把知识沉淀进长期记忆（`memories/` + `personal/`）
7. **海马体子代理**（`/memory-clean` 手动触发）对长期记忆去重、修复污染、supersede 过期条目、补链报告

**短期 vs 长期记忆**：短期（`turns/sessions/<id>/` + `notebook.md`）服务于当前会话——每轮注入、会话结束归档；长期（`memories/` + `personal/`）跨会话沉淀——固化子代理写入、`recall` 检索、海马体维护。

插件以 Cordis 插件（ESM JS，零构建）形式运行在 DeepSeek Harness 宿主内：

| 模块 | 职责 |
|---|---|
| `index.js` | 插件入口，装配各模块 |
| `config.js` | 存储路径解析（默认 `<DSH_HOME>/memory`）+ 项目名推导（`.dsh-project` 标记 / git 目录） |
| `prompt.js` | 两个 system prompt section（稳定段 + 动态段） |
| `tools.js` | 9 个 LLM 记忆工具 |
| `lifecycle.js` | 生命周期事件监听：会话目录、raw 备份、摘要、固化触发、MarkItDown |
| `extract.js` | 对话提取管线（纯 JS 零依赖）：raw 格式化、密钥脱敏、大输出哈希截断、关键动作提取 |
| `subagents.js` | 固化 / 海马体子代理启动（进程内 fork + 工具白名单） |
| `runs.js` | 子代理运行登记 + 实时活动日志 |
| `commands.js` | `/memory-clean`、`/memory-subagent-model`、`/memory-ui` |
| `webui.js` + `webui.html` | webServer 路由：控制台页面 + JSON API |
| `models.js` | 固化 / 海马体模型分离配置（`models.json`） |
| `client.js` | 浏览器半边（侧边栏入口） |

### 存储布局

```
<DSH_HOME>/memory/
├── core-prompt.md            # 主脑身份与思考框架
├── rules.md                  # 无条件行为规则
├── projects/<name>/          # 按项目隔离
│   ├── notebook.md           # 会话小本本（主 LLM 维护）
│   ├── memories/             # 长期记忆（facts / preferences / decisions / events）
│   │   └── _index.md         # 记忆索引
│   └── turns/sessions/<id>/  # 会话短期记忆（raw-<n>.md + dialogue-summary.md）
├── personal/                 # 跨项目通用知识
└── maintenance/              # 海马体整理日志
```

## 安装

### 组件构成

hpptools-memory 由**两个包**组成：

| 包 | 角色 | 发布状态 |
|---|---|---|
| `hpptools-memory` | **记忆后端**：9 个记忆工具、提示词注入、生命周期管线、固化/海马体子代理、记忆 API | ✅ 已发布 npm `0.1.0` |
| `dsh-better-sidebar` | **面板容器**：右侧栏 + 🧠 记忆管理 tab（五个视图） | 面板已 PR 至上游 `omdsh-dev/DSH-better-sidebar`（[#143](https://github.com/omdsh-dev/DSH-better-sidebar/pull/143)），合并前官方包暂无记忆 tab |

> **只装后端**（工具/子代理/提示词注入，无可视化面板）：
> ```bash
> cd ~/.dsh && dsh plugin --profile web add hpptools-memory
> ```

### 方式一：完整安装（后端 + 面板）——从源码（当前可用）

上游 PR 合并前，完整记忆控制台需从本仓库安装（内置 vendored 面板）：

**Windows**
```powershell
.\scripts\install.ps1        # 默认 DSH_HOME = $env:DSH_HOME 或 ~/.dsh
```

**Linux / macOS**
```bash
./scripts/install.sh
```

脚本将后端（`plugins/memory`）与面板（`plugins/better-sidebar`）一起装入 `<DSH_HOME>/profiles/node_modules/`，并把插件行合并进 `<DSH_HOME>/profiles/web/cordis.patch.yml`。**重启 DeepSeek Harness 后生效**。

### 方式二：完整安装——上游 PR 合并后（两个官方包）

```bash
cd ~/.dsh
dsh plugin --profile web add dsh-better-sidebar     # 面板（官方包，合并后自带记忆 tab）
dsh plugin --profile web add hpptools-memory        # 记忆后端
```

### 安装后验证

- agent 工具列表出现 `remember` / `recall` / `memory_status` / `notebook` 等
- prompt 中出现 `memory:core` / `memory:context` 段
- 右侧栏「+」菜单出现 🧠 记忆管理 tab（概览 / 文件 / 模型 / 运行 / 设置）
- 运行 `/memory-clean` 验证海马体子代理，`recall` 验证检索

存储位置默认 `<DSH_HOME>/memory`，可通过 `cordis.patch.yml` 的 `config.root` 自定义。

## 发布状态与分发

DeepSeek Harness **没有官方中央插件市场**——插件通过 npm / GitHub 分发，靠社区目录发现：

- **npm**：`hpptools-memory@0.1.0` 已发布（latest），用户侧安装：`cd ~/.dsh && dsh plugin --profile web add hpptools-memory`
- **GitHub**：`Hdaisen/hpptools-memory`（public，tag `v0.1.0`），直装：`cd ~/.dsh && dsh plugin --profile web add github:Hdaisen/hpptools-memory#v0.1.0`
- **面板上游 PR**：记忆管理 tab 已提交 [omdsh-dev/DSH-better-sidebar#143](https://github.com/omdsh-dev/DSH-better-sidebar/pull/143)（含推荐插件目录条目——合并后官方 better-sidebar 设置页「添加插件」弹窗可一键发现 hpptools-memory）

**维护者发布流程**：

```bash
cd plugins/memory && npm publish    # 发布后端（files 白名单已含 agents/）
```

发布前检查清单：
- [ ] `plugins/memory/package.json` 的 `files` 含 `agents/`（固化子代理提示词，缺失会导致固化静默失败）
- [ ] `npm pack --dry-run` 确认 tarball 含全部运行时文件
- [ ] 面板改动需在 `.tmp-test/DSH-better-sidebar` 克隆构建 lib 后同步 vendored + profile

## 本地测试（脱离宿主）

```bash
node tests/integration.test.mjs
node tests/verify-webui.mjs
```

（`node_modules/@deepseek-ai/dsh-tools` 是本地测试 stub，gitignored；宿主运行时提供真实实现。）

## 使用

**命令**：

| 命令 | 作用 |
|---|---|
| `/memory-ui` | 打印可视化控制台 URL |
| `/memory-clean` | 手动触发海马体整理子代理 |
| `/memory-subagent-model extractor\|cleaner <provider/model>` | 设置子代理模型（推荐在控制台「模型」页下拉选择） |

**工具**（agent 直接调用）：

| 工具 | 作用 |
|---|---|
| `remember` | 写入长期记忆（自动归类 fact / preference / decision / event） |
| `recall` | 搜索记忆（按置信度过滤，支持模糊匹配） |
| `forget` / `supersede` | 删除 / 标记过期记忆条目 |
| `notebook` | 查看 / 更新会话小本本 |
| `memory_status` | 查看记忆系统文件状态与条目概览 |
| `convert_file` | 二进制文件转 Markdown（MarkItDown） |
| `confirm` | 交互式 y/n 确认 |
| `set_project` | 修正当前项目名（写 `.dsh-project` 标记） |

## 已知限制

- 控制台 API 是 loopback 同源路由（无鉴权）——本地单机使用场景可接受，勿把端口暴露到公网

## License

MIT
