# 更新日志

## v0.8.1 — 🐛 resident spawn 修复（S063 反馈）

修复 S063 发现的 `resident start` 永远 `unconfirmed` / `status` 永远 `unknown` 问题：

- **根因**：`resident-tool` 用 `spawn(process.execPath, ...)` 启动 runner，但 `process.execPath` 是 opencode 二进制（Bun 编译）而非 node，runner 启动即崩，从未写 status.json。
- **修复**：改用 `findNodeBin()`（`which node`），与 loop-tool 一致；`start` 返回新增 `log` 字段（日志路径），失败路径可查。
- **新增测试**：`findNodeBin` 回归测试（真实 spawn 验证 node 可执行）。

## v0.8.2 — 📖 ccc-config resident 使用指南

`ccc_admin ccc-config` 的 resident 段扩展为完整使用指南：

- **设计理念（DESIGN RATIONALE）**：双 while 循环、mind.md 即身份、时间界限、目的性不能重、约束继承。
- **使用方式（USAGE GUIDE）**：配置/心智文件创建、start/status/stop 三步、状态值语义、恢复流程、每轮行为、STOP 提前了结、SQC 首选用例。
- **运维注意事项（OPERATIONAL NOTES）**：gitignore、端口、detached 守护、日志路径、权限模型、失败排查。

## v0.8.0 — 🏠 resident 顶层常驻 Agent（M0）+ acc_kit 通用能力工具

首个顶层常驻 agent 功能（RFC《永存 Agent 载体设计》M0）：

- **`resident` tool**：`start` / `status` / `stop`。双层 while 循环——外层永存，内层生命周期（`lifetimeMs`）到期自我了结（写心智 → 新 session → 新周期）。
- **心智协议**：`mind.md` 是唯一持久记忆，每轮原子固化（tmp+rename），agent 可死、磁盘即恢复源。
- **时间界限**：`lifetimeMs` 到期 agent 自我了结；每轮 POST 超时 = `min(timeoutMs, 剩余+grace)`。
- **可靠性**：锁 O_EXCL 防并发 start、serve 崩溃自愈、stop PID 身份校验、异步 curl + abort（SIGTERM 不延迟）、端口 CCC 盐化、remainingMs 每生命周期刷新。
- **`acc_kit` tool**：`cc_ck` 升级——`health`（CCC 三原则）/ `time` / `wait`。
- **配置**：`.serenity-meta/resident.json` + `mind.md`；`ccc_admin ccc-config` 增加 resident 配置段。
- 551+ tests 全绿；2 轮静态审查（实现正确性 + 并发时序）高危修复全部落地。

## v0.7.0 — 🛠️ Session-Keeper 全面修复与加固

Session-Keeper 从 v0.5.48 到 v0.7.0 经过多轮修复，本次小版本整合所有改动：

- **触发机制**：改为增量计分（`tool.execute.before` 实时累加）+ DCP 即时注入（`tool.execute.after` 工具返回中直接提醒），不再依赖遍历历史消息。
- **计分规则**：write/edit=3分，task=10分，read/grep/glob/msm=1分，时间 1分/分钟；默认阈值 150。
- **ACK 检测**：text 和 reasoning part 均有效；只有正确 code 才清零，未 ACK 每轮持续提醒。
- **会话恢复**：反向扫描最近匹配 + 校验 `YYYY-MM-DD--` 前缀，杜绝子 agent 系统提示污染会话名。
- **SDK 适配**：统一 ToolPart 格式（`type=="tool"`），移除废弃 toolUse/toolResult 分支。
- **代码加固**：清理死字段、空安全防护、`removeActiveSession` 逻辑修复。

## v0.5.29 — 🧠 Todo 列表自动显示当前工作会话

激活一个工作会话后，Agent 创建的每条 todo 列表顶部都会自动出现当前会话的标识（如 `SESSION: S035 — 插件长期开发`），一眼就知道"现在在哪个会话里干活"。这个标识项以已完成状态显示，不会跟待办任务混在一起。

## v0.5.28 — 📋 切换会话后，Agent 立即知道该做什么

以前切换到会话后，Agent 可能过一会儿才"反应过来"。现在只要切过去，它立刻就知道：去读 SESSION.md、同步 todo、往进度记录里记东西。不需要等下一轮对话。

## v0.5.27 — 🔗 会话进度和 todo 自动同步

激活工作会话后，Agent 会自动读取当前 SESSION.md，把里面的待办拆成 OpenCode 内置的 todo 条目。一件事完成了、进度更新了，两边同时记录，不用操心哪个才是最新的。

## v0.5.26 — 💬 Agent 的"脑内指令"写得更清楚了

Agent 每次思考前，插件会在它的系统提示里注入约束规则（哪些文件能碰、用哪个命令工具、怎么管理会话）。这次把 4 块提示词全部用完整 EAP 理论重写了一遍——每条规则的含义更明确，不再有模糊地带，Agent 执行起来更精准。

## v0.5.25 — 📚 Neat 设计协作协议升级为完整版

`neat` 工具之前给的是精简版。现在跟理论仓库同步，新增了完整的内容架构章：覆盖论文写作、翻译规范、双语定义模式、英式中文寄存器等 11 条实战经验，不仅是软件需求对齐，非软件场景的内容设计也能用。

## v0.5.24 — 📚 EAP 认知框架升级为完整版

`eap` 工具现在返回完整的 6 章论文：前置抽象的无穷性、语言作为接口（英式中文策略、词汇辨析）、实证案例、理论推论（编码贬值 vs 抽象升值）、信息论形式化证明。在对话框里直接问 `eap` 就能看到全貌。

## v0.5.23 — ⏱️ loop 单轮超时延长到 2 小时

后台 loop 任务每轮的最长等待时间从 1 小时调整为 2 小时，长任务不再被中途掐断。

## v0.5.22 — 🔄 loop 运行时，TUI 能看到进度了

以前 loop 在后台跑，你不知道它干到哪了。现在每轮完成都会弹一个 toast 通知："第 3 轮完成"、"✅ 任务完成"、"❌ 任务失败"。不用切出去看进度文件了。
