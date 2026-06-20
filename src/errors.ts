/**
 * 错误类清单（contract-v0.md 附录 B）
 *
 * 设计原则：
 * - 所有错误都是 Error 子类（保证 stack trace 完整）
 * - 错误名以 Error 结尾（grep 友好；不强制 SerenityError 前缀以便精细分类）
 * - 错误传播策略：
 *   1. plugin 入口（index.ts / tui.ts）不抛 — 返回空 hooks 或 toast 通知
 *   2. 大多数 hook 用 safeHook / safeCreateHook 静默（v0.0.1 release 静默原则 + retry-storm 防护）
 *   3. 例外：permission-guards.ts 的 tool.execute.before（RR5 hard block）故意
 *      让 throw 透传 — 中断整条 Effect 链正是 RR5 想要的行为
 */

/** 基类：所有 serenity plugin 错误的父类 */
export class SerenityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerenityError';
  }
}

/** RR1 违反：cwd 不在 git repo 内 */
export class NotInGitRepoError extends SerenityError {
  constructor(cwd: string) {
    super(`cwd "${cwd}" is not inside a git repository; serenity plugin requires RR6 (cwd must be in a git repo). Run \`git init\` in this directory first, or use \`/serenity-init\` to set up a complete CCC.`);
    this.name = 'NotInGitRepoError';
  }
}

/** RR1 违反：/.serenity 文件不存在 */
export class SerenityFileNotFoundError extends SerenityError {
  constructor(cwdRoot: string) {
    super(`/.serenity file not found in "${cwdRoot}"; serenity plugin requires RR1 (/.serenity must exist in cwd root)`);
    this.name = 'SerenityFileNotFoundError';
  }
}

/** /.serenity 文件存在但内容为空或无效 */
export class SerenityFileEmptyError extends SerenityError {
  constructor(path: string) {
    super(`/.serenity file at "${path}" is empty or contains only whitespace; expected a non-empty CCC name`);
    this.name = 'SerenityFileEmptyError';
  }
}

/** RR2 违反：.opencode/skills/<cccName>/SKILL.md 不存在 */
export class SkillNotFoundError extends SerenityError {
  constructor(cwdRoot: string, cccName: string) {
    super(`SKILL.md not found at "${cwdRoot}/.opencode/skills/${cccName}/SKILL.md"; serenity plugin requires RR2 (the CCC skill must exist)`);
    this.name = 'SkillNotFoundError';
  }
}

/** msm_exec 失败：MSM 不在注册表中 */
export class MsmNotRegisteredError extends SerenityError {
  constructor(msmName: string) {
    super(`MSM "${msmName}" is not in mech-registry.json; serenity plugin requires registration before use`);
    this.name = 'MsmNotRegisteredError';
  }
}

/** msm_exec 失败：MSM 子进程超时 */
export class MsmTimeoutError extends SerenityError {
  constructor(msmName: string, timeoutMs: number) {
    super(`MSM "${msmName}" timed out after ${timeoutMs}ms`);
    this.name = 'MsmTimeoutError';
  }
}

/** msm_register 失败：name 已被注册 */
export class MsmAlreadyRegisteredError extends SerenityError {
  constructor(msmName: string) {
    super(`MSM "${msmName}" is already registered; use msm_deregister first to replace, or pick a different name`);
    this.name = 'MsmAlreadyRegisteredError';
  }
}

/** msm_register 失败：脚本文件不存在（拒绝注册空路径）*/
export class MsmScriptNotFoundError extends SerenityError {
  constructor(msmName: string, scriptPath: string) {
    super(`MSM "${msmName}" script not found at "${scriptPath}"; serenity plugin refuses to register MSMs whose script does not exist`);
    this.name = 'MsmScriptNotFoundError';
  }
}

/** msm_deregister 失败：name 不在 registry */
export class MsmNotInRegistryError extends SerenityError {
  constructor(msmName: string) {
    super(`MSM "${msmName}" is not in mech-registry.json; nothing to deregister`);
    this.name = 'MsmNotInRegistryError';
  }
}

/** msm_exec 失败：MSM 子进程 exit code != 0
 *
 * v1.15.1：MsmExecutionError 显式持有 stdout/stderr/exitCode 三个字段
 * - 修复 S022 RFC §9 缺陷（plugin 端 msm_exec 吞掉 stdout）
 * - JSON 模式下业务 msm 把错误信息写在 stdout（per S022 §2.3），
 *   错误对象必须能让 LLM 看到 stdout 原文以便重试/诊断
 */
export class MsmExecutionError extends SerenityError {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  constructor(msmName: string, exitCode: number, stdout: string, stderr: string) {
    const stdoutSnippet = stdout ? `
stdout: ${stdout.slice(0, 1000)}` : '';
    const stderrSnippet = stderr ? `
stderr: ${stderr.slice(0, 500)}` : '';
    super(`MSM "${msmName}" failed with exit code ${exitCode}${stdoutSnippet}${stderrSnippet}`);
    this.name = 'MsmExecutionError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** RR7 触发：/.serenity 创建失败（git add/commit 阶段）*/
export class InitGitCommitError extends SerenityError {
  constructor(reason: string) {
    super(`failed to git add + commit /.serenity: ${reason}`);
    this.name = 'InitGitCommitError';
  }
}

/** v1.10 RR7：用户输入的 prefix 不是 kebab-case */
export class InvalidCccNameError extends SerenityError {
  constructor(name: string) {
    super(
      `Invalid CCC prefix "${name}"; must be kebab-case ` +
      `(lowercase a-z, 0-9, dashes; no leading or trailing dash)`,
    );
    this.name = 'InvalidCccNameError';
  }
}

/** msm_exec 失败：path-arg 解析为 cwdRoot 之外的路径（v0.1-2 path escape guard）*/
export class MsmPathEscapeError extends SerenityError {
  constructor(msmName: string, argName: string, value: string, resolved: string) {
    super(
      `MSM "${msmName}" path-arg "${argName}"="${value}" resolves to "${resolved}" ` +
      `which is outside cwdRoot; serenity plugin blocks path traversal (v0.1-2 pre-indexed guard)`,
    );
    this.name = 'MsmPathEscapeError';
  }
}

/** msm_exec 失败：path-arg 指向 symlink / symlink 链（v1-1 symlink 防御）*/
export class MsmSymlinkError extends SerenityError {
  constructor(msmName: string, argName: string, value: string, resolved: string, reason: string) {
    super(
      `MSM "${msmName}" path-arg "${argName}"="${value}" → "${resolved}": ${reason}; ` +
      `serenity plugin blocks symlink attacks (v1-1 symlink guard)`,
    );
    this.name = 'MsmSymlinkError';
  }
}

/** 文件系统操作错误（file-system-tool） */
export class FileSystemError extends SerenityError {
  constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

/** 会话管理操作错误（session-tool） */
export class SessionError extends SerenityError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}
