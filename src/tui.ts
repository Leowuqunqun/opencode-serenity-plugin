/**
 * opencode-serenity-plugin TUI entry（v1.9）
 *
 * 独立 TUI plugin（与 server plugin 平级）。opencode 1.16+ 强制 PluginModule
 * 二选一（server | tui），所以走两条独立 entry：
 * - server entry: dist/index.js（走 Hooks 系统）
 * - tui entry:    dist/tui.js  （走 TuiPluginApi）
 *
 * v1.8 → v1.9 修复：
 * - R-α fix: TUI entry 不再放在 opencode.json；放到主仓 tui.json#plugin
 * - R-β fix: default export 改为 { id, tui } 对象形式（之前是裸函数）
 * - R-γ fix: 显式 export id（路径 plugin 必须）
 * - UX：双通知 = 一次性 toast（激活瞬间）+ 永久 slot（app 底部小字）
 *
 * 与 server plugin 协同（v1.9 仍未做状态共享）：
 * - server plugin 负责"拦截 + 行为"（RR1-RR7 + permission auto-reply + config-patch）
 * - tui plugin 负责"通知用户"（让用户看到 plugin 实际激活了）
 * - 已知缺口：TUI 端不读 server 的 isActive()，所以即使 server 激活失败，slot 也会显示
 *   —— v2 再做状态共享（B 方案）
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from '@opencode-ai/plugin/tui';

const Tui: TuiPlugin = async (api) => {
  // A: 一次性 toast（激活瞬间提示，5s 后消失）
  api.ui.toast({
    title: 'serenity',
    message: 'plugin activated — read/edit = allow (cwdRoot-scoped)',
    variant: 'success',
    duration: 5000,
  });

  // C: 永久 slot 状态指示器（app 底部小字）
  api.slots.register({
    order: 999,
    slots: {
      app_bottom() {
        const theme = api.theme.current;
        return (
          <box
            flexDirection="row"
            paddingLeft={2}
            paddingRight={2}
            paddingBottom={1}
            flexShrink={0}
          >
            <text fg={theme.success}>[serenity]</text>
            <text fg={theme.textMuted}>  plugin active (cwdRoot-scoped)</text>
          </box>
        );
      },
    },
  });
};

export default {
  id: 'opencode-serenity-plugin-tui',
  tui: Tui,
};
