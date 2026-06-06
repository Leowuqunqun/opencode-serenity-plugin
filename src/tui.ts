/**
 * opencode-serenity-plugin TUI entry（v1.9 → v1.9.1 → v1.10）
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
 * v1.10 RR7 init:
 * - 注册 /serenity-init slash command
 * - onSelect(dialog) → DialogPrompt → initSerenity
 * - 失败用 toast 通知（不抛错给 TUI）
 * - 成功提示"请重启 opencode"（不做 live re-activation）
 *
 * 与 server plugin 协同：
 * - server plugin 负责"拦截 + 行为"（RR1-RR7 + permission auto-reply + config-patch）
 * - tui plugin 负责"通知用户"（激活提示 + RR7 初始化入口）
 */

import { basename } from 'node:path';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import {
  defaultPrefix,
  initSerenity,
  isValidPrefix,
} from './util/init.js';
import {
  InvalidInstanceNameError,
  NotInGitRepoError,
  InitGitCommitError,
} from './errors.js';
import { log } from './util/log.js';

const Tui: TuiPlugin = async (api) => {
  // A: 一次性 toast（激活瞬间提示，5s 后消失）
  api.ui.toast({
    title: 'serenity',
    message: 'plugin activated — read/edit = allow (cwdRoot-scoped)',
    variant: 'success',
    duration: 5000,
  });

  // C: v1.10 RR7 — /serenity-init slash command
  //    走 api.command.register（v1 SDK 的 legacy slash 入口，TS 类型仍支持）
  //    返回值是 disposer（不存，plugin 卸载时 TUI 框架负责清理）
  api.command?.register(() => [
    {
      title: 'serenity: init cwd',
      value: 'serenity-init',
      description: 'Create /.serenity and git-commit (requires restart)',
      slash: { name: 'serenity-init' },
      onSelect: (dialog) => {
        if (!dialog) {
          api.ui.toast({
            title: 'Error',
            message: 'dialog unavailable; cannot open serenity init prompt',
            variant: 'error',
            duration: 5000,
          });
          return;
        }

        const cwd = api.state.path.directory;
        const prefill = defaultPrefix(basename(cwd));

        dialog.replace(() =>
          api.ui.DialogPrompt({
            title: 'Initialize serenity',
            placeholder: 'kebab-case prefix (e.g. xx, tg)',
            value: prefill,
            onConfirm: async (value) => {
              const prefix = value.trim();
              if (!isValidPrefix(prefix)) {
                api.ui.toast({
                  title: 'Error',
                  message:
                    `Invalid prefix "${prefix}"; ` +
                    `must be kebab-case (lowercase a-z, 0-9, dashes; no leading or trailing dash)`,
                  variant: 'error',
                  duration: 5000,
                });
                return; // dialog 保持开启，让用户改完重试
              }
              try {
                const result = await initSerenity(cwd, prefix);
                dialog.clear();
                if (result.kind === 'created') {
                  api.ui.toast({
                    title: 'serenity',
                    message: `Initialized ${result.name}; please restart opencode`,
                    variant: 'success',
                    duration: 5000,
                  });
                } else {
                  api.ui.toast({
                    title: 'serenity',
                    message: `Already initialized as ${result.name}`,
                    variant: 'info',
                    duration: 5000,
                  });
                }
              } catch (err) {
                dialog.clear();
                let msg: string;
                if (err instanceof NotInGitRepoError) {
                  msg = 'cwd is not a git repository; run `git init` first, then `/serenity-init` again';
                } else if (err instanceof InitGitCommitError) {
                  msg = `git add+commit failed (rolled back): ${err.message}`;
                } else if (err instanceof InvalidInstanceNameError) {
                  msg = err.message;
                } else {
                  msg = err instanceof Error ? err.message : String(err);
                }
                api.ui.toast({ title: 'Error', message: msg, variant: 'error', duration: 5000 });
                log.warn('serenity-init', 'init failed', { err: msg });
              }
            },
            onCancel: () => {
              dialog.clear();
              api.ui.toast({
                title: 'serenity',
                message: 'Cancelled',
                variant: 'info',
                duration: 5000,
              });
            },
          }),
        );
      },
    },
  ]);
};

export default {
  id: 'opencode-serenity-plugin-tui',
  tui: Tui,
};
