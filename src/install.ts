/**
 * v1.11 — bin install CLI lib (pure logic, no side effects at import)
 *
 * 职责:
 * - 检测 global config home (XDG_CONFIG_HOME / ~/.config / %APPDATA%)
 * - 解析 install path → 两个 plugin entry (server + tui)
 * - 读写 JSON config (atomic write via tmp + rename)
 * - 幂等: 同一 plugin (id 或 abs path) 不重复添加
 * - 追踪 _plugin_origins: 知道每个 entry 是哪个 plugin 装的、何时装、从哪装
 *
 * 与 src/util/tui-install.ts 的关系:
 * - tui-install.ts 只管 global tui.json,只放 dist/tui.js,函数风格 imperative
 * - install.ts 通用化: 既管 tui.json 也管 opencode.json,同时写多个 entry
 * - 复用 tui-install.ts 的 toPluginSpec 思想 (realpath + file://)
 *
 * D23 (2026-06-07): 两 entry 架构不可破 — server entry 仅 project-level
 *   加载,TUI entry 全局加载,保留 V2 非侵入语义。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { pathToFileURL } from 'node:url';

export const PLUGIN_ID = 'opencode-serenity-plugin';
const DIST_DIR = 'dist';
const SERVER_ENTRY_FILENAME = 'index.js';
const TUI_ENTRY_FILENAME = 'tui.js';
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';
const TUI_SCHEMA_URL = 'https://opencode.ai/tui.json';

export type PluginEntry = {
  /** Plugin 逻辑 id (e.g. opencode-serenity-plugin) */
  id: string;
  /** 规范化的 file:// URL,用于 opencode 配置 */
  path: string;
  /** 绝对文件系统路径,用于 _plugin_origins 追踪 */
  absPath: string;
};

export type ResolvedEntries = {
  id: string;
  server: PluginEntry;
  tui: PluginEntry;
};

export type InstallResult = {
  changed: boolean;
  configPath: string;
  error?: string;
  addedPaths?: string[];
  skippedPaths?: string[];
};

export type ConfigType = 'opencode.json' | 'tui.json';

/** 读出的 config 结构 (可包含 _plugin_origins 元数据) */
export type ReadConfig = {
  [key: string]: unknown;
  plugin?: unknown;
  _plugin_origins?: Record<string, PluginOrigin>;
};

export type PluginOrigin = {
  id: string;
  installedAt: string;
  installPath: string;
};

// ── 路径解析 ──

/**
 * 解析 global opencode config 目录。
 *
 * 优先级:
 * 1. $XDG_CONFIG_HOME/opencode (XDG Base Directory 规范,Linux/macOS)
 * 2. $APPDATA/opencode (Windows 优先)
 * 3. ~/AppData/Roaming/opencode (Windows 兜底)
 * 4. ~/.config/opencode (Unix 兜底)
 */
export function detectGlobalConfigHome(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (typeof xdg === 'string' && xdg.trim().length > 0) {
    return join(xdg, 'opencode');
  }
  if (platform() === 'win32') {
    const appdata = process.env['APPDATA'];
    if (typeof appdata === 'string' && appdata.trim().length > 0) {
      return join(appdata, 'opencode');
    }
    return join(homedir(), 'AppData', 'Roaming', 'opencode');
  }
  return join(homedir(), '.config', 'opencode');
}

/** global config 文件路径 */
export function getGlobalConfigPath(filename: ConfigType): string {
  return join(detectGlobalConfigHome(), filename);
}

/**
 * 解析 install path → 两个 plugin entry。
 *
 * - installPath 应为 package 根目录 (含 dist/index.js + dist/tui.js)
 * - 自动 realpath 解析 symlink (npm global install / pnpm link 都会建 symlink)
 * - 绝对路径验证 (相对路径直接抛)
 */
export function resolvePluginEntries(installPath: string): ResolvedEntries {
  if (!isAbsolute(installPath)) {
    throw new Error(`installPath must be absolute: ${installPath}`);
  }
  const realInstall = realpathSync(installPath);
  const serverAbs = join(realInstall, DIST_DIR, SERVER_ENTRY_FILENAME);
  const tuiAbs = join(realInstall, DIST_DIR, TUI_ENTRY_FILENAME);
  return {
    id: PLUGIN_ID,
    server: {
      id: PLUGIN_ID,
      path: pathToFileURL(serverAbs).href,
      absPath: serverAbs,
    },
    tui: {
      id: PLUGIN_ID,
      path: pathToFileURL(tuiAbs).href,
      absPath: tuiAbs,
    },
  };
}

/**
 * 从 bin 文件路径反推 install path (package 根目录)。
 *
 * 用于 CLI: bin 位于 <pkg>/bin/<name>.js,install path = <pkg>/。
 * 自动 realpath 解析 symlink (npm global install 会建 symlink)。
 */
export function resolveInstallPathFromBin(binFilePath: string): string {
  if (!isAbsolute(binFilePath)) {
    throw new Error(`bin path must be absolute: ${binFilePath}`);
  }
  const realBin = realpathSync(binFilePath);
  // <pkg>/bin/<name>.js → dirname = <pkg>/bin → dirname = <pkg>
  return dirname(dirname(realBin));
}

// ── JSON I/O ──

/**
 * 读 JSON config。文件不存在或为空 → 返回 {}。
 *
 * 严格模式 (v1.18 收口 — 旧 tui-install.ts 行为):
 * - 文件不存在或空 → 返回 {} (允许新装)
 * - JSON.parse 失败 → 抛 Error (writePluginEntry 捕获并返回 error, 不覆盖用户数据)
 * - 根节点非 object (array / null / 标量) → 抛 Error
 *
 * 不抛的"宽松"行为会静默覆盖用户已损坏的 config, 风险高。
 * 严格模式让 writePluginEntry 显式告诉用户 "config 损坏, 请人工修复"。
 */
export function readJsonConfig(path: string): ReadConfig {
  if (!existsSync(path)) {
    return {};
  }
  const text = readFileSync(path, 'utf8');
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`parse error: ${reason}`);
  }
  if (parsed === null) {
    throw new Error(`config root is null, expected object`);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config root is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
  }
  return parsed as ReadConfig;
}

/**
 * 原子写 JSON config。
 *
 * 流程: mkdir -p parent → 写 path.tmp → rename 到 path。
 * rename 在同一文件系统下是原子操作,避免半写状态。
 */
export function writeJsonConfig(path: string, data: ReadConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, path);
}

// ── 幂等检查 ──

/** 提取 plugin 数组里所有 entry 的主 spec (string 或 [string, opts] tuple) */
function collectExistingSpecs(plugin: unknown): Set<string> {
  const specs = new Set<string>();
  if (!Array.isArray(plugin)) return specs;
  for (const item of plugin) {
    if (typeof item === 'string') {
      specs.add(item);
    } else if (Array.isArray(item) && typeof item[0] === 'string') {
      specs.add(item[0]);
    }
  }
  return specs;
}

/** 从 _plugin_origins 提取已注册的 plugin id 集合 */
function collectInstalledIds(origins: unknown): Set<string> {
  const ids = new Set<string>();
  if (!origins || typeof origins !== 'object' || Array.isArray(origins)) {
    return ids;
  }
  for (const value of Object.values(origins as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id.length > 0) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * 判定 entries 是否已安装。
 *
 * 检查顺序:
 * 1. _plugin_origins 里已有相同 id → 视为已安装 (前向兼容 object 形式)
 * 2. plugin 数组里已有相同 file:// URL → 视为已安装 (string / tuple 形式)
 *
 * 返回 true = 全部 entries 都不必再写 (no-op)
 * 返回 false = 至少一个 entry 还没装
 */
export function isAlreadyInstalled(
  entries: PluginEntry[],
  existing: ReadConfig,
): boolean {
  if (entries.length === 0) return true;

  const installedIds = collectInstalledIds(existing['_plugin_origins']);
  const existingSpecs = collectExistingSpecs(existing['plugin']);

  for (const entry of entries) {
    if (installedIds.has(entry.id)) return true;
    if (existingSpecs.has(entry.path)) return true;
  }
  return false;
}

// ── 主入口 ──

/**
 * 把 plugin entries 写入 config file 的 `plugin` 数组 (idempotent)。
 *
 * 行为契约:
 * - 文件不存在 → 创建 (含 $schema + plugin 数组)
 * - 已有 _plugin_origins → 保留,补充新 entry
 * - 已有 plugin 数组 → 保留,append 不重复 entry
 * - 已有非 plugin 字段 → 完全保留
 * - 写失败 → 返回 { changed: false, error },不抛
 *
 * @param configPath  目标 config 文件绝对路径
 * @param entries     要注册的 plugin entries (server/tui 之一或两者)
 */
export function writePluginEntry(
  configPath: string,
  entries: PluginEntry[],
): InstallResult {
  if (entries.length === 0) {
    return { changed: false, configPath, skippedPaths: [] };
  }

  let config: ReadConfig;
  try {
    config = readJsonConfig(configPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { changed: false, configPath, error: `read failed: ${reason}` };
  }

  // 分离: 真正要新增的 vs 已存在的
  const installedIds = collectInstalledIds(config['_plugin_origins']);
  const existingSpecs = collectExistingSpecs(config['plugin']);
  const currentPlugin = Array.isArray(config['plugin']) ? config['plugin'] : [];
  const toAdd: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (installedIds.has(entry.id) || existingSpecs.has(entry.path)) {
      skipped.push(entry.path);
    } else {
      toAdd.push(entry.path);
    }
  }

  if (toAdd.length === 0) {
    return {
      changed: false,
      configPath,
      skippedPaths: skipped,
    };
  }

  // 追加 spec
  for (const spec of toAdd) {
    currentPlugin.push(spec);
  }
  config['plugin'] = currentPlugin;

  // 更新 _plugin_origins 追踪
  if (
    !config['_plugin_origins'] ||
    typeof config['_plugin_origins'] !== 'object' ||
    Array.isArray(config['_plugin_origins'])
  ) {
    config['_plugin_origins'] = {};
  }
  const origins = config['_plugin_origins'] as Record<string, PluginOrigin>;
  const installedAt = new Date().toISOString();
  for (const entry of entries) {
    // 只追踪本次涉及的 entry;保留历史 entry 的 origins
    if (skipped.includes(entry.path)) continue;
    origins[entry.path] = {
      id: entry.id,
      installedAt,
      installPath: dirname(dirname(entry.absPath)), // dist/.. = package root
    };
  }
  config['_plugin_origins'] = origins;

  // 新文件加 $schema (与 tui-install.ts 一致)
  if (!('$schema' in config)) {
    config['$schema'] = configPath.endsWith('tui.json')
      ? TUI_SCHEMA_URL
      : OPENCODE_SCHEMA_URL;
  }

  try {
    writeJsonConfig(configPath, config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { changed: false, configPath, error: `write failed: ${reason}` };
  }

  return {
    changed: true,
    configPath,
    addedPaths: toAdd,
    skippedPaths: skipped,
  };
}
