/**
 * hpptools-memory — browser half（直接嵌入 DSH Web UI）
 *
 * - sidebar.footer.action：侧边栏底部 🧠 按钮（宽侧边栏显示文字，rail 模式仅图标；
 *   有子代理运行时按钮上显示橙色活动点，5s 轮询）；点击打开宿主右侧详情列
 * - details：嵌入宿主详情列（对话区自动让位、宿主拖拽手柄调宽；替换宿主
 *   自带的工具详情面板——single slot 无法共存）。面板 iframe 嵌入 Host
 *   提供的控制台页面（/hpptools-memory/，与独立访问同一页面，零重复实现）
 * - theme：宿主主题 token（--dsw-*）通过 postMessage 注入 iframe，页面配色
 *   随应用主题（浅色/深色）自动切换
 *
 * 构建格式：DSH web 客户端入口的 __ModuleLoader__ 包装（与官方 client 包一致）。
 * package.json 需声明 "dsh": { "client": { "platform": "web", "inject": [...] } }
 * 并导出 "./client"。
 */
window.__ModuleLoader__.load({
  id: "hpptools-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    const API_BASE = "/hpptools-memory";

    // ---------------- 活动子代理轮询（按钮红点指示） ----------------
    function useActiveRuns() {
      const [active, setActive] = React.useState(0);
      React.useEffect(() => {
        let cancelled = false;
        const tick = async () => {
          try {
            const res = await fetch(API_BASE + "/api/overview", { cache: "no-store" });
            if (!res.ok) return;
            const data = await res.json();
            if (!cancelled) setActive(data.activeRuns || 0);
          } catch { /* host 未安装/未就绪时静默 */ }
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);
      return active;
    }

    // ---------------- 侧边栏底部按钮（打开宿主详情列） ----------------
    function MemoryButton(props) {
      const active = useActiveRuns();
      const wide = props.wide === true;
      return React.createElement(
        "button",
        {
          onClick: props.onOpen,
          title: "🧠 hpptools-memory 记忆控制台（打开右侧面板）",
          style: {
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "8px 10px",
            background: "none",
            border: "none",
            color: "var(--text-2, #8b93a5)",
            cursor: "pointer",
            fontSize: 13,
            whiteSpace: "nowrap",
          },
        },
        React.createElement("span", { style: { fontSize: 16 } }, "🧠"),
        wide ? React.createElement("span", null, "记忆") : null,
        active > 0
          ? React.createElement("span", {
              style: {
                position: "absolute",
                top: 4,
                right: wide ? 14 : 8,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#d9a45b",
                boxShadow: "0 0 6px #d9a45b",
              },
            })
          : null,
      );
    }

    // ---------------- 详情列面板（iframe 嵌入控制台） ----------------
    // 宽度/开合由宿主 details 列管理（对话区 grid 自动让位，宿主手柄拖宽）。
    function MemoryPanel(props) {
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100%", minWidth: 0 } },
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "var(--dsw-alias-bg-layer-1, #1c1f26)",
              borderBottom: "1px solid var(--dsw-alias-border-l1, #2e3440)",
              color: "var(--dsw-alias-label-primary, #d8dee9)",
              fontSize: 13,
              fontWeight: 600,
              flexShrink: 0,
            },
          },
          React.createElement("span", null, "🧠 hpptools-memory"),
          React.createElement("span", { style: { flex: 1 } }),
          React.createElement(
            "a",
            {
              href: API_BASE + "/",
              target: "_blank",
              rel: "noreferrer",
              style: { color: "var(--dsw-alias-label-secondary, #8b93a5)", textDecoration: "none", fontSize: 12, marginRight: 8 },
            },
            "新标签页打开 ↗",
          ),
          React.createElement(
            "button",
            {
              onClick: props.onClose,
              title: "关闭面板",
              style: {
                background: "none",
                border: "none",
                color: "var(--dsw-alias-label-secondary, #8b93a5)",
                cursor: "pointer",
                fontSize: 14,
                padding: "2px 6px",
              },
            },
            "✕",
          ),
        ),
        React.createElement("iframe", {
          src: API_BASE + "/",
          "data-hpptools-memory": true,
          style: { flex: 1, border: "none", width: "100%", background: "var(--dsw-alias-bg-base, #14161a)" },
        }),
      );
    }

    // ---------------- 主题同步：把宿主 --dsw-* token 推给 iframe ----------------
    function syncTheme(theme) {
      const push = (snapshot) => {
        for (const f of document.querySelectorAll("iframe[data-hpptools-memory]")) {
          f.contentWindow?.postMessage(
            { type: "hpptools-theme", colorScheme: snapshot.colorScheme, tokens: snapshot.tokens },
            "*",
          );
        }
      };
      push(theme.getTheme());
      theme.on("theme/change", push);
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, {
          wide: props.wide,
          onOpen: () => ctx.get("layout")?.openDetails(),
        }),
      ));
      // 嵌入宿主详情列（single slot：替换宿主工具详情面板）。
      slots.inject("details", () => slots.register(
        { name: "details", id: "hpptools-memory", order: 10 },
        () => React.createElement(MemoryPanel, {
          onClose: () => ctx.get("layout")?.closeDetails(),
        }),
      ));
      const theme = ctx.get("theme");
      if (theme !== undefined) syncTheme(theme);
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
