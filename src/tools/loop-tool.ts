/**
 * loop-tool.ts — Loop tool（Plugin tool）
 *
 * 让 headless agent 在当前 CCC root 下反复执行任务，直到 LLM 输出 stop token。
 * 每次调用启动专用 opencode serve，循环结束自动清理。
 *
 * 机制：
 *   1. 生成 128 位随机 stop token + 随机端口
 *   2. 清理该端口上的孤儿 serve（PID 文件兜底）
 *   3. spawn loop-runner.ts（外部进程），通过 stdin 传 prompt + port + token
 *   4. 外部进程每轮回复后写一行 JSON 到 stdout
 *   5. Plugin tool 用 line-by-line 读取 stdout，实时更新 ctx.metadata()
 *   6. 外部进程检测到 stop token 后结束，自动 kill 专用 serve
 *   7. Plugin dispose 钩子清理所有残留
 */

import { randomBytes } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState } from "../state.js";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findNodeBin(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim() || "node";
  } catch {
    return "node";
  }
}

/** 当前活跃的 loop 端口列表（供 dispose 钩子清理） */
export const activePorts = new Set<number>();

function randomPort(): number {
  return 1024 + randomBytes(2).readUInt16BE(0) % 64511;
}

export const loopTool: ToolDefinition = tool({
  description:
    "Loop tool — 让 headless agent 在当前 CCC root 下反复执行任务直到完成。" +
    "自动管理专用 opencode serve 生命周期，循环结束自动清理。" +
    "每轮进度会实时更新。" +
    "\n\n" +
    "调用者必须在 prompt 中交代以下内容：\n" +
    "1. 要使用的 SESSION — loop agent 需要知道工作在哪个会话上下文中\n" +
    "2. 完整的任务背景和上下文—— loop agent 是独立进程，没有主 session 的对话记忆，\n" +
    "   必须把相关文件路径、已有决策、当前状态等一次性给足。不要假设它'知道'任何事\n" +
    "3. 明确的目标 (goal) — 最终要达成什么\n" +
    "4. 完成判定方式 (done criteria) — 如何判断已完成\n" +
    "\n" +
    "loop agent 会自动在 AGENT_SESSIONS/loop-{label}.md 中维护进度文件。\n" +
    "中断恢复：loop 的工作可能因超时、服务崩溃等原因中断。如果发生中断，\n" +
    "loop 将被重新启动并从进度文件续跑——不重复已完成的工作。" +
    "\n" +
    "提示词长度必须大于 100 字符，不足会被拒绝。",
  args: {
    prompt: z
      .string()
      .min(101, "提示词长度必须大于 100 字符。请完整给出：SESSION标识、任务背景与上下文、目标、完成判定方式、相关文件路径。")
      .describe("任务描述。必须 >100 字符，需包含：SESSION标识、完整任务背景与上下文、目标、完成判定方式、相关文件路径引用。"),
    label: z
      .string()
      .min(1)
      .max(50)
      .describe("任务标签，用作 session 标题和进度文件名 (如 'SQC-扫描', '字幕制作')"),
    agent: z
      .string()
      .optional()
      .describe("使用的 agent 类型名称 (headless API 暂不支持，保留参数)"),
    model: z
      .string()
      .optional()
      .describe("指定 LLM 模型 (headless API 暂不支持，使用当前 opencode.json 默认配置)"),
  },
  execute: async (input, ctx) => {
    const prompt = input.prompt;
    const label = input.label;
    const stopToken = randomBytes(16).toString("hex");
    const port = randomPort();
    const runnerPath = resolve(__dirname, "loop-runner.js");
    const cwdRoot = getState().cwdRoot;

    activePorts.add(port);

    const child = spawn(findNodeBin(), [runnerPath, stopToken, String(port), label, cwdRoot], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,  // 独立进程组，可以用 -pid 组杀
    });

    // 收集 stderr（错误日志）
    const stderrChunks: string[] = [];
    child.stderr!.on("data", (chunk: Buffer) => { stderrChunks.push(chunk.toString()); });

    // 写 prompt 到 stdin
    child.stdin!.write(prompt);
    child.stdin!.end();

    // 杀进程组的辅助函数
    const killGroup = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
    };

    // 逐行读 stdout，每行 JSON 实时更新 metadata
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      lines.push(line);
      try {
        const data = JSON.parse(line);
        const summary = data.response
          ? data.response.slice(0, 80) + (data.response.length > 80 ? "..." : "")
          : "(no response)";
        ctx.metadata({
          title: `loop ${label} 第 ${data.round} 轮: ${summary}`,
          metadata: {
            label,
            round: data.round,
            done: data.done,
            response: data.response,
            finishReason: data.finishReason,
          },
        });
        if (data.done) (child as any)._loopResult = data;
      } catch { /* skip non-JSON */ }
    });

    // 用户取消 → 进程组杀（runner + serve 一锅端）
    if (ctx.abort.aborted) {
      killGroup();
      activePorts.delete(port);
      throw new Error("loop 已被用户取消");
    }
    const onAbort = () => { killGroup(); };
    ctx.abort.addEventListener("abort", onAbort);

    // 等待子进程退出
    const exitCode = await new Promise<number>((resolve) => child.on("close", resolve));
    ctx.abort.removeEventListener("abort", onAbort);
    activePorts.delete(port);

    const result = (child as any)._loopResult;
    if (ctx.abort.aborted) {
      throw new Error("loop 已被用户取消");
    }
    if (result && result.done) {
      return JSON.stringify({
        rounds: result.round,
        finalResponse: result.response,
        finishReason: result.finishReason ?? "stop",
      }, null, 2);
    }

    const stderr = stderrChunks.join("").trim();
    const allOutput = lines.join("\n");
    throw new Error(
      `loop: 外部进程意外退出 (exit=${exitCode})\n` +
      (stderr ? `[stderr]\n${stderr}\n\n` : "") +
      `[stdout]\n${allOutput.slice(0, 2000)}`,
    );
  },
});

const PID_DIR = "/tmp/serenity-bg-task";

/** 清理所有活跃 loop 的 serve 进程（供 dispose 钩子调用） */
export function cleanupAllLoops(): void {
  for (const port of activePorts) {
    try {
      const pf = `${PID_DIR}/server-${port}.pid`;
      if (existsSync(pf)) {
        const pid = parseInt(readFileSync(pf, "utf-8").trim(), 10);
        try { execSync(`kill ${pid} 2>/dev/null`, { stdio: "ignore" }); } catch {}
        try { unlinkSync(pf); } catch {}
      }
    } catch {}
  }
  activePorts.clear();
}
