/**
 * RR7 简化实现 — v0 通过 external shell script + chat.message 提示
 *
 * 真实 SDK 1.15.13 不暴露 registerCommand API（仅有 command.execute.before hook）
 * v0 务实方案：
 * 1. plugin 仓 scripts/serenity-init.sh 提供外部脚本
 * 2. chat.message hook 检测 /serenity-init 字符串 → 注入 system prompt 提示
 *    LLM 改用 msm_exec 调用该脚本
 *
 * 这避免了"插件内注册 slash command" 的 SDK 限制，同时保留 RR7 的产品行为
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState } from './state.js';

export const chatMessageHook: NonNullable<Hooks['chat.message']> = async (_input, _output) => {
  // 注：当前 SDK 类型中 chat.message 没有 messages in output（只有 message + parts）
  // v0 简化：不在此 hook 实际注入；改在 system.transform hook 中根据激活状态注入
  // 实际 RR7 触发由 system.transform 处理
  void getState();
};

export const systemTransformHook: NonNullable<Hooks['experimental.chat.system.transform']> = async (
  _input,
  output,
) => {
  if (!getState().activated) return;

  // RR7 触发提示：如果 system prompt 中已包含提示文本，LLM 知道如何响应用户输入 /serenity-init
  // 注：这是条件性——只有当用户**当前**输入了 /serenity-init 时才需要注入
  // v0 简化：始终注入 RR7 帮助文本（token 成本 < 100，LLM 自行判断）
  output.system.push(
    `[serenity-plugin] Available slash commands: \`/serenity-init\` (RR7). ` +
      `When the user types \`/serenity-init\`, do NOT try to execute it via bash. ` +
      `Instead, call \`msm_exec\` with msm_name="serenity-init" and appropriate args. ` +
      `The init script will: ① create /.serenity in cwd root ② git add + commit it. ` +
      `Use msm_name = "serenity-init" only if it's in mech-registry.json; otherwise ask the user to run the external init script \`scripts/serenity-init.sh\` from the plugin repo.`,
  );

  // 同时提示 RR3 核心约束
  output.system.push(
    `[serenity-plugin] \`bash\` tool is disabled (RR3). Use \`msm_list\` to discover MSMs and \`msm_exec\` to invoke. ` +
      `Tool scope is limited to cwd root (RR5).`,
  );
};
