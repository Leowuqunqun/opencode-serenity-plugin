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
    "自动管理 opencode serve 生命周期，无需手动启动。" +
    "每轮进度会实时更新。适用于需要可靠循环的场景。",
  args: {
    prompt: z
      .string()
      .describe("任务描述，可以非常长。Agent 会循环执行直到任务完成。"),
    agent: z
      .string()
      .optional()
      .describe("使用的 agent 类型名称 (默认 default)"),
  },
  execute: async (input, ctx) => {
    const prompt = input.prompt;
    const stopToken = randomBytes(16).toString("hex");
    const runnerPath = resolve(__dirname, "loop-runner.js");

    // 通过 child_process 启动外部进程（内部逻辑会自启动 opencode serve）
    const child = spawn(process.execPath, [runnerPath, stopToken], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 收集 stderr（之前被管道吞了导致看不到错误）
    const stderrChunks: string[] = [];
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // 通过 stdin 传递 prompt
    child.stdin!.write(prompt);
    child.stdin!.end();

    // 用 line 事件收集 stdout（比 for await...of 更可靠，避免丢失最后一行）
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      lines.push(line);

      try {
        const data = JSON.parse(line);
        if (data.done) {
          ctx.metadata({
            title: `loop 完成 (${data.round} 轮)`,
          });
          (child as any)._loopResult = data;
        }

        const summary = data.response
          ? data.response.slice(0, 80) + (data.response.length > 80 ? "..." : "")
          : "(no response)";
        ctx.metadata({
          title: `loop 第 ${data.round} 轮: ${summary}`,
        });
      } catch {
        // 非 JSON 行（如日志）跳过
      }
    });

    // 等待子进程退出
    const exitCode = await new Promise<number>((resolve) => child.on("close", resolve));
    const result = (child as any)._loopResult;

    if (result && result.done) {
      return JSON.stringify({
        rounds: result.round,
        finalResponse: result.response,
        finishReason: result.finishReason ?? "stop",
      }, null, 2);
    }

    // 没有 done 信号——收集 stderr 作为错误信息
    const allOutput = lines.join("\n");
    const stderr = stderrChunks.join("").trim();
    throw new Error(
      `loop: 外部进程意外退出 (exit=${exitCode})\n` +
      (stderr ? `[stderr]\n${stderr}\n\n` : "") +
      `[stdout]\n${allOutput.slice(0, 2000)}`,
    );
  },
});
