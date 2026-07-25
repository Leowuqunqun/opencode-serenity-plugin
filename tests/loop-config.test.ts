/**
 * loop-config.test.ts — Loop tool CCC 配置读取测试
 *
 * 验证：
 * 1. 有 serenity.json 且 loop.defaultModel 存在时正确读取
 * 2. 无配置文件时返回空字符串
 * 3. 配置文件格式错误时返回空字符串
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readLoopDefaultModel } from '../src/tools/loop-tool.js';
import { setState, resetState } from '../src/state.js';

let cwd = '';

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-config-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.serenity'), 'test-ccc');
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function writeConfig(root: string, content: string): void {
  const dir = join(root, '.opencode');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'serenity.json'), content);
}

describe('readLoopDefaultModel()', () => {
  beforeEach(() => {
    resetState();
    cwd = setupRepo();
    setState({ activated: true, cwdRoot: cwd, cccName: 'test-ccc', skillPath: null, skillContent: null, needsPhase2: false, phase2Prompt: null });
  });

  afterEach(() => {
    resetState();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('从 serenity.json loop.defaultModel 读取', () => {
    writeConfig(cwd, JSON.stringify({ loop: { defaultModel: 'deepseek/deepseek-v4-flash' } }));
    expect(readLoopDefaultModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('无配置文件时返回空字符串', () => {
    expect(readLoopDefaultModel()).toBe('');
  });

  it('配置文件不含 loop 字段时返回空字符串', () => {
    writeConfig(cwd, JSON.stringify({ other: { foo: 'bar' } }));
    expect(readLoopDefaultModel()).toBe('');
  });

  it('配置文件格式错误时返回空字符串', () => {
    writeConfig(cwd, 'not json');
    expect(readLoopDefaultModel()).toBe('');
  });

  it('空 defaultModel 时返回空字符串', () => {
    writeConfig(cwd, JSON.stringify({ loop: { defaultModel: '' } }));
    expect(readLoopDefaultModel()).toBe('');
  });

  it('配置值带空格时自动 trim', () => {
    writeConfig(cwd, JSON.stringify({ loop: { defaultModel: '  deepseek/model  ' } }));
    expect(readLoopDefaultModel()).toBe('deepseek/model');
  });

  it('cwdRoot 未设置时返回空字符串', () => {
    resetState();
    expect(readLoopDefaultModel()).toBe('');
  });
});
