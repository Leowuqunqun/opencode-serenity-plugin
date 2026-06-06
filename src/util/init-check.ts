/**
 * opencode.json 启动时自检（v1.5 init-check）
 *
 * 目标：plugin 启动时校验主仓 opencode.json 的关键配置。
 * 行为：**只警告，不 patch**（用户明确要求"不通过修改配置实现功能"）。
 *
 * 检查项：
 * 1. opencode.json 存在
 * 2. 顶层 default_agent 与 expectedInstanceName 匹配
 * 3. agent 字典有 expectedInstanceName 条目
 * 4. plugin 字段包含 opencode-serenity-plugin
 *
 * 失败：log.warn（plugin 不工作 / 用户/LLM 看 stderr）
 * 成功：log.info
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';

export type CheckResult = {
  ok: boolean;
  warnings: string[];
  details: Record<string, unknown>;
};

export function checkSerenityConfig(
  cwdRoot: string,
  expectedInstanceName: string,
): CheckResult {
  const warnings: string[] = [];
  const details: Record<string, unknown> = { cwdRoot, expectedInstanceName };
  const configPath = join(cwdRoot, 'opencode.json');

  if (!existsSync(configPath)) {
    warnings.push(`opencode.json not found at "${configPath}"`);
    log.warn('init-check', 'opencode.json not found', { path: configPath });
    return { ok: false, warnings, details };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`opencode.json parse error: ${reason}`);
    log.warn('init-check', 'opencode.json parse error', { path: configPath, err: reason });
    return { ok: false, warnings, details };
  }

  // 1. default_agent
  if (!config.default_agent) {
    warnings.push("opencode.json missing 'default_agent'");
  } else if (config.default_agent !== expectedInstanceName) {
    warnings.push(`default_agent is "${config.default_agent}", expected "${expectedInstanceName}"`);
  }
  details.default_agent = config.default_agent;

  // 2. agent 字典
  if (!config.agent || typeof config.agent !== 'object') {
    warnings.push("opencode.json missing 'agent' dictionary");
  } else if (!config.agent[expectedInstanceName]) {
    warnings.push(`agent dictionary missing entry for "${expectedInstanceName}"`);
  }
  details.has_instance_agent = !!(config.agent && config.agent[expectedInstanceName]);

  // 3. plugin 字段
  if (!Array.isArray(config.plugin) || config.plugin.length === 0) {
    warnings.push("opencode.json missing 'plugin' array");
  } else {
    const hasSerenityPlugin = config.plugin.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => typeof p === 'string' && p.includes('opencode-serenity-plugin'),
    );
    if (!hasSerenityPlugin) {
      warnings.push("plugin array does not include opencode-serenity-plugin");
    }
  }
  details.plugin_count = Array.isArray(config.plugin) ? config.plugin.length : 0;

  for (const w of warnings) {
    log.warn('init-check', w, { configPath });
  }
  if (warnings.length === 0) {
    log.info('init-check', 'all checks passed', details);
  }

  return { ok: warnings.length === 0, warnings, details };
}
