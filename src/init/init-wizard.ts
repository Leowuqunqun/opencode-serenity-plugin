/**
 * init-wizard.ts — D1 Init 向导 Phase 1
 *
 * CLI 交互式创建认知容器 (CCC) 的目录骨架、git 初始化并复制标准技能模板。
 *
 * 设计文档：docs/ccc-init-flow-design.md（home-serenity 仓）
 *
 * 流程：
 *   1. 交互问答 4 题（prefix / description / remote / scope）
 *   2. git init → add → commit（Phase 1 写骨架前）
 *   3. 创建目录骨架（.serenity, opencode.json, AGENT_SESSIONS/, docs/）
 *   4. 复制 3 个标准技能模板到 .opencode/skills/
 *   5. git remote add → push（如果提供了 remote）
 *   6. 写入 Phase 2 Agent prompt
 *   7. 输出完成信息
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  getTemplatesDir,
  installTemplate,
  defaultPlaceholders,
  type Placeholders,
} from '../skills/template-loader.js';
import { isValidPrefix, buildCccName } from '../util/init.js';

// ── 类型 ──

export interface InitOptions {
  /** 目标路径 */
  targetPath: string;
  /** 实例前缀（如 home, work） */
  prefix?: string;
  /** 一句话描述 */
  description?: string;
  /** Git SSH URL（如 git@github.com:user/work-serenity.git） */
  remote?: string;
  /** 规模：单人/小团队/多人/企业 */
  scope?: string;
  /** Plugin 根路径（用于定位模板） */
  pluginRoot: string;
  /** 非交互模式（必须提供 prefix + description + remote） */
  nonInteractive?: boolean;
  /** 强制覆盖已有文件 */
  force?: boolean;
}

export interface InitResult {
  success: boolean;
  prefix: string;
  cccName: string;
  message: string;
  createdDirs: string[];
  installedSkills: string[];
  gitPushed: boolean;
}

// ── 默认值 ──

/** Phase 1 预装的 3 个标准技能（设计决策 D20） */
const STANDARD_SKILLS = [
  'compass',
  'session',
  'sqc',
] as const;

/** 从目录名推断 prefix（kebab-case，取第一部分） */
function inferPrefix(dirName: string): string {
  const cleaned = dirName.replace(/[^a-zA-Z0-9-]/g, '');
  const first = cleaned.split(/[-_]/)[0];
  if (!first) return 'my';
  return first.toLowerCase().slice(0, 8);
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

interface CollectedInfo {
  prefix: string;
  description: string;
  remote: string;
  scope: string;
}

async function collectInfo(prefill: string): Promise<CollectedInfo> {
  const prefix = await askQuestion(
    'CCC prefix? (kebab-case, e.g. "home", "work")',
    prefill,
  );

  const description = await askQuestion(
    'What does this CCC manage? (one sentence)',
  );

  const remote = await askQuestion(
    'Git SSH URL? (e.g. git@github.com:user/work-serenity.git, repo must be empty)',
  );

  const scope = await askQuestion(
    'Scale? [solo/small-team/team/enterprise]',
    'solo',
  );

  return {
    prefix: prefix || prefill,
    description: description || 'A concrete cognitive container (CCC)',
    remote: remote || '',
    scope: scope || 'solo',
  };
}

// ── 骨架生成 ──

interface SkeletonFile {
  path: string;
  content: string;
  isDir?: boolean;
}

function buildSkeleton(
  prefix: string,
  description: string,
  scope: string,
  remote: string,
): SkeletonFile[] {
  const cccName = buildCccName(prefix);
  const skillDir = join('.opencode', 'skills');
  const rootSkill = cccName;

  return [
    // 目录
    { path: join('AGENT_SESSIONS'), content: '', isDir: true },
    { path: join('docs'), content: '', isDir: true },
    // .serenity
    { path: '.serenity', content: `${cccName}\n` },
    // .gitignore — CCC 自己的文件全部纳入
    {
      path: '.gitignore',
      content: [
        '# CCC .gitignore — 默认全纳入版本控制',
        '# 用户可在此追加专属的排除规则',
        '',
      ].join('\n'),
    },
    // opencode.json — write 全开（配合 P3 权限二分）
    {
      path: 'opencode.json',
      content: JSON.stringify({
        permissions: {
          read: 'allow',
          edit: 'allow',
          write: 'allow',
        },
        description,
      }, null, 2) + '\n',
    },
    // 根 skill 骨架（等待 Phase 2 Agent 完善）
    // 格式对齐 docs/ccc-init-flow-design.md §7.3
    {
      path: join(skillDir, rootSkill, 'SKILL.md'),
      content: [
        '---',
        `name: ${cccName}`,
        `description: ${description}`,
        '---',
        '',
        `# Skill: ${cccName}`,
        '',
        `> 我是这个 CCC 的根入口文件。Agent 进入此目录时优先加载我。`,
        '',
        '## 用途',
        '',
        description,
        '',
        '## 触发条件/何时加载',
        '',
        `- Agent 进入此 CCC 后最先加载`,
        '- 需要 MSM 工具查询、路径解析、技能路由时',
        '',
        '## 系统身份',
        '',
        '| 属性 | 值 |',
        '|------|-----|',
        `| CCC 名称 | ${cccName} |`,
        `| 规模 | ${scope} |`,
        `| Git 远程 | ${remote || '(not configured)'} |`,
        '',
        '## 技能清单',
        '',
        '| Skill | 定位 | 何时加载 |',
        '|-------|------|---------|',
        `| ${cccName} | 根入口技能 | 进入 CCC 后最先加载 |`,
        '| compass | 方向判断 | 开始新工作前 |',
        '| session | 会话追踪 | 多步工作前 |',
        '| sqc | 品质循环 | 定期扫描 |',
        '',
        '---',
        '',
        '<!-- Phase 2 Agent: 以下内容由你补充。',
        `     加载 scripts/generate-root-skill.prompt.md 获取访谈问题。 -->`,
        '',
        '## 任务路由表',
        '',
        '<!-- Agent: 根据访谈结果填写 -->',
        '',
        '## 协作协议',
        '',
        '<!-- Agent: 根据访谈结果填写 -->',
        '',
        '## 相关技能',
        '',
        '<!-- Agent: 根据访谈结果填写 -->',
        '',
      ].join('\n'),
    },
    // 根 skill 目录结构
    { path: join(skillDir, rootSkill, 'references'), content: '', isDir: true },
    { path: join(skillDir, rootSkill, 'scripts'), content: '', isDir: true },
    // Agent Phase 2 prompt
    {
      path: join(skillDir, rootSkill, 'scripts', 'generate-root-skill.prompt.md'),
      content: generatePhase2Prompt(prefix),
    },
    // 根 skill 注册表骨架（3 个 MSM 预设 — 设计文档 §4.3）
    {
      path: join(skillDir, rootSkill, 'references', 'mech-registry.json'),
      content: JSON.stringify({
        version: 1,
        description: `${cccName} MSM registry`,
        entries: [
          {
            name: 'compass-tool',
            skill: 'compass',
            category: 'mech',
            description: '方向判断工具。validate: 信号报告格式校验；judge: 3 通道条件评估与决策矩阵。',
          },
          {
            name: 'session-tool',
            skill: 'session',
            category: 'mech',
            description: '会话索引重建工具（ACC session 补充）。为历史会话分配编号并重命名目录。',
          },
          {
            name: 'sqc-tool',
            skill: 'sqc',
            category: 'semi-mech',
            description: 'SQC 品质循环工具。check: 品质检查；report: 验证报告；pipeline: 5 阶段流水线编排。',
          },
        ],
      }, null, 2) + '\n',
    },
  ];
}

// ── Phase 2 Agent Prompt ──
// 对齐 docs/ccc-init-flow-design.md §7.2

function generatePhase2Prompt(prefix: string): string {
  const cccName = buildCccName(prefix);

  return [
    `You are now in **Phase 2 initialization** of the CCC "${cccName}".`,
    `This is a forced interview — your response replaces whatever the user originally typed.`,
    '',
    `## Your Task`,
    '',
    `Interview the user with the following 4 questions, then write the completed root SKILL.md at \`.opencode/skills/${cccName}/SKILL.md\`.`,
    ``,
    `### Question 1 — Sub-projects / modules`,
    `"What sub-projects, repos, or modules does this CCC manage?"`,
    `→ Fill the **Task Route Table** section in SKILL.md with a task → skill/script mapping.`,
    '',
    `### Question 2 — Collaboration style`,
    `"Structured (formal docs/SOP) or flexible (ad-hoc communication)?"`,
    `→ Fill the **Collaboration Protocols** section (Neat conventions, naming rules, session tracking).`,
    '',
    `### Question 3 — Language preference`,
    `"Precise, conversational, or technical?"`,
    `→ Adjust SKILL.md language style and EAP trigger thresholds accordingly.`,
    '',
    `### Question 4 — Remote services / devices`,
    `"Any servers, APIs, or devices this CCC manages?"`,
    `→ Add relevant skills to the **Related Skills** section; suggest \`install-skill\` if domain skills are needed.`,
    '',
    '## After the Interview',
    '',
    '1. Remove the `<!-- Phase 2 Agent:` marker comment from SKILL.md',
    '2. Commit: `cc-git commit "feat: complete Phase 2 root skill configuration"`',
    '3. Push: `cc-git push`',
    '',
    '## Available tools',
    '- **cc-fs**: file operations within CCC root',
    '- **cc-git**: git status/commit/push/log',
    '- **session**: session lifecycle management',
    '- **3 pre-installed skills**: compass, session, sqc',
    '',
  ].join('\n') + '\n';
}

// ── Git 初始化 helper ──

function execGit(args: string[], cwd: string): string {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.trimEnd();
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    throw new Error(`git ${args[0]} failed: ${stderr || stdout || err.message}`);
  }
}

// ── 主入口 ──

export async function initWizard(opts: InitOptions): Promise<InitResult> {
  const { targetPath, pluginRoot, force } = opts;
  const targetDirName = basename(targetPath);

  const emptyResult = (): InitResult => ({
    success: false,
    prefix: '',
    cccName: '',
    message: '',
    createdDirs: [],
    installedSkills: [],
    gitPushed: false,
  });

  // 检查目标目录 — 已存在 CCC 则拒绝（除非 --force）
  if (existsSync(targetPath)) {
    const hasSerenity = existsSync(join(targetPath, '.serenity'));
    if (hasSerenity && !force) {
      return {
        ...emptyResult(),
        message: `Target already contains a CCC: ${targetPath}. Use --force to overwrite.`,
      };
    }
  }

  // Phase 1: 收集基本信息（交互或非交互）
  const prefill = opts.prefix ?? inferPrefix(targetDirName);

  let prefix: string;
  let description: string;
  let remote: string;
  let scope: string;

  if (opts.nonInteractive) {
    prefix = prefill;
    description = opts.description ?? 'A concrete cognitive container (CCC)';
    remote = opts.remote ?? '';
    scope = opts.scope ?? 'solo';
  } else {
    const info = await collectInfo(prefill);
    prefix = info.prefix;
    description = info.description;
    remote = info.remote;
    scope = info.scope;
  }

  // 验证 prefix — 统一使用 isValidPrefix（与 RR7 init / path.ts 一致）
  if (!isValidPrefix(prefix)) {
    return {
      ...emptyResult(),
      prefix,
      message: `Invalid prefix "${prefix}": must be kebab-case (lowercase a-z, 0-9, dashes; no leading or trailing dash)`,
    };
  }

  const cccName = buildCccName(prefix);
  const ph: Placeholders = defaultPlaceholders(prefix);

  // Phase 1a: 创建目标目录
  mkdirSync(targetPath, { recursive: true });

  // Phase 1b: 写入目录骨架（git init 之前先写文件，否则 git add -A 为空）
  const createdDirs: string[] = [];
  const skeleton = buildSkeleton(prefix, description, scope, remote);

  for (const item of skeleton) {
    const fullPath = join(targetPath, item.path);
    if (item.isDir) {
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        createdDirs.push(item.path);
      }
    } else {
      if (existsSync(fullPath) && !force) continue;
      const lastSep = fullPath.lastIndexOf('/');
      if (lastSep >= 0) {
        const parentDir = fullPath.slice(0, lastSep);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
      }
      writeFileSync(fullPath, item.content, 'utf8');
      createdDirs.push(item.path);
    }
  }

  // Phase 1c: 复制标准技能模板
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
        noPrefix: true,
      });
      if (result.changed) {
        installedSkills.push(skillName);
      }
    } catch {
      templatesMissing = true;
    }
  }

  // Phase 1d: git init + add + commit + remote + push
  let gitPushed = false;
  let gitError: string | undefined;

  try {
    execGit(['init', '-b', 'main'], targetPath);
    execGit(['add', '-A'], targetPath);
    execGit(['commit', '-m', `chore: init ${cccName} CCC`], targetPath);

    if (remote) {
      execGit(['remote', 'add', 'origin', remote], targetPath);
      try {
        execGit(['push', '-u', 'origin', 'main'], targetPath);
        gitPushed = true;
      } catch (err: any) {
        gitError = `Git push failed: ${err.message}. CCC created locally but not pushed.`;
      }
    }
  } catch (err: any) {
    gitError = `Git init failed: ${err.message}`;
  }

  // ── 输出 ──
  const skillSummary = installedSkills.length > 0
    ? `Pre-installed ${installedSkills.length} skill(s): ${installedSkills.join(', ')}`
    : 'No templates were copied (templates may not exist yet)';

  const message = [
    `CCC "${cccName}" created at ${targetPath}`,
    `  prefix: ${prefix}`,
    `  description: ${description}`,
    remote ? `  remote: ${remote}` : '',
    `  ${skillSummary}`,
    gitPushed ? '' : `  ⚠ Git: ${gitError || 'not pushed (no remote provided)'}`,
    '',
    'Next steps (two-phase init):',
    `  Phase 1 ✅  — CCC skeleton created.`,
    `  Phase 2 ⏳  — Restart OpenCode and open ${targetPath}.`,
    `     The Agent will automatically guide you through a 4-question interview`,
    `     to complete the root skill configuration.`,
    templatesMissing ? '  (Some skill templates not found — run `opencode-serenity-plugin install-skill <name>` to add them later)' : '',
  ].filter(Boolean).join('\n');

  return {
    success: true,
    prefix,
    cccName,
    message,
    createdDirs,
    installedSkills,
    gitPushed,
  };
}
