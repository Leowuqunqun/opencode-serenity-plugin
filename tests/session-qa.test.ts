/**
 * session-qa.test.ts — QA 子命令单测
 *
 * 覆盖：
 * 1. 结构化检查（缺失章节 / 空章节）
 * 2. 完成度矛盾（已完成但有未完成任务/未解决问题）
 * 3. 进度新鲜度（长时间无更新）
 * 4. 决策质量（缺理由）
 * 5. 产出物文件存在性
 * 6. 边界：无 SESSION.md、不存在的会话
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 返回 N 天前的日期字符串 (YYYY-MM-DD) */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** 临时会话目录名用的日期前缀 */
function datePrefix(): string {
  return daysAgo(0);
}

/** 最近的日期（1 天前），不会触发 stale 检查 */
const RECENT = daysAgo(1);
/** 过旧的日期，会触发 stale 检查 */
const ANCIENT = '2025-01-01';

/** 创建临时 AGENT_SESSIONS 目录，返回路径和 helper */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qa-test-'));
  const sessionsDir = join(root, 'AGENT_SESSIONS');
  mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 在 sessionsDir 下创建一个会话目录及 SESSION.md */
function createSession(sessionsDir: string, dirName: string, content: string) {
  const sessionPath = join(sessionsDir, dirName);
  mkdirSync(sessionPath, { recursive: true });
  writeFileSync(join(sessionPath, 'SESSION.md'), content, 'utf8');
  return dirName;
}

const CLEAN_SESSION = `# SESSION: test-clean
- ID: S001

## 目标
验证 QA 功能正常工作

## 状态
- [x] 实现 QA 函数
- [x] 编写测试
- [ ] 集成验证

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 使用 text-based 报告 | LLM 可读性优于 JSON |

## 进度记录
- ${RECENT} — 开始实现 QA

## 产出物
- 测试报告

## 未解决的问题
- 暂无
`;

const COMPLETED_SESSION = `# SESSION: test-completed
- ID: S002

## 目标
完成全部任务

## 状态
已完成。所有任务完成。

- [x] 任务一
- [x] 任务二

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 使用 TS | 类型安全 |

## 进度记录
- ${RECENT} — 创建

## 产出物
- 完成报告

## 未解决的问题
- 暂无
`;

const INCONSISTENT_SESSION = `# SESSION: test-inconsistent
- ID: S003

## 目标
矛盾检查

## 状态
全部完成

- [x] 任务一
- [ ] 未完成的任务二
- [ ] 未完成的任务三

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 测试 | 验证矛盾检测 |

## 进度记录
- ${RECENT} — 开始

## 产出物
- 结果

## 未解决的问题
- 问题一
- 问题二
- TODO: 修复边缘情况
`;

const EMPTY_SECTION_SESSION = `# SESSION: test-empty-sections
- ID: S004

## 目标

## 状态
- [x] 检查

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 决策一 | 理由一 |

## 进度记录
- ${RECENT} — 创建

## 产出物

## 未解决的问题

`;

const STALE_SESSION = `# SESSION: test-stale
- ID: S005

## 目标
很久没更新的会话

## 状态
- [ ] 任务一
- [ ] 任务二
- [ ] 任务三

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 某个决定 | 某个理由 |

## 进度记录
- ${ANCIENT} — 创建

## 产出物
- 暂无

## 未解决的问题
- 卡了很久
`;

const NO_DECISIONS_SESSION = `# SESSION: test-no-decisions
- ID: S006

## 目标
没有决策记录

## 状态
- [ ] 进行中

## 关键决策
（暂无）

## 进度记录
- ${RECENT} — 创建

## 产出物
- 

## 未解决的问题
- 
`;

const COMPLETED_WITH_UNRESOLVED_SESSION = `# SESSION: test-completed-unresolved
- ID: S007

## 目标
完成但留有未解决问题

## 状态
已全部完成，结束。

- [x] 实现
- [x] 测试

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 选择方案 A | 性能更好 |

## 进度记录
- ${RECENT} — 开始实现
- ${RECENT} — 完成

## 产出物
- 代码

## 未解决的问题
- 还有未解决的设计问题
- open question: 是否需要扩展
`;

const ALL_TASKS_DONE_SESSION = `# SESSION: test-all-done
- ID: S008

## 目标
全部完成但未标记

## 状态
- [x] 任务一
- [x] 任务二
- [x] 任务三

## 关键决策
| # | 决策 | 理由 |
|---|------|------|
| 1 | 决定用 TS | 类型安全 |

## 进度记录
- ${RECENT} — 创建
- ${RECENT} — 完成所有

## 产出物
- 代码

## 未解决的问题
- 无
`;

describe('session-qa — 事实核对', () => {
  it('qa on non-existent session → error', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      const { qaSession } = await import('../src/session/lib.js');
      expect(() => qaSession(sessionsDir, 'non-existent')).toThrow(/Session not found/);
    } finally {
      cleanup();
    }
  });

  it('qa on session without SESSION.md → error', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      const dirName = `${RECENT}--S999--empty-dir`;
      mkdirSync(join(sessionsDir, dirName), { recursive: true });
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, dirName);
      expect(result).toContain('has no SESSION.md');
    } finally {
      cleanup();
    }
  });

  it('clean session → no errors or warnings', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S001--test-clean`, CLEAN_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S001');
      expect(result).toContain('0 error');
      expect(result).toContain('0 warning');
    } finally {
      cleanup();
    }
  });

  it('completed session (consistent) → no errors', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S002--test-completed`, COMPLETED_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S002');
      expect(result).toContain('0 error');
    } finally {
      cleanup();
    }
  });

  it('session marked complete but has pending tasks → error', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S003--test-inconsistent`, INCONSISTENT_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S003');
      expect(result).toContain('[ERR:consistency]');
      expect(result).toContain('pending task');
    } finally {
      cleanup();
    }
  });

  it('session with empty sections → warnings', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S004--test-empty-sections`, EMPTY_SECTION_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S004');
      // 目标为空、产出物为空、未解决的问题为空 → 多个 warning
      expect(result).toContain('[WRN:structure]');
      const warningMatches = result.match(/\[WRN:structure\]/g);
      expect(warningMatches!.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it('stale session with pending tasks → warning', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${ANCIENT}--S005--test-stale`, STALE_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S005');
      expect(result).toContain('[WRN:stale]');
    } finally {
      cleanup();
    }
  });

  it('session with no decisions on active session → info', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S006--test-no-decisions`, NO_DECISIONS_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S006');
      expect(result).toContain('[INF:quality]');
      expect(result).toContain('No decisions recorded');
    } finally {
      cleanup();
    }
  });

  it('completed session with unresolved items → warning', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S007--test-completed-unresolved`, COMPLETED_WITH_UNRESOLVED_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S007');
      expect(result).toContain('[WRN:consistency]');
      expect(result).toContain('unresolved');
    } finally {
      cleanup();
    }
  });

  it('all tasks done but no completion mark → info', async () => {
    const { sessionsDir, cleanup } = setup();
    try {
      createSession(sessionsDir, `${RECENT}--S008--test-all-done`, ALL_TASKS_DONE_SESSION);
      const { qaSession } = await import('../src/session/lib.js');
      const result = qaSession(sessionsDir, 'S008');
      expect(result).toContain('[INF:consistency]');
      expect(result).toContain('completed but session not marked');
    } finally {
      cleanup();
    }
  });
});
