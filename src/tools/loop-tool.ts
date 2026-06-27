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
    "调用者必须在 prompt 中完整给出：\n" +
    "1. 明确的目标 (goal) — 最终要达成什么\n" +
    "2. 完成判定方式 (done criteria) — 如何判断已完成\n" +
    "3. 建议引用的文件路径 (reference files)\n" +
    "\n" +
    "loop agent 会自动在 AGENT_SESSIONS/loop-{label}.md 中维护进度文件：\n" +
    "- 开始前写入目标\n" +
    "- 每轮结束时更新已完成步骤和剩余步骤\n" +
    "- 方便派发者随时查看进度\n" +
    "\n" +
    "提示词长度必须大于 100 字符，不足会被拒绝。",
  args: {
    prompt: z
      .string()
      .min(101, "提示词长度必须大于 100 字符。请完整给出：任务内容、目标、完成判定方式、相关文件引用。")
      .describe("任务描述。必须 >100 字符，需包含任务内容、目标、完成判定方式、相关文件路径引用。"),
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
    });

    // 收集 stderr
    const stderrChunks: string[] = [];
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // 取消时 kill runner → runner exit handler → kill serve
    ctx.abort?.addEventListener("abort", () => {
      try { child.kill("SIGTERM"); } catch {}
    });

    // 通过 stdin 传递 prompt
    child.stdin!.write(prompt);
    child.stdin!.end();

    // 用 line 事件收集 stdout
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
          title: `loop 第 ${data.round} 轮: ${summary}`,
          metadata: {
            round: data.round,
            response: data.response,
            finishReason: data.finishReason,
          },
        });

        if (data.done) {
          (child as any)._loopResult = data;
        }
      } catch {
        // 非 JSON 行跳过
      }
    });

    // 等待子进程退出
    const exitCode = await new Promise<number>((resolve) => child.on("close", resolve));
    const result = (child as any)._loopResult;

    activePorts.delete(port);

    if (result && result.done) {
      return JSON.stringify({
        rounds: result.round,
        finalResponse: result.response,
        finishReason: result.finishReason ?? "stop",
      }, null, 2);
    }

    const allOutput = lines.join("\n");
    const stderr = stderrChunks.join("").trim();
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
