#!/usr/bin/env node
/**
 * opencode-serenity-plugin CLI (v1.11 → v0.0.4 全局化)
 *
 * Usage:
 *   opencode-serenity-plugin install [flags]
 *
 * Flags:
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
 * - v0.0.4: 两个 entry (server + TUI) 都装到全局 config:
 *   - dist/index.js → ~/.config/opencode/opencode.json#plugin
 *   - dist/tui.js   → ~/.config/opencode/tui.json#plugin
 * - 所有目录下 opencode 都加载两个 entry,由 tryActivateSync 判断是否激活。
 *   (之前 server entry 装项目级 opencode.json, 非 serenity 目录不加载 server)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  resolvePluginEntries,
  resolveInstallPathFromBin,
  getGlobalConfigPath,
  writePluginEntry,
} from '../dist/install.js';
import { installSkill } from '../dist/skills/install-skill.js';
import { initWizard } from '../dist/init/init-wizard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INSTALL_PATH = resolveInstallPathFromBin(__filename);

// ── CLI 解析 (轻量,无 yargs 依赖) ──

function parseArgs(argv) {
  const flags = {
    command: null,
    /** skill name for install-skill, or target path for init */
    skillName: null,
    prefix: null,
    /** flag for non-interactive init */
    nonInteractive: false,
    /** flag for force overwrite */
    force: false,
    global: false,
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
  };
  let expectPrefix = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // handle --prefix <value> (consumes next arg)
    if (expectPrefix) {
      flags.prefix = arg;
      expectPrefix = false;
      continue;
    }

    switch (arg) {
      case 'init':
        flags.command = 'init';
        // next arg is the target path (optional)
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags.skillName = argv[++i];
        }
        break;
      case 'install': flags.command = 'install'; break;
      case 'install-skill':
        flags.command = 'install-skill';
        // next arg is the skill name
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags.skillName = argv[++i];
        }
        break;
      case 'uninstall': flags.command = 'uninstall'; break;
      case '--global': flags.global = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--verbose': case '-v': flags.verbose = true; break;
      case '--non-interactive': flags.nonInteractive = true; break;
      case '--force': flags.force = true; break;
      case '--help': case '-h': flags.help = true; break;
      case '--version': flags.version = true; break;
      default:
        if (arg.startsWith('--prefix=')) {
          flags.prefix = arg.slice('--prefix='.length);
        } else if (arg === '--prefix') {
          expectPrefix = true;
        } else if (arg.startsWith('--')) {
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
  opencode-serenity-plugin init [path] [flags]
  opencode-serenity-plugin install [flags]
  opencode-serenity-plugin install-skill <name> [flags]

Commands:
  init            Create a new serenity instance (interactive wizard)
  install         Write server + TUI plugin entries to global opencode configs (idempotent)
  install-skill   Install a domain skill from built-in templates into the current serenity instance

  init [path]           Path for the new serenity instance (default: current directory)
  install-skill <name>  Available skills vary by version

Flags:
  --prefix=<str>   Skill prefix (default: auto-detect from .serenity)
  --non-interactive Skip interactive prompts (use defaults)
  --force           Overwrite existing files
  --dry-run        Print what would be done without writing
  --verbose        Show detailed output
  --help, -h       Show this help
  --version        Print version and exit

Exit codes:
  0  Success
  1  Hard error
`);
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

  // 3. 决定目标 — 两个 entry 都装到全局 config
  //    server entry 在全局 opencode.json，TUI entry 在全局 tui.json。
  //    所有目录下 opencode 都加载两个 entry，由 tryActivateSync 判断是否激活。
  //    （之前 server entry 装到项目级 opencode.json，导致非 serenity 目录不加载 server）
  const targets = [
    {
      configPath: getGlobalConfigPath('opencode.json'),
      entries: [entries.server],
      label: `global opencode.json`,
    },
    {
      configPath: getGlobalConfigPath('tui.json'),
      entries: [entries.tui],
      label: `global tui.json`,
    },
  ];

  // 4. 执行 — writePluginEntry 内已做幂等检查（isAlreadyInstalled）
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

// ── install-skill 命令 ──

function installSkillCommand(flags) {
  const name = flags.skillName;
  if (!name) {
    process.stderr.write('error: install-skill requires a skill name\n');
    process.stderr.write('usage: opencode-serenity-plugin install-skill <name> [--prefix=<str>]\n');
    return 1;
  }

  const result = installSkill({
    pluginRoot: INSTALL_PATH,
    name,
    cwd: process.cwd(),
    prefix: flags.prefix || undefined,
    dryRun: flags.dryRun,
  });

  if (!result.success) {
    process.stderr.write(`error: ${result.message}\n`);
    return 1;
  }

  if (flags.dryRun && flags.verbose && result.createdFiles?.length) {
    process.stdout.write('Files to create:\n');
    for (const f of result.createdFiles) {
      process.stdout.write(`  ${f}\n`);
    }
  }

  process.stdout.write(result.message + '\n');
  return 0;
}

// ── init 命令 ──

async function initCommand(flags) {
  const targetPath = flags.skillName || process.cwd(); // reuse skillName as positional target

  const result = await initWizard({
    targetPath,
    pluginRoot: INSTALL_PATH,
    prefix: flags.prefix || undefined,
    nonInteractive: flags.nonInteractive,
    force: flags.force,
  });

  if (!result.success) {
    process.stderr.write(`error: ${result.message}\n`);
    return 1;
  }

  process.stdout.write(result.message + '\n');
  return 0;
}

async function main() {
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
    case 'init':
      return await initCommand(flags);
    case 'install':
      return installCommand(flags);
    case 'install-skill':
      return installSkillCommand(flags);
    case 'uninstall':
      process.stderr.write(`error: 'uninstall' not implemented in v1.11 (D24 scope: install only)\n`);
      process.stderr.write(`hint: manually remove entry from <config>#plugin, then delete from _plugin_origins\n`);
      return 1;
    default:
      process.stderr.write(`error: unknown command: ${flags.command}\n`);
      return 1;
  }
}

main().then((code) => process.exit(code ?? 0));
