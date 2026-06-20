#!/usr/bin/env npx tsx
/**
 * compass-tool.ts — 方向判断统一工具
 *
 * Mech（机械 — 纯确定性，零 LLM 推理）：
 *   validate — 信号报告格式校验
 *   judge    — 3 通道（决策质量/工程困难/知识价值）条件评估与决策矩阵
 *   两个子命令均为纯确定性 — 无 LLM 决策点。
 *
 * subcommands:
 *   validate <report-file>            校验信号报告格式（缺/错字段、值越界）
 *   judge    <signal-report-file>     3 通道评估并输出 SUFFICIENT / INSUFFICIENT
 *
 * 用法：
 *   npx tsx .opencode/skills/compass/scripts/compass-tool.ts validate <report.json>
 *   npx tsx .opencode/skills/compass/scripts/compass-tool.ts judge    <signal-report.json>
 *
 * 退出码（参见 msm-writing-standards.md §5.3 命名空间）：
 *   0 — 成功（validate 通过 / judge SUFFICIENT）
 *   1 — user（参数错 / 未知子命令 / 拒绝协议 flag / 报告未通过校验 / judge INSUFFICIENT）
 *   2 — system（无法定位 CCC root / 文件读取失败 / JSON 解析失败）
 *   3 — operator（注册表缺失等，参见 msm-exec 调用 — 此 msm 不直接产 operator 错）
 *   4 — internal（未预期的异常）
 *
 * 输出：
 *   - 成功：stdout 文本（人类可读）
 *   - 失败：stderr 6 字段 schema（msm-writing-standards.md §5.5）
 *
 * 错误码（参见 msm-writing-standards.md §8 字典）：
 *   - PARAMETER_MISSING            user   缺必填参数
 *   - PARAMETER_INVALID_VALUE      user   未知子命令 / 未知 flag / 拒绝协议 flag
 *   - CCC_ROOT_NOT_FOUND          system 无法定位 CCC root
 *   - REPORT_FILE_NOT_FOUND        system 报告文件不存在
 *   - REPORT_FORMAT_INVALID        system 报告 JSON 解析失败
 *   - VALIDATION_FAILED            user   validate 报告格式未通过
 *   - JUDGMENT_FAILED              user   judge 判定为 INSUFFICIENT
 *   - INTERNAL_UNHANDLED_STATE     internal 兜底
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 错误类（参见 msm-writing-standards.md §5.13 模板 v0.2）──

type Category = "user" | "system" | "operator" | "internal";

class MsmError extends Error {
  constructor(
    public code: string,
    public category: Category,
    public message: string,
    public context: Record<string, unknown> = {},
    public remediation?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "MsmError";
  }

  toStderr(): string {
    // v0.1 §5.5 6 字段 schema：code / category / message / cause / remediation / context
    // msm-exec parseStderrError 6/6 严格匹配 — 必须每个字段都有独立行
    // cause 始终输出（占位字符串防止 fallback INTERNAL_PARSE_FAILED）
    const lines: string[] = [
      `[${this.code}]`,
      `  code: ${this.code}`,
      `  category: ${this.category}`,
      `  message: ${this.message}`,
      `  cause: ${this.cause !== undefined && this.cause !== ""
        ? (this.cause instanceof Error ? this.cause.message : String(this.cause))
        : "(no underlying cause)"}`,
    ];
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

function emitError(err: MsmError): void {
  process.stderr.write(err.toStderr() + "\n");
}

// ── Find CCC root（通用 CCC 检测：向上查找 .serenity 标记文件）──

function findCccRoot(): string {
  let dir = resolve(process.cwd());
  const maxDepth = 20;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, ".serenity"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MsmError(
    "CCC_ROOT_NOT_FOUND",
    "system",
    "无法定位 CCC 根目录（未检测到 .serenity 标记文件）",
    { startDir: process.cwd() },
    "在 CCC 工作目录下执行；或检查 .serenity 文件是否存在",
  );
}

// ── 业务函数：读取并解析 JSON 文件（抛 MsmError）──

function loadJsonFile<T>(filePath: string, codeNotFound: string, codeFormat: string): T {
  if (!existsSync(filePath)) {
    throw new MsmError(
      codeNotFound,
      "system",
      `文件不存在: ${filePath}`,
      { path: filePath },
      "检查路径拼写；或运行 file-system exists <path> 验证",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new MsmError(
      codeFormat,
      "system",
      `文件读取失败: ${filePath}`,
      { path: filePath },
      "检查文件权限",
      err,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new MsmError(
      codeFormat,
      "system",
      `JSON 解析失败: ${filePath}`,
      { path: filePath },
      "运行 `python3 -m json.tool < path` 验证 JSON 格式",
      err,
    );
  }
}

// ── Types ──

interface SignalReport {
  issueId?: string;
  decisionQuality?: {
    score?: string;
    hasCriticalFlaw?: boolean;
    flaws?: string[];
    relatedSkills?: string[];
    sessionHistory?: string[];
  };
  engineeringDifficulty?: {
    reposAccessible?: boolean;
    servicesAvailable?: boolean;
    dataAccessible?: boolean;
    blockers?: string[];
    dependencies?: string[];
  };
  knowledgeValue?: {
    expectedCognitiveGain?: string;
    artifactsReusable?: boolean;
    existingGemsOverlap?: string[];
    docGaps?: string[];
  };
}

interface Blocker {
  blocker: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  source: number;
  detail: string;
  neededFrom?: string;
}

interface Assessment {
  decisionQuality: string;
  engineeringDifficulty: string;
  knowledgeValue: string;
}

interface JudgeResult {
  issueId: string;
  verdict: "SUFFICIENT" | "INSUFFICIENT";
  blockers: Blocker[];
  assessment: Assessment;
  conditionsMet: ConditionResult[];
  recommendedNextStep: string;
}

interface ConditionResult {
  condition: string;
  met: boolean;
  detail: string;
}

interface Violation {
  path: string;
  severity: "error" | "warning";
  message: string;
}

interface ValidationResult {
  file: string;
  totalViolations: number;
  errors: number;
  warnings: number;
  violations: Violation[];
  passed: boolean;
}

// ── 业务函数：validate（v0.1 抛 MsmError, 失败 → user=1, 文件错误 → system=2）──

const REQUIRED_CHANNELS = ["decisionQuality", "engineeringDifficulty", "knowledgeValue"];

interface ChannelValidation {
  name: string;
  requiredFields: string[];
}

const CHANNEL_VALIDATIONS: ChannelValidation[] = [
  { name: "decisionQuality", requiredFields: ["score"] },
  { name: "engineeringDifficulty", requiredFields: ["reposAccessible", "servicesAvailable", "dataAccessible"] },
  { name: "knowledgeValue", requiredFields: ["expectedCognitiveGain", "artifactsReusable"] },
];

function validateChannelValues(obj: Record<string, unknown>, prefix: string): Violation[] {
  const violations: Violation[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (key === "confidence" || key.endsWith("Confidence")) {
      if (typeof value === "number") {
        if (value < 0 || value > 1) {
          violations.push({ path, severity: "error", message: `confidence 值 ${value} 超出 [0, 1] 范围` });
        }
      } else if (typeof value === "string") {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0 || num > 1) {
          violations.push({ path, severity: "warning", message: `confidence 值 "${value}" 非有效 0-1 数值` });
        }
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      violations.push(...validateChannelValues(value as Record<string, unknown>, path));
    }
  }
  return violations;
}

function validateSignalReport(data: unknown, filePath: string): ValidationResult {
  const violations: Violation[] = [];

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {
      file: filePath, totalViolations: 1, errors: 1, warnings: 0,
      violations: [{ path: "$", severity: "error", message: "顶层必须是 JSON 对象" }], passed: false,
    };
  }

  const root = data as Record<string, unknown>;

  for (const channel of REQUIRED_CHANNELS) {
    if (!(channel in root)) {
      violations.push({ path: `$.${channel}`, severity: "error", message: `缺少必需通道: ${channel}` });
    }
  }

  for (const cv of CHANNEL_VALIDATIONS) {
    const channelObj = root[cv.name];
    if (!channelObj || typeof channelObj !== "object" || Array.isArray(channelObj)) {
      if (!violations.some((v) => v.path === `$.${cv.name}`)) {
        violations.push({ path: `$.${cv.name}`, severity: "error", message: `${cv.name} 必须是一个对象` });
      }
      continue;
    }
    const channel = channelObj as Record<string, unknown>;
    for (const field of cv.requiredFields) {
      if (!(field in channel)) {
        violations.push({ path: `$.${cv.name}.${field}`, severity: "error", message: `缺少必需字段: ${cv.name}.${field}` });
      }
    }
    violations.push(...validateChannelValues(channel, `$.${cv.name}`));
  }

  if ("issueId" in root && typeof root.issueId !== "string") {
    violations.push({ path: "$.issueId", severity: "warning", message: "issueId 应为字符串" });
  }

  violations.push(...validateChannelValues(root, "$"));

  const errors = violations.filter((v) => v.severity === "error").length;
  const warnings = violations.filter((v) => v.severity === "warning").length;

  return {
    file: filePath, totalViolations: violations.length, errors, warnings,
    violations, passed: errors === 0,
  };
}

function cmdValidate(filePath: string): void {
  const data = loadJsonFile<unknown>(filePath, "REPORT_FILE_NOT_FOUND", "REPORT_FORMAT_INVALID");
  const result = validateSignalReport(data, filePath);

  process.stdout.write("方向判断信号报告格式校验\n");
  process.stdout.write("=".repeat(40) + "\n");
  process.stdout.write(`文件: ${filePath}\n`);
  process.stdout.write(`结果: ${result.passed ? "✅ 通过" : "❌ 发现问题"}\n`);
  process.stdout.write(`错误: ${result.errors}, 警告: ${result.warnings}\n\n`);
  for (const v of result.violations) {
    const icon = v.severity === "error" ? "❌" : "⚠️";
    process.stdout.write(`  ${icon} [${v.path}] ${v.message}\n`);
  }
  if (result.passed && result.violations.length === 0) {
    process.stdout.write("  未发现问题，信号报告格式合规。\n");
  }

  if (!result.passed) {
    // msm-exec parseStderrError 的 context regex 用 \{[\s\S]*?\} 非贪婪匹配，
    // 嵌套对象（violations: [...]）会被截断触发 JSON.parse 失败 → context=null。
    // 防御措施：context 只放扁平 key-value，violations 放 remediation 文本。
    const violationSummary = result.violations
      .filter((v) => v.severity === "error")
      .slice(0, 3)
      .map((v) => `[${v.path}] ${v.message}`)
      .join("; ");
    throw new MsmError(
      "VALIDATION_FAILED",
      "user",
      `信号报告格式校验未通过: ${result.errors} 个错误`,
      { file: filePath, errorCount: result.errors, warningCount: result.warnings },
      `修复以下 error 字段后重跑: ${violationSummary || "(无 error 详情)"}`,
    );
  }
}

// ── 业务函数：judge（Mech，3 通道评估）──

function evaluateSignal(report: SignalReport): JudgeResult {
  const issueId = report.issueId || "UNKNOWN";
  const blockers: Blocker[] = [];
  const conditions: ConditionResult[] = [];

  // Condition 1: 决策质量
  const hasCriticalFlaw = report.decisionQuality?.hasCriticalFlaw === true;
  const qualityAcceptable = !hasCriticalFlaw;
  conditions.push({
    condition: "决策质量 — 无致命缺陷",
    met: qualityAcceptable,
    detail: qualityAcceptable
      ? `评分: ${report.decisionQuality?.score || "N/A"}`
      : `存在致命缺陷: ${(report.decisionQuality?.flaws || []).join(", ")}`,
  });
  if (!qualityAcceptable) {
    blockers.push({ blocker: "决策质量存在致命缺陷", severity: "CRITICAL", source: 1,
      detail: `缺陷: ${(report.decisionQuality?.flaws || []).join(", ")}`, neededFrom: "方案制定者" });
  }

  // Condition 2: 工程困难
  const reposOk = report.engineeringDifficulty?.reposAccessible !== false;
  const servicesOk = report.engineeringDifficulty?.servicesAvailable !== false;
  const dataOk = report.engineeringDifficulty?.dataAccessible !== false;
  const engFeasible = reposOk && servicesOk && dataOk;
  conditions.push({
    condition: "工程困难 — 仓库/服务/数据可及",
    met: engFeasible,
    detail: engFeasible
      ? `仓库可及: ${reposOk}, 服务可用: ${servicesOk}, 数据可达: ${dataOk}`
      : `阻塞项: ${(report.engineeringDifficulty?.blockers || []).join(", ")}`,
  });
  if (!engFeasible) {
    const engBlockers = report.engineeringDifficulty?.blockers || [];
    const deps = report.engineeringDifficulty?.dependencies || [];
    blockers.push({
      blocker: "工程困难不可缓解", severity: "HIGH", source: 2,
      detail: engBlockers.length > 0 || deps.length > 0
        ? `阻塞: ${engBlockers.join(", ")}; 依赖: ${deps.join(", ")}`
        : "仓库/服务/数据至少一项不可及",
    });
  }

  // Condition 3: 知识价值
  const gainSpecified = !!report.knowledgeValue?.expectedCognitiveGain;
  const artifactsPlan = report.knowledgeValue?.artifactsReusable !== false;
  const valuable = gainSpecified && artifactsPlan;
  conditions.push({
    condition: "知识价值 — 认知增量明确且产出可复用",
    met: valuable,
    detail: valuable
      ? `预期增量: ${report.knowledgeValue?.expectedCognitiveGain || "N/A"}`
      : `${gainSpecified ? "" : "认知增量未明确; "}${artifactsPlan ? "" : "产出物不可复用"}`,
  });
  if (!valuable) {
    blockers.push({
      blocker: "知识价值不明确", severity: "MEDIUM", source: 3,
      detail: `${gainSpecified ? "" : "认知增量未描述; "}${artifactsPlan ? "" : "产出物复用性低"}`,
    });
  }

  // Verdict
  const allSufficientMet = conditions.every((c) => c.met);
  const hasCriticalBlocker = blockers.some((b) => b.severity === "CRITICAL");

  const verdict: "SUFFICIENT" | "INSUFFICIENT" = allSufficientMet ? "SUFFICIENT" : "INSUFFICIENT";

  const assessment: Assessment = {
    decisionQuality: qualityAcceptable ? "达标" : "不达标",
    engineeringDifficulty: engFeasible ? "可及" : "不可及",
    knowledgeValue: valuable ? "明确" : "不明确",
  };

  const recommendedNextStep = verdict === "SUFFICIENT"
    ? "信号充分，可以推进。建议创建 SESSION 并启动实施。"
    : hasCriticalBlocker
      ? `存在 ${blockers.filter((b) => b.severity === "CRITICAL").length} 个致命阻塞项，需解决后重新评估。`
      : "信号不足，补充信息后重新运行 compass-tool judge。";

  return { issueId, verdict, blockers, assessment, recommendedNextStep, conditionsMet: conditions };
}

function cmdJudge(signalReportPath: string): void {
  const report = loadJsonFile<SignalReport>(signalReportPath, "REPORT_FILE_NOT_FOUND", "REPORT_FORMAT_INVALID");
  const result = evaluateSignal(report);

  process.stdout.write(`\n🧭 方向判断 — 3 通道评估\n`);
  process.stdout.write(`=========================\n`);
  process.stdout.write(`Issue: ${result.issueId}\n`);
  process.stdout.write(`结论: ${result.verdict === "SUFFICIENT" ? "✅ SUFFICIENT" : "❌ INSUFFICIENT"}\n`);
  process.stdout.write(`\n评估维度:\n`);
  process.stdout.write(`  决策质量: ${result.assessment.decisionQuality}\n`);
  process.stdout.write(`  工程困难: ${result.assessment.engineeringDifficulty}\n`);
  process.stdout.write(`  知识价值: ${result.assessment.knowledgeValue}\n`);
  process.stdout.write(`\n条件检查:\n`);
  for (const c of result.conditionsMet) {
    process.stdout.write(`  ${c.met ? "✅" : "❌"} ${c.condition}\n`);
  }
  if (result.blockers.length > 0) {
    process.stdout.write(`\n阻塞项:\n`);
    for (const b of result.blockers) {
      process.stdout.write(`  [${b.severity}] S${b.source}: ${b.blocker}\n`);
    }
  }
  process.stdout.write(`\n下一步: ${result.recommendedNextStep}\n`);

  if (result.verdict !== "SUFFICIENT") {
    // 同 VALIDATION_FAILED：避免 context 嵌套对象触发 msm-exec parseStderrError regex bug
    const blockerSummary = result.blockers
      .slice(0, 3)
      .map((b) => `[${b.severity}] ${b.blocker}`)
      .join("; ");
    throw new MsmError(
      "JUDGMENT_FAILED",
      "user",
      `方向判断: INSUFFICIENT (${result.blockers.length} 个阻塞项)`,
      { issueId: result.issueId, blockerCount: result.blockers.length },
      `解决阻塞项: ${blockerSummary || "(无)"}。补充信息后重新运行 compass-tool judge`,
    );
  }
}

// ── 业务协议 flag 拒绝（v0.2 §10.4：业务 msm 不接受 --json/--format/--help/--log）──

function rejectProtocolFlags(args: string[]): void {
  for (const arg of args) {
    if (arg === "--json" || arg === "--format" || arg.startsWith("--format=") || arg === "--help" || arg === "-h" || arg === "--log") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受协议 flag: ${arg}`,
        {
          arg,
          validSubcommands: ["validate", "judge"],
          validBusinessFlags: [],
        },
        "使用 msm_exec --help compass-tool 查看用法（业务 msm 只接受位置参数 <file>，不接受 --json/--format/--help/--log 等协议 flag）",
      );
    }
    if (arg.startsWith("--") && arg !== "--") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受 flag: ${arg}`,
        { arg, validSubcommands: ["validate", "judge"] },
        "validate/judge 子命令只接受 1 个位置参数 <report-file>，不接受任何 flag",
      );
    }
    if (arg.startsWith("-") && arg.length === 2 && arg !== "--") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受缩写 flag: ${arg}（v0.2 §10.4 必须 --全名）`,
        { arg },
        "将缩写替换为全名 flag 或位置参数",
      );
    }
  }
}

// ── Main router（唯一的 process.exit 处）──

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "缺少子命令",
      { receivedArgs: argv, validSubcommands: ["validate", "judge"] },
      "用法: compass-tool <validate|judge> <report-file>（使用 msm_exec --help compass-tool 查看详细）",
    );
  }

  // 拒绝协议 flag 出现在 args 任意位置（业务 msm 不感知 msm_exec）
  rejectProtocolFlags(argv);

  const subcommand = argv[0];
  const subArgs = argv.slice(1);

  // 业务 msm 不接受位置参数之外的参数
  if (subArgs.length > 1) {
    throw new MsmError(
      "PARAMETER_INVALID_VALUE",
      "user",
      `多余位置参数: ${subArgs.slice(1).join(" ")}`,
      { received: subArgs, expected: ["<report-file>"] },
      `用法: compass-tool ${subcommand} <report-file>`,
    );
  }

  switch (subcommand) {
    case "validate": {
      if (subArgs.length === 0) {
        throw new MsmError(
          "PARAMETER_MISSING",
          "user",
          "validate 子命令需要 1 个位置参数 <report-file>",
          { receivedArgs: subArgs },
          "用法: compass-tool validate <report-file>",
        );
      }
      cmdValidate(subArgs[0]);
      process.exit(0);
      return;
    }

    case "judge": {
      if (subArgs.length === 0) {
        throw new MsmError(
          "PARAMETER_MISSING",
          "user",
          "judge 子命令需要 1 个位置参数 <signal-report-file>",
          { receivedArgs: subArgs },
          "用法: compass-tool judge <signal-report-file>",
        );
      }
      cmdJudge(subArgs[0]);
      process.exit(0);
      return;
    }

    default:
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `未知子命令: ${subcommand}`,
        { subcommand, validSubcommands: ["validate", "judge"] },
        "用法: compass-tool <validate|judge> <report-file>",
      );
  }
}

try {
  main();
} catch (err) {
  if (err instanceof MsmError) {
    emitError(err);
    process.exit(err.exitCode());
  }
  // 完全未预期的错误（如代码 bug）
  const e = err instanceof Error ? err : new Error(String(err));
  const fallback = new MsmError(
    "INTERNAL_UNHANDLED_STATE",
    "internal",
    `未预期的异常: ${e.message}`,
    { stack: e.stack },
    `请向 Agent 报告此 bug（附带错误: ${e.message}）`,
    e,
  );
  emitError(fallback);
  process.exit(fallback.exitCode());
}
