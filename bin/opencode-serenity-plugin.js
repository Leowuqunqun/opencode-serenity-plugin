#!/usr/bin/env node
/**
 * opencode-serenity-plugin CLI (v1.11)
 *
 * Usage:
 *   opencode-serenity-plugin install [flags]
 *
 * Flags:
 *   --global     Write only to global tui.json (skip project opencode.json)
 *   --dry-run    Print what would be done without writing
 *   --verbose    Show detailed output (default: silent on no-op success)
 *   --help       Show this help
 *   --version    Show version
 *
 * Exit codes:
 *   0  Success (including no-op when already installed)
 *   1  Hard error (permission denied, dist/ not built, etc.)
 *   2  Conflict: plugin already installed at a different path
 *
 * Notes:
 * - 逻辑层在 ../dist/install.js (来自 src/install.ts)。
 *   跑 install 前必须 `pnpm build` (或 `npm run build`)。
 * - 项目 vs global 自动检测:
 *   - cwd 在 git repo → 写 project opencode.json + global tui.json
 *   - cwd 不在 git repo → 只写 global tui.json
 *   - --global 强制只写 global tui.json
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  PLUGIN_ID,
  resolvePluginEntries,
  resolveInstallPathFromBin,
  getGlobalConfigPath,
  readJsonConfig,
  writePluginEntry,
} from '../dist/install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INSTALL_PATH = resolveInstallPathFromBin(__filename);

// ── CLI 解析 (轻量,无 yargs 依赖) ──

function parseArgs(argv) {
  const flags = {
    command: null,
    global: false,
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case 'install': flags.command = 'install'; break;
      case 'uninstall': flags.command = 'uninstall'; break;
      case '--global': flags.global = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--verbose': case '-v': flags.verbose = true; break;
      case '--help': case '-h': flags.help = true; break;
      case '--version': flags.version = true; break;
      default:
        if (arg.startsWith('--')) {
          process.stderr.write(`error: unknown flag: ${arg}\n`);
          process.exit(1);
        }
    }
  }
  return flags;
}

function readVersion() {
  const pkgPath = resolve(INSTALL_PATH, 'package.json');
  if (!existsSync(pkgPath)) return 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  const version = readVersion();
  process.stdout.write(`opencode-serenity-plugin v${version}

Usage:
  opencode-serenity-plugin install [flags]

Commands:
  install    Write server + TUI plugin entries to opencode config (idempotent)

Flags:
  --global     Write only to global tui.json (skip project opencode.json)
  --dry-run    Print what would be done without writing
  --verbose    Show detailed output
  --help, -h   Show this help
  --version    Print version and exit

What gets installed:
  - <cwd>/opencode.json#plugin  → dist/index.js   (server entry, project only)
  - <global>/tui.json#plugin    → dist/tui.js     (TUI entry, global for V1)

Auto-detect:
  - cwd is in a git repo → install both project + global
  - cwd is NOT in a git repo → install global only
  - --global → always skip project

Exit codes:
  0  Success (including no-op when already installed)
  1  Hard error (permission denied, dist/ not built, etc.)
  2  Conflict: plugin already installed at a different path
`);
}

// ── 工具 ──

/** walk up 找最近的 .git/ 目录 */
function findGitRoot(cwd) {
  let dir = resolve(cwd);
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 检测 plugin id 是否已在 _plugin_origins 里以不同路径注册 */
function detectConflictId(entries, config) {
  const origins = config['_plugin_origins'];
  if (!origins || typeof origins !== 'object' || Array.isArray(origins)) {
    return null;
  }
  for (const entry of entries) {
    for (const [path, origin] of Object.entries(origins)) {
      if (origin && typeof origin === 'object' && origin.id === entry.id
          && path !== entry.path) {
        return { id: entry.id, existingPath: path, newPath: entry.path };
      }
    }
  }
  return null;
}

// ── 主入口 ──

function installCommand(flags) {
  // 1. 解析 entries
  let entries;
  try {
    entries = resolvePluginEntries(INSTALL_PATH);
  } catch (err) {
    process.stderr.write(`error: failed to resolve plugin entries: ${err.message}\n`);
    return 1;
  }

  // 2. 检查 dist/ 是否存在
  if (!existsSync(entries.server.absPath) || !existsSync(entries.tui.absPath)) {
    process.stderr.write(`error: dist/ not built at ${INSTALL_PATH}\n`);
    process.stderr.write(`hint: run 'pnpm build' or 'npm run build' first\n`);
    return 1;
  }

  // 3. 决定目标
  const targets = [];
  if (!flags.global) {
    const gitRoot = findGitRoot(process.cwd());
    if (gitRoot) {
      targets.push({
        configPath: join(gitRoot, 'opencode.json'),
        entries: [entries.server],
        label: `project opencode.json (${gitRoot})`,
      });
    } else if (flags.verbose) {
      process.stdout.write(`→ cwd not in a git repo, skipping project opencode.json\n`);
    }
  }
  targets.push({
    configPath: getGlobalConfigPath('tui.json'),
    entries: [entries.tui],
    label: `global tui.json`,
  });

  // 4. 冲突检测
  for (const t of targets) {
    const config = readJsonConfig(t.configPath);
    const conflict = detectConflictId(t.entries, config);
    if (conflict) {
      process.stderr.write(`error: ${conflict.id} already installed at a different path\n`);
      process.stderr.write(`  existing: ${conflict.existingPath}\n`);
      process.stderr.write(`  new:      ${conflict.newPath}\n`);
      process.stderr.write(`hint: remove the existing entry manually, then re-run install\n`);
      return 2;
    }
  }

  // 5. 执行
  let changed = 0;
  let noop = 0;
  for (const t of targets) {
    if (flags.dryRun) {
      const specs = t.entries.map(e => e.path).join(', ');
      process.stdout.write(`[dry-run] would write ${specs} to ${t.configPath}\n`);
      continue;
    }
    const result = writePluginEntry(t.configPath, t.entries);
    if (result.error) {
      process.stderr.write(`error: ${t.label}: ${result.error}\n`);
      return 1;
    }
    if (result.changed) {
      changed++;
      if (flags.verbose) {
        process.stdout.write(`✓ wrote ${t.configPath} (${result.addedPaths.join(', ')})\n`);
      }
    } else {
      noop++;
      if (flags.verbose) {
        process.stdout.write(`✓ already installed: ${t.configPath}\n`);
      }
    }
  }

  // 6. 输出
  if (flags.dryRun) {
    // already printed above
  } else if (changed > 0 && !flags.verbose) {
    process.stdout.write(`opencode-serenity-plugin: installed (${changed} config${changed === 1 ? '' : 's'}). restart opencode to activate.\n`);
  } else if (flags.verbose) {
    process.stdout.write(`done. changed=${changed} noop=${noop}\n`);
  }
  // else: silent on no-op success

  return 0;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.version) {
    process.stdout.write(readVersion() + '\n');
    return 0;
  }
  if (flags.help || !flags.command) {
    printHelp();
    return flags.help ? 0 : 1;
  }

  switch (flags.command) {
    case 'install':
      return installCommand(flags);
    case 'uninstall':
      process.stderr.write(`error: 'uninstall' not implemented in v1.11 (D24 scope: install only)\n`);
      process.stderr.write(`hint: manually remove entry from <config>#plugin, then delete from _plugin_origins\n`);
      return 1;
    default:
      process.stderr.write(`error: unknown command: ${flags.command}\n`);
      return 1;
  }
}

process.exit(main());
