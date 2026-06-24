/**
 * cc-git-tool.ts — CCC git 管理工具（ACC 内置 tool）
 *
 * 提供无 bash 依赖的 git 操作，覆盖最频繁的无风险操作。
 * merge/rebase/conflict resolution 不 Mech 化 — Agent 协调 + bash 人工决策。
 *
 * 子命令：
 *   status  — git status --porcelain（返回 JSON）
 *   commit  — git add -A && git commit -m <msg>
 *   push    — git push origin <current-branch>
 *   log     — git log --oneline [-n <count>]
 *   pull    — git pull --ff-only（安全 fast-forward；有分歧时输出 [REJECTED] + 操作建议）
 *   diff    — git diff [--cached] [<ref>] [-- <path>]
 *
 * 冲突约定（设计文档 §8.4）：
 *   - push/pull 被 non-fast-forward 拒绝时输出 [REJECTED] + 操作建议
 *   - push/pull 成功时输出简洁摘要
 */

import { execFileSync } from 'node:child_process';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { findSerenityRoot } from '../fs/resolve-path.js';
import pkg from '../../package.json' with { type: 'json' };

const VERSION = pkg.version;

const SUBCOMMANDS = ['status', 'commit', 'push', 'log', 'pull', 'diff'] as const;

// ── 内部 helper ──

function execGit(args: string[], cwd: string): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024, // 1MB
    });
    return { stdout: stdout.trimEnd(), stderr: '' };
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  }
}

function getCurrentBranch(root: string): string {
  const { stdout } = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (!stdout) throw new Error('cc-git: cannot determine current branch');
  return stdout;
}

function hasChanges(root: string): boolean {
  const { stdout } = execGit(['status', '--porcelain'], root);
  return stdout.length > 0;
}

function hasRemote(root: string): boolean {
  const { stdout } = execGit(['remote'], root);
  return stdout.length > 0;
}

// ── Tool 定义 ──

export const ccGitTool: ToolDefinition = tool({
  description:
    `Serenity git utility (v${VERSION}). ` +
    `Git operations for the CCC (Concrete Cognitive Container). ` +
    `Subcommands: status (porcelain status), commit (git add -A + commit), push (push to origin), log (oneline history), ` +
    `pull (pull --ff-only), diff (git diff [--staged] [--ref <ref>] [--path <path>]). ` +
    `Use this for git operations when bash is not available. ` +
    `Conflict resolution is NOT automated — use bash for merges and rebases.`,
  args: {
    subcommand: z
      .enum(SUBCOMMANDS)
      .describe(
        'Operation: status (git status --porcelain), ' +
        'commit (git add -A + commit -m <msg>), ' +
        'push (git push origin HEAD), ' +
        'log (git log --oneline), ' +
        'pull (git pull --ff-only), ' +
        'diff (git diff [--staged] [--ref <ref>] [--path <path>])',
      ),
    message: z
      .string()
      .optional()
      .describe('Commit message (required for commit subcommand)'),
    n: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(10)
      .describe('Number of commits for log subcommand (default: 10, max: 100)'),
    staged: z
      .boolean()
      .optional()
      .default(false)
      .describe('For diff: show staged changes (git diff --cached)'),
    ref: z
      .string()
      .optional()
      .describe('For diff: compare against a ref (e.g. HEAD~1, main, origin/main)'),
    path: z
      .string()
      .optional()
      .describe('For diff: filter to specific path (e.g. src/, package.json)'),
  },
  execute: async (input, ctx) => {
    const root = findSerenityRoot(ctx.directory);
    const sub = input.subcommand;

    // ── status ──
    if (sub === 'status') {
      const { stdout } = execGit(['status', '--porcelain'], root);
      // Parse porcelain output
      const lines = stdout ? stdout.split('\n') : [];
      const entries = lines.map((line) => {
        // porcelain format: XY filename (X=staging, Y=worktree)
        const status = line.slice(0, 2).trim() || '??';
        const file = line.slice(3);
        return { status, file };
      });
      return JSON.stringify(
        {
          clean: entries.length === 0,
          files: entries,
          summary: entries.length === 0 ? '(clean)' : `${entries.length} file(s) with changes`,
        },
        null,
        2,
      );
    }

    // ── commit ──
    if (sub === 'commit') {
      if (!input.message || input.message.trim() === '') {
        throw new Error('cc-git commit: missing required arg "message"');
      }

      if (!hasChanges(root)) {
        return '(nothing to commit — working tree clean)';
      }

      const addResult = execGit(['add', '-A'], root);
      if (addResult.stderr) {
        throw new Error(`cc-git commit: git add failed\n${addResult.stderr}`);
      }

      try {
        const commitResult = execGit(['commit', '-m', input.message], root);
        if (commitResult.stderr && commitResult.stderr.includes('nothing to commit')) {
          return '(nothing to commit — working tree clean)';
        }
        // git commit outputs to stderr by convention; include both
        const output = commitResult.stdout || commitResult.stderr || 'committed';
        return output.trimEnd();
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || '';
        throw new Error(`cc-git commit: git commit failed\n${stderr}`);
      }
    }

    // ── push ──
    if (sub === 'push') {
      if (!hasRemote(root)) {
        throw new Error(
          'cc-git push: no remote configured. Add one with:\n' +
          '  git remote add origin <url>',
        );
      }

      const branch = getCurrentBranch(root);

      // Check if there are commits to push
      try {
        execGit(['fetch', 'origin', branch], root);
      } catch {
        // fetch failure is not fatal — proceed with push
      }

      const { stdout, stderr } = execGit(
        ['push', 'origin', branch],
        root,
      );

      // Success
      if (!stderr || stderr.includes('->') || stderr === '') {
        return stdout || `Pushed to origin/${branch}`;
      }

      // Non-fast-forward rejection
      if (stderr.includes('non-fast-forward') || stderr.includes('rejected') || stderr.includes('[rejected]')) {
        return `[REJECTED] Push to origin/${branch} was rejected (non-fast-forward).\n\n远程有新的提交，本地落后。操作建议：
  1. 先用 bash: git fetch origin ${branch}
  2. 查看远程变更: git log HEAD..origin/${branch}
  3. 合并或变基: git merge origin/${branch} 或 git rebase origin/${branch}
  4. 有冲突则手动解决后: git add ... && git commit
  5. 再次推送: cc-git push`;
      }

      // Other errors
      throw new Error(`cc-git push failed:\n${stderr}`);
    }

    // ── pull ──
    if (sub === 'pull') {
      if (!hasRemote(root)) {
        throw new Error(
          'cc-git pull: no remote configured. Add one with:\n' +
          '  git remote add origin <url>',
        );
      }

      const branch = getCurrentBranch(root);

      // git pull = git fetch + git merge FETCH_HEAD
      // 用 FETCH_HEAD 而非 origin/<branch>，避免 remote-tracking ref 未更新
      const fetchResult = execGit(['fetch', 'origin', branch], root);
      if (fetchResult.stderr) {
        return `[WARN] fetch had stderr:\n${fetchResult.stderr}`;
      }

      // 检查是否已 up-to-date：rev-list --count HEAD..FETCH_HEAD
      const revResult = execGit(['rev-list', '--count', 'HEAD..FETCH_HEAD'], root);
      if (revResult.stderr) {
        return `[WARN] cannot check ahead count:\n${revResult.stderr}`;
      }
      if (revResult.stdout === '0' || revResult.stdout === '') {
        return 'Already up to date.';
      }

      // git merge --ff-only FETCH_HEAD
      const mergeResult = execGit(['merge', '--ff-only', 'FETCH_HEAD'], root);
      if (!mergeResult.stderr) {
        const msg = mergeResult.stdout || 'Pulled successfully.';
        return msg.endsWith('\n') ? msg.trimEnd() : msg;
      }

      if (
        mergeResult.stderr.includes('non-fast-forward') ||
        mergeResult.stderr.includes('Not possible to fast-forward') ||
        mergeResult.stderr.includes('rejected') ||
        mergeResult.stderr.includes('could not be applied')
      ) {
        return `[REJECTED] Pull from origin/${branch} was rejected (non-fast-forward).

远程有新的提交，本地的历史与远程产生了分歧（非快进）。操作建议：
  1. 查看差异: cc-git log HEAD..origin/${branch}
  2. 用 bash 手动合并: git merge origin/${branch}
  3. 或用 rebase: git rebase origin/${branch}
  4. 有冲突则手动解决后: git add <file> && git commit
  5. 推送: cc-git push`;
      }

      throw new Error(`cc-git pull failed:\n${mergeResult.stderr}`);
    }

    // ── log ──
    if (sub === 'log') {
      const n = input.n ?? 10;
      const { stdout } = execGit(['log', '--oneline', `-n`, String(n)], root);
      if (!stdout) return '(no commits)';
      return stdout;
    }

    // ── diff ──
    if (sub === 'diff') {
      const args: string[] = ['diff'];
      if (input.staged) args.push('--cached');
      if (input.ref) args.push(input.ref);
      if (input.path) args.push('--', input.path);

      const { stdout, stderr } = execGit(args, root);
      if (stderr) return `[WARN] git diff had stderr:\n${stderr}`;
      if (!stdout) return '(no diff)';
      return stdout;
    }

    throw new Error(`cc-git: unknown subcommand "${sub}"`);
  },
});
