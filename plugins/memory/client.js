/**
 * hpptools-memory — browser half（直接嵌入 DSH Web UI）
 *
 * - sidebar.footer.action：侧边栏底部 🧠 按钮（宽侧边栏显示文字，rail 模式仅图标；
 *   有子代理运行时按钮上显示橙色活动点，5s 轮询）
 * - shell.overlay：点击按钮打开的右侧抽屉，iframe 嵌入 Host 提供的控制台页面
 *   （/hpptools-memory/，与独立访问同一页面，零重复实现）
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

    // ---------------- 模块级共享状态（按钮 ↔ 悬浮窗） ----------------
    const store = { open: false, listeners: new Set() };
    function setOpen(v) {
      store.open = v;
      for (const l of store.listeners) l();
    }
    function useOpen() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => {
        store.listeners.add(force);
        return () => store.listeners.delete(force);
      }, []);
      return store.open;
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

    // ---------------- 侧边栏底部按钮 ----------------
    function MemoryButton(props) {
      const open = useOpen();
      const active = useActiveRuns();
      const wide = props.wide === true;
      return React.createElement(
        "button",
        {
          onClick: () => setOpen(!open),
          title: "🧠 hpptools-memory 记忆控制台",
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
            color: open ? "var(--accent, #5e81ac)" : "var(--text-2, #8b93a5)",
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

    // ---------------- 右侧抽屉（非模态：无遮罩、点击外部不关闭、宽度可拖拽） ----------------
    function MemoryOverlay() {
      const open = useOpen();
      const [width, setWidth] = React.useState(540);
      const [dragging, setDragging] = React.useState(false);
      if (!open) return null;

      // 拖拽左缘调整宽度（320px ～ 视口 85%，上限 1400px）。宿主 overlay 层点击穿透，
      // 面板自身 pointer-events:auto，因此抽屉外的主界面始终可操作。
      const maxDrawer = () => Math.min(1400, Math.round(window.innerWidth * 0.85));
      const startHandle = (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        setDragging(true);
        const move = (ev) => {
          setWidth(Math.max(320, Math.min(maxDrawer(), startWidth + (startX - ev.clientX))));
        };
        const up = () => {
          setDragging(false);
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        document.body.style.cursor = "col-resize";
      };

      return React.createElement(
        "div",
        {
          style: {
            position: "fixed",
            right: 0, top: 0, bottom: 0,
            width: width,
            maxWidth: "94vw",
            display: "flex",
            flexDirection: "column",
            background: "#14161a",
            borderLeft: "1px solid #2e3440",
            boxShadow: "-12px 0 48px rgba(0,0,0,.5)",
            zIndex: 20,
            overflow: "hidden",
          },
        },
        // 宽度拖拽手柄（面板左缘）
        React.createElement("div", {
          onMouseDown: startHandle,
          title: "拖拽调整宽度",
          style: {
            position: "absolute",
            left: -4, top: 0, bottom: 0,
            width: 8,
            cursor: "col-resize",
            zIndex: 5,
          },
        }),
        React.createElement(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              background: "#1c1f26",
              borderBottom: "1px solid #2e3440",
              color: "#d8dee9",
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
              style: { color: "#8b93a5", textDecoration: "none", fontSize: 12, marginRight: 8 },
            },
            "新标签页打开 ↗",
          ),
          React.createElement(
            "button",
            {
              onClick: () => setOpen(false),
              title: "关闭",
              style: {
                background: "none",
                border: "none",
                color: "#8b93a5",
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
          style: { flex: 1, border: "none", width: "100%", background: "#14161a", pointerEvents: dragging ? "none" : "auto" },
        }),
      );
    }

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, { wide: props.wide }),
      ));
      slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "hpptools-memory", order: 10 },
        () => React.createElement(MemoryOverlay),
      ));
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
