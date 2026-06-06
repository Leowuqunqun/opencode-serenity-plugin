/**
 * opencode-serenity-plugin TUI entry（v1.9 → v1.9.1）
 *
 * 独立 TUI plugin（与 server plugin 平级）。opencode 1.16+ 强制 PluginModule
 * 二选一（server | tui），所以走两条独立 entry：
 * - server entry: dist/index.js（走 Hooks 系统）
 * - tui entry:    dist/tui.js  （走 TuiPluginApi）
 *
 * v1.9 修复：
 * - R-α fix: TUI entry 不放 opencode.json；放到主仓 tui.json#plugin
 * - R-β fix: default export 改为 { id, tui } 对象形式（之前是裸函数）
 * - R-γ fix: 路径 plugin 显式 export id
 *
 * v1.9.1 调整（slot 暂未实现）：
 * - 移除 JSX slot。@opentui/solid 的 JSX runtime 只支持 build-time transform
 *   （bun-plugin / babel-preset-solid），运行时 import 必然 throw。
 *   我们用 tsc 编译没有 bun-plugin，所以 slot 加载会炸掉整个 plugin。
 * - 保留 toast（不依赖 JSX），用户至少看到 "plugin activated" 通知。
 * - 永久 slot 状态指示器待 v1.10 — 需要切到 bun build + bun-plugin-solid
 *   或者重写为 createElement/spread 直调。
 *
 * 与 server plugin 协同（v1.9 仍未做状态共享）：
 * - server plugin 负责"拦截 + 行为"（RR1-RR7 + permission auto-reply + config-patch）
 * - tui plugin 负责"通知用户"（让用户看到 plugin 实际激活了）
 */

import type { TuiPlugin } from '@opencode-ai/plugin/tui';

const Tui: TuiPlugin = async (api) => {
  // A: 一次性 toast（激活瞬间提示，5s 后消失）
  api.ui.toast({
    title: 'serenity',
    message: 'plugin activated — read/edit = allow (cwdRoot-scoped)',
    variant: 'success',
    duration: 5000,
  });

  // C: 永久 slot — TODO v1.10（见文件头注释）
  // 暂时不注册 slot，避免 plugin 加载失败
};

export default {
  id: 'opencode-serenity-plugin-tui',
  tui: Tui,
};
