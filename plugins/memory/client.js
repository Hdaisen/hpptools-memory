/**
 * hpptools-memory — browser half（直接嵌入 DSH Web UI）
 *
 * - sidebar.footer.action：侧边栏底部 🧠 按钮（宽侧边栏显示文字，rail 模式仅图标；
 *   有子代理运行时按钮上显示橙色呼吸活动点，5s 轮询）；点击打开宿主右侧详情列
 * - details：嵌入宿主详情列（对话区自动让位、宿主拖拽手柄调宽；替换宿主
 *   自带的工具详情面板——single slot 无法共存）。面板 iframe 嵌入 Host
 *   提供的控制台页面（/hpptools-memory/，与独立访问同一页面，零重复实现）；
 *   整个面板包错误边界——渲染崩溃显示错误条而非空白面板
 * - theme + locale：宿主主题 token（--dsw-*）与语言偏好（DSH locale，
 *   zh/en）通过 postMessage 注入 iframe；语言切换实时推送
 *
 * 视觉参考 dsh-better-sidebar：DSH 语义 token（--dsw-alias-*）、扁平无阴影、
 * 28px 圆形图标控件（hover 填充）、hairline 边框。全局样式经 <style> 注入，
 * 由插件 fiber 管理生命周期（HMR-safe）。
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

    // ---------------- 全局样式（HMR-safe：apply 注入，fiber 卸载时移除） ----------------
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
      return ctx.effect(() => {
        style.remove();
      }, "hpptools-memory: global styles");
    }

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
          className: "hpptools-mem-btn",
          onClick: props.onOpen,
          title: "🧠 hpptools-memory 记忆控制台（打开右侧面板）",
          style: {
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "7px 10px",
            background: "none",
            border: "none",
            borderRadius: 8,
            color: "var(--dsw-alias-label-secondary, #8b93a5)",
            cursor: "pointer",
            fontSize: 13,
            whiteSpace: "nowrap",
          },
        },
        React.createElement("span", { style: { fontSize: 15, lineHeight: 1 } }, "🧠"),
        wide ? React.createElement("span", null, "记忆") : null,
        active > 0
          ? React.createElement("span", { className: "hpptools-mem-dot", style: { top: 3, right: wide ? 12 : 6 } })
          : null,
      );
    }

    // ---------------- 错误边界（渲染崩溃 → 错误条 + 重试，不白屏） ----------------
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      componentDidCatch(error, info) {
        console.error("[hpptools-memory] panel render error:", error, info);
      }
      render() {
        if (this.state.error !== null) {
          const isZh = this.props.isZh !== false;
          return React.createElement(
            "div",
            {
              style: {
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", fontSize: 12.5, lineHeight: 1.5,
                color: "var(--dsw-alias-state-error-primary, #c9685f)",
                background: "color-mix(in srgb, var(--dsw-alias-state-error-primary, #c9685f) 10%, transparent)",
                borderBottom: "1px solid var(--dsw-alias-border-l1, #2e3440)",
                flex: "none",
              },
            },
            React.createElement("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" } },
              "[hpptools-memory] " + this.state.error),
            React.createElement(
              "button",
              {
                onClick: () => this.setState({ error: null }),
                style: {
                  flex: "none",
                  padding: "3px 10px",
                  fontSize: 12,
                  color: "var(--dsw-alias-label-primary, #d8dee9)",
                  background: "var(--dsw-alias-bg-layer-2, #232733)",
                  border: "1px solid var(--dsw-alias-border-l2, #3b4252)",
                  borderRadius: 6,
                  cursor: "pointer",
                },
              },
              isZh ? "重试" : "Retry",
            ),
          );
        }
        return this.props.children;
      }
    }

    // ---------------- 详情列面板（iframe 嵌入控制台） ----------------
    // 宽度/开合由宿主 details 列管理（对话区 grid 自动让位，宿主手柄拖宽）。
    function MemoryPanel(props) {
      const header = React.createElement(
        "div",
        {
          style: {
            display: "flex", alignItems: "center", gap: 8,
            padding: "7px 10px 7px 14px",
            background: "var(--dsw-alias-bg-layer-1, #1c1f26)",
            borderBottom: "1px solid var(--dsw-alias-border-l1, #2e3440)",
            color: "var(--dsw-alias-label-primary, #d8dee9)",
            fontSize: 13, fontWeight: 600,
            flexShrink: 0,
          },
        },
        React.createElement("span", { style: { fontSize: 14 } }, "🧠"),
        React.createElement("span", null, "hpptools-memory"),
        React.createElement("span", { style: { flex: 1 } }),
        React.createElement(
          "button",
          {
            onClick: props.onClose,
            title: props.isZh ? "关闭面板" : "Close panel",
            "aria-label": props.isZh ? "关闭面板" : "Close panel",
            style: {
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, padding: 0,
              background: "transparent", border: "none", borderRadius: "50%",
              color: "var(--dsw-alias-label-secondary, #8b93a5)",
              cursor: "pointer", fontSize: 14,
              transition: "background 160ms ease, color 160ms ease",
            },
            onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, #2e3440)"; e.currentTarget.style.color = "var(--dsw-alias-label-primary, #d8dee9)"; },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--dsw-alias-label-secondary, #8b93a5)"; },
          },
          "✕",
        ),
      );
      const frame = React.createElement("iframe", {
        src: API_BASE + "/",
        "data-hpptools-memory": true,
        title: "hpptools-memory console",
        style: {
          flex: 1, border: "none", width: "100%", minHeight: 0,
          background: "var(--dsw-alias-bg-base, #14161a)",
        },
      });
      return React.createElement(
        PanelBoundary,
        { isZh: props.isZh },
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", height: "100%", minWidth: 0 } },
          header,
          frame,
        ),
      );
    }

    // ---------------- 主题同步：把宿主 --dsw-* token 推给 iframe ----------------
    // theme 是业务服务（getTheme/setTheme），事件挂在插件 ctx 上监听
    // （ui-layout 的 theme-presenter 同款用法：ctx.on('theme/change', ...)）。
    // iframe 加载完成后会发 hpptools-theme-request，这里响应初始主题，
    // 避免 iframe 在推送之后才加载导致一直用深色默认值。
    function syncTheme(ctx, theme) {
      let snapshot = theme.getTheme();
      const push = (s) => {
        snapshot = s;
        for (const f of document.querySelectorAll("iframe[data-hpptools-memory]")) {
          f.contentWindow?.postMessage(
            { type: "hpptools-theme", colorScheme: s.colorScheme, tokens: s.tokens },
            "*",
          );
        }
      };
      push(snapshot);
      window.addEventListener("message", (e) => {
        if (!e.data || e.data.type !== "hpptools-theme-request") return;
        e.source?.postMessage(
          { type: "hpptools-theme", colorScheme: snapshot.colorScheme, tokens: snapshot.tokens },
          "*",
        );
      });
      ctx.on("theme/change", push);
    }

    // ---------------- 语言同步：把 DSH locale 偏好推给 iframe ----------------
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
        if (id) e.source?.postMessage({ type: "hpptools-locale", locale: String(id).toLowerCase().startsWith("zh") ? "zh" : "en" }, "*");
      });
      // locale 服务是 LocaleFace：subscribe 在语言切换时通知
      if (typeof locale.subscribe === "function") {
        return ctx.effect(() => locale.subscribe(push), "hpptools-memory: locale");
      }
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      injectGlobalCss(ctx);

      const locale = ctx.get("locale");
      const isZh = () => {
        try { return String(locale?.getSnapshot().active ?? "").toLowerCase().startsWith("zh"); }
        catch { return true; }
      };
      const layout = ctx.get("layout");
      const openDetails = () => { try { layout?.openDetails(); } catch { /* noop */ } };
      const closeDetails = () => { try { layout?.closeDetails(); } catch { /* noop */ } };

      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, {
          wide: props.wide,
          onOpen: openDetails,
        }),
      ));
      // 嵌入宿主详情列（single slot：以更低 priority shadow 宿主工具详情面板，
      // lowest renders；priority 必须与宿主注册（0）不同，order 不是 priority）。
      slots.inject("details", () => slots.register(
        { name: "details", id: "hpptools-memory", priority: -1 },
        () => React.createElement(MemoryPanel, {
          isZh: isZh(),
          onClose: closeDetails,
        }),
      ));

      const theme = ctx.get("theme");
      if (theme !== undefined) syncTheme(ctx, theme);
      if (locale !== undefined) syncLocale(ctx, locale);
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
