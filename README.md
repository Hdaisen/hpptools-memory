# hpptools-memory

**Pi Memory System → DeepSeek Harness 插件**（Pi Coding Agent 记忆系统的 DSH 移植版）

三层 Markdown 记忆系统，为 DeepSeek Harness 的 agent 提供：

1. **Core Prompt**（`core-prompt.md` + `rules.md` + Memory Index）— 每轮注入 system prompt（稳定前缀，缓存友好）
2. **Session Notebook**（`projects/<name>/notebook.md`）— 主 LLM 每轮主动维护的活动白板
3. **Long-term Memory**（`projects/<name>/memories/` + `personal/`）— 固化子代理沉淀的事实/偏好/决策/事件

**存储路径（社区版规范化）**：默认 `<DSH_HOME>/memory`（如 `~/.dsh/memory`），不借用 Pi 的 `~/.pi/agent/memory`。
**Pi 记忆迁移是保守的**：只有当 `~/.pi/agent/memory` 存在**且含实质记忆内容**（core-prompt.md 或 personal/projects 下有 .md 文件）时才复制一次（幂等、非破坏、跳过符号链接，完成后写 `.migrated-from-pi.json` 标记）。99% 没有用过 Pi 记忆系统的用户完全零打扰。
可通过组合行 `config.root` 自定义存储位置。

## 🖥️ 可视化 — 记忆管理面板（在 dsh-better-sidebar fork 内）

记忆管理面板已**按 dsh-better-sidebar 源码风格内置进它的 fork**（[`.tmp-test/DSH-better-sidebar`](.tmp-test/DSH-better-sidebar)，分支 `feat/memory-console`）——原生 React 组件 + 内置 tab 注册，与 explorer / git / 终端同等的拖拽分栏体验：

- **🧠 记忆管理 tab**（内置，`+` 菜单 order 25）：概览（记忆统计卡片 + Pi 迁移）/ 文件（记忆 vault 树 + Markdown 预览编辑）/ 模型（子代理模型配置）/ 运行（子代理日志 + 清理）/ 设置（存储路径 / 迁移 / 文件夹）
- 本插件（hpptools-memory）作为**记忆后端**：提供 `/hpptools-memory/api/*`（同源 loopback 路由，面板数据来源）+ agent 记忆工具（remember / recall / notebook 等）+ 生命周期沉淀管线
- fork 的 `src/client/memory/` 面板通过 `fetch('/hpptools-memory/api/*')` 消费本插件的 API；两插件共享 `<DSH_HOME>/memory` 存储

面板内容（fork 内置 tab，原生 React）：

| 视图 | 内容 |
|------|------|
| **概览** | 存储根路径、迁移信息、core-prompt/rules/notebook 状态、项目/全局记忆统计（**已排除技能库**）、最近整理时间、活动子代理数、当前模型配置（每 5 秒刷新） |
| **文件** | 文件树（核心文件 / 会话小本本 / 全局记忆 / 当前项目记忆，分组折叠状态持久化）+ Markdown 预览 / 编辑 / 保存 + 条目导航 |
| **模型** | 固化子代理 / 海马体模型下拉选择——选项直接来自 **DeepSeek Harness 已配置的模型**（`llm.listProviders` + `listModels`） |
| **运行** | 最近运行列表（类型/状态/耗时/终态原因），点击行查看**实时活动日志**（每 3 秒刷新），一键「运行记忆清理」 |
| **设置** | 存储路径修改（可复制现有数据）、Pi 记忆迁移、打开存储文件夹 |

**UI 工程（fork 内实现，风格与 dsh-better-sidebar 完全一致）**：DSH 语义 token（`--dsw-alias-*`）全程、SideCard 卡片网格、扁平 hairline、图标控件 hover 填充；i18n 走 better-sidebar 的 `locales.ts` 词典（zh/en 跟随 DSH locale）；错误兜底（面板错误边界）；轮询随 `visible` 暂停。

> 注：hpptools-memory 插件自身的 `client.js` 仍保留一个「消费 betterSidebar 服务」的 iframe 版 tab 注册作为兜底——若使用 fork 内置面板，两者会各出现一个入口（`记忆管理` 原生版 + `hpptools-memory:console` iframe 版），可卸载本插件的 client 半边或删除该注册避免重复。

独立访问完整版控制台（不含 fork）：`/memory-ui` 命令打印 URL。

> 记忆统计口径：`walkMarkdownFiles` 排除 `skills/` 技能库目录（SKILL.md 是程序性技能，有独立的注入机制），技能数量单独显示——避免把技能库文件算进"记忆条目"。

## 为什么是独立新项目（不是 pi-memory-system 的分支）

| 维度 | 结论 |
|------|------|
| 代码形态 | pi 版是 `ExtensionAPI` 插件（TS→dist 构建）；DSH 版是 Cordis 插件（ESM JS，零构建直接加载） |
| 生命周期 API | `before_agent_start`/`agent_end`/`session_shutdown` → `systemPrompt.section`/`agent/turn-stopping`/`agent/disposed`——**完全不同的 API 面，是重写不是分支** |
| 仓库工作流 | pi 仓库有 main=通用发布版 / personal=个人版 的分支策略和"安装版→仓库"同步流程；混入新生态会互相污染 |
| 结论 | **单独新项目**，原 pi-memory-system 保持原样继续使用 |

## 架构映射（pi → DSH）

| Pi Coding Agent | DeepSeek Harness | 实现 |
|---|---|---|
| `before_agent_start`（注入记忆） | `systemPrompt.section()` | `prompt.js`：`memory:core`（-90，稳定段）+ `memory:context`（65，动态段） |
| `context`（裁剪历史） | （DSH 自带 compaction 管线，不移植） | — |
| `agent_end`（写 raw + 摘要 + 每 5 轮固化） | `agent/turn-stopping`（serial） | `lifecycle.js` + `extract.js`（run_extraction.py 的 JS 移植） |
| `session_start`（会话目录锚点） | `agent/session-start` | `lifecycle.js`（sessionId 末 12 位作锚点，resume 复用目录） |
| `session_shutdown`（余数 ≥3 补固化） | `agent/disposed` | `lifecycle.js` |
| `tool_result`（二进制自动 MarkItDown） | `tools/post-execute`（waterfall） | `lifecycle.js` |
| `registerTool`（9 个工具） | `ctx.tools.register(defineTool(...))` | `tools.js`（remember/recall/forget/supersede/notebook/memory_status/convert_file/confirm/set_project） |
| `registerCommand`（/memory-clean 等） | `ctx.commands.register(...)` | `commands.js`（/memory-clean、/memory-subagent-model） |
| `spawn pi -p + memory-extractor.md` | `ctx.subagents.start('fork', {toolFilter})` | `subagents.js`（进程内子代理 + 工具白名单，无需外部 CLI） |
| `run_extraction.py`（Python 管线） | `extract.js`（纯 JS，零依赖） | 含 raw-<n>.md 格式化、密钥脱敏、大输出哈希截断、关键动作提取 |
| `ctx.ui.setStatus` / TUI 面板 | DSH 无 TUI（Web UI 原生展示子代理进度） | 移除 |

## 目录结构

```
hpptools_memory/
├── plugins/memory/          # Cordis 插件包（ESM JS，零构建）
│   ├── index.js             # 插件入口（name/inject/apply）
│   ├── config.js            # PATHS（默认 <DSH_HOME>/memory）+ Pi 记忆一键迁移
│   ├── utils.js             # 关键词提取/Wiki 链接/索引/搜索/技能匹配（1:1 移植）
│   ├── diversity.js         # 多样性排序（1:1 移植）
│   ├── memory-ops.js        # _index.md 刷新/状态/网络健康报告/维护记录
│   ├── extract.js           # 提取管线（run_extraction.py 的 JS 移植）
│   ├── tools.js             # 9 个 ToolDefinition
│   ├── markitdown.js        # WSL MarkItDown 转换
│   ├── prompt.js            # systemPrompt 两个段（稳定优先）
│   ├── lifecycle.js         # 生命周期事件监听 + 消息转换
│   ├── subagents.js         # 固化/海马体子代理启动（'fork' provider）
│   ├── commands.js          # /memory-clean、/memory-subagent-model、/memory-ui
│   ├── models.js            # 固化/海马体模型分离配置（models.json）
│   ├── runs.js              # 子代理运行登记 + 实时活动日志（session/event 观察）
│   ├── webui.js             # webServer 路由（页面 + JSON API）
│   ├── webui.html           # 控制台页面（自包含单页，betterSidebar tab iframe 嵌入；?embed= 定位）
│   ├── client.js            # 浏览器半边：侧边栏 🧠 按钮 + betterSidebar「记忆管理」tab 注册（__ModuleLoader__ 入口格式）
│   └── cordis.patch.yml     # 插件行（安装脚本会合并进 profile）
├── agents/                  # 子代理提示词（memory-extractor / memory-cleaner，DSH 适配）
├── templates/               # core-prompt.md / rules.md / notebook.md / memories/*（初始化用）
├── cordis.patch.yml         # 插件行（安装脚本会合并进 profile）
├── scripts/install.ps1      # Windows 安装（junction + patch 合并）
├── scripts/install.sh       # Linux/macOS 安装（symlink + patch 合并）
└── tests/
    ├── integration.test.mjs    # 集成冒烟测试（mock Cordis ctx，38 项断言；迁移段待更新）
    └── verify-webui.mjs        # WebUI 静态验证（路由/结构/i18n/错误兜底/现场恢复/betterSidebar 消费，46 项断言）
```

## 安装

### Windows
```powershell
.\scripts\install.ps1        # 默认 DSH_HOME = $env:DSH_HOME 或 ~/.dsh
```
脚本做两件事：
1. `plugins/memory` → `<DSH_HOME>/profiles/node_modules/hpptools-memory`（junction）
2. 插件行（含 `config.root`）合并进 `<DSH_HOME>/profiles/web/cordis.patch.yml`

然后**重启 DeepSeek Harness**（插件在启动时加载）。验证：agent 的工具列表出现 `remember`/`recall`/`memory_status` 等，prompt 中出现 `memory:core` / `memory:context` 段。

### Linux / macOS
```bash
./scripts/install.sh
```

### 本地测试（脱离宿主）
```bash
node tests/integration.test.mjs
```
（`node_modules/@deepseek-ai/dsh-tools` 是本地测试 stub，gitignored；宿主运行时提供真实实现。）

## 与 pi 版的行为差异（有意为之）

| 差异 | 原因 |
|------|------|
| 存储根 = `<DSH_HOME>/memory`（非 `~/.pi/agent/memory`），首次启动自动迁移 Pi 记忆 | 社区版插件不应依赖另一个 agent 的私有路径；迁移复制而非移动 |
| 固化/海马体模型分开配置（`models.json`），UI 下拉从 DSH 已配置模型选择 | pi 版只有一个统一 subagent-model.txt |
| 不裁剪对话历史 | DSH 自带 compaction 管线，不重复实现 |
| prompt 注入不做"按当前 prompt 自动搜索" | section provider 拿不到用户 prompt；用 `recall` 工具代替 |
| notebook `updateTaskWidget` 移除 | DSH 无 TUI widget |
| 子代理进度：`runs.js` 观察子代理 session 事件 → Web UI 实时日志 | pi 版用 TUI 面板；DSH 用浏览器 |
| 会话锚点 = DSH sessionId（末 12 位） | pi 用 session file 名，DSH 的持久身份是 sessionId |
| `set_project` 只写 `.dsh-project`（读取兼容 `.pi-project`） | 存储已分离，标记也各管各的 |

## 验证状态（2026-08-15）

- ✅ 静态插件包集成测试 41/41（工具/提示段/命令/生命周期注册、remember/recall 真实读写、extract 管线、模型配置、**迁移空壳判断**、**skills 排除统计**、运行登记、Web 路由、client 半边语法）——**注意**：`tests/integration.test.mjs` 迁移段仍引用旧 API `migrateFromPiIfNeeded`（config.js 已重构为 `detectLegacyMemory` + 无参 `migrateFromPi`，路径写死 `~/.pi/agent/memory`），该段断言当前会失败；修复需 mock `os.homedir()` 并处理 `detectLegacyMemory` 结果缓存，待跟进
- ✅ 本会话动态原型实测：
  - `memory_status` 读到真实记忆库；`remember` 写入记忆文件（磁盘验证，pi 格式一致）；`recall` 检索命中
  - 控制台页面 200 + API 全通：模型列表（2 provider / 18 模型，来自真实配置）、模型设置写入 `models.json`、**真实海马体子代理经 UI 按钮触发，runs 实时显示其工具活动（read/工具完成）与最终报告**
  - 统计口径修正实测：全局记忆 811 文件/3494 条目（含技能库）→ **27 文件/62 条目 + 99 技能**（排除 `personal/skills/` 技能库后）
- ✅ 2026-08-15 UI 重设计回归：webui.html 内联 JS 语法检查通过、i18n 键完整性校验通过（zh/en 对齐）、元素 ID 引用全解析、webui.js 12 条路由注册正常、client.js 语法通过（`tests/verify-webui.mjs`，46 项断言）
- ✅ 2026-08-15 架构定稿：**弃用自研侧边栏壳，改为消费 dsh-better-sidebar 服务**（`ctx.betterSidebar.registerTab` 注册「记忆管理」tab，可选服务 + 20s 超时降级）——侧边栏框架/拖拽分栏/布局持久化全部交给 better-sidebar，避免重复实现与宿主冲突
- ⏳ Client 半边（侧边栏按钮 + 详情列）重设计后需**安装后重启 DSH** 验证（动态 client 插件需要授权，本会话审批策略为 never）

## 已知限制

- **动态插件沙箱**（本会话原型）：无 `Buffer`/`AbortController`/`fetch`，webui 的 body 解析用字符串累加、子代理 signal 用 duck-typed 永不中止对象——**正式静态插件无此限制**（完整 Node 环境）
- 控制台 API 是 loopback 同源路由（无鉴权）——本地单机使用场景可接受，勿把端口暴露到公网

## 路线图

- [x] 核心记忆插件（工具 + 提示注入 + 提取管线 + 固化/海马体子代理）
- [ ] 端到端实测固化子代理（每 5 轮触发 → `fork` 子代理写长期记忆）
- [ ] settings 面板可视化记忆状态 / 一键 /memory-clean
- [ ] 可选插件拆分：`hpptools-ocr`（PaddleOCR）、`hpptools-auto`（任务自动执行）、`hpptools-token-tracker`（pi 仓库里还有这三个独立扩展，按需迁移）

## License

MIT
