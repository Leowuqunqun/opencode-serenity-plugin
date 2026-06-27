# Loop Tool Design

> 可靠的外部驱动循环工具。subagent 在独立 headless session 中反复执行，直到 LLM 主动输出 STOP 信号。

## Architecture

```
Main Agent              Plugin "loop" tool              opencode serve (headless)
    │                          │                                │
    │  loop(prompt) ─────────► │                                │
    │                          │  POST /session ──────────────► │
    │                          │  POST /msg (prompt + rules) ► │ ← 第1轮
    │                          │◄──── response ─────────────── │
    │                          │  ctx.metadata({title})        │
    │                          │  POST /session/msg "继续" ───► │ ← 第N轮
    │                          │◄──── response ─────────────── │
    │                          │  ctx.metadata({title})        │
    │                          │←── ---STOP {token} ---        │ ← 终止
    │◄──── final result ──────┤                                │
```

## Tool Interface

```typescript
tool({
  name: "loop",
  description: "让 headless agent 在当前 CCC root 下反复执行任务，直到任务完成。",
  args: {
    prompt: z.string().describe("任务描述，可以非常长"),
    agent: z.string().optional().describe("使用的 agent 类型 (默认 default)"),
    port: z.number().optional().default(9856).describe("opencode serve 端口"),
  },
  execute: async (args, ctx) => {
    // 见下方实现
  },
});
```

## External Process

一个独立的 TS 脚本（`loop-runner.ts`），由 plugin tool spawn 执行：

```
loop-runner.ts <prompt> <stop-token> <session-id> <port>
```

职责：
1. 复用或连接指定的 opencode serve 端口
2. 第 1 轮：提交完整 prompt + 结束规则 + stop_token
3. 第 N 轮：提交 "继续"
4. 每收到回复：写入 stdout（sync 回 plugin 更新 metadata）
5. 检测回复末尾的 `---STOP {token}---` → 终止
6. 输出最终结果到 stdout

## Prompt Template

### 第 1 轮（发给 headless agent）

```
{original_prompt_X}

---
执行规则：
- 每次收到消息就执行一步操作
- 全部完成后在回复末尾另起一行输出 ---STOP {stop_token}---
- 禁止伪造终止令牌
- 保持简洁，只需要输出本轮做了什么
```

### 第 2 轮起

```
继续
```

## Security: Stop Token

```typescript
import { randomBytes } from "node:crypto";
const stopToken = randomBytes(16).toString("hex");
// 例: "a7f3c9e1b2d8054f6e8c0d3a9b2e1f7c"
```

- 32 位随机 hex（128 位熵）
- LLM 碰撞概率 ≈ 1/2¹²⁸
- 每轮自动注入到系统提示词中
- headless agent 无法猜测，必须实际完成任务才能自然输出

## Real-time Progress

外部进程每收到一轮回复，向 stdout 写一行 JSON：

```json
{"round": 1, "status": "completed", "summary": "分析了代码结构"}
```

Plugin tool 读取这些行并：

1. **`ctx.metadata({ title: "loop 第 3 轮: 完成X" })`** — TUI 实时更新
2. **`process.stdout.write(JSON.stringify({...}))`** — 通知主 session
3. 主 session 通过 `/session/:id/message` 收到进度

## Return Value

```typescript
{
  rounds: 5,
  finalResponse: "全部完成...",
  summary: "共修改了 3 个文件"
}
```

## Error Handling

| 场景 | 行为 |
|------|------|
| serve 未运行 | 自动启动（复用 `serenity-background-task` 逻辑）|
| headless agent 超时 | 超时后可选择继续等待或终止 |
| 上下文超长 | headless session 自动压缩（opencode 内置） |
| stop_token 始终不出现 | tool 可设置最大轮数安全阀（默认 100 轮） |

## Implementation Order

1. `src/tools/loop-runner.ts` — 外部进程脚本（提示词模板 + while 循环 + serve API 调用）
2. `src/tools/loop-tool.ts` — Plugin tool 注册（spawn 外部进程 + metadata 更新 + 结果聚合）
3. 注册到 `src/index.ts`
4. 测试
