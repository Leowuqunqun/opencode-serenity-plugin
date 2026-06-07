/**
 * Global TUI config auto-registration utility (v1.10.1)
 *
 * 背景：TUI plugin 只在 tui.json 文件里登记的路径下被加载。默认登记在
 * 项目 tui.json（`/home/yh/our-home/HOME-SERENITY/home-serenity/tui.json`），
 * 这意味着非 serenity 目录下 opencode 找不到 tui.json → plugin 不加载
 * → `Tui(api)` 永不调 → `/serenity-init` slash command 不出现。
 *
 * 修复思路：plugin 在 `Tui(api)` 入口**自检并自安装**到 global TUI config
 * （`$XDG_CONFIG_HOME/opencode/tui.json` 或 `~/.config/opencode/tui.json`）。
 * 之后 opencode 在**任何**目录启动都会加载 plugin → slash command 全局可见。
 *
 * v1.18 统一：薄包装 install.ts 的 writePluginEntry + getGlobalConfigPath
 * - install.ts 已是 XDG + Windows APPDATA 兼容（detectGlobalConfigHome）
 * - install.ts 的 writePluginEntry 原子写、幂等、_plugin_origins 追踪
 * - tui-install.ts 保留 toPluginSpec / getGlobalTuiConfigPath /
 *   ensureGlobalTuiPluginRegistration 三个 public 名字（向后兼容 — tests
 *   依赖这些 export 名）
 *
 * 行为差异（v1.18 收口）：
 * - 之前 tui-install.ts 仅 XDG；现在 Windows 上走 APPDATA
 * - 这是正确的：tui auto-install 与 bin install 行为对齐
 * - 写盘时 install.ts 会更新 _plugin_origins（opencode 忽略未知 key）
 */

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  writePluginEntry,
  getGlobalConfigPath,
  PLUGIN_ID,
  type InstallResult,
} from '../install.js';

export type { InstallResult };

export type InstallOptions = {
  /** Override the config path (for tests). */
  configPath?: string;
};

/** 解析 global TUI config 路径（薄包装到 install.ts#getGlobalConfigPath）
 *
 * 优先 `$XDG_CONFIG_HOME/opencode/tui.json`（respects XDG 规范），
 * 回退到 `~/.config/opencode/tui.json`（或 Windows APPDATA）。
 */
export function getGlobalTuiConfigPath(): string {
  return getGlobalConfigPath('tui.json');
}

/**
 * 把 plugin 文件路径或 `file://` URL 规范化为 `file://` spec。
 *
 * - `file://` URL → realpath → 重新编码
 * - 绝对路径 → realpath → 编码
 * - 相对路径 → 抛错（global registration 必须用绝对路径）
 *
 * 与 opencode `ConfigPlugin.resolvePluginSpec` 对齐，保证两边都把同一个文件
 * 解析到同一个 `file://` URL。
 */
export function toPluginSpec(input: string): string {
  let absPath: string;
  if (input.startsWith('file://')) {
    absPath = realpathSync(fileURLToPath(input));
  } else if (isAbsolute(input)) {
    absPath = realpathSync(input);
  } else {
    throw new Error(`plugin path must be absolute: ${input}`);
  }
  return pathToFileURL(absPath).href;
}

/**
 * 把 plugin path 写入 global tui.json 的 `plugin` 数组（如果尚未存在）。
 *
 * 幂等：plugin path 已在 list 中则 no-op。保留 tui.json 其他字段。
 * 失败返回 `{ changed: false, error }`，**不抛**。
 *
 * v1.18 内部：委托给 install.ts#writePluginEntry（原子写、_plugin_origins 追踪、
 * XDG + APPDATA 兼容），本函数只做 plugin spec 规范化 + 错误包装。
 *
 * @param pluginPath  绝对文件路径或 `file://` URL（如 `dist/tui.js`）
 * @param options     configPath 覆盖（仅测试用）
 */
export function ensureGlobalTuiPluginRegistration(
  pluginPath: string,
  options: InstallOptions = {},
): InstallResult {
  const configPath = options.configPath ?? getGlobalTuiConfigPath();

  let spec: string;
  try {
    spec = toPluginSpec(pluginPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { changed: false, configPath, error: `bad plugin path: ${reason}` };
  }

  const absPath = fileURLToPath(spec);
  const result = writePluginEntry(configPath, [{
    id: PLUGIN_ID,
    path: spec,
    absPath,
  }]);

  return {
    changed: result.changed,
    configPath: result.configPath,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
