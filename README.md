# hpptools-memory

**Pi Memory System → DeepSeek Harness 插件**（Pi Coding Agent 记忆系统的 DSH 移植版）

三层 Markdown 记忆系统，为 DeepSeek Harness 的 agent 提供：

1. **Core Prompt**（`core-prompt.md` + `rules.md` + Memory Index）— 每轮注入 system prompt（稳定前缀，缓存友好）
2. **Session Notebook**（`projects/<name>/notebook.md`）— 主 LLM 每轮主动维护的活动白板
3. **Long-term Memory**（`projects/<name>/memories/` + `personal/`）— 固化子代理沉淀的事实/偏好/决策/事件

**默认复用 `~/.pi/agent/memory` 存储**：与 Pi Coding Agent **共享同一份记忆数据**（迁移零成本，两个 agent 的记忆互相可见）。可通过组合行 `config.root` 换存储根。

---

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
│   ├── config.js            # PATHS（可配置 root，默认 ~/.pi/agent/memory）
│   ├── utils.js             # 关键词提取/Wiki 链接/索引/搜索/技能匹配（1:1 移植）
│   ├── diversity.js         # 多样性排序（1:1 移植）
│   ├── memory-ops.js        # _index.md 刷新/状态/网络健康报告/维护记录
│   ├── extract.js           # 提取管线（run_extraction.py 的 JS 移植）
│   ├── tools.js             # 9 个 ToolDefinition
│   ├── markitdown.js        # WSL MarkItDown 转换
│   ├── prompt.js            # systemPrompt 两个段（稳定优先）
│   ├── lifecycle.js         # 生命周期事件监听 + 消息转换
│   ├── subagents.js         # 固化/海马体子代理启动（'fork' provider）
│   └── commands.js          # /memory-clean、/memory-subagent-model
├── agents/                  # 子代理提示词（memory-extractor / memory-cleaner，DSH 适配）
├── templates/               # core-prompt.md / rules.md / notebook.md / memories/*（初始化用）
├── cordis.patch.yml         # 插件行（安装脚本会合并进 profile）
├── scripts/install.ps1      # Windows 安装（junction + patch 合并）
├── scripts/install.sh       # Linux/macOS 安装（symlink + patch 合并）
└── tests/integration.test.mjs  # 集成冒烟测试（mock Cordis ctx，27 项断言）
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
| 不裁剪对话历史 | DSH 自带 compaction 管线，不重复实现 |
| prompt 注入不做"按当前 prompt 自动搜索" | section provider 拿不到用户 prompt；用 `recall` 工具代替 |
| notebook `updateTaskWidget` 移除 | DSH 无 TUI widget |
| 子代理模型选择：`/memory-subagent-model <provider/model>` | DSH 无交互 select，改为命令参数；写入 `subagent-model.txt`，固化/海马体经 `agentOptions` 生效 |
| 会话锚点 = DSH sessionId（末 12 位） | pi 用 session file 名，DSH 的持久身份是 sessionId |

## 验证状态（2026-08-15）

- ✅ 静态插件包集成测试 27/27（工具/提示段/命令/生命周期注册、remember/recall 真实读写、extract 管线 raw + 摘要 + 关键动作）
- ✅ 本会话动态原型 `hpmm-1` 实测：`memory_status` 读到真实 `~/.pi/agent/memory`（Core Prompt ✅ / 8 文件 37 条目）；`remember` 写入 `projects/pi-memory-system/memories/events.md`（磁盘验证，pi 格式一致）；`recall` 检索命中

## 路线图

- [x] 核心记忆插件（工具 + 提示注入 + 提取管线 + 固化/海马体子代理）
- [ ] 端到端实测固化子代理（每 5 轮触发 → `fork` 子代理写长期记忆）
- [ ] settings 面板可视化记忆状态 / 一键 /memory-clean
- [ ] 可选插件拆分：`hpptools-ocr`（PaddleOCR）、`hpptools-auto`（任务自动执行）、`hpptools-token-tracker`（pi 仓库里还有这三个独立扩展，按需迁移）

## License

MIT
