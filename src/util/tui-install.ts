/**
 * Global TUI config auto-registration utility（v1.10.1 修复）
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
 * 行为契约：
 * - 幂等：plugin path 已在 global list 时 no-op
 * - 保留其他字段（theme / keybinds / attention / prompt / …）
 * - 写失败不抛：返回 `{ changed: false, error }`，调用方负责 toast/log
 * - 路径规范化：所有 path 走 realpathSync + pathToFileURL，与 opencode
 *   的 `ConfigPlugin.resolvePluginSpec` 一致（见 packages/opencode/src/config/plugin.ts:42-60）
 *
 * 为什么不做"自动恢复"：用户 m0040 已决定不做 live re-activation；
 * 自安装后还需用户**重启 opencode**（与 D5 一致），但只需一次。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = 'opencode';
const TUI_CONFIG_FILE = 'tui.json';
const TUI_SCHEMA_URL = 'https://opencode.ai/tui.json';

export type InstallResult = {
  changed: boolean;
  configPath: string;
  error?: string;
};

export type InstallOptions = {
  /** Override the config path (for tests). */
  configPath?: string;
};

/**
 * 解析 global TUI config 文件路径。
 *
 * 优先 `$XDG_CONFIG_HOME/opencode/tui.json`（respects XDG 规范），
 * 回退到 `~/.config/opencode/tui.json`。
 *
 * 路径不做 symlink 解析（保留字面量）。调用方应传入已解析的 plugin path。
 */
export function getGlobalTuiConfigPath(): string {
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  const configHome = xdgConfig && xdgConfig.trim().length > 0
    ? xdgConfig
    : join(homedir(), '.config');
  return join(configHome, APP_DIR, TUI_CONFIG_FILE);
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

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let text: string;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { changed: false, configPath, error: `read failed: ${reason}` };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { changed: false, configPath, error: 'tui.json root is not a JSON object' };
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { changed: false, configPath, error: `parse failed: ${reason}` };
    }
  }

  const current = config['plugin'];
  const list: unknown[] = Array.isArray(current) ? current : [];

  const existingSpecs = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string') {
      existingSpecs.add(item);
    } else if (Array.isArray(item) && typeof item[0] === 'string') {
      existingSpecs.add(item[0]);
    }
  }

  if (existingSpecs.has(spec)) {
    return { changed: false, configPath };
  }

  list.push(spec);
  config['plugin'] = list;

  if (!('$schema' in config)) {
    config['$schema'] = TUI_SCHEMA_URL;
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { changed: false, configPath, error: `write failed: ${reason}` };
  }

  return { changed: true, configPath };
}
