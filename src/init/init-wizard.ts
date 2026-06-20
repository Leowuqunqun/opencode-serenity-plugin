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
  process.stdout.write('\n  Welcome to Serenity CCC initialization!\n');
  process.stdout.write("  Let's set up your new cognitive container.\n\n");

  const prefix = await askQuestion(
    '  What would you like to name it?\n'
    + '    (lowercase letters, numbers, dashes — e.g. "home", "work-project")\n'
    + '  > ',
    prefill,
  );

  const description = await askQuestion(
    '\n  What does it manage, in one sentence?\n'
    + '    (e.g. "Manages home network, NAS, and smart home")\n'
    + '  > ',
  );

  const remote = await askQuestion(
    '\n  [Optional] Git remote URL for version control?\n'
    + '    (e.g. git@github.com:user/my-serenity.git — new or empty repo recommended)\n'
    + '  > ',
  );

  const scope = await askQuestion(
    '\n  How many people will use this CCC?\n'
    + '    solo = just you\n'
    + '    pair = you + one collaborator\n'
    + '    team = multiple people\n'
    + '  > ',
    'solo',
  );

  process.stdout.write('\n');

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
    // opencode.json — 完整 CCC 配置（D22.1 clean primary agent）
    // agent.permission 留空 → 继承顶层 permission 全开
    // ACC 本身控制目录访问，不在此层限制
    {
      path: 'opencode.json',
      content: JSON.stringify({
        '$schema': 'https://opencode.ai/config.json',
        default_agent: cccName,
        permission: {
          read: 'allow',
          edit: 'allow',
          write: 'allow',
        },
        agent: {
          [cccName]: {
            mode: 'primary',
            description: description,
            permission: {},
          },
        },
        plugin: [
          '@shgroup/opencode-serenity-plugin@latest',
        ],
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
            path: '.opencode/skills/compass/scripts/compass-tool.ts',
            skill: 'compass',
            category: 'mech',
            description: '方向判断工具。validate: 信号报告格式校验；judge: 3 通道条件评估与决策矩阵。',
            usage: 'npx tsx .opencode/skills/compass/scripts/compass-tool.ts <validate|judge> [args...]',
          },
          {
            name: 'session-tool',
            path: '.opencode/skills/session/scripts/session-tool.ts',
            skill: 'session',
            category: 'mech',
            description: '会话索引重建工具（ACC session 补充）。为历史会话分配 S### 编号并重命名目录。',
            usage: 'npx tsx .opencode/skills/session/scripts/session-tool.ts reindex',
          },
          {
            name: 'sqc-tool',
            path: '.opencode/skills/sqc/scripts/sqc-tool.ts',
            skill: 'sqc',
            category: 'semi-mech',
            description: 'SQC 品质循环工具。check: 品质检查；report: 验证报告；pipeline: 5 阶段流水线编排。',
            usage: 'npx tsx .opencode/skills/sqc/scripts/sqc-tool.ts <check|report|pipeline> [args...]',
          },
        ],
      }, null, 2) + '\n',
    },
  ];
}

// ── Phase 2 Agent Prompt ──
// EAP 驱动访谈 — 用户目标往往不具体，必须用 EAP 方法论对齐抽象层次

function generatePhase2Prompt(prefix: string): string {
  const cccName = buildCccName(prefix);

  return [
    `You are now in **Phase 2 initialization** of the CCC "${cccName}".`,
    `This is a forced interview — your response replaces whatever the user originally typed.`,
    '',
    `## ⚠️ Before You Start: Load EAP`,
    '',
    `Use the \`eap\` tool to enter **EAP mode**. The user's goals will be vague and`,
    `implicit — EAP is essential to help them crystallize intent into explicit structure.`,
    '',
    `## Your Task`,
    '',
    `Conduct a **collaborative interview**, not a questionnaire. Use EAP methodology`,
    `throughout. When the user gives a vague answer, probe. When they say "I don't know"`,
    `or "没想好", accept it — the agent will work with what's available and help analyze`,
    `rather than forcing the user to invent answers they don't have yet.`,
    `Then write the completed root SKILL.md at \`.opencode/skills/${cccName}/SKILL.md\`.`,
    '',
    `### EAP Interview Method`,
    '',
    `For every user answer, apply these steps:`,
    `1. **Diagnose E/R/S** — is it explicit enough? What's missing?`,
    `2. **Probe missing structure** — if user says "courses", ask: for whom? format? scope?`,
    `3. **Concretize** — turn "manage the company" into: what entities? what lifecycle stages?`,
    `4. **Refuse false closure** — "not sure" is a signal, not an answer. Explore *why* they're unsure.`,
    `5. **Confirm** — rephrase the user's answer in explicit terms, ask if it's correct.`,
    '',
    `### Interview Topics`,
    '',
    `#### Topic 1 — What is this CCC for? (purpose + team size)`,
    `"What does this CCC exist to do? Who is it for?"`,
    `EAP probes:`,
    `  • One-sentence description — what does it manage? (the SKILL.md \`description\` field)`,
    `  • Scope — solo (just you), pair (you + one collaborator), or team (shared with many)?`,
    `  • What entities does it manage? (projects? devices? knowledge? people?)`,
    `  • What's the boundary? (what is it NOT for?)`,
    `  • What stage is it at? (idea → building → operating → maintaining)`,
    `→ Fill **用途**, **系统身份**, and the \`scope\` field.`,
    `→ If user is vague: "I want to start a company" → probe: what kind? what do you need to track?`,
    '',
    `#### Topic 2 — Git remote`,
    `"Git remote configured? Want one?"`,
    `→ If not: note \`(local only)\`. No remote is fine — can add later with \`git remote add\`.`,
    `→ If yes: setup via cc-git.`,
    '',
    `#### Topic 3 — Sub-projects / task routing`,
    `"What concrete work items will this CCC track? Name 2-3 specific examples."`,
    `EAP probes:`,
    `  • What's the first thing you'll do in this CCC?`,
    `  • How do these items relate to each other? (independent? pipeline? hierarchy?)`,
    `→ Fill **任务路由表**. If user struggles, offer categories based on Topic 1 answer.`,
    '',
    `#### Topic 4 — Collaboration style`,
    `"Casual or structured?"`,
    `EAP probes:`,
    `  • What does "structured" mean to you? (naming rules? commit format? mandatory sessions?)`,
    `  • Who else might read these docs?`,
    `→ Fill **协作协议** section.`,
    '',
    `#### Topic 5 — Extra capabilities`,
    `"Any external services, APIs, or domain-specific skills needed?"`,
    `→ If unsure: skip. Can add later with \`install-skill\`.`,
    `→ Pre-installed: compass, session, sqc.`,
    '',
    '## After the Interview',
    '',
    '1. Write SKILL.md — every entity defined, relationships explicit, boundaries clear',
    '2. Remove the `<!-- Phase 2 Agent:` marker comment',
    '3. Save the interview record at `docs/phase2-interview-record.md` for ACC diagnostics',
    '4. Commit: `cc-git commit "feat: Phase 2 complete"`',
    '5. Push: `cc-git push`',
    '',
    '## Available tools',
    '- **eap** — cognitive quality framework (USE THIS throughout)',
    '- **neat** — design partnership protocol',
    '- **cc-fs** — file operations within CCC root',
    '- **cc-git** — git status/commit/push/log',
    '- **session** — session lifecycle management',
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
    `     Type anything — your first message will be intercepted`,
    `     and the Agent will guide you through a collaborative interview`,
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
