/**
 * hpptools-memory — browser half（直接嵌入 DSH Web UI）
 *
 * 基于 dsh-better-sidebar 服务化基座：把记忆管理控制台注册为它的一个
 * tab（ctx.betterSidebar.registerTab），侧边栏框架 / 拖拽分栏 / 宽度 /
 * 布局持久化全部由 better-sidebar 提供，本插件只贡献面板内容。
 *
 * - betterSidebar 已安装 → 注册「🧠 记忆管理」tab（iframe 嵌入
 *   /hpptools-memory/?embed=1，复用 Host 渲染的控制台页面）；
 *   侧边栏底部 🧠 按钮点击 → openTab（带 url seed 的内容型打开，
 *   自动展开面板并聚焦记忆 tab）
 * - betterSidebar 未安装 → 按钮降级为在新标签页打开控制台
 *   （/memory-ui 命令仍可用）
 * - theme + locale：宿主主题 token（--dsw-*）与语言偏好（DSH locale，
 *   zh/en）通过 postMessage 注入 iframe；语言切换实时推送
 * - 有子代理运行时侧边栏按钮显示橙色呼吸活动点（5s 轮询）
 *
 * 视觉：DSH 语义 token（--dsw-alias-*）、28px 圆形图标控件（hover 填充）。
 * 全局样式经 <style> 注入，由插件 fiber 管理生命周期（HMR-safe）。
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
    const TAB_ID = "hpptools-memory:console";

    // ============================================================
    // 全局样式（HMR-safe：apply 注入，fiber 卸载时移除）
    // ============================================================
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
/* 记忆 tab 内的 iframe 铺满面板 */
.hpptools-memory-console { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: var(--dsw-alias-bg-base, #14161a); }
`;

    function injectGlobalCss(ctx) {
      const style = document.createElement("style");
      style.id = "hpptools-memory-styles";
      style.textContent = GLOBAL_CSS;
      document.head.appendChild(style);
      return ctx.effect(() => { style.remove(); }, "hpptools-memory: global styles");
    }

    // ============================================================
    // 活动子代理轮询（按钮红点指示）
    // ============================================================
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

    // ============================================================
    // 错误边界（渲染崩溃 → 错误条，不白屏）
    // ============================================================
    class PanelBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      componentDidCatch(error, info) { console.error("[hpptools-memory] panel render error:", error, info); }
      render() {
        if (this.state.error !== null) {
          const isZh = this.props.isZh !== false;
          return React.createElement(
            "div",
            { style: {
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", fontSize: 12.5, lineHeight: 1.5,
              color: "var(--dsw-alias-state-error-primary, #c9685f)",
              background: "color-mix(in srgb, var(--dsw-alias-state-error-primary, #c9685f) 10%, transparent)",
              borderBottom: "1px solid var(--dsw-alias-border-l1, #2e3440)",
            } },
            React.createElement("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" } },
              "[hpptools-memory] " + this.state.error),
            React.createElement("button", {
              onClick: () => this.setState({ error: null }),
              style: {
                flex: "none", padding: "3px 10px", fontSize: 12,
                color: "var(--dsw-alias-label-primary, #d8dee9)",
                background: "var(--dsw-alias-bg-layer-2, #232733)",
                border: "1px solid var(--dsw-alias-border-l2, #3b4252)",
                borderRadius: 6, cursor: "pointer",
              },
            }, isZh ? "重试" : "Retry"),
          );
        }
        return this.props.children;
      }
    }

    // ============================================================
    // 记忆控制台 tab 内容（iframe 嵌入控制台页面）
    // ============================================================
    function ConsoleView() {
      return React.createElement("iframe", {
        className: "hpptools-memory-console",
        src: API_BASE + "/?embed=1",
        "data-hpptools-memory": true,
        title: "hpptools-memory console",
      });
    }

    // ============================================================
    // 注册到 betterSidebar（可选服务：检测 + 轮询等待加载顺序）
    // ============================================================
    function registerConsoleTab(ctx, svc) {
      const isZh = () => {
        try { return String(ctx.get("locale")?.getSnapshot().active ?? "").toLowerCase().startsWith("zh"); }
        catch { return true; }
      };
      return ctx.effect(() => svc.registerTab({
        id: TAB_ID,
        title: () => (isZh() ? "记忆管理" : "Memory"),
        icon: () => "🧠",
        order: 60,
        single: true,
        component: () => React.createElement(
          PanelBoundary,
          { isZh: isZh() },
          React.createElement(ConsoleView),
        ),
      }), "hpptools-memory: register console tab");
    }

    /**
     * 等待可选服务出现（client 插件加载顺序不保证；服务缺失时超时放弃）。
     * 返回 disposer：卸载时注销已注册资源并停止轮询。
     */
    function waitForService(ctx, name, cb) {
      const svc = ctx.get(name);
      if (svc !== undefined) { return cb(svc) || (() => {}); }
      let cleanup = () => {};
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        const s = ctx.get(name);
        if (s !== undefined) {
          clearInterval(timer);
          cleanup = cb(s) || (() => {});
          return;
        }
        if (attempts >= 80) clearInterval(timer); // ~20s 超时
      }, 250);
      return () => { cleanup(); clearInterval(timer); };
    }

    /** 打开记忆控制台：betterSidebar 内容型打开（自动展开面板）或降级新标签页。 */
    function openConsole(ctx) {
      const svc = ctx.get("betterSidebar");
      if (svc !== undefined && typeof svc.openTab === "function") {
        try {
          const isZh = String(ctx.get("locale")?.getSnapshot().active ?? "").toLowerCase().startsWith("zh");
          svc.openTab({ type: TAB_ID, url: "hpptools-memory", title: isZh ? "记忆管理" : "Memory" });
          return;
        } catch (e) {
          console.error("[hpptools-memory] openTab failed:", e);
        }
      }
      window.open(API_BASE + "/", "_blank");
    }

    // ============================================================
    // 侧边栏底部按钮（打开记忆控制台）
    // ============================================================
    function MemoryButton(props) {
      const active = useActiveRuns();
      const wide = props.wide === true;
      return React.createElement(
        "button",
        {
          className: "hpptools-mem-btn",
          onClick: props.onOpen,
          title: "🧠 hpptools-memory 记忆控制台",
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

    // ============================================================
    // 主题 + 语言同步（推给每个 iframe）
    // ============================================================
    function syncTheme(ctx, theme) {
      let snapshot = theme.getTheme();
      const push = (s) => {
        snapshot = s;
        for (const f of document.querySelectorAll("iframe[data-hpptools-memory]")) {
          f.contentWindow?.postMessage(
            { type: "hpptools-theme", colorScheme: s.colorScheme, tokens: s.tokens }, "*");
        }
      };
      push(snapshot);
      window.addEventListener("message", (e) => {
        if (!e.data || e.data.type !== "hpptools-theme-request") return;
        e.source?.postMessage(
          { type: "hpptools-theme", colorScheme: snapshot.colorScheme, tokens: snapshot.tokens }, "*");
      });
      ctx.on("theme/change", push);
    }

    function syncLocale(ctx, locale) {
      const active = () => {
        try { return locale.getSnapshot().active; } catch { return undefined; }
      };
      const push = () => {
        const id = active();
        if (!id) return;
        const normalized = String(id).toLowerCase().startsWith("zh") ? "zh" : "en";
        for (const f of document.querySelectorAll("iframe[data-hpptools-memory]")) {
          f.contentWindow?.postMessage({ type: "hpptools-locale", locale: normalized }, "*");
        }
      };
      push();
      window.addEventListener("message", (e) => {
        if (!e.data || e.data.type !== "hpptools-locale-request") return;
        const id = active();
        if (id) e.source?.postMessage(
          { type: "hpptools-locale", locale: String(id).toLowerCase().startsWith("zh") ? "zh" : "en" }, "*");
      });
      if (typeof locale.subscribe === "function") {
        return ctx.effect(() => locale.subscribe(push), "hpptools-memory: locale");
      }
    }

    // ============================================================
    // 插件入口
    // ============================================================
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      injectGlobalCss(ctx);

      const theme = ctx.get("theme");
      if (theme !== undefined) syncTheme(ctx, theme);
      const locale = ctx.get("locale");
      if (locale !== undefined) syncLocale(ctx, locale);

      // 可选消费 betterSidebar：注册记忆管理 tab（服务出现后自动注册）
      ctx.effect(
        () => waitForService(ctx, "betterSidebar", (svc) => registerConsoleTab(ctx, svc)),
        "hpptools-memory: betterSidebar consumer",
      );

      // 侧边栏底部按钮：打开记忆控制台
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, {
          wide: props.wide,
          onOpen: () => openConsole(ctx),
        }),
      ));
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
