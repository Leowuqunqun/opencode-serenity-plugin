/**
 * loop-tool.ts — Loop tool（Plugin tool）
 *
 * 让 headless agent 在当前 CCC root 下反复执行任务，直到 LLM 输出 stop token。
 * 通过外部进程调用 opencode serve headless API 实现可靠循环。
 *
 * 机制：
 *   1. 生成 128 位随机 stop token
 *   2. spawn loop-runner.ts（外部进程），通过 stdin 传 prompt
 *   3. 外部进程每轮回复后写一行 JSON 到 stdout
 *   4. Plugin tool 用 line-by-line 读取 stdout，实时更新 ctx.metadata()
 *   5. 外部进程检测到 stop token 后结束，输出最终结果
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const loopTool: ToolDefinition = tool({
  description:
    "Loop tool — 让 headless agent 在当前 CCC root 下反复执行任务直到完成。" +
    "通过 opencode serve API 驱动独立 session，不受当前对话影响。" +
    "每轮进度会实时更新。适用于需要可靠循环的场景。",
  args: {
    prompt: z
      .string()
      .describe("任务描述，可以非常长。Agent 会循环执行直到任务完成。"),
    agent: z
      .string()
      .optional()
      .describe("使用的 agent 类型名称 (默认 default)"),
    port: z
      .number()
      .optional()
      .default(4096)
      .describe("opencode serve 端口 (默认 4096)"),
  },
  execute: async (input, ctx) => {
    const prompt = input.prompt;
    const port = input.port ?? 4096;
    const stopToken = randomBytes(16).toString("hex");
    const runnerPath = resolve(__dirname, "loop-runner.js");

    // 通过 child_process 启动外部进程
    const child = spawn(process.execPath, [runnerPath, stopToken, String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 通过 stdin 传递 prompt
    child.stdin!.write(prompt);
    child.stdin!.end();

    // 收集 stdout 行
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lines.push(line);

      try {
        const data = JSON.parse(line);
        if (data.done) {
          // 最终结果
          ctx.metadata({
            title: `loop 完成 (${data.round} 轮)`,
          });
          return JSON.stringify({
            rounds: data.round,
            finalResponse: data.response,
            finishReason: data.finishReason ?? "stop",
          }, null, 2);
        }

        // 进度更新
        const summary = data.response
          ? data.response.slice(0, 80) + (data.response.length > 80 ? "..." : "")
          : "(no response)";
        ctx.metadata({
          title: `loop 第 ${data.round} 轮: ${summary}`,
        });
      } catch {
        // 非 JSON 行（如日志）跳过
      }
    }

    // 进程意外结束（没有 done 信号）
    const exitCode = child.exitCode ?? (await new Promise<number>((resolve) => child.on("close", resolve)));
    const allOutput = lines.join("\n");
    throw new Error(
      `loop: 外部进程意外退出 (exit=${exitCode})\n${allOutput.slice(0, 2000)}`,
    );
  },
});
