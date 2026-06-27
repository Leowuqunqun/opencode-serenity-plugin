#!/usr/bin/env node
/**
 * loop-runner.ts — Loop tool 外部进程
 *
 * 由 loop tool 通过 child_process.spawn 启动，在独立进程中
 * 通过 opencode serve headless API 驱动 LLM 循环执行。
 *
 * 用法: loop-runner.ts <stop-token> <port>
 *   stdin: 第 1 轮的 prompt 文本
 *   stdout: 每轮 JSON 进度行 + 最终 JSON 结果
 *
 * 协议:
 *   - 第 1 轮: prompt + 执行规则 + stop token 一起提交
 *   - 第 N 轮: 提交 "继续"
 *   - 每轮 stdout 一行 JSON: {"round":N,"response":"...","done":false}
 *   - 检测到 stop token → {"round":N,"response":"...","done":true}
 *   - 进程退出码 0=成功 1=错误
 */



const STOP_TOKEN = process.argv[2];
const PORT = parseInt(process.argv[3] ?? "4096", 10);

if (!STOP_TOKEN || !PORT) {
  process.stderr.write("usage: loop-runner.ts <stop-token> <port>\n");
  process.exit(1);
}

const BASE_URL = `http://localhost:${PORT}`;

// ── 错误类 ──

class LoopError extends Error {
  constructor(public code: string, message: string, public ctx: Record<string, unknown> = {}) {
    super(message);
    this.name = "LoopError";
  }
}

// ── HTTP 工具 ──

async function api<T>(path: string, body?: unknown, timeoutMs = 300_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LoopError("HTTP_ERROR", `HTTP ${res.status}: ${text}`, { path, status: res.status });
    }
    return await res.json() as T;
  } catch (err) {
    if (err instanceof LoopError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoopError("HTTP_FAILED", `fetch failed: ${msg}`, { path });
  } finally {
    clearTimeout(timer);
  }
}

// ── 主流程 ──

async function main(): Promise<void> {
  // 收集 stdin (prompt)
  const stdin = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
  const prompt = stdin.trim();
  if (!prompt) throw new LoopError("NO_PROMPT", "stdin 未收到 prompt");

  // 1. 创建 session
  const session = await api<{ id: string }>("/session", { title: "loop-task" });
  const sessionId = session.id;

  // 2. 构建第 1 轮消息
  const round1Msg = `${prompt}

---
执行规则：
- 每次收到消息就执行一步操作
- 全部完成后在回复末尾另起一行输出 ---STOP ${STOP_TOKEN}---
- 禁止伪造终止令牌
- 保持简洁，每轮只输出本轮做了什么
`;

  // 3. 循环提交消息
  let round = 0;
  let finalResponse = "";

  while (true) {
    round++;
    const text = round === 1 ? round1Msg : "继续";
    const maxWait = round === 1 ? 600_000 : 300_000;

    const result = await api<{ info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }>(
      `/session/${sessionId}/message`,
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
      finalResponse = responseText.slice(0, stopIdx).trim();
      // 输出最终结果
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: finalResponse,
        finishReason: result.info?.finishReason ?? "stop",
      }) + "\n");
      return;
    }

    // 输出进度
    process.stdout.write(JSON.stringify({
      round,
      done: false,
      response: responseText,
      finishReason: result.info?.finishReason ?? "unknown",
    }) + "\n");

    // 安全阀：最大轮数
    if (round >= 100) {
      finalResponse = responseText;
      process.stdout.write(JSON.stringify({
        round,
        done: true,
        response: finalResponse,
        finishReason: "max_rounds",
      }) + "\n");
      return;
    }
  }
}

// ── CLI 守卫 ──

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((err) => {
    const msg = err instanceof LoopError ? `${err.code}: ${err.message}` : String(err);
    process.stderr.write(msg + "\n");
    process.exit(1);
  });
}
