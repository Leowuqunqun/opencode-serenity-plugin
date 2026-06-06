/**
 * opencode-serenity-plugin TUI entry（v1.8）
 *
 * 独立 TUI plugin（与 server plugin 平级）。opencode 1.16+ PluginModule.tui?: never
 * 限制同一 module 不能同时是 server + tui，所以走两条独立 entry：
 * - server entry: dist/index.js (走 Hooks 系统)
 * - tui entry:    dist/tui.js  (走 TuiPluginApi，**真显示 TUI**)
 *
 * 与 server plugin 协同：
 * - server plugin 负责"拦截 + 行为"（RR1-RR7 + permission auto-reply + config-patch）
 * - tui plugin 负责"通知用户"（让用户看到 plugin 实际激活了）
 *
 * 行为：
 * - plugin 激活时立刻 toast（用户重启后看到"serenity 已激活"）
 * - tool 注册变化时 toast（新增 msm 提示）
 */

import type { TuiPlugin } from '@opencode-ai/plugin/tui';

const ACTIVATION_TOAST = {
  title: 'serenity',
  message: 'plugin activated — read/edit = allow (cwdRoot-scoped)',
  variant: 'success' as const,
  duration: 5000,
};

export const Tui: TuiPlugin = async (api) => {
  // 立即 toast：plugin 激活通知
  api.ui.toast(ACTIVATION_TOAST);

  // 监听 config-patch 事件（如服务端有 patch 行为，告知用户）
  api.event.on('server.connected', () => {
    api.ui.toast({
      title: 'serenity',
      message: 'server plugin connected',
      variant: 'info',
      duration: 3000,
    });
  });
};

export default Tui;
