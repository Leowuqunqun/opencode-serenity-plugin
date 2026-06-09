/**
 * init-wizard.ts — D1 Init 向导 Phase 1
 *
 * CLI 交互式创建宁静号实例的目录骨架并复制标准技能模板。
 *
 * 流程：
 *   1. 收集基本信息（prefix, description）
 *   2. 创建目录骨架（.serenity, .gitignore, AGENT_SESSIONS/, docs/）
 *   3. 复制 9 个标准技能模板到 .opencode/skills/
 *   4. 生成 opencode.json（注册 plugin）
 *   5. 写入 Phase 2 Agent prompt
 *   6. 输出完成信息
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  getTemplatesDir,
  installTemplate,
  defaultPlaceholders,
  type Placeholders,
} from '../skills/template-loader.js';

// ── 类型 ──

export interface InitOptions {
  /** 目标路径 */
  targetPath: string;
  /** 实例前缀（如 home, tg, pg） */
  prefix?: string;
  /** 实例名称（如 宁静号，用于根 skill 标题） */
  name?: string;
  /** 实例描述（一句话） */
  description?: string;
  /** Plugin 根路径（用于定位模板） */
  pluginRoot: string;
  /** 非交互模式 */
  nonInteractive?: boolean;
  /** 强制覆盖已有文件 */
  force?: boolean;
}

export interface InitResult {
  success: boolean;
  prefix: string;
  name: string;
  message: string;
  createdDirs: string[];
  installedSkills: string[];
}

// ── 默认值 ──

const STANDARD_SKILLS = [
  'compass',
  'session',
  'sqc',
  'exploration',
  'quality-review',
  'landscape',
  'git',
];

/** 从目录名推断 prefix */
function inferPrefix(dirName: string): string {
  // 取第一个词（小写，非字母开头的去掉）
  const cleaned = dirName.replace(/[^a-zA-Z0-9-]/g, '');
  const first = cleaned.split(/[-_]/)[0];
  if (!first) return 'my';
  return first.toLowerCase().slice(0, 8);
}

/** 从 prefix 推断中文名 */
function inferName(prefix: string): string {
  const names: Record<string, string> = {
    home: '宁静号',
    tg: '天工宁静号',
    pg: '盘古宁静号',
  };
  return names[prefix] ?? `${prefix.toUpperCase()} 宁静号`;
}

// ── 交互式问答 ──

async function askQuestion(prompt: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    const fullPrompt = defaultValue
      ? `${prompt} [${defaultValue}]: `
      : `${prompt}: `;
    rl.question(fullPrompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function collectInfo(prefill: string): Promise<{
  prefix: string;
  description: string;
}> {
  const prefix = await askQuestion(
    'What prefix for skill names? (kebab-case, e.g. "home", "tg", "pg")',
    prefill,
  );

  const description = await askQuestion(
    'Describe this serenity instance in one sentence',
    '',
  );

  return {
    prefix: prefix || prefill,
    description: description || 'A serenity instance',
  };
}

// ── 骨架生成 ──

interface SkeletonFiles {
  path: string;
  content: string;
  isDir?: boolean;
}

function buildSkeleton(
  prefix: string,
): SkeletonFiles[] {
  const skillDir = join('.opencode', 'skills');
  const rootSkill = `${prefix}-serenity`;

  return [
    // 目录
    { path: join('AGENT_SESSIONS'), content: '', isDir: true },
    { path: join('docs'), content: '', isDir: true },
    { path: join('.opencode', 'scripts'), content: '', isDir: true },
    { path: join('.opencode', 'references'), content: '', isDir: true },
    // .serenity
    { path: '.serenity', content: `${rootSkill}\n` },
    // .gitignore
    {
      path: '.gitignore',
      content: [
        '# 宁静号标准 .gitignore — 外部仓库不被纳入本仓库',
        '# 用户可在此追加专属的排除规则',
        '',
        '# 在宁静号项目中，所有子项目作为独立 git 仓库存放',
        '# 通过根 .gitignore 排除它们，避免意外提交',
      ].join('\n') + '\n',
    },
    // opencode.json
    {
      path: 'opencode.json',
      content: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: {
          read: 'allow',
          edit: 'allow',
        },
      }, null, 2) + '\n',
    },
    // 根 skill 骨架（等待 Phase 2 生成）
    {
      path: join(skillDir, rootSkill, 'SKILL.md'),
      content: [
        `# ${rootSkill} — ${inferName(prefix)}`,
        '',
        '> 由 serenity-plugin init 创建。此文件将在 Phase 2 由 Agent 完善。',
        '> 运行 `npx tsx ` + resolve + ` 根据引导完成初始化。',
        '',
        '## 初始配置',
        '',
        `- prefix: ${prefix}`,
        '- 标准技能已预装（见 .opencode/skills/）',
        '- 等待 Phase 2 生成完整的根 skill',
      ].join('\n') + '\n',
    },
    // 根 skill 目录结构
    { path: join(skillDir, rootSkill, 'references'), content: '', isDir: true },
    { path: join(skillDir, rootSkill, 'scripts'), content: '', isDir: true },
    // Agent Phase 2 prompt
    {
      path: join(skillDir, rootSkill, 'scripts', 'generate-root-skill.prompt.md'),
      content: generatePhase2Prompt(prefix),
    },
    // 根 skill 注册表骨架
    {
      path: join(skillDir, rootSkill, 'references', 'mech-registry.json'),
      content: JSON.stringify({
        version: 1,
        serenity: rootSkill,
        description: `Register for ${rootSkill}`,
        entries: [],
      }, null, 2) + '\n',
    },
  ];
}

// ── Phase 2 Agent Prompt ──

function generatePhase2Prompt(prefix: string): string {
  return [
    `# Phase 2: Complete ${prefix}-serenity Root Skill`,
    '',
    'This serenity instance has been initialized with all standard meta-skills.',
    'Now you need to complete the root skill SKILL.md.',
    '',
    '## Interview Questions',
    '',
    'Answer these questions interactively with the user, then fill in the root skill at',
    `.opencode/skills/${prefix}-serenity/SKILL.md`,
    '',
    '1. **System description**: What project/system does this serenity manage?',
    '2. **Scope**: Single person, small team, or enterprise?',
    '3. **Key components**: What sub-projects or modules does the system contain?',
    '4. **Collaboration style**: Structured (formal docs/SOP) or flexible (ad-hoc)?',
    '5. **Language preference**: Precise, conversational, or technical?',
    '',
    '## Root Skill Skeleton',
    '',
    `Create the SKILL.md for ${prefix}-serenity with these sections:`,
    '',
    '- `# Skill: ${prefix}-serenity — <Name>`',
    '- System identity and core principles',
    '- Skill list (all 9 pre-installed skills)',
    '- Task route table (basic routes)',
    '- Collaboration protocols (Neat + naming + session conventions)',
    '- EAP checklist',
    '',
    '## Available Tools',
    '',
    'The plugin provides these tools that work in any serenity instance:',
    '- **file_system**: root/resolve/list (no instance-specific coupling)',
    '- **session_tool**: list/show/create/health/archive/summary',
    '- **msm_list / msm_exec / msm_admin**: standard MSM management',
    '',
    '## Important',
    '',
    '- All 9 standard skills are already installed',
    '- The AGENT_SESSIONS/ directory exists and session_tool is ready',
    '- Guide the user through the 5 questions, then write the SKILL.md',
    '- The SKILL.md should be fully usable — no placeholder text',
  ].join('\n') + '\n';
}

// ── 主入口 ──

export async function initWizard(opts: InitOptions): Promise<InitResult> {
  const { targetPath, pluginRoot, force } = opts;
  const targetDirName = basename(targetPath);

  // 检查目标目录
  if (existsSync(targetPath)) {
    const hasFiles = existsSync(join(targetPath, '.serenity'));
    if (hasFiles && !force) {
      return {
        success: false,
        prefix: '',
        name: '',
        message: `Target already contains a serenity instance: ${targetPath}. Use --force to overwrite.`,
        createdDirs: [],
        installedSkills: [],
      };
    }
  }

  // Phase 1: 收集基本信息
  const prefill = opts.prefix ?? inferPrefix(targetDirName);

  let prefix: string;
  let description: string;

  if (opts.nonInteractive) {
    prefix = prefill;
    description = opts.description ?? 'Serenity instance';
  } else {
    const info = await collectInfo(prefill);
    prefix = info.prefix;
    description = info.description;
  }

  // 验证 prefix
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(prefix)) {
    return {
      success: false, prefix: '', name: '',
      message: `Invalid prefix "${prefix}": must be kebab-case (lowercase a-z, 0-9, dashes; max 20 chars)`,
      createdDirs: [], installedSkills: [],
    };
  }

  const name = opts.name ?? inferName(prefix);
  const ph: Placeholders = defaultPlaceholders(prefix);

  // Phase 1a: 创建目录骨架
  const createdDirs: string[] = [];
  const skeleton = buildSkeleton(prefix);

  mkdirSync(targetPath, { recursive: true });

  for (const item of skeleton) {
    const fullPath = join(targetPath, item.path);
    if (item.isDir) {
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        createdDirs.push(item.path);
      }
    } else {
      if (existsSync(fullPath) && !force) continue;
      const parentDir = fullPath.slice(0, fullPath.lastIndexOf('/'));
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, item.content, 'utf8');
      createdDirs.push(item.path);
    }
  }

  // Phase 1b: 复制标准技能模板
  const templatesDir = getTemplatesDir(pluginRoot);
  const installedSkills: string[] = [];
  let templatesMissing = false;

  for (const skillName of STANDARD_SKILLS) {
    try {
      const result = installTemplate({
        templateDir: templatesDir,
        name: skillName,
        serenityRoot: targetPath,
        prefix,
        placeholders: ph,
        dryRun: false,
      });
      if (result.changed) {
        installedSkills.push(skillName);
      }
    } catch {
      // 模板缺失是允许的 — 用户可后续 install-skill
      templatesMissing = true;
    }
  }

  // Phase 1c: 写 .serenity 确认
  const serenityPath = join(targetPath, '.serenity');
  if (!existsSync(serenityPath) || force) {
    writeFileSync(serenityPath, `${prefix}-serenity\n`, 'utf8');
  }

  // 输出
  const skillSummary = installedSkills.length > 0
    ? `Pre-installed ${installedSkills.length} skill(s): ${installedSkills.join(', ')}`
    : 'No templates were copied (templates may not exist yet)';

  return {
    success: true,
    prefix,
    name,
    message: [
      `Serenity instance "${name}" created at ${targetPath}`,
      `  prefix: ${prefix}`,
      `  description: ${description}`,
      `  ${skillSummary}`,
      '',
      `Next steps:`,
      `  1. Open ${targetPath} in OpenCode`,
      `  2. Agent will guide you through Phase 2 to complete the root skill`,
      templatesMissing ? '  (Some skill templates not found — run `opencode-serenity-plugin install-skill <name>` to add them later)' : '',
    ].filter(Boolean).join('\n'),
    createdDirs,
    installedSkills,
  };
}
