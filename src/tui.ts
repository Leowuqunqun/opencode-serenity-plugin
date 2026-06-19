/**
 * opencode-serenity-plugin TUI entry（v1.9 → ... → v1.15 → v0.1 D6）
 *
 * 独立 TUI plugin（与 server plugin 平级）。opencode 1.16+ 强制 PluginModule
 * 二选一（server | tui），所以走两条独立 entry：
 * - server entry: dist/index.js（走 Hooks 系统）
 * - tui entry:    dist/tui.js  （走 TuiPluginApi）
 *
 * v0.1 D6:
 * - 启动时检测当前目录的宁静号状态，显示在 toast 上
 * - 三种状态：Activated / Not Activated / Error
 * - 版本号始终显示
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
 * v1.10.1 修复（/serenity-init 在非 serenity 目录不可见的 bug）：
 * - 根因：plugin path 只登记在项目 tui.json；非 serenity 目录 walk-up
 *   找不到 tui.json → plugin 不加载 → Tui(api) 永不调 → slash 不出现
 *   详见 AGENT_SESSIONS/2026-06-06--S020--fix-serenity-init-visibility
 * - 修复：B 段自安装到 global tui.json（$XDG_CONFIG_HOME/opencode/tui.json
 *   或 ~/.config/opencode/tui.json），让 opencode 在**任何**目录启动都加载
 *   plugin。slash command 注册不受 self-install 成功与否影响
 *   （try/catch 包住，失败仅 log.warn）
 * - 一次性行为：self-install 幂等，no-op 当 plugin path 已存在
 *
 * v1.15 版本号可见性:
 * - 每次 plugin 加载在 toast 里显示 `opencode-serenity-plugin v${VERSION}`，
 *   用户重启 opencode 时即可确认实际加载的版本（避免 dev 缓存/旧 dist）。
 * - VERSION 动态从 package.json 读（`import pkg ... with { type: 'json' }`），
 *   release 时改 package.json#version 即可，无需同步本文件。
 * - "loaded" toast 放在 self-install 之前，无论 self-install 是否成功都
 *   能看到版本号。
 *
 * 与 server plugin 协同：
 * - server plugin 负责"拦截 + 行为"（RR1-RR7 + permission auto-reply + config-patch）
 * - tui plugin 负责"通知用户"（激活提示 + 自安装 + RR7 初始化入口）
 */

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import {
  defaultPrefix,
  initSerenity,
  isValidPrefix,
} from './util/init.js';
import { ensureGlobalTuiPluginRegistration } from './util/tui-install.js';
import {
  InvalidCccNameError,
  InitGitCommitError,
} from './errors.js';
import { log } from './util/log.js';
import { findSerenityRootSafe, readSerenityCccName } from './fs/resolve-path.js';
import { setBashDisabled, isBashDisabled } from './bash-toggle.js';
import pkg from '../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

const Tui: TuiPlugin = async (api) => {
  // v1.15 — 每次加载都显示版本号
  api.ui.toast({
    title: `opencode-serenity-plugin v${VERSION}`,
    message: 'loaded',
    variant: 'success',
    duration: 3000,
  });

  // v0.1 D6 — 检测当前目录的宁静号状态
  const cwd = api.state.path.directory;
  let serenityStatus: string;
  let serenityVariant: 'success' | 'info' | 'error';
  let serenityInstance: string | null = null;  // CCC name

  const root = findSerenityRootSafe(cwd);
  if (root) {
    const name = readSerenityCccName(root);
    serenityInstance = name;
    // 验证 SKILL.md 存在（RR2 同级检测）
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const skillPath = name
      ? resolve(root, '.opencode', 'skills', name, 'SKILL.md')
      : null;
    if (skillPath && existsSync(skillPath)) {
      serenityStatus = `✓ Serenity Activated${name ? ` (${name})` : ''}`;
      serenityVariant = 'success';
    } else {
      serenityStatus = `⚠ Serenity Error${name ? ` (${name})` : ''}`;
      serenityVariant = 'error';
    }
  } else {
    serenityStatus = '○ Serenity Not Activated';
    serenityVariant = 'info';
  }

  api.ui.toast({
    title: `serenity v${VERSION}`,
    message: serenityInstance
      ? `${serenityStatus} — instance: ${serenityInstance}`
      : serenityStatus,
    variant: serenityVariant,
    duration: 5000,
  });

  // A: v1.1 — self-install to global tui.json
  //    让 plugin 在非 serenity 目录也被加载，从而 /serenity-init 全局可见
  //    失败不抛（仅 log），slash command 仍注册
  try {
    const pluginFile = fileURLToPath(import.meta.url);
    const result = ensureGlobalTuiPluginRegistration(pluginFile);
    if (result.changed) {
      api.ui.toast({
        title: 'serenity',
        message:
          `opencode-serenity-plugin v${VERSION} installed; restart opencode to ` +
          `enable /serenity-init in non-serenity directories`,
        variant: 'info',
        duration: 8000,
      });
    } else if (result.error) {
      log.warn('tui-install', 'self-install failed; /serenity-init visible only in this project', {
        error: result.error,
        configPath: result.configPath,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('tui-install', 'unexpected error during self-install (slash command still registered)', {
      error: reason,
    });
  }

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
                  const msg = result.gitInited
                    ? `Git repo auto-created. Initialized ${result.name}; restart opencode to complete`
                    : `Initialized ${result.name}; please restart opencode`;
                  api.ui.toast({
                    title: 'serenity',
                    message: msg,
                    variant: 'success',
                    duration: 6000,
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
                if (err instanceof InitGitCommitError) {
                  msg = `git add+commit failed (rolled back): ${err.message}`;
                } else if (err instanceof InvalidCccNameError) {
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
    // D: /serenity-bash-on — 启用 bash
    {
      title: 'serenity: enable bash',
      value: 'serenity-bash-on',
      description: 'Enable bash tool (default)',
      slash: { name: 'serenity-bash-on' },
      onSelect: () => {
        setBashDisabled(false);
        api.ui.toast({
          title: 'Bash',
          message: 'bash is now enabled',
          variant: 'success',
          duration: 3000,
        });
      },
    },
    // D: /serenity-bash-off — 禁用 bash（静默拒绝）
    {
      title: 'serenity: disable bash',
      value: 'serenity-bash-off',
      description: 'Disable bash tool (silent reject via plugin hook)',
      slash: { name: 'serenity-bash-off' },
      onSelect: () => {
        setBashDisabled(true);
        api.ui.toast({
          title: 'Bash',
          message: 'bash is now disabled (silent reject)',
          variant: 'warning',
          duration: 3000,
        });
      },
    },
    // D: /serenity-bash-status — 查看当前状态
    {
      title: 'serenity: bash status',
      value: 'serenity-bash-status',
      description: 'Show current bash toggle status',
      slash: { name: 'serenity-bash-status' },
      onSelect: () => {
        const disabled = isBashDisabled();
        api.ui.toast({
          title: 'Bash Status',
          message: disabled ? 'bash is DISABLED (silent reject)' : 'bash is enabled',
          variant: disabled ? 'warning' : 'success',
          duration: 5000,
        });
      },
    },
  ]);
};

export default {
  id: 'opencode-serenity-plugin-tui',
  tui: Tui,
};
