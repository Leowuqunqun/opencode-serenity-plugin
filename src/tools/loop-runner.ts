#!/usr/bin/env node
/**
 * loop-runner.ts — Loop tool 外部进程
 *
 * 由 loop tool 通过 child_process.spawn 启动，在独立进程中
 * 通过 opencode serve headless API 驱动 LLM 循环执行。
 *
 * 始终为新循环启动专用 opencode serve，结束时自动清理。
 *
 * 用法: loop-runner.ts <stop-token> <port> [label] [cwd-root]
 *   stdin: 第 1 轮的 prompt 文本
 *   stdout: 每轮 JSON 进度行 + 最终 JSON 结果
 *   stderr: 日志信息
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { spawn, execSync, execFileSync } from "node:child_process";

const STOP_TOKEN = process.argv[2];
const PORT = parseInt(process.argv[3] ?? "0", 10);
const LABEL = process.argv[4]?.trim() || "task";
const CWD_ROOT = process.argv[5] || "";
const MODEL = (process.argv[6] ?? "").replace(/^''$/g, "").trim();
const SESSION_ID = (process.argv[7] ?? "").replace(/^''$/g, "").trim();
const SESSION_DIR = (process.argv[8] ?? "").replace(/^''$/g, "").trim();

if (!STOP_TOKEN || !PORT) {
  process.stderr.write("  usage: loop-runner.ts <stop-token> <port> [label] [cwd-root] [model] [session-id] [session-dir] [session-title]\n");
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}`;
const PID_DIR = "/tmp/serenity-bg-task";

// 进度文件：如果指定了 SESSION 目录则放入其中，否则放 AGENT_SESSIONS/
const progressDir = SESSION_DIR || (CWD_ROOT ? `${CWD_ROOT}/AGENT_SESSIONS` : "");
const PROGRESS_FILE = progressDir ? `${progressDir}/loop-${LABEL}.md` : "";
const STATUS_FILE = progressDir ? `${progressDir}/loop-${LABEL}.json` : "";
let serveProc: ReturnType<typeof spawn> | null = null;

// ── 状态文件 ──

function writeStatus(round: number, done: boolean, response: string, status?: string): void {
  if (!STATUS_FILE) return;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({
      label: LABEL,
      round,
      done,
      status: status ?? (done ? "done" : "running"),
      response: response.slice(0, 200),
      updatedAt: Date.now(),
    }));
  } catch {}
}
function writeFailedStatus(code: string, message: string): void {
  if (!STATUS_FILE) return;
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({
      label: LABEL,
      round: 0,
      done: true,
      status: "failed",
      errorCode: code,
      errorMessage: message.slice(0, 200),
      response: "",
      updatedAt: Date.now(),
    }));
  } catch {}
}

// ── 错误类 ──

class LoopError extends Error {
  constructor(public code: string, message: string, public ctx: Record<string, unknown> = {}) {
    super(message);
    this.name = "LoopError";
  }
}

// ── 模型验证 ──

function validateModel(model: string): void {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    log(`无效模型格式: "${model}" (应为 provider/model)`);
    process.stderr.write(`[loop] 错误: 模型格式无效 "${model}"。格式应为 provider/model (如 deepseek/deepseek-v4-flash)\n`);
    process.exit(1);
  }

  log(`验证模型可用性: ${model}`);
  let modelsOutput: string;
  try {
    modelsOutput = execSync("opencode models", { encoding: "utf-8", timeout: 15000 });
  } catch {
    log("警告: 无法执行 opencode models 验证模型");
    return; // fail-open: 无法验证时继续
  }

  const lines = modelsOutput.split("\n").map(l => l.trim()).filter(Boolean);
  const found = lines.some(l => l === model);
  if (!found) {
    const hint = lines
      .filter(l => l.includes(model.split("/")[1] || ""))
      .slice(0, 5);
    const hintMsg = hint.length
      ? `\n  相近模型:\n    ${hint.join("\n    ")}`
      : `\n  可用模型数: ${lines.length} (用 opencode models 查看完整列表)`;
    process.stderr.write(
      `[loop] 错误: 模型 "${model}" 不可用。` +
      `请确认该 provider 已配置且有有效 API key。${hintMsg}\n`
    );
    process.exit(1);
  }
  log(`模型验证通过: ${model}`);
}

// ── 日志 ──

function log(msg: string): void {
  process.stderr.write(`[loop] ${msg}\n`);
}

// ── 清理 ──

function cleanupServe(): void {
  if (serveProc && serveProc.pid) {
    try { serveProc.kill("SIGTERM"); } catch {}
    serveProc = null;
  }
  try { unlinkSync(pidFile(PORT)); } catch {}
}

// 确保 runner 退出时 serve 也被清理
process.on("exit", cleanupServe);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// ── Server 生命周期 ──

function findOpenCodeBin(): string {
  const candidates = [
    "/home/yh/.opencode/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const out = execSync("which opencode", { encoding: "utf-8" });
    return out.trim();
  } catch {
    throw new LoopError("SERVER_BIN_NOT_FOUND", "找不到 opencode 二进制，请确认已安装");
  }
}

function pidFile(port: number): string {
  return `${PID_DIR}/server-${port}.pid`;
}

function logFile(port: number): string {
  return `${PID_DIR}/server-${port}.log`;
}

function startServer(port: number): void {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  const bin = findOpenCodeBin();
  const lf = logFile(port);
  const fd = openSync(lf, "a");

  const args = ["serve", "--port", String(port), "--hostname", "0.0.0.0"];
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // 注入模型覆盖（OPENCODE_CONFIG_CONTENT）
  if (MODEL) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: MODEL });
    log(`使用模型: ${MODEL} (OPENCODE_CONFIG_CONTENT)`);
  }

  log(`启动 opencode serve (${bin}) --port ${port}`);
  serveProc = spawn(bin, args, {
    stdio: ["ignore", fd, fd],
    env,
  });
  writeFileSync(pidFile(port), String(serveProc.pid ?? ""));
}

async function waitForServer(timeout = 30): Promise<void> {
  log("等待 server 就绪...");
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try {
      const out = execSync(
        `curl -s -f --max-time 3 --connect-timeout 2 "${BASE_URL}/global/health"`,
        { encoding: "utf-8" },
      );
      const body = JSON.parse(out) as Record<string, unknown>;
      if (body.healthy === true) {
        log("server 就绪");
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new LoopError("SERVER_TIMEOUT", `server 未在 ${timeout}s 内就绪`);
}

// ── HTTP 工具 ──

function api<T>(path: string, body?: unknown, timeoutMs = 300_000, retries = 3): T {
  const maxTime = Math.ceil(timeoutMs / 1000);
  const url = `${BASE_URL}${path}`;
  const method = body ? "POST" : "GET";
  const args = [
    "-s", "-f",
    "-X", method,
    "--max-time", String(maxTime),
    "--connect-timeout", "30",
    "-H", "Content-Type: application/json",
  ];
  if (body) args.push("-d", JSON.stringify(body));
  args.push(url);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const stdout = execFileSync("curl", args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(stdout) as T;
    } catch (err: any) {
      // curl -f 在 HTTP 4xx/5xx 时退出码 22 → 不重试
      if (err.status === 22) {
        throw new LoopError("HTTP_ERROR", `curl HTTP error: ${err.stderr?.toString()?.slice(0, 200) ?? err.message}`, { path, exitCode: 22 });
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        log(`curl 重试 (${attempt + 1}/${retries - 1}): ${lastErr.message}`);
        execSync("sleep 1", { stdio: "ignore" });
      }
    }
  }
  const code = (lastErr as any)?.status ?? "unknown";
  const msg = lastErr?.message ?? "unknown";
  log(`curl 失败 (${retries} 次重试): exit=${code} ${msg}`);
  throw new LoopError("HTTP_FAILED", `curl failed after ${retries} retries: exit=${code} ${msg}`, { path });
}

// ── 主流程 ──

async function main(): Promise<void> {
  // 1. 清理旧孤儿 serve
  const pf = pidFile(PORT);
  if (existsSync(pf)) {
    try {
      const oldPid = parseInt(readFileSync(pf, "utf-8").trim(), 10);
      try { execSync(`kill -0 ${oldPid}`, { stdio: "ignore" }); execSync(`kill ${oldPid}`, { stdio: "ignore" }); } catch {}
    } catch {}
    try { unlinkSync(pf); } catch {}
  }

  // 2. 模型验证（在启动 serve 前执行，快速失败）
  if (MODEL) validateModel(MODEL);

  // 2b. SESSION 目录存在性检查
  if (SESSION_ID && SESSION_DIR && !existsSync(SESSION_DIR)) {
    process.stderr.write(`[loop] 错误: SESSION ${SESSION_ID} 目录不存在: ${SESSION_DIR}\n`);
    process.exit(1);
  }
  if (SESSION_ID && !SESSION_DIR) {
    process.stderr.write(`[loop] 错误: SESSION ${SESSION_ID} 未找到，请先用 session create 创建\n`);
    process.exit(1);
  }

  // 3. 启动专用 serve
  startServer(PORT);
  await waitForServer(30);

  // 4. 收集 stdin (prompt)
  const stdin = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
  const prompt = stdin.trim();
  if (!prompt) throw new LoopError("NO_PROMPT", "stdin 未收到 prompt");

  // 5. 创建 headless session
  log("创建 headless session");
  const headlessSession = await api<{ id: string }>("/session", { title: `loop-task-${LABEL}` });
  const headlessSessionId = headlessSession.id;
  log(`headless session: ${headlessSessionId}`);

  // 6. 初始化进度文件
  if (PROGRESS_FILE) {
    try {
      mkdirSync(progressDir, { recursive: true });
      writeFileSync(PROGRESS_FILE, [
        `# loop-task-${LABEL}`,
        ``,
        `## 目标`,
        `${prompt.split("\n")[0]?.slice(0, 200)}`,
        ``,
        `## 进度`,
        `- [ ] 开始执行`,
        ``,
      ].join("\n"));
    } catch {}
  }

  // 7. 构建消息模板（伪代码循环体）
  const progressRule = PROGRESS_FILE ? `每轮更新进度文件: ${PROGRESS_FILE}` : '';

  // 7a. SESSION 上下文（如果指定了 session）
  const sessionRules = SESSION_ID ? [
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // 工作会话`,
    `  // ═══════════════════════════════════════════`,
    `  当前工作会话: ${SESSION_ID}`,
    SESSION_DIR ? `  SESSION.md: ${SESSION_DIR}/SESSION.md` : `  （SESSION ${SESSION_ID} 目录未找到，请先创建）`,
    ``,
    `  每轮完成后:`,
    `    1. 读取 SESSION.md 了解已有进度`,
    `    2. 推进工作`,
    `    3. 更新 SESSION.md 进度记录`,
    ``,
  ] : [];

  const rules = [
    ``,
    `你正在一个循环中执行。每收到一条消息，就是循环的一次迭代。`,
    ``,
    `for (let round = 1; ; round++) {`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // 你的任务`,
    `  // ═══════════════════════════════════════════`,
    `  ${prompt}`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // 规则`,
    `  // ═══════════════════════════════════════════`,
    `  本轮内你可以自由工作：读文件、改代码、运行命令、`,
    `  做任何推进任务需要的事情。你需要自己判断本轮做到`,
    `  什么程度停下来最合适。`,
    ``,
    `  本轮的输出中需要包含：`,
    `    1. 本轮做了什么（具体）`,
    `    2. 发现或问题`,
    `    3. 剩余未完成`,
    `    4. 下一步计划`,
    ``,
    `  如果任务全部完成：`,
    `    在回复末尾另起一行输出 ---STOP ${STOP_TOKEN}--- break;`,
    ``,
    `  如果任务无法完成或遇到不可恢复的错误：`,
    `    输出 ---STOP ${STOP_TOKEN}--- 并说明原因，break;`,
    ``,
    `  // ═══════════════════════════════════════════`,
    `  // 中断恢复`,
    `  // ═══════════════════════════════════════════`,
    `  你的工作可能因任何原因中断：超时、服务崩溃、`,
    `  网络故障…… 如果发生中断，你将被重新启动。`,
    ``,
    `  每轮开始前，先检查已经完成了什么——`,
    `  永远从已完成的进度之后继续，不重复工作。`,
    ``,
    `  ${progressRule}`,
    ...sessionRules,
    `  // ═══════════════════════════════════════════`,
    `  // 禁止`,
    `  // ═══════════════════════════════════════════`,
    `  禁止伪造 ---STOP ${STOP_TOKEN}--- break;`,
    `}`,
    ``,
  ].join('\n');

  const round1Msg = rules;

  // 9. 循环提交消息
  let round = 0;

  while (true) {
    round++;
    const text = round1Msg;
    const maxWait = 7200_000; // 2 小时

    log(`第 ${round} 轮，提交消息 (timeout=${(maxWait / 1000).toFixed(0)}s)`);
    const result = await api<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>(
      `/session/${headlessSessionId}/message`,
      { parts: [{ type: "text", text }] },
      maxWait,
    );

    const responseText = (result.parts ?? [])
      .filter(p => p.type === "text")
      .map(p => p.text ?? "")
      .join("\n");

    // 检查 stop token
    const stopIdx = responseText.indexOf(`---STOP ${STOP_TOKEN}---`);
    if (stopIdx !== -1) {
      const finalResponse = responseText.slice(0, stopIdx).trim();
      log(`第 ${round} 轮检测到 stop token，循环结束`);
      writeStatus(round, true, finalResponse);
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: finalResponse,
        finishReason: result.info?.finishReason ?? "stop",
      }) + "\n");
      return;
    }

    log(`第 ${round} 轮完成 (${responseText.length} chars)`);
    writeStatus(round, false, responseText);
    process.stdout.write(JSON.stringify({
      round,
      done: false,
      response: responseText,
      finishReason: result.info?.finishReason ?? "unknown",
    }) + "\n");

    // 安全阀
    if (round >= 100) {
      log("达到最大轮数 (100)，强制结束");
      writeStatus(round, true, responseText);
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: responseText,
        finishReason: "max_rounds",
      }) + "\n");
      return;
    }
  }
}

// ── CLI 守卫 ──

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().then(() => process.exit(0)).catch((err) => {
    const code = err instanceof LoopError ? err.code : "UNKNOWN";
    const msg = err instanceof LoopError ? `${err.code}: ${err.message}` : String(err);
    writeFailedStatus(code, msg);
    log(`错误: ${msg}`);
    process.exit(1);
  });
}
