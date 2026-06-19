#!/usr/bin/env npx tsx
/**
 * msm-exec-runtime.ts — opencode-serenity-plugin 端 msm_exec 协议 runtime
 *
 * 角色：msm_exec 协议层 in-process runtime (S028 反转 S024/D26)。Plugin 端
 *       msm_exec tool 调本文件 export 的 runMsmExec()，解析 6 必含 flag 后调
 *       业务 MSM，按 --format/--log 包装输出。零 spawn（除业务 msm 本身），
 *       plugin 端 3 msm tool 完全自包含。
 *
 * 源：本文件 90% 移植自 serenity 仓 msm-exec.ts
 *      (S024 v1.14 产物, 2026-06-07 by commit 725a9e7)
 *
 * 移植变更（S028）：
 * - resolveRegistryPath 改 plugin 仓根 mech-registry.json
 *   + D6 bootstrap (缺失则创建空 {version:1, entries:[]})
 * - route() 重构为 routeWithArgv(argv, opts?) 返回 MsmExecResult
 *   不再直接写 stdout/stderr (改 in-process 调用栈)
 * - runBusinessMsm 增加 cwd 参数, timeout 30s → 600s (D11 统一)
 * - 新增 runMsmExec() 导出 (msm-call 调用入口)
 * - emitText/emitJson 移除 (由 msm-call 层负责格式化)
 *
 * 协议契约 (S022 RFC §2)：
 * - 协议 flag 只能出现在 args 前缀段（紧邻 msm-name 之前）
 * - 6 个必含 flag：
 *     --format=<text|json>   输出格式 (默认 text)
 *     --log <path>           JSON Lines 日志
 *     --help / -h            自身或某 msm 的帮助
 *     --version              打印 msm_exec 版本
 *     --list                 列出所有 msm
 *     --schema <name>        打印某 msm 的 JSON schema
 * - 输出契约：
 *   - text 模式：业务 msm stdout/stderr/exit 透传
 *   - json 模式：包装为 6 字段 schema (success: ok/exit/data; failure: ok/exit/error)
 *   - log 模式：JSON Lines (ts/level/msm/exit/error_code/error_message)
 *
 * 退出码：
 *   0 — 成功
 *   1 — user (参数错误 / 未知 msm / 拒绝协议 flag)
 *   2 — system (注册表缺失 / 子进程启动失败)
 *   3 — operator (业务 msm 自身非 0 exit，由 --format=json 时透传)
 *
 * 用法 (CLI 模式, 主要用于 plugin 仓内调试):
 *   npx tsx msm-exec-runtime.ts <msm-name> [args...]
 *   npx tsx msm-exec-runtime.ts --format=json <msm-name> [args...]
 *   npx tsx msm-exec-runtime.ts --log /tmp/x.log --format=json <msm-name> [args...]
 *   npx tsx msm-exec-runtime.ts --list
 *   npx tsx msm-exec-runtime.ts --schema <msm-name>
 *   npx tsx msm-exec-runtime.ts --help [msm-name]
 *   npx tsx msm-exec-runtime.ts --version
 *
 * 用法 (in-process 模式, plugin 端 msm-call 调用):
 *   import { runMsmExec } from "./msm-exec-runtime";
 *   const result = await runMsmExec(["--list"]);
 *   const result = await runMsmExec(["--format=json", "msm-name", "arg1"]);
 *   const result = await runMsmExec(["msm-name", "arg1"], { cwd: "/path/to/cwd" });
 *
 * 不接受：缩写 (--json 替代 --format=json), 短别名 (--ls 替代 --list)
 * — 严格遵循 §10.4 业务 msm 零协议 flag + §2.1 flag 必须在 prefix
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getState } from "../state.js";
import pkg from "../../package.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 版本 ──

const MSM_EXEC_VERSION = "1.0.0";

// ── 类型 ──

type ProtocolFlags = {
  format: "text" | "json";
  log: string | null;
  help: string | null; // null = 自帮助, string = 该 msm 的帮助
  version: boolean;
  list: boolean;
  schema: string | null;
};

type ParsedArgs = {
  protocol: ProtocolFlags;
  msmName: string | null;
  businessArgs: string[];
};

type StderrError = {
  code: string;
  category: string;
  message: string;
  cause: string;
  remediation: string;
  context: Record<string, unknown> | null;
};

type JsonResult =
  | { ok: true; exit: 0; data: string }
  | { ok: false; exit: number; error: StderrError };

type LogEvent = {
  ts: string;
  level: "info" | "warn" | "error";
  msm: string | null;
  msm_exec: string;
  protocol: Partial<ProtocolFlags>;
  args: string[];
  exit?: number;
  error_code?: string;
  error_message?: string;
};

/**
 * in-process 调用结果 (S028 新增)
 *
 * - stdout/stderr: runtime 捕获的"原本会写到 process.stdout/stderr"的内容
 * - exitCode: 退出码 (0/1/2/3/4, 与原文协议一致)
 * - jsonResult: --format=json 时填充的 6 字段 schema, 供 caller 直接透传给 opencode
 */
export type MsmExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  jsonResult: JsonResult | null;
};

/** runMsmExec 可选参数 (S028 新增) */
export type RunMsmExecOptions = {
  /** 业务 msm spawn 时的 cwd. 默认 process.cwd(). */
  cwd?: string;
  /**
   * 注册表绝对路径. 提供时优先使用（in-process 调用由 msm-call 传入 cwdRoot 的注册表路径,
   * 与 msm.ts loadMechRegistry 同一份文件 — S028 收口双注册表问题）.
   * 不提供时 fallback 到 plugin 仓根 `mech-registry.json` (D9 + D6 bootstrap, CLI 调试用).
   */
  registryPath?: string;
};

// ── 错误类 (6 字段 schema per msm-writing-standards §5.5) ──

export class MsmExecError extends Error {
  constructor(
    public code: string,
    public category: "user" | "system" | "operator" | "internal",
    public override message: string,
    public context: Record<string, unknown> = {},
    public remediation?: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "MsmExecError";
  }

  toStderr(): string {
    const lines = [
      `[${this.code}]`,
      `  category: ${this.category}`,
      `  message: ${this.message}`,
    ];
    if (this.cause !== undefined) {
      const c = this.cause instanceof Error ? this.cause.message : String(this.cause);
      if (c) lines.push(`  cause: ${c}`);
    }
    if (this.remediation) lines.push(`  remediation: ${this.remediation}`);
    if (Object.keys(this.context).length > 0) {
      lines.push(`  context: ${JSON.stringify(this.context)}`);
    }
    return lines.join("\n");
  }

  exitCode(): number {
    return { user: 1, system: 2, operator: 3, internal: 4 }[this.category];
  }
}

// ── Registry 解析 (S028: 路径改 plugin 仓根 + D6 bootstrap) ──

type RegistryEntry = {
  name: string;
  path: string;
  skill: string;
  category: "mech" | "semi-mech";
  description: string;
  usage: string;
  subcommands?: Array<{ name: string; description: string; args?: Array<{ name: string; type: string; required?: boolean; description?: string }>; flags?: Array<{ name: string; type: string; default?: unknown; description?: string }> }>;
  flags?: Array<{ name: string; type: string; default?: unknown; description?: string }>;
  exit_codes?: Record<string, string>;
  error_codes?: string[];
};

type RegistryFile = {
  version?: number;
  description?: string;
  entries: RegistryEntry[];
};

/**
 * 解析 plugin 仓 mech-registry.json 路径
 *
 * S028 D9: 优先 plugin 仓根 `mech-registry.json` (D9 决策 = `__dirname/../../`)
 * D6 bootstrap: 不存在则创建空 `{version:1, entries:[]}`
 *
 * S028 v0.0.3 收口: caller 可通过 opts.registryPath 显式指定路径
 * (msm-call 传入 cwdRoot 的注册表路径，与 msm.ts loadMechRegistry 同一份).
 * 该参数让 msm-exec-runtime 不再依赖 plugin 仓内置的 plugin-root 注册表
 * (该注册表仅供 CLI 调试用，业务流实际写读均走 cwdRoot 注册表).
 */
function resolveRegistryPath(registryPath?: string): string {
  if (registryPath) return registryPath;
  // msm-exec-runtime.ts 位于 <plugin-root>/src/util/
  // 注册表位于 <plugin-root>/mech-registry.json
  const candidate = resolve(__dirname, "..", "..", "mech-registry.json");
  return candidate;
}

/** D6 bootstrap: 确保 plugin 仓 mech-registry.json 存在 (不存在则创建空) */
function ensureRegistryFile(path: string): void {
  if (existsSync(path)) return;
  // 确保父目录存在
  mkdirSync(dirname(path), { recursive: true });
  const empty: RegistryFile = {
    version: 1,
    description: "opencode-serenity-plugin 内部 msm 注册表（plugin 仓独立 — 不依赖 serenity 仓）",
    entries: [],
  };
  writeFileSync(path, JSON.stringify(empty, null, 2) + "\n", "utf8");
}

function loadRegistry(opts: { registryPath?: string } = {}): RegistryFile {
  const path = resolveRegistryPath(opts.registryPath);
  // D6 bootstrap 行为分流 (S028 v0.0.3 收口):
  // - 无 registryPath (CLI 模式): ensureRegistryFile 不存在则创建空, 让 --list 等元命令在冷启动可用
  // - 有 registryPath (in-process 模式): 不 bootstrap, 文件不存在 → 抛 MSM_REGISTRY_NOT_FOUND
  //   (避免覆盖 msm_admin 已写的注册表; msm.ts loadMechRegistry 也会兜底返回 [])
  if (!opts.registryPath) {
    ensureRegistryFile(path);
  } else if (!existsSync(path)) {
    throw new MsmExecError(
      "MSM_REGISTRY_NOT_FOUND",
      "system",
      `caller-supplied registry path 不存在: ${path}`,
      { path },
      "确认 msm_admin register 已创建该文件, 或检查 cwdRoot/.opencode/skills/<inst>/ 是否正确",
    );
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { entries: parsed as RegistryEntry[] };
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return parsed as RegistryFile;
    }
    throw new MsmExecError(
      "MSM_REGISTRY_INVALID",
      "system",
      "mech-registry.json 顶层既不是数组也无 entries 字段",
      { path },
      "修复注册表顶层结构为 { version, description, entries: [...] }",
    );
  } catch (err) {
    if (err instanceof MsmExecError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new MsmExecError(
      "MSM_REGISTRY_PARSE_FAILED",
      "system",
      `mech-registry.json 解析失败: ${detail}`,
      { path },
      "检查 JSON 语法",
      err,
    );
  }
}

function findEntry(registry: RegistryFile, name: string): RegistryEntry {
  const entry = registry.entries.find((e) => e.name === name);
  if (!entry) {
    throw new MsmExecError(
      "MSM_NOT_FOUND",
      "user",
      `MSM "${name}" 不在 mech-registry.json 中`,
      { msmName: name, availableCount: registry.entries.length },
      "运行 msm-exec.ts --list 查看所有可用 msm",
    );
  }
  return entry;
}

// ── 协议 flag 解析 (§2.1) ──

function parseArgs(argv: string[]): ParsedArgs {
  const protocol: ProtocolFlags = {
    format: "text",
    log: null,
    help: null,
    version: false,
    list: false,
    schema: null,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") && arg !== "-h") break;
    const [key, value] = arg.includes("=") ? arg.slice(2).split("=", 2) : [arg === "-h" ? "help" : arg.slice(2), "true"];

    if (key === "format") {
      if (value !== "text" && value !== "json") {
        throw new MsmExecError("PARAMETER_INVALID_VALUE", "user", `--format 必须是 text 或 json, 收到: ${value}`, { received: value }, "使用 --format=text 或 --format=json");
      }
      protocol.format = value;
      i++;
    } else if (key === "log") {
      if (value === "true" || value === undefined) {
        // --log <path> 形式: 取下一个 token
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new MsmExecError("PARAMETER_MISSING", "user", "--log 需要 1 个位置参数 <path>", { received: next ?? null }, "用法: --log <path>");
        }
        protocol.log = next;
        i += 2;
      } else {
        protocol.log = value;
        i++;
      }
    } else if (key === "help" || arg === "-h") {
      // --help [name] 形式: 可选 name
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        protocol.help = next;
        i += 2;
      } else {
        protocol.help = "__self__"; // 自帮助
        i++;
      }
    } else if (key === "version") {
      protocol.version = true;
      i++;
    } else if (key === "list") {
      protocol.list = true;
      i++;
    } else if (key === "schema") {
      if (value === "true" || value === undefined) {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new MsmExecError("PARAMETER_MISSING", "user", "--schema 需要 1 个位置参数 <name>", { received: next ?? null }, "用法: --schema <msm-name>");
        }
        protocol.schema = next;
        i += 2;
      } else {
        protocol.schema = value;
        i++;
      }
    } else {
      throw new MsmExecError("PARAMETER_INVALID_VALUE", "user", `未知协议 flag: --${key}`, { flag: key, validFlags: ["format", "log", "help", "version", "list", "schema"] }, "msm-exec 只接受 6 个协议 flag (参见 S022 RFC §2.2)");
    }
  }

  const [msmName, ...businessArgs] = argv.slice(i);
  return { protocol, msmName: msmName ?? null, businessArgs };
}

// ── 业务 msm 执行 (S028: 接受 cwd 参数, timeout 30s → 600s) ──

function runBusinessMsm(entry: RegistryEntry, businessArgs: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // 预检脚本文件存在性 — 防 npx tsx 在文件缺失时卡住不退出
  const absPath = resolve(cwd, entry.path);
  if (!existsSync(absPath)) {
    return Promise.reject(
      new MsmExecError(
        "SCRIPT_NOT_FOUND",
        "system",
        `业务 MSM 脚本文件不存在: ${absPath}`,
        { msmName: entry.name, path: entry.path },
        "确认 msm_admin register 的参数 path 正确，或脚本文件未被删除",
      ),
    );
  }

  return new Promise((resolveRun, rejectRun) => {
    // 注：path.escape 校验由 plugin 端的 v0.1-2 path-arg guard 负责
    // msm-exec-runtime 这里只 spawn，不再做二次校验（避免重复）

    const state = getState();
    const child = spawn("npx", ["tsx", absPath, ...businessArgs], {
      cwd,
      env: state.activated
        ? {
            ...process.env,
            SERENITY_ROOT: state.cwdRoot,
            SERENITY_CCC: state.cccName,
            SERENITY_VERSION: pkg.version,
          }
        : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000, // S028 D11: 30s → 600s 统一
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolveRun({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on("error", (err) => {
      rejectRun(err);
    });
  });
}

// ── stderr 6 字段 schema 解析 (§2.3) ──

function parseStderrError(stderr: string): StderrError {
  const codeMatch = stderr.match(/^\s*code:\s*(\S+)/m);
  const categoryMatch = stderr.match(/^\s*category:\s*(\S+)/m);
  const messageMatch = stderr.match(/^\s*message:\s*(.+)$/m);
  const causeMatch = stderr.match(/^\s*cause:\s*(.+)$/m);
  const remediationMatch = stderr.match(/^\s*remediation:\s*(.+)$/m);
  const contextMatch = stderr.match(/^\s*context:\s*(\{[\s\S]*?\})/m);

  // 6 字段必须全部命中
  if (codeMatch && categoryMatch && messageMatch && causeMatch && remediationMatch && contextMatch) {
    let ctx: Record<string, unknown> | null = null;
    try {
      ctx = JSON.parse(contextMatch[1]!);
    } catch {
      ctx = null;
    }
    return {
      code: codeMatch[1]!,
      category: categoryMatch[1]!,
      message: messageMatch[1]!.trim(),
      cause: causeMatch[1]!.trim(),
      remediation: remediationMatch[1]!.trim(),
      context: ctx,
    };
  }

  // 部分命中或未命中：fallback
  return {
    code: "INTERNAL_PARSE_FAILED",
    category: "internal",
    message: "msm-exec 无法从业务 msm stderr 解析 6 字段错误 schema",
    cause: stderr.trim() || "(empty stderr)",
    remediation: "业务 msm 应输出 msm-writing-standards §5.5 6 字段 stderr schema",
    context: null,
  };
}

// ── JSON Lines 日志写入 ──

function writeLogLine(logPath: string, event: LogEvent): void {
  try {
    appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch (err) {
    // log 写失败不阻断主流程；走 stderr 提示
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[msm-exec] warning: failed to write log line to "${logPath}": ${detail}\n`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Meta-command 处理 ──

function doList(registry: RegistryFile): string {
  return registry.entries
    .map((e) => `${e.name} | ${e.skill} | ${e.category} | ${e.description}`)
    .join("\n");
}

function doSchema(registry: RegistryFile, name: string): string {
  const entry = findEntry(registry, name);
  return JSON.stringify(entry, null, 2);
}

function doHelp(registry: RegistryFile | null, name: string | null): string {
  if (!name || name === "__self__") {
    return `msm-exec v${MSM_EXEC_VERSION} — 宁静号 msm_exec 协议层 (plugin in-process runtime)

用法:
  msm-exec [协议-flag...] <msm-name> [业务-args...]
           └─ 协议段 ─┘         └── 业务段 ──┘

协议 flag (必须出现在 args 前缀):
  --format=<text|json>   输出格式 (默认 text)
  --log <path>           JSON Lines 日志
  --help, -h [name]      自身帮助 或 某 msm 的帮助
  --version              打印版本
  --list                 列出所有 msm
  --schema <name>        打印某 msm 的 JSON schema

示例:
  msm-exec --list
  msm-exec --schema ssh-connect
  msm-exec ssh-connect check ubuntu
  msm-exec --format=json --log /tmp/x.log ssh-connect exec ubuntu "ls -la"

退出码:
  0  成功
  1  user (参数错 / 未知 msm)
  2  system (注册表缺失 / 子进程启动失败)
  3  operator (业务 msm 自身非 0 exit, --format=json 时透传)
`;
  }
  if (!registry) {
    throw new MsmExecError("MSM_REGISTRY_NOT_FOUND", "system", "无法定位 mech-registry.json", { scriptDir: __dirname }, "msm-exec --help <name> 需要注册表可访问");
  }
  const entry = findEntry(registry, name);
  return `${entry.name} — ${entry.description}

用法: msm-exec ${entry.name} ${entry.usage}

${entry.subcommands && entry.subcommands.length > 0 ? `子命令:\n${entry.subcommands.map((s) => `  ${s.name.padEnd(15)} ${s.description}`).join("\n")}` : ""}
${entry.flags && entry.flags.length > 0 ? `\nflag:\n${entry.flags.map((f) => `  ${f.name.padEnd(15)} ${f.description ?? ""} (type=${f.type}${f.default !== undefined ? `, default=${JSON.stringify(f.default)}` : ""})`).join("\n")}` : ""}

退出码: ${entry.exit_codes ? Object.entries(entry.exit_codes).map(([k, v]) => `\n  ${k}  ${v}`).join("") : "见 msm-writing-standards §5.3"}
错误码: ${entry.error_codes?.join(", ") ?? "(无)"}
`;
}

function doVersion(): string {
  return `msm-exec v${MSM_EXEC_VERSION}`;
}

// ── 业务 msm 调用 (主路径, S028: 返回 MsmExecResult) ──

async function runBusiness(registry: RegistryFile, msmName: string, businessArgs: string[], protocol: ProtocolFlags, cwd: string): Promise<MsmExecResult> {
  const entry = findEntry(registry, msmName);

  // 写 start log
  if (protocol.log) {
    writeLogLine(protocol.log, {
      ts: nowIso(),
      level: "info",
      msm: msmName,
      msm_exec: MSM_EXEC_VERSION,
      protocol: { format: protocol.format, log: protocol.log },
      args: businessArgs,
    });
  }

  const { stdout, stderr, exitCode } = await runBusinessMsm(entry, businessArgs, cwd);

  let result: JsonResult;
  if (exitCode === 0) {
    result = { ok: true, exit: 0, data: stdout };
  } else {
    const error = parseStderrError(stderr);
    result = { ok: false, exit: exitCode, error };
  }

  // 写 end log
  if (protocol.log) {
    const logEvent: LogEvent = {
      ts: nowIso(),
      level: exitCode === 0 ? "info" : "error",
      msm: msmName,
      msm_exec: MSM_EXEC_VERSION,
      protocol: { format: protocol.format, log: protocol.log },
      args: businessArgs,
      exit: exitCode,
    };
    if (exitCode !== 0 && !result.ok) {
      logEvent.error_code = result.error.code;
      logEvent.error_message = result.error.message;
    }
    writeLogLine(protocol.log, logEvent);
  }

  // S028: 改为返回 MsmExecResult (不再 emitText/emitJson)
  if (protocol.format === "json") {
    return {
      stdout: JSON.stringify(result) + "\n",
      stderr: "",
      exitCode,
      jsonResult: result,
    };
  }
  return {
    stdout,
    stderr,
    exitCode,
    jsonResult: null,
  };
}

// ── 路由 (S028 重构: routeWithArgv 返回 MsmExecResult) ──

async function routeWithArgv(argv: string[], opts: RunMsmExecOptions = {}): Promise<MsmExecResult> {
  const cwd = opts.cwd ?? process.cwd();
  const { protocol, msmName, businessArgs } = parseArgs(argv);

  // 元命令 (不需要 msmName)
  if (protocol.version) {
    return { stdout: doVersion(), stderr: "", exitCode: 0, jsonResult: null };
  }

  // --list/--schema/--help 需要 registry
  let registry: RegistryFile | null = null;
  if (protocol.list || protocol.schema || protocol.help) {
    registry = loadRegistry(opts);
  }

  if (protocol.list) {
    return { stdout: doList(registry!), stderr: "", exitCode: 0, jsonResult: null };
  }

  if (protocol.schema) {
    return { stdout: doSchema(registry!, protocol.schema), stderr: "", exitCode: 0, jsonResult: null };
  }

  if (protocol.help !== null) {
    return {
      stdout: doHelp(registry, protocol.help === "__self__" ? null : protocol.help),
      stderr: "",
      exitCode: 0,
      jsonResult: null,
    };
  }

  // 业务路径 (需要 registry + msmName)
  if (!msmName) {
    throw new MsmExecError("PARAMETER_MISSING", "user", "缺少 msm-name (非元命令必须指定)", { received: argv }, "用法: msm-exec [协议-flag...] <msm-name> [业务-args...]");
  }

  if (!registry) {
    registry = loadRegistry(opts);
  }

  return await runBusiness(registry, msmName, businessArgs, protocol, cwd);
}

// ── 公开入口 (S028 新增) ──

/**
 * in-process 调 msm_exec 协议 runtime (S028 msm-call.ts 唯一调用点)
 *
 * @param argv 完整 args (协议 flag 可选 + msm-name 必需 + 业务 args)
 *             例: ["--list"], ["--format=json", "session-tool", "list"], ["ssh-connect", "check", "ubuntu"]
 * @param opts.cwd 业务 msm spawn 时的 cwd (默认 process.cwd())
 * @returns MsmExecResult {stdout, stderr, exitCode, jsonResult}
 * @throws MsmExecError 协议错误 (参数错 / 未知 msm / 注册表解析失败等)
 */
export async function runMsmExec(argv: string[], opts: RunMsmExecOptions = {}): Promise<MsmExecResult> {
  return await routeWithArgv(argv, opts);
}

// ── CLI 入口 (plugin 仓内调试用) ──

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let result: MsmExecResult;
  try {
    result = await runMsmExec(argv);
  } catch (err) {
    if (err instanceof MsmExecError) {
      process.stderr.write(err.toStderr() + "\n");
      return err.exitCode();
    }
    // 未预期错误
    const e = err instanceof Error ? err : new Error(String(err));
    const fallback = new MsmExecError(
      "INTERNAL_UNHANDLED_STATE",
      "internal",
      `未预期异常: ${e.message}`,
      { stack: e.stack },
      "请向 Agent 报告此 bug",
      e,
    );
    process.stderr.write(fallback.toStderr() + "\n");
    return fallback.exitCode();
  }

  // 写 result
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

// CLI 守卫：仅当本文件被当 CLI 跑（process.argv[1] === 本文件）才执行 main
// 否则作为库 import 时（如 vitest 跑测试、plugin 端 in-process 调），main 会被静默触发
// 并读取 import 时的 process.argv 触发意外行为（S028 v0.0.3 修复 — 移植 v0.0.2 守卫）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof MsmExecError) {
      process.stderr.write(err.toStderr() + "\n");
      process.exit(err.exitCode());
    }
    const e = err instanceof Error ? err : new Error(String(err));
    const fallback = new MsmExecError(
      "INTERNAL_UNHANDLED_STATE",
      "internal",
      `未预期异常: ${e.message}`,
      { stack: e.stack },
      "请向 Agent 报告此 bug",
      e,
    );
    process.stderr.write(fallback.toStderr() + "\n");
    process.exit(fallback.exitCode());
  },
);
}
