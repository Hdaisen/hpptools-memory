/**
 * hpptools-memory — browser half（直接嵌入 DSH Web UI）
 *
 * VSCode 风格侧边栏工作台（交互参考 dsh-better-sidebar）：
 * - 右侧固定面板：可拖宽（280–640px）、可折叠（⇤ 折叠 / ✕ 关闭）；
 *   开合与宽度持久化 localStorage
 * - tabBar：5 个控制台视图（概览 / 文件 / 模型 / 运行 / 设置），
 *   滚轮横向滚动、HTML5 拖拽重排、中键关闭
 * - 分栏工作台：拖 Tab 到 pane 边缘（左/右/上/下）拆分出新分栏，
 *   拖到中心合并回原分栏；分栏间 Divider 可拖拽调整大小；
 *   分栏树持久化 localStorage
 * - 每个视图的内容是 iframe（/hpptools-memory/?view=<id>&embed=1），
 *   复用 Host 渲染的控制台页面（与独立访问同一实现，零重复）
 * - theme + locale：宿主主题 token（--dsw-*）与语言偏好通过 postMessage
 *   注入每个 iframe；语言切换实时推送
 * - 有子代理运行时侧边栏按钮显示橙色呼吸活动点（5s 轮询）
 *
 * 视觉：DSH 语义 token（--dsw-alias-*）、扁平无阴影、hairline 边框、
 * 28px 圆形图标控件（hover 填充）、紧凑间距。全局样式经 <style> 注入，
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
    const STORE_KEY = "hpptools-sidebar-layout";
    const TAB_DRAG_TYPE = "application/x-hpptools-tab";
    const PANEL_MIN = 280;
    const PANEL_MAX = 640;

    // ============================================================
    // 视图定义（控制台页签）
    // ============================================================
    const VIEW_DEFS = [
      { id: "overview", icon: "📊", zh: "概览", en: "Overview" },
      { id: "files", icon: "📄", zh: "文件", en: "Files" },
      { id: "models", icon: "⚙️", zh: "模型配置", en: "Models" },
      { id: "runs", icon: "🔄", zh: "子代理运行", en: "Runs" },
      { id: "settings", icon: "🛠️", zh: "设置", en: "Settings" },
    ];
    const VIEW_IDS = VIEW_DEFS.map((v) => v.id);

    // ============================================================
    // 分栏树 store（纯函数操作 + localStorage 持久化）
    // 节点：Leaf { kind:'leaf', id, tabs:[viewId], active:viewId }
    //       Split { kind:'split', id, dir:'row'|'col', children:[node], sizes:[frac] }
    // ---- STORE-START (test hook: tests/sidebar-store.test.mjs 提取本段) ----
    const PANEL_DEFAULT = 420;
    let idSeq = 0;
    function genId(prefix) {
      return prefix + "-" + (++idSeq) + "-" + Date.now().toString(36);
    }

    function defaultStore() {
      return {
        open: true,
        width: PANEL_DEFAULT,
        focusLeaf: null,
        root: { kind: "leaf", id: genId("pane"), tabs: ["overview"], active: "overview" },
      };
    }

    function loadStore() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (s && s.root) {
            // 校验树结构基本合法
            if (s.root.kind === "leaf" || s.root.kind === "split") return s;
          }
        }
      } catch { /* ignore */ }
      return defaultStore();
    }

    function saveStore(store) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
    }

    function isLeaf(node) { return node.kind === "leaf"; }

    function walkLeaves(node, visit) {
      if (isLeaf(node)) { visit(node); return; }
      for (const c of node.children) walkLeaves(c, visit);
    }

    function allLeaves(node) {
      const out = [];
      walkLeaves(node, (l) => out.push(l));
      return out;
    }

    function leafWithTab(node, tabId) {
      let found = undefined;
      walkLeaves(node, (l) => { if (found === undefined && l.tabs.includes(tabId)) found = l; });
      return found;
    }

    /** 把目标 leaf 替换为 split(dir, [front? fresh: target])，返回新树 + 新 leaf id。 */
    function insertLeafAt(node, paneId, dir, viewId, front) {
      const fresh = { kind: "leaf", id: genId("pane"), tabs: [viewId], active: viewId };
      const leafId = fresh.id;
      function mapLeaf(n) {
        if (n.kind === "leaf") {
          if (n.id === paneId) {
            const target = { ...n };
            const split = {
              kind: "split", id: genId("split"), dir,
              sizes: [0.5, 0.5],
              children: front ? [fresh, target] : [target, fresh],
            };
            Object.assign(n, split);
          }
          return;
        }
        for (const c of n.children) mapLeaf(c);
      }
      mapLeaf(node);
      return { node, leafId };
    }

    /** 移除一个 leaf；split 只剩一个子时提升该子。 */
    function removeLeafAt(node, paneId) {
      if (node.kind === "leaf") return node.id === paneId ? { ...node, tabs: [], active: null } : node;
      const children = node.children.filter((c) => !(c.kind === "leaf" && c.id === paneId));
      if (children.length === node.children.length) {
        return { ...node, children: node.children.map((c) => removeLeafAt(c, paneId)) };
      }
      if (children.length === 1) return children[0];
      const idxMap = [];
      for (const c of node.children) {
        if (!(c.kind === "leaf" && c.id === paneId)) idxMap.push(c);
      }
      return { ...node, children, sizes: node.sizes.filter((_, i) => node.children[i].kind !== "leaf" || node.children[i].id !== paneId) };
    }

    /** VSCode 拖拽手势：从源 pane 移出 tab，center → 合并到目标 leaf，edge → 拆分。 */
    function moveTabToEdge(state, fromPane, tabId, toPane, zone) {
      if (fromPane === toPane && zone === "center") {
        // 拖回自己的中心：重排到末尾
        return moveTab(state, fromPane, tabId, toPane, -1);
      }
      const source = leafWithTab(state.root, tabId);
      if (source === undefined) return state;
      const root = { ...state.root };
      // 从源 leaf 移除
      let emptied = false;
      (function removeFrom(n) {
        if (n.kind === "leaf") {
          if (n.id === source.id) {
            n.tabs = n.tabs.filter((t) => t !== tabId);
            if (n.active === tabId) n.active = n.tabs[n.tabs.length - 1] ?? null;
            if (n.tabs.length === 0) emptied = true;
          }
          return;
        }
        for (const c of n.children) removeFrom(c);
      })(root);
      let tree = emptied ? removeLeafAt(root, source.id) : root;
      // 目标操作
      if (zone === "center") {
        (function appendTo(n) {
          if (n.kind === "leaf") {
            if (n.id === toPane) { n.tabs = [...n.tabs, tabId]; n.active = tabId; }
            return;
          }
          for (const c of n.children) appendTo(c);
        })(tree);
        return { ...state, root: tree, focusLeaf: toPane };
      }
      const dir = zone === "left" || zone === "right" ? "row" : "col";
      const r = insertLeafAt(tree, toPane, dir, tabId, zone === "left" || zone === "up");
      return { ...state, root: r.node, focusLeaf: r.leafId };
    }

    /** 同 pane 重排：把 tab 移到 beforeTabId 之前（-1 = 末尾）。 */
    function moveTab(state, fromPane, tabId, toPane, beforeTabId) {
      const root = { ...state.root };
      (function reorder(n) {
        if (n.kind === "leaf") {
          if (n.id === fromPane) {
            const idx = n.tabs.indexOf(tabId);
            if (idx === -1) return;
            const [tab] = n.tabs.splice(idx, 1);
            if (n.id === toPane) {
              const pos = beforeTabId === -1 ? n.tabs.length : n.tabs.indexOf(beforeTabId);
              n.tabs.splice(pos < 0 ? n.tabs.length : pos, 0, tab);
              n.active = tab;
            }
          }
          return;
        }
        for (const c of n.children) reorder(c);
      })(root);
      return { ...state, root, focusLeaf: toPane };
    }

    /** 关闭 tab；leaf 空则移除；root 空则回落到 overview。 */
    function closeTab(state, leafId, tabId) {
      let root = { ...state.root };
      let emptied = false;
      (function removeFrom(n) {
        if (n.kind === "leaf") {
          if (n.id === leafId) {
            n.tabs = n.tabs.filter((t) => t !== tabId);
            if (n.active === tabId) n.active = n.tabs[n.tabs.length - 1] ?? null;
            if (n.tabs.length === 0) emptied = true;
          }
          return;
        }
        for (const c of n.children) removeFrom(c);
      })(root);
      if (emptied) {
        root = removeLeafAt(root, leafId);
        const leaves = allLeaves(root);
        if (leaves.length === 0 || (leaves.length === 1 && leaves[0].tabs.length === 0)) {
          // 全空：回落到 overview
          root = { kind: "leaf", id: genId("pane"), tabs: ["overview"], active: "overview" };
        }
      }
      const focusLeaf = allLeaves(root).length ? allLeaves(root)[0].id : null;
      return { ...state, root, focusLeaf };
    }

    /** 激活某个 leaf 里的 tab。 */
    function activateTab(state, leafId, tabId) {
      const root = { ...state.root };
      (function act(n) {
        if (n.kind === "leaf") { if (n.id === leafId) n.active = tabId; return; }
        for (const c of n.children) act(c);
      })(root);
      return { ...state, root, focusLeaf: leafId };
    }

    /** 全局去重打开：view 已在某 leaf → 聚焦；否则加入 focus leaf。 */
    function openView(state, viewId) {
      const existing = leafWithTab(state.root, viewId);
      if (existing !== undefined) return activateTab(state, existing.id, viewId);
      const leaves = allLeaves(state.root);
      const target = state.focusLeaf && leaves.find((l) => l.id === state.focusLeaf)
        ? state.focusLeaf
        : (leaves[0] ? leaves[0].id : null);
      if (target === null) {
        const root = { kind: "leaf", id: genId("pane"), tabs: [viewId], active: viewId };
        return { ...state, root, focusLeaf: root.id };
      }
      const root = { ...state.root };
      (function addTo(n) {
        if (n.kind === "leaf") { if (n.id === target) { n.tabs = [...n.tabs, viewId]; n.active = viewId; } return; }
        for (const c of n.children) addTo(c);
      })(root);
      return { ...state, root, focusLeaf: target };
    }

    /** 调整 split 中相邻两个分栏的大小比例（Divider 拖拽）。 */
    function resizeSplit(state, splitId, index, deltaFrac) {
      const root = { ...state.root };
      (function resize(n) {
        if (n.kind === "split") {
          if (n.id === splitId) {
            const min = 0.12;
            let a = n.sizes[index] + deltaFrac;
            let b = n.sizes[index + 1] - deltaFrac;
            // 先 clamp 到最小值，再归一化（保证最小值在归一化后依然成立）
            if (a < min) { b -= (min - a); a = min; }
            if (b < min) { a -= (min - b); b = min; }
            const total = a + b;
            n.sizes[index] = a / total;
            n.sizes[index + 1] = b / total;
          }
          for (const c of n.children) resize(c);
          return;
        }
      })(root);
      return { ...state, root };
    }
    // ---- STORE-END (test hook) ----

    // ============================================================
    // 全局样式（HMR-safe）
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

/* ---- 侧边栏面板 ---- */
.hpptools-panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  z-index: 60;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base, #14161a);
  border-left: 1px solid var(--dsw-alias-border-l2, #3b4252);
  transition: transform 160ms ease-in-out, width 160ms ease-in-out;
}
.hpptools-panel.closed {
  transform: translateX(102%);
  pointer-events: none;
  visibility: hidden;
}
.hpptools-panel[data-dragging] { transition: none; }
.hpptools-panel-resize {
  position: absolute; left: -4px; top: 0; bottom: 0;
  width: 8px; cursor: col-resize; z-index: 2; touch-action: none;
}
.hpptools-panel-resize:hover, .hpptools-panel-resize.active { background: var(--dsw-alias-interactive-bg-hover-accent, #3d4457); }
.hpptools-panel-header {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px 7px 14px; flex: none;
  background: var(--dsw-alias-bg-layer-1, #1c1f26);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2e3440);
  color: var(--dsw-alias-label-primary, #d8dee9);
  font-size: 13px; font-weight: 600;
}
.hpptools-panel-header .hpptools-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  background: transparent; border: none; border-radius: 50%;
  color: var(--dsw-alias-label-secondary, #8b93a5);
  cursor: pointer; font-size: 14px;
  transition: background 160ms ease, color 160ms ease;
}
.hpptools-panel-header .hpptools-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, #2e3440);
  color: var(--dsw-alias-label-primary, #d8dee9);
}
.hpptools-panel-body { flex: 1; min-height: 0; min-width: 0; display: flex; }

/* ---- 分栏 ---- */
.hpptools-split { display: flex; flex: 1; min-width: 0; min-height: 0; }
.hpptools-split.row { flex-direction: row; }
.hpptools-split.col { flex-direction: column; }
.hpptools-split-child { display: flex; flex: 1; min-width: 0; min-height: 0; }
.hpptools-divider { flex: none; background: transparent; position: relative; z-index: 3; }
.hpptools-divider.row { width: 5px; cursor: col-resize; }
.hpptools-divider.col { height: 5px; cursor: row-resize; }
.hpptools-divider:hover, .hpptools-divider.active { background: var(--dsw-alias-interactive-bg-hover-accent, #3d4457); }

/* ---- leaf / tabBar ---- */
.hpptools-leaf { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.hpptools-tabbar {
  display: flex; align-items: stretch; gap: 2px;
  padding: 0 6px; flex: none;
  background: var(--dsw-alias-bg-layer-1, #1c1f26);
  border-bottom: 1px solid var(--dsw-alias-border-l1, #2e3440);
  overflow-x: auto;
}
.hpptools-tabbar::-webkit-scrollbar { height: 0; }
.hpptools-tab {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 8px 5px; flex: none; max-width: 150px;
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-secondary, #8b93a5);
  font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: color 160ms ease, background 160ms ease;
}
.hpptools-tab:hover { color: var(--dsw-alias-label-primary, #d8dee9); background: var(--dsw-alias-interactive-bg-hover, #2e3440); }
.hpptools-tab.active { color: var(--dsw-alias-label-primary, #d8dee9); border-bottom-color: var(--dsw-alias-button-primary-fill, #5e81ac); }
.hpptools-tab .ht-icon { font-size: 12px; line-height: 1; }
.hpptools-tab .ht-title { overflow: hidden; text-overflow: ellipsis; }
.hpptools-tab .ht-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0; flex: none;
  background: none; border: none; border-radius: 50%;
  color: var(--dsw-alias-label-tertiary, #6c7486);
  cursor: pointer; font-size: 11px; line-height: 1;
}
.hpptools-tab .ht-close:hover { background: var(--dsw-alias-interactive-bg-hover, #2e3440); color: var(--dsw-alias-label-primary, #d8dee9); }

/* ---- leaf 内容区（iframe + drop overlay） ---- */
.hpptools-leaf-content { position: relative; flex: 1; min-height: 0; min-width: 0; }
.hpptools-leaf-content iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: var(--dsw-alias-bg-base, #14161a); }
.hpptools-leaf-content.dragging iframe { pointer-events: none; }
.hpptools-dropzone { position: absolute; inset: 0; z-index: 5; display: none; pointer-events: none; }
.hpptools-leaf-content.drop .hpptools-dropzone { display: block; }
.hpptools-dropzone .dz {
  position: absolute; background: color-mix(in srgb, var(--dsw-alias-button-primary-fill, #5e81ac) 18%, transparent);
  border: 1px solid var(--dsw-alias-button-primary-fill, #5e81ac); border-radius: 4px;
}
.hpptools-dropzone .dz-left   { left: 4px; top: 4px; bottom: 4px; width: 25%; }
.hpptools-dropzone .dz-right  { right: 4px; top: 4px; bottom: 4px; width: 25%; }
.hpptools-dropzone .dz-up     { top: 4px; left: 4px; right: 4px; height: 25%; }
.hpptools-dropzone .dz-down   { bottom: 4px; left: 4px; right: 4px; height: 25%; }
.hpptools-dropzone .dz-center { left: 25%; right: 25%; top: 25%; bottom: 25%; border-radius: 8px; }
.hpptools-dropzone .dz.hot { background: color-mix(in srgb, var(--dsw-alias-button-primary-fill, #5e81ac) 32%, transparent); }
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
              borderBottom: "1px solid var(--dsw-alias-border-l1, #2e3440)", flex: "none",
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
    // 视图 iframe（一个 leaf 只渲染激活 tab 的 iframe）
    // ============================================================
    function ViewFrame(props) {
      const { viewId } = props;
      return React.createElement("iframe", {
        src: API_BASE + "/?view=" + viewId + "&embed=1",
        "data-hpptools-memory": true,
        title: viewId,
      });
    }

    // ============================================================
    // Divider（pointer-capture 拖拽调整分栏大小）
    // ============================================================
    function Divider(props) {
      const { dir, onResize } = props;
      const last = React.useRef({ x: 0, y: 0, size: 1 });
      const [dragging, setDragging] = React.useState(false);
      return React.createElement("div", {
        className: "hpptools-divider " + dir + (dragging ? " active" : ""),
        onPointerDown: (event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const box = event.currentTarget.parentElement?.getBoundingClientRect();
          last.current = {
            x: event.clientX, y: event.clientY,
            size: box === undefined ? 1 : (dir === "row" ? box.width : box.height),
          };
          setDragging(true);
        },
        onPointerMove: (event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const delta = dir === "row" ? event.clientX - last.current.x : event.clientY - last.current.y;
          onResize(delta / Math.max(1, last.current.size));
          last.current.x = event.clientX;
          last.current.y = event.clientY;
        },
        onPointerUp: (event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        },
      });
    }

    // ============================================================
    // TabBar（滚轮横向滚动 + 拖拽 + 关闭）
    // ============================================================
    function TabBar(props) {
      const { leaf, onActivate, onClose, onDragStartTab, onDropTabBefore, isZh } = props;
      const listRef = React.useRef(null);
      const [dragOverTab, setDragOverTab] = React.useState(null);

      // 滚轮横向滚动（非 passive：overflow-x 不消费 deltaY）
      React.useEffect(() => {
        const el = listRef.current;
        if (el === null) return;
        const onWheel = (event) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
          if (el.scrollWidth <= el.clientWidth) return;
          event.preventDefault();
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
          el.scrollLeft += (event.deltaX + event.deltaY) * unit;
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => { el.removeEventListener("wheel", onWheel); };
      }, []);

      const tabs = leaf.tabs.map((viewId) => {
        const def = VIEW_DEFS.find((v) => v.id === viewId) || { id: viewId, icon: "📄", zh: viewId, en: viewId };
        const label = isZh ? def.zh : def.en;
        const closeBtn = React.createElement("button", {
          className: "ht-close",
          title: isZh ? "关闭" : "Close",
          onClick: (e) => { e.stopPropagation(); onClose(leaf.id, viewId); },
        }, "✕");
        return React.createElement("div", {
          key: viewId,
          className: "hpptools-tab" + (leaf.active === viewId ? " active" : ""),
          title: label,
          draggable: true,
          onDragStart: (e) => {
            e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ leafId: leaf.id, tabId: viewId }));
            e.dataTransfer.effectAllowed = "move";
            document.body.setAttribute("data-hpptools-dragging", "");
          },
          onDragEnd: () => {
            document.body.removeAttribute("data-hpptools-dragging");
            setDragOverTab(null);
          },
          onDragOver: (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverTab(viewId);
          },
          onDragLeave: () => setDragOverTab((v) => (v === viewId ? null : v)),
          onDrop: (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.body.removeAttribute("data-hpptools-dragging");
            setDragOverTab(null);
            const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
            try {
              const payload = JSON.parse(raw);
              if (payload && payload.tabId) onDropTabBefore(payload, leaf.id, viewId);
            } catch { /* ignore */ }
          },
          onClick: () => onActivate(leaf.id, viewId),
          onAuxClick: (e) => {
            if (e.button === 1) { e.preventDefault(); onClose(leaf.id, viewId); }
          },
        },
          React.createElement("span", { className: "ht-icon" }, def.icon),
          React.createElement("span", { className: "ht-title" }, label),
          closeBtn,
        );
      });

      return React.createElement("div", { className: "hpptools-tabbar", ref: listRef }, tabs);
    }

    // ============================================================
    // DropZone 计算 + LeafView
    // ============================================================
    function zoneAt(event, el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return "center";
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < 0.25) return "left";
      if (x > 0.75) return "right";
      if (y < 0.25) return "up";
      if (y > 0.75) return "down";
      return "center";
    }

    function LeafView(props) {
      const { leaf, store, onUpdate, isZh } = props;
      const [dropZone, setDropZone] = React.useState(null);
      const [dragging, setDragging] = React.useState(false);
      const contentRef = React.useRef(null);
      const dragDepth = React.useRef(0);

      const activeView = leaf.active ? leaf.tabs.find((t) => t === leaf.active) : leaf.tabs[0] ?? null;

      const handleDragOver = (e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        if (contentRef.current) setDropZone(zoneAt(e, contentRef.current));
        setDragging(true);
      };
      const handleDragLeave = () => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) { setDropZone(null); setDragging(false); dragDepth.current = 0; }
      };
      const handleDragEnter = () => { dragDepth.current += 1; };
      const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.removeAttribute("data-hpptools-dragging");
        setDragging(false);
        dragDepth.current = 0;
        const zone = dropZone || "center";
        setDropZone(null);
        const raw = e.dataTransfer.getData(TAB_DRAG_TYPE);
        try {
          const payload = JSON.parse(raw);
          if (!payload || !payload.tabId) return;
          const next = moveTabToEdge(store, payload.leafId, payload.tabId, leaf.id, zone);
          onUpdate(next);
        } catch { /* ignore */ }
      };

      const zones = [
        ["left", "dz-left"], ["right", "dz-right"],
        ["up", "dz-up"], ["down", "dz-down"], ["center", "dz-center"],
      ];
      const overlay = React.createElement("div", { className: "hpptools-dropzone" },
        zones.map(([z, cls]) =>
          React.createElement("div", { key: z, className: "dz " + cls + (dropZone === z ? " hot" : "") })));

      return React.createElement("div", { className: "hpptools-leaf" },
        React.createElement(TabBar, {
          leaf, isZh,
          onActivate: (leafId, tabId) => onUpdate(activateTab(store, leafId, tabId)),
          onClose: (leafId, tabId) => onUpdate(closeTab(store, leafId, tabId)),
          onDropTabBefore: (payload, toLeaf, beforeTabId) =>
            onUpdate(moveTab(store, payload.leafId, payload.tabId, toLeaf, beforeTabId)),
        }),
        React.createElement("div", {
          ref: contentRef,
          className: "hpptools-leaf-content" + (dragging ? " dragging" : "") + (dropZone !== null ? " drop" : ""),
          onDragOver: handleDragOver,
          onDragEnter: handleDragEnter,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        },
          activeView !== null ? React.createElement(ViewFrame, { key: activeView, viewId: activeView }) : null,
          overlay,
        ),
      );
    }

    // ============================================================
    // SplitPane（递归渲染分栏树）
    // ============================================================
    function SplitPane(props) {
      const { node, store, onUpdate, isZh } = props;
      if (node.kind === "leaf") {
        return React.createElement(LeafView, { leaf: node, store, onUpdate, isZh });
      }
      const children = node.children.map((child, i) => {
        const pane = React.createElement("div", { className: "hpptools-split-child", key: child.id },
          React.createElement(SplitPane, { node: child, store, onUpdate, isZh }));
        if (i < node.children.length - 1) {
          const divider = React.createElement(Divider, {
            key: "d" + i,
            dir: node.dir === "row" ? "row" : "col",
            onResize: (deltaFrac) => onUpdate(resizeSplit(store, node.id, i, deltaFrac)),
          });
          return [pane, divider];
        }
        return [pane];
      }).flat();
      return React.createElement("div", { className: "hpptools-split " + node.dir }, children);
    }

    // ============================================================
    // 侧边栏面板（右侧固定 + 拖宽 + 折叠）
    // ============================================================
    function SidebarPanel(props) {
      const { store, onUpdate, isZh } = props;
      const [dragWidth, setDragWidth] = React.useState(false);
      const lastX = React.useRef(0);

      const widthDrag = {
        onPointerDown: (event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          lastX.current = event.clientX;
          setDragWidth(true);
          document.body.setAttribute("data-hpptools-dragging", "");
        },
        onPointerMove: (event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const delta = lastX.current - event.clientX;
          lastX.current = event.clientX;
          const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, store.width + delta));
          onUpdate({ ...store, width: w });
        },
        onPointerUp: (event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragWidth(false);
          document.body.removeAttribute("data-hpptools-dragging");
        },
      };

      const header = React.createElement("div", { className: "hpptools-panel-header" },
        React.createElement("span", { style: { fontSize: 14 } }, "🧠"),
        React.createElement("span", null, "hpptools-memory"),
        React.createElement("span", { style: { flex: 1 } }),
        React.createElement("button", {
          className: "hpptools-close",
          title: isZh ? "关闭面板" : "Close panel",
          onClick: () => onUpdate({ ...store, open: false }),
        }, "✕"),
      );

      return React.createElement("div", {
        className: "hpptools-panel" + (store.open ? "" : " closed") + (dragWidth ? " dragging" : ""),
        "data-dragging": dragWidth || undefined,
        style: { width: store.width },
      },
        React.createElement("div", { className: "hpptools-panel-resize", ...widthDrag }),
        header,
        React.createElement("div", { className: "hpptools-panel-body" },
          React.createElement(SplitPane, { node: store.root, store, onUpdate, isZh })),
      );
    }

    // ============================================================
    // 侧边栏底部按钮（打开/关闭面板）
    // ============================================================
    function MemoryButton(props) {
      const active = useActiveRuns();
      const wide = props.wide === true;
      return React.createElement(
        "button",
        {
          className: "hpptools-mem-btn",
          onClick: props.onToggle,
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

      const locale = ctx.get("locale");
      const isZh = () => {
        try { return String(locale?.getSnapshot().active ?? "").toLowerCase().startsWith("zh"); }
        catch { return true; }
      };

      // 面板挂到 document.body（不受宿主 details 列限制，真正可拖宽 / 分栏）
      const ReactDOM = require("react-dom/client");
      const panelHost = document.createElement("div");
      panelHost.setAttribute("data-hpptools-memory-panel", "");
      document.body.appendChild(panelHost);
      const reactRoot = ReactDOM.createRoot(panelHost);

      // 布局状态（localStorage 持久化）
      let stateRef = loadStore();
      const update = (next) => {
        stateRef = next;
        saveStore(stateRef);
        reactRoot.render(React.createElement(
          PanelBoundary,
          { isZh: isZh() },
          React.createElement(SidebarPanel, { store: stateRef, onUpdate: update, isZh: isZh() }),
        ));
      };
      update(stateRef);

      ctx.effect(() => {
        return () => {
          try { reactRoot.unmount(); } catch { /* ignore */ }
          panelHost.remove();
        };
      }, "hpptools-memory: sidebar panel mount");

      // 侧边栏底部按钮：点击开合面板
      slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "hpptools-memory", order: 10, label: () => "Memory" },
        (props) => React.createElement(MemoryButton, {
          wide: props.wide,
          onToggle: () => update({ ...stateRef, open: !stateRef.open }),
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
