/**
 * template-loader.ts — 技能模板加载器（v0.1 D2）
 *
 * 职责：
 *   1. 从 plugin 的 src/templates/<name>/ 目录加载模板
 *   2. 替换占位符（{{prefix}}, {{instance_name}}, {{date}}）
 *   3. 输出目标路径 → 文件内容映射
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 类型 ──

export interface TemplateManifest {
  name: string;
  eal?: string;
  description: string;
  /** 依赖的其他技能名 */
  dependencies?: string[];
  /** 需要注册的 MSM 列表 */
  msm?: Array<{
    name: string;
    path: string;
    description: string;
    category: 'mech' | 'semi-mech';
  }>;
  version?: string;
}

export interface TemplateFiles {
  /** 根目录下要创建的文件（key = 相对路径, value = 内容） */
  files: Record<string, string>;
  /** 模板清单 */
  manifest: TemplateManifest;
}

export interface Placeholders {
  prefix: string;
  instanceName: string;
  date: string;
}

// ── 默认值 ──

export function defaultPlaceholders(prefix: string): Placeholders {
  const now = new Date();
  return {
    prefix,
    instanceName: `${prefix}-serenity`,
    date: now.toISOString().slice(0, 10),
  };
}

// ── 模板发现 ──

/**
 * 返回 plugin 内置模板的 src/templates/ 目录路径。
 * 开发模式：相对于 bin/ 脚本的安装路径。
 */
export function getTemplatesDir(pluginRoot: string): string {
  return join(pluginRoot, 'src', 'templates');
}

/**
 * 列出所有可用模板名
 */
export function listAvailableTemplates(templatesDir: string): string[] {
  try {
    return readdirSync(templatesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ── 模板加载 ──

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

function replacePlaceholders(content: string, placeholders: Placeholders): string {
  return content.replace(PLACEHOLDER_PATTERN, (_, key: string) => {
    switch (key) {
      case 'prefix': return placeholders.prefix;
      case 'instance_name': return placeholders.instanceName;
      case 'date': return placeholders.date;
      default: return `{{${key}}}`; // 保持未知占位符不变
    }
  });
}

/**
 * 加载模板目录，返回文件映射（已替换占位符）。
 * 跳过 manifest.yaml 本身（不作为目标文件）。
 */
export function loadTemplate(
  templatesDir: string,
  name: string,
  placeholders: Placeholders,
): TemplateFiles {
  const templatePath = join(templatesDir, name);

  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: "${name}" at ${templatePath}`);
  }

  if (!statSync(templatePath).isDirectory()) {
    throw new Error(`Template path is not a directory: ${templatePath}`);
  }

  // 读取 manifest
  const manifestPath = join(templatePath, 'manifest.yaml');
  let manifest: TemplateManifest;
  if (existsSync(manifestPath)) {
    const raw = readFileSync(manifestPath, 'utf8');
    manifest = parseManifest(raw, name);
  } else {
    manifest = { name, description: `Skill: ${name}` };
  }

  // 收集所有文件（递归）
  const files: Record<string, string> = {};

  function collectFiles(dir: string, relativeDir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'manifest.yaml') continue; // 跳过 manifest
      const fullPath = join(dir, entry.name);
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        collectFiles(fullPath, relPath);
      } else if (entry.isFile()) {
        const content = readFileSync(fullPath, 'utf8');
        files[relPath] = replacePlaceholders(content, placeholders);
      }
    }
  }

  collectFiles(templatePath, '');
  return { files, manifest };
}

// ── Manifest 解析（简单 yaml 解析） ──

function parseManifest(raw: string, fallbackName: string): TemplateManifest {
  const result: TemplateManifest = { name: fallbackName, description: '' };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case 'name': result.name = value; break;
      case 'eal': result.eal = value; break;
      case 'description': result.description = value; break;
      case 'version': result.version = value; break;
    }
  }
  return result;
}

// ── 模板安装 ──

export interface InstallTemplateOptions {
  /** 源模板路径（plugin 的 src/templates/<name>/） */
  templateDir: string;
  /** 模板名 */
  name: string;
  /** 目标 serenity 根路径（cwdRoot） */
  serenityRoot: string;
  /** 实例前缀 */
  prefix: string;
  /** 占位符（可选，不传则用默认值） */
  placeholders?: Placeholders;
  /** dry-run 模式 */
  dryRun?: boolean;
}

export interface InstallTemplateResult {
  /** 是否做了实际写入 */
  changed: boolean;
  /** 安装的目标技能目录名（如 "prefix-auth"） */
  skillDirName: string;
  /** 创建的文件列表 */
  createdFiles: string[];
  /** 错误信息（可选） */
  error?: string;
}

/**
 * 安装技能模板到 serenity 实例。
 * 输出到 <serenityRoot>/.opencode/skills/<prefix>-<name>/
 */
export function installTemplate(opts: InstallTemplateOptions): InstallTemplateResult {
  const { templateDir, name, serenityRoot, prefix, dryRun } = opts;
  const ph = opts.placeholders ?? defaultPlaceholders(prefix);

  // 加载模板
  const { files } = loadTemplate(templateDir, name, ph);

  // 目标路径
  const targetDir = join(serenityRoot, '.opencode', 'skills', `${prefix}-${name}`);
  const createdFiles: string[] = [];

  if (dryRun) {
    return {
      changed: true,
      skillDirName: `${prefix}-${name}`,
      createdFiles: Object.keys(files),
    };
  }

  // 写入文件
  let hasChanges = false;
  for (const [relPath, content] of Object.entries(files)) {
    const targetFile = join(targetDir, relPath);
    const parentDir = targetFile.slice(0, targetFile.lastIndexOf('/'));

    // 检查是否已存在且内容一致
    if (existsSync(targetFile)) {
      const existing = readFileSync(targetFile, 'utf8');
      if (existing === content) continue;
    }

    // 创建父目录
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    writeFileSync(targetFile, content, 'utf8');
    createdFiles.push(relPath);
    hasChanges = true;
  }

  return {
    changed: hasChanges,
    skillDirName: `${prefix}-${name}`,
    createdFiles,
  };
}
