#!/usr/bin/env npx tsx
/**
 * sqc-tool.ts — SQC 品质循环统一工具 (4→1)
 *
 * Semi-Mech（半机械）：
 *   check               — 确定性检查 (DC-1~4) + GP-4 模板合规检查 (Mech)
 *   report              — Stage 4 验证报告生成 (Mech)
 *   pipeline            — 5 阶段全流水线编排 (Semi-Mech：Stage 1-3 需 Agent 手动执行)
 *
 * subcommands:
 *   check deterministic <extractions-file>    DC-1~4 确定性检查
 *   check template <extractions-file>         GP-4 模板合规检查
 *   check both <extractions-file>             确定性 + 模板 全检查
 *   report <run-dir> [--commit-if-good] [--dry-run]
 *   pipeline [--stage <N>] [--resume <dir>]
 *
 * 用法：
 *   npx tsx sqc-tool.ts check deterministic <extractions.json>
 *   npx tsx sqc-tool.ts check template <extractions.json>
 *   npx tsx sqc-tool.ts check both <extractions.json>
 *   npx tsx sqc-tool.ts report <run-dir> [--commit-if-good] [--dry-run]
 *   npx tsx sqc-tool.ts pipeline [--stage <N>] [--resume <dir>]
 *
 * 退出码（参见 msm-writing-standards.md §5.3 命名空间）：
 *   0 — 成功
 *   1 — user（缺必填参数 / 未知子命令 / 拒绝协议 flag / 子命令内部 action 错 / 报告缺参数）
 *   2 — system（提取文件不存在 / 解析失败 / git 命令失败 / 运行目录不存在）
 *   4 — internal（兜底）
 *
 * 输出：
 *   - 成功：stdout 文本（人类可读）
 *   - 失败：stderr 6 字段 schema（msm-writing-standards.md §5.5）
 *
 * 错误码（参见 msm-writing-standards.md §8 字典）：
 *   - PARAMETER_MISSING              user   缺必填参数
 *   - PARAMETER_INVALID_VALUE        user   未知子命令 / 拒绝协议 flag
 *   - EXTRACTIONS_FILE_NOT_FOUND     system 提取文件不存在
 *   - EXTRACTIONS_FORMAT_INVALID     system 提取 JSON 解析失败 / 顶层非数组
 *   - RUN_DIR_NOT_FOUND              system 运行目录不存在
 *   - RUN_DIR_FORMAT_INVALID         system 运行目录缺 00-state.json / 解析失败
 *   - GIT_DIFF_FAILED                system git diff 失败（best effort，记录但不中断）
 *   - CHECK_FAILED                   user   check 检查出 issues
 *   - REPORT_FAILED                  system 报告生成失败
 *   - PIPELINE_FAILED                system pipeline 编排失败
 *   - INTERNAL_UNHANDLED_STATE       internal 兜底
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
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
    // v0.1 §5.5 6 字段 schema: code/category/message/cause/remediation/context
    // msm-exec parseStderrError 6/6 严格匹配 — 始终输出所有 6 字段
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

// ============================================================
// Types
// ============================================================

interface ExtractionEntry {
  skill_name: string;
  file_path: string;
  sections: string[];
  cross_references: string[];
  has_loading_condition: boolean;
  loading_condition_summary: string;
  has_related_skills: boolean;
  related_skills_list: string[];
}

interface Issue {
  check: string;
  skill_name: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  description: string;
  fixable: boolean;
}

interface DeterministicReport {
  timestamp: string;
  totalSkills: number;
  issues: Issue[];
  dc1BrokenRefs: number;
  dc2OrphanSkills: number;
  dc3MissingLoading: number;
  dc4MissingRelated: number;
}

interface SectionCheck {
  label: string;
  found: boolean;
  matchedSection?: string;
}

interface SkillResult {
  skill_name: string;
  file_path: string;
  required: SectionCheck[];
  recommended: SectionCheck[];
  allRequiredPresent: boolean;
  missingCount: number;
}

interface TemplateReport {
  timestamp: string;
  totalSkills: number;
  results: SkillResult[];
  compliantCount: number;
  nonCompliantCount: number;
  summary: string;
}

interface FixEntry {
  fix_id?: string;
  status: string;
  severity?: string;
  file?: string;
  error?: string;
}

interface ReportData {
  timestamp: string;
  runDir: string;
  dryRun: boolean;
  totalFixes: number;
  successCount: number;
  failCount: number;
  successRate: number;
  hasHighFailures: boolean;
  diffStat?: string;
  committed?: boolean;
}

interface StageState {
  stage: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  completedAt?: string;
}

interface RunState {
  runDir: string;
  currentStage: number;
  stages: StageState[];
  createdAt: string;
}

// ============================================================
// Helpers
// ============================================================

const REQUIRED_SECTIONS = [
  { patterns: [/^用途$/], label: "用途" },
  { patterns: [/^触发条件/, /^触发条件\s*\/\s*何时加载$/, /^何时加载$/], label: "触发条件" },
  { patterns: [/^相关技能$/], label: "相关技能" },
];

const RECOMMENDED_SECTIONS = [
  { patterns: [/^##\s*前提条件$/], label: "前提条件" },
  { patterns: [/^##\s*核心内容$/, /^##\s*核心内容\s*\(.*\)$/], label: "核心内容" },
];

const STAGE_NAMES = ["启动准备", "数据采集", "确定性检查", "改进设计+修复", "验证报告"];
const TOTAL_STAGES = 5;

function getOfficialSkillNames(manifestPath?: string): string[] {
  const root = findCccRoot();
  const mPath = manifestPath || join(root, ".opencode", "skills", "MANIFEST.yaml");
  if (!existsSync(mPath)) return [];
  const content = readFileSync(mPath, "utf-8");
  const names: string[] = [];
  let inSkills = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("skills:")) { inSkills = true; continue; }
    if (inSkills) {
      const match = line.match(/^  (\S+):$/);
      if (match) names.push(match[1]);
      else if (line.trim() && !line.startsWith("  ")) inSkills = false;
    }
  }
  return names;
}

function matchSection(heading: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(heading.trim()));
}

function checkSections(sections: string[], specs: { patterns: RegExp[]; label: string }[]): SectionCheck[] {
  return specs.map((spec) => {
    const found = sections.find((h) => matchSection(h, spec.patterns));
    return { label: spec.label, found: !!found, matchedSection: found || undefined };
  });
}

// ============================================================
// 加载提取文件（业务函数，抛 MsmError）
// ============================================================

function loadExtractions(extractionsPath: string): ExtractionEntry[] {
  if (!existsSync(extractionsPath)) {
    throw new MsmError(
      "EXTRACTIONS_FILE_NOT_FOUND",
      "system",
      `提取文件不存在: ${extractionsPath}`,
      { path: extractionsPath },
      "检查路径拼写；或运行 file-system exists <path> 验证",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(extractionsPath, "utf-8");
  } catch (err) {
    throw new MsmError(
      "EXTRACTIONS_FORMAT_INVALID",
      "system",
      `提取文件读取失败: ${extractionsPath}`,
      { path: extractionsPath },
      "检查文件权限",
      err,
    );
  }
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      throw new MsmError(
        "EXTRACTIONS_FORMAT_INVALID",
        "system",
        `提取 JSON 顶层不是数组: ${extractionsPath}`,
        { path: extractionsPath, topLevelType: Array.isArray(entries) ? "array" : typeof entries },
        "确保 Stage 1 输出是 ExtractionEntry[] 数组",
      );
    }
    return entries as ExtractionEntry[];
  } catch (err) {
    if (err instanceof MsmError) throw err;
    throw new MsmError(
      "EXTRACTIONS_FORMAT_INVALID",
      "system",
      `提取 JSON 解析失败: ${extractionsPath}`,
      { path: extractionsPath },
      "运行 `python3 -m json.tool < path` 验证 JSON 格式",
      err,
    );
  }
}

// ============================================================
// check 子命令 — Deterministic + Template（v0.2 拆为子子命令）
// ============================================================

type CheckSubAction = "deterministic" | "template" | "both";

function runDeterministicChecks(entries: ExtractionEntry[]): DeterministicReport {
  const officialNames = getOfficialSkillNames();
  const issues: Issue[] = [];

  for (const entry of entries) {
    const skillName = entry.skill_name || entry.file_path;
    const refs = entry.cross_references || [];

    // DC-1
    for (const ref of refs) {
      if (ref.startsWith("home-") && officialNames.length > 0 && !officialNames.includes(ref)) {
        issues.push({ check: "DC-1", skill_name: skillName, severity: "HIGH", description: `跨引用目标 "${ref}" 不在官方技能清单中`, fixable: true });
      }
    }
    // DC-3
    if (!entry.has_loading_condition) {
      issues.push({ check: "DC-3", skill_name: skillName, severity: "HIGH", description: `缺少"触发条件/何时加载"小节`, fixable: true });
    }
    // DC-4
    if (!entry.has_related_skills) {
      issues.push({ check: "DC-4", skill_name: skillName, severity: "MEDIUM", description: `缺少"相关技能"小节`, fixable: true });
    }
  }

  // DC-2
  const referencedSkills = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.cross_references || []) referencedSkills.add(ref);
    for (const rs of entry.related_skills_list || []) { if (rs) referencedSkills.add(rs); }
  }
  for (const entry of entries) {
    const name = entry.skill_name;
    if (name && !referencedSkills.has(name) && officialNames.includes(name)) {
      if (name === "{{ccc_name}}") continue;
      issues.push({ check: "DC-2", skill_name: name, severity: "MEDIUM", description: `孤儿技能: 不被任何其他技能引用`, fixable: true });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalSkills: entries.length,
    issues,
    dc1BrokenRefs: issues.filter((i) => i.check === "DC-1").length,
    dc2OrphanSkills: issues.filter((i) => i.check === "DC-2").length,
    dc3MissingLoading: issues.filter((i) => i.check === "DC-3").length,
    dc4MissingRelated: issues.filter((i) => i.check === "DC-4").length,
  };
}

function runTemplateChecks(entries: ExtractionEntry[]): TemplateReport {
  const results: SkillResult[] = entries.map((entry) => {
    const sections = entry.sections || [];
    const required = checkSections(sections, REQUIRED_SECTIONS);
    const recommended = checkSections(sections, RECOMMENDED_SECTIONS);
    const allRequiredPresent = required.every((r) => r.found);
    const missingCount = required.filter((r) => !r.found).length;
    return { skill_name: entry.skill_name, file_path: entry.file_path, required, recommended, allRequiredPresent, missingCount };
  });

  const compliant = results.filter((r) => r.allRequiredPresent);
  const nonCompliant = results.filter((r) => !r.allRequiredPresent);

  return {
    timestamp: new Date().toISOString(),
    totalSkills: entries.length,
    results,
    compliantCount: compliant.length,
    nonCompliantCount: nonCompliant.length,
    summary: `${compliant.length}/${entries.length} skills compliant, ${nonCompliant.length} skills missing required sections`,
  };
}

function printDeterministicReport(report: DeterministicReport): void {
  process.stdout.write(`\nSQC 确定性检查结果\n`);
  process.stdout.write(`========================\n`);
  process.stdout.write(`总计: ${report.totalSkills} skills\n`);
  process.stdout.write(`DC-1 跨引用断裂: ${report.dc1BrokenRefs}\n`);
  process.stdout.write(`DC-2 孤儿技能: ${report.dc2OrphanSkills}\n`);
  process.stdout.write(`DC-3 加载条件缺失: ${report.dc3MissingLoading}\n`);
  process.stdout.write(`DC-4 相关技能缺失: ${report.dc4MissingRelated}\n`);
  process.stdout.write(`总 issues: ${report.issues.length}\n`);
  for (const issue of report.issues) {
    process.stdout.write(`  [${issue.severity}] ${issue.check}: ${issue.skill_name} — ${issue.description}\n`);
  }
}

function printTemplateReport(report: TemplateReport): void {
  process.stdout.write(`\nSQC GP-4 — 模板合规检查\n`);
  process.stdout.write(`========================\n`);
  process.stdout.write(`总计: ${report.totalSkills} skills\n`);
  process.stdout.write(`合规: ${report.compliantCount}\n`);
  process.stdout.write(`不合规: ${report.nonCompliantCount}\n`);
  for (const sk of report.results.filter((r) => !r.allRequiredPresent)) {
    const missing = sk.required.filter((r) => !r.found).map((r) => r.label);
    process.stdout.write(`  - ${sk.skill_name}: 缺少 [${missing.join(", ")}]\n`);
  }
}

function cmdCheck(args: string[]): void {
  // 拒绝所有 flag
  for (const arg of args) {
    if (arg.startsWith("-")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `check 子命令不接受 flag: ${arg}（v0.2 §10.4 业务 msm 必须 --全名）`,
        { arg, validSubActions: ["deterministic", "template", "both"] },
        "用法: sqc-tool check <deterministic|template|both> <extractions-file>",
      );
    }
  }

  if (args.length < 2) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "check 子命令需要 2 个位置参数: <action> <extractions-file>",
      { receivedArgs: args, validActions: ["deterministic", "template", "both"] },
      "用法: sqc-tool check <deterministic|template|both> <extractions-file>",
    );
  }

  const subAction = args[0];
  if (subAction !== "deterministic" && subAction !== "template" && subAction !== "both") {
    throw new MsmError(
      "PARAMETER_INVALID_VALUE",
      "user",
      `check action 必须是 deterministic | template | both: ${subAction}`,
      { received: subAction, validActions: ["deterministic", "template", "both"] },
      "用法: sqc-tool check <deterministic|template|both> <extractions-file>",
    );
  }

  const extractionsPath = args[1];
  const entries = loadExtractions(extractionsPath);

  const outputObj: Record<string, unknown> = {};
  if (subAction === "deterministic" || subAction === "both") {
    outputObj.deterministic = runDeterministicChecks(entries);
  }
  if (subAction === "template" || subAction === "both") {
    outputObj.template = runTemplateChecks(entries);
  }

  // 文本模式输出
  if (outputObj.deterministic) {
    printDeterministicReport(outputObj.deterministic as DeterministicReport);
  }
  if (outputObj.template) {
    printTemplateReport(outputObj.template as TemplateReport);
  }

  const hasErrors = (outputObj.deterministic && (outputObj.deterministic as DeterministicReport).issues.length > 0) ||
                    (outputObj.template && (outputObj.template as TemplateReport).nonCompliantCount > 0);
  if (hasErrors) {
    throw new MsmError(
      "CHECK_FAILED",
      "user",
      `check ${subAction} 发现 issues`,
      {
        action: subAction,
        deterministicIssueCount: outputObj.deterministic ? (outputObj.deterministic as DeterministicReport).issues.length : 0,
        templateNonCompliant: outputObj.template ? (outputObj.template as TemplateReport).nonCompliantCount : 0,
      },
      "查看 stdout 中标注的 issues；修复后重跑",
    );
  }
}

// ============================================================
// report 子命令 — Stage 4 report generation
// ============================================================

function tryLoadFixes(applyResultsPath: string): { fixes: FixEntry[]; loadError?: MsmError } {
  if (!existsSync(applyResultsPath)) {
    return { fixes: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(applyResultsPath, "utf-8"));
    return { fixes: parsed.fixes || [] };
  } catch (err) {
    // v0.1 §5.7 修复：原 L397 `catch { /* ignore */ }` 是严格静默
    // 修复：emit error 到 stderr，但流程继续（apply-results 损坏是 best effort）
    const cause = err instanceof Error ? err.message : String(err);
    const loadError = new MsmError(
      "RUN_DIR_FORMAT_INVALID",
      "system",
      `apply-results 解析失败: ${applyResultsPath}`,
      { path: applyResultsPath },
      "检查 03-apply-results.json 是否被外部修改损坏；将按空 fixes 列表继续",
      err,
    );
    emitError(loadError);
    return { fixes: [], loadError };
  }
}

function tryGitDiff(root: string, runDir: string, dryRun: boolean): string {
  if (dryRun) return "";
  try {
    const diffStat = execSync("git diff --stat", { encoding: "utf-8", cwd: root });
    writeFileSync(join(runDir, "_git-diff-stat.txt"), diffStat, "utf-8");
    return diffStat;
  } catch (err) {
    // v0.1 §5.7 修复：原 L412 `catch { /* ignore */ }` 是严格静默
    // 修复：emit error 到 stderr，但报告继续（无 diff 也应能生成报告）
    const cause = err instanceof Error ? err.message : String(err);
    const gitErr = new MsmError(
      "GIT_DIFF_FAILED",
      "system",
      `git diff 失败: ${root}`,
      { cwd: root },
      "检查 git 仓库状态；报告将继续（无 diff 段）",
      err,
    );
    emitError(gitErr);
    writeFileSync(join(runDir, "_git-diff-stat.txt"), `(git diff failed: ${cause})\n`, "utf-8");
    return "";
  }
}

function tryAutoCommit(root: string, successRate: number, hasHighFailures: boolean, totalFixes: number, dryRun: boolean): boolean | undefined {
  if (dryRun) {
    if (successRate > 0.8 && !hasHighFailures && totalFixes > 0) {
      process.stdout.write(`[DRY RUN] 条件满足 (修复率 ${(successRate * 100).toFixed(1)}%), 将执行 git commit\n`);
    }
    return undefined;
  }
  if (!(successRate > 0.8 && !hasHighFailures && totalFixes > 0)) {
    return undefined;
  }
  try {
    execSync("git add -A", { encoding: "utf-8", cwd: root });
    const dateStr = new Date().toISOString().slice(0, 10);
    execSync(`git commit -m "sqc: auto quality improvements ${dateStr}"`, { encoding: "utf-8", cwd: root });
    process.stdout.write(`自动 commit 成功\n`);
    return true;
  } catch (err) {
    // v0.1 §5.7 修复：原 L659 catch 块 console.log → stderr
    const cause = err instanceof Error ? err.message : String(err);
    const commitErr = new MsmError(
      "REPORT_FAILED",
      "system",
      `自动 commit 失败: ${cause}`,
      { cwd: root },
      "手动运行 git commit；或检查 git 状态（pre-commit hook 拒绝、dirty 等）",
      err,
    );
    emitError(commitErr);
    return false;
  }
}

function cmdReport(args: string[]): void {
  // 拒绝协议 flag + 收集业务 flag
  let commitIfGood = false;
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--commit-if-good") {
      commitIfGood = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json" || arg === "--format" || arg.startsWith("--format=") || arg === "--help" || arg === "-h" || arg === "--log") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受协议 flag: ${arg}`,
        { arg, validBusinessFlags: ["--commit-if-good", "--dry-run"] },
        "使用 msm_exec --help sqc-tool 查看用法",
      );
    } else if (arg.startsWith("--")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `未知业务 flag: ${arg}`,
        { arg, validBusinessFlags: ["--commit-if-good", "--dry-run"] },
        "用法: sqc-tool report <run-dir> [--commit-if-good] [--dry-run]",
      );
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "report 子命令需要 1 个位置参数 <run-dir>",
      { receivedArgs: args },
      "用法: sqc-tool report <run-dir> [--commit-if-good] [--dry-run]",
    );
  }
  const runDir = positional[0];

  if (!existsSync(runDir)) {
    throw new MsmError(
      "RUN_DIR_NOT_FOUND",
      "system",
      `运行目录不存在: ${runDir}`,
      { runDir },
      "检查 runDir 路径；或对一个新 pipeline 任务使用 'sqc-tool pipeline'",
    );
  }

  const root = findCccRoot();

  // 读取 apply results（best effort）
  const applyResultsPath = join(runDir, "03-apply-results.json");
  const { fixes } = tryLoadFixes(applyResultsPath);

  const totalFixes = fixes.length;
  const successCount = fixes.filter((f) => f.status === "SUCCESS").length;
  const failCount = fixes.filter((f) => f.status !== "SUCCESS").length;
  const successRate = totalFixes > 0 ? successCount / totalFixes : 1;
  const hasHighFailures = fixes.some((f) => f.status !== "SUCCESS" && f.severity === "HIGH");

  // git diff (best effort, 不中断)
  const diffStat = tryGitDiff(root, runDir, dryRun);

  // 生成 markdown report
  const reportLines: string[] = [
    `# SQC 质量报告 — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `## 修复统计`,
    `- 总计修复: ${totalFixes}`,
    `- 成功: ${successCount}`,
    `- 失败: ${failCount}`,
    `- 修复率: ${(successRate * 100).toFixed(1)}%`,
    ``,
  ];
  if (fixes.length > 0) {
    reportLines.push(`## 详细结果`);
    for (const fix of fixes) {
      reportLines.push(`- ${fix.fix_id || "?"}: ${fix.status}${fix.error ? ` — ${fix.error}` : ""}`);
    }
    reportLines.push(``);
  }
  if (diffStat) {
    reportLines.push(`## 变更统计`);
    reportLines.push("```");
    reportLines.push(diffStat);
    reportLines.push("```");
    reportLines.push(``);
  }

  if (!dryRun) {
    writeFileSync(join(runDir, "04-report.md"), reportLines.join("\n"), "utf-8");
    process.stdout.write(`报告已写入: ${join(runDir, "04-report.md")}\n`);
  }

  // Auto commit
  const committed = tryAutoCommit(root, successRate, hasHighFailures, totalFixes, dryRun);

  const report: ReportData = {
    timestamp: new Date().toISOString(),
    runDir,
    dryRun,
    totalFixes,
    successCount,
    failCount,
    successRate,
    hasHighFailures,
    diffStat,
    committed,
  };

  const prefix = dryRun ? "[DRY RUN] " : "";
  process.stdout.write(`\n${prefix}Stage 4: 验证与报告\n`);
  process.stdout.write(`  修复率: ${(successRate * 100).toFixed(1)}% (${successCount}/${totalFixes})\n`);
  process.stdout.write(`  自动 commit: ${committed === true ? "yes" : committed === false ? "no" : "未请求"}\n`);
}

// ============================================================
// pipeline 子命令 — 5-stage pipeline orchestration
// ============================================================

function pipelineCreateRunState(root: string): RunState {
  const sqcDir = join(root, "AGENT_SESSIONS", "_sqc-runs");
  if (!existsSync(sqcDir)) mkdirSync(sqcDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const existingRuns = readdirSync(sqcDir).filter((d) => d.includes("--sqc-run-"));
  const runIndex = existingRuns.length;
  const runDirName = `${dateStr}--sqc-run-${runIndex}`;
  const runDir = join(sqcDir, runDirName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(sqcDir, ".current-run-path"), runDir, "utf-8");

  const stages: StageState[] = Array.from({ length: TOTAL_STAGES }, (_, i) => ({
    stage: i, name: STAGE_NAMES[i], status: "pending" as const,
  }));

  const state: RunState = { runDir, currentStage: 0, stages, createdAt: new Date().toISOString() };
  writeFileSync(join(runDir, "00-state.json"), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

function pipelineLoadState(runDir: string): RunState {
  const statePath = join(runDir, "00-state.json");
  if (!existsSync(statePath)) {
    throw new MsmError(
      "RUN_DIR_NOT_FOUND",
      "system",
      `运行目录缺少 00-state.json: ${runDir}`,
      { runDir },
      "检查 runDir 路径；或对一个新 pipeline 任务省略 --resume",
    );
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch (err) {
    throw new MsmError(
      "RUN_DIR_FORMAT_INVALID",
      "system",
      `00-state.json JSON 解析失败: ${statePath}`,
      { runDir, statePath },
      "检查 00-state.json 是否被外部修改损坏",
      err,
    );
  }
}

function pipelineSaveState(state: RunState): void {
  writeFileSync(join(state.runDir, "00-state.json"), JSON.stringify(state, null, 2), "utf-8");
}

function pipelineCompleteStage(state: RunState, s: number): void {
  if (state.stages[s]) {
    state.stages[s].status = "completed";
    state.stages[s].completedAt = new Date().toISOString();
  }
  state.currentStage = Math.min(s + 1, TOTAL_STAGES);
  pipelineSaveState(state);
}

// Stage 0: 启动准备（业务函数）
function pipelineStage0(state: RunState, root: string): void {
  process.stdout.write(`[Stage 0] ${STAGE_NAMES[0]}...\n`);

  // v0.1 §5.7 修复：原 L561/L565 错误埋入文件是简略文本
  // 修复：catch 块用 6 字段 schema 格式（code/category/message/cause/context）写入
  try {
    const gitLog = execSync("git log --oneline -5", { encoding: "utf-8", cwd: root });
    writeFileSync(join(state.runDir, "_git-log.txt"), gitLog, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const errorEntry = new MsmError(
      "GIT_LOG_FAILED",
      "system",
      "git log 失败",
      { cwd: root, runDir: state.runDir },
      "检查 git 仓库状态",
      err,
    );
    // 写入文件用 §5.5 schema（agent 后续读取可解析）
    writeFileSync(join(state.runDir, "_git-log.txt"), `${errorEntry.toStderr()}\n`, "utf-8");
  }
  try {
    const gitStatus = execSync("git status --short", { encoding: "utf-8", cwd: root });
    writeFileSync(join(state.runDir, "_git-status.txt"), gitStatus, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const errorEntry = new MsmError(
      "GIT_DIFF_FAILED",
      "system",
      "git status 失败",
      { cwd: root, runDir: state.runDir },
      "检查 git 仓库状态",
      err,
    );
    writeFileSync(join(state.runDir, "_git-status.txt"), `${errorEntry.toStderr()}\n`, "utf-8");
  }

  const skillsDir = join(root, ".opencode", "skills");
  let skillDirs: string[] = [];
  if (existsSync(skillsDir)) {
    skillDirs = readdirSync(skillsDir)
      .filter((d) => d.startsWith("home-") || d === "eap")
      .map((d) => d);
    writeFileSync(join(state.runDir, "_skill-dirs.txt"), skillDirs.map((d) => `.opencode/skills/${d}/`).join("\n"), "utf-8");
  }

  const inventory = skillDirs.map((dir) => {
    const skillPath = join(skillsDir, dir);
    return { dir, hasSKILL: existsSync(join(skillPath, "SKILL.md")), hasReferences: existsSync(join(skillPath, "references")), hasScripts: existsSync(join(skillPath, "scripts")) };
  });
  writeFileSync(join(state.runDir, "00-inventory.json"), JSON.stringify(inventory, null, 2), "utf-8");

  process.stdout.write(`  Skill 清单: ${inventory.length} 技能\n`);
  process.stdout.write(`  Git 状态已记录\n`);
  process.stdout.write(`  运行目录: ${state.runDir}\n`);
}

function pipelineStageInstructions(state: RunState, s: number): void {
  const instructions: Record<number, string> = {
    1: `\n[Stage 1] ${STAGE_NAMES[1]} — 操作指令
  ========================
  1. Read 00-state.json → 技能列表
  2. 将技能按 3-4 个一组分桶
  3. 每批 spawn sub-agent (Task 工具)
  4. Prompt: 读取并提取 SKILL.md 内容:
     - skill_name, file_path, sections, cross_references
     - has_loading_condition, loading_condition_summary
     - has_related_skills, related_skills_list
  5. 合并结果 → ${state.runDir}/01-extractions.json`,
    2: `\n[Stage 2] ${STAGE_NAMES[2]} — 操作指令
   ========================
   1. Run structural checks: \`sqc-tool check both ${state.runDir}/01-extractions.json\`
   2. Run DC-5 (EAP content quality evaluation): for each skill, Agent reads the
      SKILL.md and evaluates 6 EAP items (variable definition, relationship encoding,
      context independence, boundary specification, constraint listing, ambiguity).
      See SKILL.md §DC-5 for full checklist.
   3. Merge all issues → ${state.runDir}/02-issues.json`,
    3: `\n[Stage 3] ${STAGE_NAMES[3]} — 操作指令
  ========================
  1. Read 02-issues.json
  2. 筛选 fixable=true 的 issue
  3. 对每个生成 fix 规格: file, old_string, new_string
  4. 先 grep 验证 old_string 存在
  5. 应用修复 (edit 工具)
  6. 写入结果 → ${state.runDir}/03-apply-results.json`,
  4: `\n[Stage 4] ${STAGE_NAMES[4]} — 操作指令
  ========================
  1. 运行 \`sqc-tool report ${state.runDir}\``,
  };
  process.stdout.write(instructions[s] || "");
}

function pipelineStage4(state: RunState, root: string): void {
  process.stdout.write(`[Stage 4] ${STAGE_NAMES[4]}...\n`);
  const applyPath = join(state.runDir, "03-apply-results.json");
  const { fixes } = tryLoadFixes(applyPath);
  const totalCount = fixes.length;
  const successCount = fixes.filter((f) => f.status === "SUCCESS").length;
  const hasHighFailures = fixes.some((f) => f.status !== "SUCCESS" && f.severity === "HIGH");
  const successRate = totalCount > 0 ? successCount / totalCount : 1;

  // v0.1 §5.7 修复：原 L639 git diff 静默 catch → emit error
  try {
    const diffStat = execSync("git diff --stat", { encoding: "utf-8", cwd: root });
    writeFileSync(join(state.runDir, "_git-diff-stat.txt"), diffStat, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const gitErr = new MsmError(
      "GIT_DIFF_FAILED",
      "system",
      `Stage 4 git diff 失败: ${root}`,
      { cwd: root },
      "检查 git 仓库状态；报告将继续（无 diff 段）",
      err,
    );
    emitError(gitErr);
    writeFileSync(join(state.runDir, "_git-diff-stat.txt"), `(git diff failed: ${cause})\n`, "utf-8");
  }

  const report = [
    `# SQC 质量报告 — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `## 修复统计`,
    `- 总计: ${totalCount}`,
    `- 成功: ${successCount}`,
    `- 失败: ${totalCount - successCount}`,
    `- 修复率: ${(successRate * 100).toFixed(1)}%`,
    ``,
  ];
  writeFileSync(join(state.runDir, "04-report.md"), report.join("\n"), "utf-8");

  if (successRate > 0.8 && !hasHighFailures && totalCount > 0) {
    try {
      execSync("git add -A", { encoding: "utf-8", cwd: root });
      const dateStr = new Date().toISOString().slice(0, 10);
      execSync(`git commit -m "sqc: auto quality improvements ${dateStr}"`, { encoding: "utf-8", cwd: root });
      process.stdout.write(`  自动 commit 成功\n`);
    } catch {
      // best effort: git commit 失败不应中断 pipeline
      process.stdout.write(`  自动 commit: 无变更或失败\n`);
    }
  }

  process.stdout.write(`  报告已写入: 04-report.md\n`);
  process.stdout.write(`  修复率: ${(successRate * 100).toFixed(1)}%\n`);
}

function cmdPipeline(args: string[]): void {
  let stage: number | undefined;
  let resumeDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stage") {
      if (i + 1 >= args.length) {
        throw new MsmError(
          "PARAMETER_MISSING",
          "user",
          "--stage 需要 1 个值 <N>",
          { received: "<missing>" },
          "用法: sqc-tool pipeline [--stage <N>] [--resume <dir>]",
        );
      }
      const v = parseInt(args[++i], 10);
      if (isNaN(v) || v < 0 || v >= TOTAL_STAGES) {
        throw new MsmError(
          "PARAMETER_INVALID_VALUE",
          "user",
          `--stage 必须是 0-${TOTAL_STAGES - 1} 整数: ${args[i]}`,
          { received: args[i], validRange: `0-${TOTAL_STAGES - 1}` },
          `用法: sqc-tool pipeline [--stage <0-${TOTAL_STAGES - 1}>] [--resume <dir>]`,
        );
      }
      stage = v;
    } else if (arg === "--resume") {
      if (i + 1 >= args.length) {
        throw new MsmError(
          "PARAMETER_MISSING",
          "user",
          "--resume 需要 1 个值 <dir>",
          { received: "<missing>" },
          "用法: sqc-tool pipeline [--stage <N>] --resume <dir>",
        );
      }
      resumeDir = args[++i];
    } else if (arg === "--json" || arg === "--format" || arg.startsWith("--format=") || arg === "--help" || arg === "-h" || arg === "--log") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受协议 flag: ${arg}`,
        { arg, validBusinessFlags: ["--stage", "--resume"] },
        "使用 msm_exec --help sqc-tool 查看用法",
      );
    } else if (arg.startsWith("--")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `未知业务 flag: ${arg}`,
        { arg, validBusinessFlags: ["--stage", "--resume"] },
        "用法: sqc-tool pipeline [--stage <N>] [--resume <dir>]",
      );
    } else {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `pipeline 不接受位置参数: ${arg}`,
        { arg },
        "用法: sqc-tool pipeline [--stage <N>] [--resume <dir>]",
      );
    }
  }

  const root = findCccRoot();

  let state: RunState;
  if (resumeDir) {
    state = pipelineLoadState(resumeDir);
  } else {
    state = pipelineCreateRunState(root);
  }

  const startStage = stage !== undefined ? stage : state.currentStage;

  process.stdout.write(`\nSQC 品质循环 — ${state.runDir}\n`);
  process.stdout.write(`从 Stage ${startStage} 开始\n`);
  process.stdout.write(`===============================\n\n`);

  for (let s = startStage; s < TOTAL_STAGES; s++) {
    switch (s) {
      case 0: pipelineStage0(state, root); pipelineCompleteStage(state, 0); break;
      case 1: pipelineStageInstructions(state, 1); break;
      case 2: pipelineStageInstructions(state, 2); break;
      case 3: pipelineStageInstructions(state, 3); break;
      case 4: pipelineStage4(state, root); pipelineCompleteStage(state, 4); break;
    }
    if (s >= 1 && s <= 3) {
      process.stdout.write(`\n  Stage ${s} 需 Agent 手动执行。完成后恢复:\n`);
      process.stdout.write(`     sqc-tool pipeline --resume ${state.runDir} --stage ${s + 1}\n`);
      break;
    }
  }

  if (state.currentStage >= TOTAL_STAGES) {
    process.stdout.write(`\nSQC 品质循环全部完成\n`);
  }
}

// ── 业务协议 flag 拒绝（v0.2 §10.4）──

function rejectProtocolFlags(args: string[]): void {
  for (const arg of args) {
    if (arg === "--json" || arg === "--format" || arg.startsWith("--format=") || arg === "--help" || arg === "-h" || arg === "--log" || arg === "--output") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `业务 msm 不接受协议 flag: ${arg}`,
        { arg, validSubcommands: ["check", "report", "pipeline"] },
        "使用 msm_exec --help sqc-tool 查看用法（业务 msm 不接受 --json/--format/--help/--log/--output 等协议 flag）",
      );
    }
  }
}

// ── Main router（唯一的 process.exit 处）──

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "缺少子命令",
      { receivedArgs: args, validSubcommands: ["check", "report", "pipeline"] },
      "用法: sqc-tool <check|report|pipeline> [args...]（使用 msm_exec --help sqc-tool 查看详细）",
    );
  }

  rejectProtocolFlags(args);

  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "check": {
      cmdCheck(rest);
      process.exit(0);
      return;
    }
    case "report": {
      cmdReport(rest);
      process.exit(0);
      return;
    }
    case "pipeline": {
      cmdPipeline(rest);
      process.exit(0);
      return;
    }
    default:
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `未知子命令: ${cmd}`,
        { subcommand: cmd, validSubcommands: ["check", "report", "pipeline"] },
        "用法: sqc-tool <check|report|pipeline> [args...]",
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
    "请向 Agent 报告此 bug",
    e,
  );
  emitError(fallback);
  process.exit(fallback.exitCode());
}
