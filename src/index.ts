/**
 * opencode-serenity-plugin — v0 stub 入口
 *
 * 当前为空实现。等 R1-R5 核对后填充：
 * - R1: bash 工具替换（同名 tool 抛错 + permission.bash:deny）
 * - R2: msm_list + msm_exec 两个 tool
 * - R3: read 弹窗关闭（permission.read:allow）
 * - R4: primary-agent 集成（修 default_agent throw + 禁 cheap-worker）
 * - R5: 作用域门控（HOME_SERENITY_RESTRICT env）
 *
 * @see AGENT_SESSIONS/2026-06-04--opencode-plugin-investigation/requirements-locked-v0.md
 */

const plugin = async () => {
  return {};
};

export default plugin;
