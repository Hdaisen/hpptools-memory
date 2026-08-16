/**
 * hpptools-memory — browser half（no-op 入口）
 *
 * 可视化面板已内置进 dsh-better-sidebar fork（plugins/better-sidebar，
 * 内置「🧠 记忆管理」tab）——本 client 半边不再注册任何 UI。
 * 此文件保留以满足 package.json 的 "./client" 导出声明与
 * "dsh.client" 注入配置，实际不注册任何槽位/按钮（侧边栏底部按钮
 * 已按用户要求移除，2026-08-16）。
 *
 * 构建格式：DSH web 客户端入口的 __ModuleLoader__ 包装（与官方 client 包一致）。
 */
window.__ModuleLoader__.load({
  id: "hpptools-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 不注册任何 UI（记忆面板全部由 dsh-better-sidebar fork 内置 tab 承载）。
    function apply() { /* no-op */ }

    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  },
});
