/**
 * 错误类清单（contract-v0.md 附录 B）
 *
 * 设计原则：
 * - 所有错误都是 Error 子类（保证 stack trace 完整）
 * - 错误名以 SerenityError 结尾（grep 友好）
 * - 不抛顶层（plugin 入口不抛），错误在 hook 内部被捕获
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
    super(`cwd "${cwd}" is not inside a git repository; serenity plugin requires RR6 (cwd must be in a git repo)`);
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
    super(`/.serenity file at "${path}" is empty or contains only whitespace; expected a non-empty instance name`);
    this.name = 'SerenityFileEmptyError';
  }
}

/** RR2 违反：.opencode/skills/<instanceName>/SKILL.md 不存在 */
export class SkillNotFoundError extends SerenityError {
  constructor(cwdRoot: string, instanceName: string) {
    super(`SKILL.md not found at "${cwdRoot}/.opencode/skills/${instanceName}/SKILL.md"; serenity plugin requires RR2 (the instance skill must exist)`);
    this.name = 'SkillNotFoundError';
  }
}

/** RR3 违反：LLM 试图调用被禁的 bash 工具 */
export class BashDisabledError extends SerenityError {
  constructor() {
    super('bash tool is disabled by serenity policy (RR3); use msm_list + msm_exec instead. To run an MSM that does not exist, ask the user to register a new one in mech-registry.json first.');
    this.name = 'BashDisabledError';
  }
}

/** msm_exec 失败：MSM 不在注册表中 */
export class MsmNotRegisteredError extends SerenityError {
  constructor(msmName: string) {
    super(`MSM "${msmName}" is not in mech-registry.json; serenity plugin requires registration before use`);
    this.name = 'MsmNotRegisteredError';
  }
}

/** msm_exec 失败：args 解析错误 */
export class MsmArgsParseError extends SerenityError {
  constructor(rawArgs: string, reason: string) {
    super(`failed to parse msm_exec args "${rawArgs}" as JSON: ${reason}`);
    this.name = 'MsmArgsParseError';
  }
}

/** msm_exec 失败：MSM 子进程超时 */
export class MsmTimeoutError extends SerenityError {
  constructor(msmName: string, timeoutMs: number) {
    super(`MSM "${msmName}" timed out after ${timeoutMs}ms`);
    this.name = 'MsmTimeoutError';
  }
}

/** msm_exec 失败：MSM 子进程 exit code != 0 */
export class MsmExecutionError extends SerenityError {
  constructor(msmName: string, exitCode: number, stderr: string) {
    super(`MSM "${msmName}" failed with exit code ${exitCode}: ${stderr.slice(0, 500)}`);
    this.name = 'MsmExecutionError';
  }
}

/** RR7 触发：/.serenity 创建失败（git add/commit 阶段）*/
export class InitGitCommitError extends SerenityError {
  constructor(reason: string) {
    super(`failed to git add + commit /.serenity: ${reason}`);
    this.name = 'InitGitCommitError';
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
