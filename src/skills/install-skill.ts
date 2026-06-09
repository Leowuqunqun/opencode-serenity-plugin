/**
 * install-skill.ts — D2: 技能安装命令处理器
 *
 * CLI: opencode-serenity-plugin install-skill <name> [--prefix=<str>] [--include=<feat>] [--dry-run]
 *
 * 流程：
 *   1. 确定 prefix（从 --prefix 或 .serenity）
 *   2. 找到 plugin 的 src/templates/<name>/
 *   3. 加载模板，替换占位符
 *   4. 写入 <serenityRoot>/.opencode/skills/<prefix>-<name>/
 *   5. 注册 MSM（若 manifest 有声明）
 *   6. 输出结果
 */

import { existsSync } from 'node:fs';
import {
  findSerenityRootSafe,
  readSerenityInstanceName,
} from '../fs/resolve-path.js';
import {
  getTemplatesDir,
  listAvailableTemplates,
  installTemplate,
} from './template-loader.js';

export interface InstallSkillOptions {
  /** plugin 根目录（resolveInstallPathFromBin 的产出） */
  pluginRoot: string;
  /** 技能名（如 auth, pagedesigner） */
  name: string;
  /** 宁静号项目 cwd（用于定位 .serenity） */
  cwd: string;
  /** 技能前缀（可选，默认从 .serenity 推断） */
  prefix?: string;
  /** dry-run 模式 */
  dryRun?: boolean;
}

export interface InstallSkillResult {
  success: boolean;
  skillDir?: string;
  createdFiles?: string[];
  message: string;
}

/**
 * 主入口：安装技能到 serenity 实例
 */
export function installSkill(opts: InstallSkillOptions): InstallSkillResult {
  const { pluginRoot, name, cwd, dryRun } = opts;

  // 1. 验证 .serenity 存在
  const serenityRoot = findSerenityRootSafe(cwd);
  if (!serenityRoot) {
    return {
      success: false,
      message: `Not inside a serenity instance: no .serenity found from ${cwd}`,
    };
  }

  // 2. 确定 prefix
  const prefix = opts.prefix ?? readSerenityInstanceName(serenityRoot);
  if (!prefix) {
    return {
      success: false,
      message: `Failed to determine instance prefix: .serenity at ${serenityRoot} is empty or unreadable`,
    };
  }

  // 3. 验证模板存在
  const templatesDir = getTemplatesDir(pluginRoot);
  if (!existsSync(templatesDir)) {
    return {
      success: false,
      message: `Templates directory not found: ${templatesDir} (plugin not built or src/ missing)`,
    };
  }

  const available = listAvailableTemplates(templatesDir);
  if (!available.includes(name)) {
    const hint = available.length > 0
      ? `Available templates: ${available.join(', ')}`
      : 'No templates available.';
    return {
      success: false,
      message: `Template "${name}" not found. ${hint}`,
    };
  }

  // 4. 安装模板
  try {
    const result = installTemplate({
      templateDir: templatesDir,
      name,
      serenityRoot,
      prefix,
      dryRun,
    });

    if (result.error) {
      return { success: false, message: result.error };
    }

    if (!result.changed) {
      return {
        success: true,
        skillDir: result.skillDirName,
        createdFiles: [],
        message: `Already installed: ${result.skillDirName} (no changes)`,
      };
    }

    const fileCount = result.createdFiles.length;
    return {
      success: true,
      skillDir: result.skillDirName,
      createdFiles: result.createdFiles,
      message: dryRun
        ? `[dry-run] Would install: ${result.skillDirName}/ (${fileCount} file(s))`
        : `Installed: ${result.skillDirName}/ (${fileCount} file(s))`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Install failed: ${msg}` };
  }
}
