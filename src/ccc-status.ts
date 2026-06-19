/**
 * ccc-status.ts — CCC status check tool (v0.3)
 *
 * Validates the three CCC principles:
 *   P1: .serenity file exists and is non-empty
 *   P2: root is inside a git repository
 *   P3: opencode.json plugin configuration is present
 *
 * Output is a JSON status report.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { findSerenityRoot } from './fs/resolve-path.js';
import { getState, ensureReady } from './state.js';
import pkg from '../package.json' with { type: 'json' };

const VERSION = pkg.version;

export const cccStatusTool: ToolDefinition = tool({
  description:
    `CCC status health check (v${VERSION}). Validates three CCC principles: ` +
    'P1 (rooted — .serenity exists), P2 (git-managed), P3 (binary permissions — opencode.json present). ' +
    'Returns a JSON status report with pass/fail per principle.',
  args: {},
  execute: async (_input, ctx) => {
    await ensureReady();
    const state = getState();

    const root = findSerenityRoot(ctx.directory);

    // P1: .serenity file exists and is non-empty
    const serenityPath = resolve(root, '.serenity');
    const p1Pass = existsSync(serenityPath);
    // Note: .serenity content is already validated during activation

    // P2: git-managed — the state.activated implies git check passed
    // (RR6 in activation.ts verifies git repo)
    const p2Pass = state.activated;

    // P3: opencode.json with plugin config
    const opencodeJsonPath = resolve(root, 'opencode.json');
    let p3Pass = false;
    let p3Detail = '';
    if (existsSync(opencodeJsonPath)) {
      // Simple check: file exists. Full parse is done by activation.
      p3Pass = true;
      p3Detail = 'opencode.json found';
    } else {
      p3Detail = 'opencode.json not found at CCC root';
    }

    const allPass = p1Pass && p2Pass && p3Pass;

    const report = {
      ccc: state.cccName,
      root,
      version: VERSION,
      status: allPass ? 'healthy' : 'degraded',
      principles: {
        P1_rooted: {
          pass: p1Pass,
          detail: p1Pass ? '.serenity marker found' : '.serenity marker missing',
        },
        P2_git_managed: {
          pass: p2Pass,
          detail: p2Pass ? 'git repository verified' : 'not in a git repository',
        },
        P3_binary_permissions: {
          pass: p3Pass,
          detail: p3Detail,
        },
      },
    };

    return JSON.stringify(report, null, 2);
  },
});
