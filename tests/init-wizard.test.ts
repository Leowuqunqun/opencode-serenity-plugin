/**
 * init-wizard 测试
 *
 * 测试范围：
 *   - Non-interactive mode: 基本骨架创建
 *   - Git init: git repo 初始化验证
 *   - Template installation: 3 个标准技能安装
 *   - Prefix validation: 非法 prefix 拒绝
 *   - Already-existing CCC: 无 --force 拒绝
 *   - --force: 覆盖已存在的 CCC
 *   - opencode.json + mech-registry.json 内容验证
 *   - Remote add + push: 用本地 bare repo 模拟
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initWizard, type InitResult } from '../src/init/init-wizard.js';

// ── helpers ──

function execGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
}

function getPluginRoot(): string {
  // plugin root is the parent of this test file's src/ directory
  // tests/cc-git-tool.test.ts → ../src/ → plugin root
  // tests are at <root>/tests/, source at <root>/src/
  // We don't import the actual templates dir function — just resolve from __dirname
  // Actually, vitest runs from project root, so we can just use process.cwd()
  return process.cwd();
}

// The template-loader.ts resolves templates from join(pluginRoot, 'src', 'templates')
// From the project root, that's src/templates/

// ── tests ──

describe('init-wizard — non-interactive mode', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'init-wiz-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates CCC skeleton with git repo', async () => {
    const target = join(root, 'test-ccc');
    const result = await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'A test CCC',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.prefix).toBe('test');
    expect(result.cccName).toBe('test-serenity');
    expect(result.installedSkills).toContain('compass');
    expect(result.installedSkills).toContain('session');
    expect(result.installedSkills).toContain('sqc');
    expect(result.installedSkills.length).toBe(3);

    // Verify .serenity
    expect(existsSync(join(target, '.serenity'))).toBe(true);
    expect(readFileSync(join(target, '.serenity'), 'utf8').trim()).toBe('test-serenity');

    // Verify git repo
    expect(existsSync(join(target, '.git'))).toBe(true);
    const log = execGit(['log', '--oneline'], target);
    expect(log).toContain('test-serenity');

    // Verify branch is main
    const branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], target);
    expect(branch).toBe('main');
  });

  it('creates opencode.json with clean primary agent', async () => {
    const target = join(root, 'test-ccc2');
    const result = await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'A test CCC with desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);

    const ocJson = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'));
    expect(ocJson['$schema']).toBe('https://opencode.ai/config.json');
    expect(ocJson.default_agent).toBe('test-serenity');
    expect(ocJson.permission).toEqual({ read: 'allow', edit: 'allow', write: 'allow' });
    expect(ocJson.agent['test-serenity']).toEqual({
      mode: 'primary',
      description: 'A test CCC with desc',
      permission: {},
    });
    expect(ocJson.plugin).toEqual(['@shgroup/opencode-serenity-plugin@latest']);
  });

  it('creates mech-registry.json with 3 preset MSMs', async () => {
    const target = join(root, 'test-ccc3');
    const result = await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'ccc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);

    const registryPath = join(target, '.opencode/skills/test-serenity/references/mech-registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.entries.length).toBe(3);

    const names = registry.entries.map((e: any) => e.name);
    expect(names).toContain('compass-tool');
    expect(names).toContain('session-tool');
    expect(names).toContain('sqc-tool');
  });

  it('creates root SKILL.md skeleton', async () => {
    const target = join(root, 'test-ccc4');
    await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    const skillPath = join(target, '.opencode/skills/test-serenity/SKILL.md');
    const content = readFileSync(skillPath, 'utf8');

    expect(content).toContain('name: test-serenity');
    expect(content).toContain('description: desc');
    expect(content).toContain('Phase 2 Agent');
    expect(content).toContain('任务路由表');
    expect(content).toContain('协作协议');
  });

  it('creates Phase 2 prompt file with 5 questions', async () => {
    const target = join(root, 'test-ccc5');
    await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    const promptPath = join(target, '.opencode/skills/test-serenity/scripts/generate-root-skill.prompt.md');
    const content = readFileSync(promptPath, 'utf8');

    expect(content).toContain('Phase 2 initialization');
    expect(content).toContain('5 questions');
    expect(content).toContain('Question 1');
    expect(content).toContain('Git remote');
    expect(content).toContain('Question 2');
    expect(content).toContain('What does this CCC manage');
    expect(content).toContain('Question 3');
    expect(content).toContain('Formality level');
    expect(content).toContain('Question 4');
    expect(content).toContain('Language preference');
    expect(content).toContain('Question 5');
    expect(content).toContain('Extra skills');
  });

  it('creates 3 standard skill directories', async () => {
    const target = join(root, 'test-ccc6');
    await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(existsSync(join(target, '.opencode/skills/compass/SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.opencode/skills/session/SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.opencode/skills/sqc/SKILL.md'))).toBe(true);
  });

  it('creates AGENT_SESSIONS and docs directories', async () => {
    const target = join(root, 'test-ccc7');
    await initWizard({
      targetPath: target,
      prefix: 'test',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(existsSync(join(target, 'AGENT_SESSIONS'))).toBe(true);
    expect(existsSync(join(target, 'docs'))).toBe(true);
  });
});

describe('init-wizard — prefix validation', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'init-wiz-val-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rejects invalid prefix (uppercase)', async () => {
    const target = join(root, 'bad-ccc');
    const result = await initWizard({
      targetPath: target,
      prefix: 'Home',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid prefix');
  });

  it('rejects invalid prefix (leading dash)', async () => {
    const target = join(root, 'bad-ccc2');
    const result = await initWizard({
      targetPath: target,
      prefix: '-home',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid prefix');
  });

  it('rejects invalid prefix (underscore)', async () => {
    const target = join(root, 'bad-ccc3');
    const result = await initWizard({
      targetPath: target,
      prefix: 'home_test',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid prefix');
  });

  it('accepts valid kebab-case prefix', async () => {
    const target = join(root, 'good-ccc');
    const result = await initWizard({
      targetPath: target,
      prefix: 'my-project',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.cccName).toBe('my-project-serenity');
  });
});

describe('init-wizard — already exists', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'init-wiz-exists-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('refuses to overwrite existing CCC without --force', async () => {
    const target = join(root, 'existing');
    // Create first CCC
    await initWizard({
      targetPath: target,
      prefix: 'first',
      description: 'first',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    // Try to init again
    const result = await initWizard({
      targetPath: target,
      prefix: 'second',
      description: 'second',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('already contains a CCC');
    expect(result.message).toContain('--force');
  });

  it('overwrites with --force', async () => {
    const target = join(root, 'force-test');
    // Create first
    await initWizard({
      targetPath: target,
      prefix: 'first',
      description: 'first ccc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    // Overwrite with force
    const result = await initWizard({
      targetPath: target,
      prefix: 'second',
      description: 'second ccc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
      force: true,
    });

    expect(result.success).toBe(true);
    expect(result.cccName).toBe('second-serenity');
  });
});

describe('init-wizard — git remote + push', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'init-wiz-remote-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds remote and pushes when remote is provided', async () => {
    // Create bare repo as "remote"
    const barePath = mkdtempSync(join(tmpdir(), 'init-wiz-bare-'));
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: barePath, stdio: 'ignore' });

    const target = join(root, 'remoted-ccc');
    const result = await initWizard({
      targetPath: target,
      prefix: 'remoted',
      description: 'ccc with remote',
      remote: barePath, // local path as SSH URL substitute
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.gitPushed).toBe(true);

    // Verify remote is set
    const remote = execGit(['remote', 'get-url', 'origin'], target);
    expect(remote).toBe(barePath);

    // Verify branch tracking
    const upstream = execGit(['rev-parse', '--abbrev-ref', 'HEAD@{upstream}'], target);
    expect(upstream).toBe('origin/main');

    rmSync(barePath, { recursive: true, force: true });
  });

  it('succeeds without remote', async () => {
    const target = join(root, 'no-remote-ccc');
    const result = await initWizard({
      targetPath: target,
      prefix: 'lonely',
      description: 'no remote',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(true);
    expect(result.gitPushed).toBe(false);

    // Git repo exists, has commits, but no remote
    expect(existsSync(join(target, '.git'))).toBe(true);
    const remotes = execGit(['remote'], target);
    expect(remotes).toBe('');
  });
});

describe('init-wizard — error handling', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'init-wiz-err-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('handles empty prefix in nonInteractive mode gracefully', async () => {
    const target = join(root, 'empty-prefix');
    const result = await initWizard({
      targetPath: target,
      prefix: '',
      description: 'desc',
      pluginRoot: getPluginRoot(),
      nonInteractive: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid prefix');
  });
});
