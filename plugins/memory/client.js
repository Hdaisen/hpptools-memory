/**
 * hpptools-memory — browser half（精简为兜底入口）
 *
 * 可视化面板已内置进 dsh-better-sidebar fork（plugins/better-sidebar，
 * 内置「🧠 记忆管理」tab）——本 client 半边不再注册侧边栏 tab（避免与
 * fork 原生面板重复入口），只保留一个侧边栏底部按钮：点击在新标签页
 * 打开独立控制台页面（/memory-ui 命令打印 URL）。有子代理运行时按钮
 * 显示橙色呼吸活动点（5s 轮询）。
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

    const GLOBAL_CSS = `
.hpptools-mem-btn {
  transition: background 160ms ease, color 160ms ease;
}
.hpptools-mem-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2e3440);
  color: var(--dsw-alias-label-primary, #d8dee9);
}
.hpptools-mem-dot {
  position: absolute;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #d9a45b);
  box-shadow: 0 0 6px var(--dsw-alias-state-warn-primary, #d9a45b);
  animation: hpptools-pulse 1.6s ease-in-out infinite;
}
@keyframes hpptools-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
`;

    function injectGlobalCss(ctx) {
      const style = document.createElement("style");
      style.id = "hpptools-memory-styles";
      style.textContent = GLOBAL_CSS;
      document.head.appendChild(style);
      return ctx.effect(() => { style.remove(); }, "hpptools-memory: global styles");
    }

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

    function MemoryButton(props) {
      const active = useActiveRuns();
      const wide = props.wide === true;
      return React.createElement(
        "button",
        {
          className: "hpptools-mem-btn",
          onClick: props.onOpen,
          title: "🧠 hpptools-memory 记忆控制台（在新标签页打开）",
          style: {
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: "100%", padding: "7px 10px",
            background: "none", border: "none", borderRadius: 8,
            color: "var(--dsw-alias-label-secondary, #8b93a5)",
            cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
          },
        },
        React.createElement("span", { style: { fontSize: 15, lineHeight: 1 } }, "🧠"),
        wide ? React.createElement("span", null, "记忆") : null,
        active > 0
          ? React.createElement("span", { className: "hpptools-mem-dot", style: { top: 3, right: wide ? 12 : 6 } })
          : null,
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      injectGlobalCss(ctx);
      // 兜底入口：独立控制台页面（fork 侧边栏面板是主入口）
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, {
          wide: props.wide,
          onOpen: () => { window.open(API_BASE + "/", "_blank"); },
        }),
      ));
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
