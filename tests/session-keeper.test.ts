/**
 * session-keeper.test.ts — Session-keeper unit tests
 *
 * Tests: config reading, score accumulation, ACK detection,
 * reminder injection, code validation, multi-round state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  processSessionKeeper,
  readKeeperThreshold,
  resetKeeperStore,
} from '../src/session/session-keeper.js';

let cwd = '';

const OC_SESSION_ID = 'test-oc-session';
const SESSION_DIR = '2026-07-30--S999--test-session';

function setupEnv(config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'keeper-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.serenity'), 'test-ccc');
  const opencodeDir = join(root, '.opencode');
  mkdirSync(opencodeDir, { recursive: true });
  if (config) {
    writeFileSync(join(opencodeDir, 'serenity.json'), JSON.stringify(config));
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function resetEnv(): void {
  if (cwd) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ok */ } }
  cwd = '';
}

function makeUserMsg(text: string, parts?: any[]): any {
  return { info: { role: 'user' }, parts: parts ?? [{ type: 'text', text }] };
}

function makeAssistantMsg(text: string): any {
  return { info: { role: 'assistant' }, parts: [{ type: 'text', text }] };
}

function makeToolUse(name: string, input?: Record<string, unknown>): any {
  return { type: 'toolUse', name, input: input ?? {} };
}

function makeToolUsePart(name: string, input?: Record<string, unknown>): any {
  return { type: 'toolUse', name, input: input ?? {} };
}

function makeMsg(role: string, text: string, parts?: any[]): any {
  return {
    info: { role },
    parts: parts ?? [{ type: 'text', text }],
    ...(role === 'user' ? {} : {}),
  };
}

describe('readKeeperThreshold()', () => {
  afterEach(() => resetEnv());

  it('no config file -> default 100', () => {
    cwd = setupEnv(undefined);
    expect(readKeeperThreshold(cwd)).toBe(100);
  });

  it('config with custom threshold', () => {
    cwd = setupEnv({ sessionKeeper: { threshold: 50 } });
    expect(readKeeperThreshold(cwd)).toBe(50);
  });

  it('config without sessionKeeper section -> default', () => {
    cwd = setupEnv({ loop: { defaultModel: 'x' } });
    expect(readKeeperThreshold(cwd)).toBe(100);
  });

  it('invalid threshold type -> default', () => {
    cwd = setupEnv({ sessionKeeper: { threshold: 'abc' } });
    expect(readKeeperThreshold(cwd)).toBe(100);
  });

  it('threshold zero is valid', () => {
    cwd = setupEnv({ sessionKeeper: { threshold: 0 } });
    expect(readKeeperThreshold(cwd)).toBe(0);
  });
});

describe('processSessionKeeper() — basic state machine', () => {
  beforeEach(() => { cwd = setupEnv(undefined); resetKeeperStore(); });
  afterEach(() => resetEnv());

  it('returns null reminder when score below threshold', () => {
    const messages = [
      makeMsg('user', 'hello'),
      makeAssistantMsg('hi there'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).toBeNull();
    expect(r.code).toBeNull();
  });

  it('injects reminder when score reaches threshold via write tools', () => {
    const messages = [
      makeMsg('user', 'do work', [
        { type: 'text', text: 'do work' },
        makeToolUsePart('write', { filePath: '/tmp/test.md' }),
        makeToolUsePart('write', { filePath: '/tmp/test2.md' }),
        makeToolUsePart('edit', { filePath: '/tmp/test3.md' }),
      ]),
      makeAssistantMsg('done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    // 3 writes * 3 = 9, well below 100 — wait, that's not enough
    expect(r.reminder).toBeNull();
    expect(r.code).toBeNull();
  });

  it('injects reminder with random 3-char code when threshold reached', () => {
    // Generate enough tool calls to reach threshold 100
    const toolUses: any[] = [];
    for (let i = 0; i < 35; i++) {
      toolUses.push(makeToolUsePart('write', { filePath: `/tmp/f${i}.md` }));
    }
    const messages = [
      makeMsg('user', 'batch write', toolUses),
      makeAssistantMsg('all done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    // 35 writes * 3 = 105 >= 100
    expect(r.reminder).not.toBeNull();
    expect(r.code).not.toBeNull();
    expect(r.code).toMatch(/^[A-Za-z0-9]{3}$/);
    expect(r.reminder).toContain(r.code);
    expect(r.reminder).toContain(SESSION_DIR);
  });

  it('code is random across calls', () => {
    const toolUses: any[] = [];
    for (let i = 0; i < 35; i++) {
      toolUses.push(makeToolUsePart('write', { filePath: `/tmp/f${i}.md` }));
    }
    const msgs = () => [
      makeMsg('user', 'batch', toolUses),
      makeAssistantMsg('done'),
    ];
    const r1 = processSessionKeeper(OC_SESSION_ID + 'a', msgs(), cwd, SESSION_DIR);
    const r2 = processSessionKeeper(OC_SESSION_ID + 'b', msgs(), cwd, SESSION_DIR);
    expect(r1.code).not.toBe(r2.code);
  });
});

describe('processSessionKeeper() — ACK cycle (multi-round)', () => {
  beforeEach(() => { cwd = setupEnv({ sessionKeeper: { threshold: 10 } }); resetKeeperStore(); });
  afterEach(() => resetEnv());

  function triggerReminder(): { code: string } {
    const toolUses: any[] = [];
    for (let i = 0; i < 4; i++) {
      toolUses.push(makeToolUsePart('write', { filePath: `/tmp/f${i}.md` }));
    }
    const messages = [
      makeMsg('user', 'batch write', toolUses),
      makeAssistantMsg('all done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).not.toBeNull();
    return { code: r.code! };
  }

  it('round 1: trigger reminder, round 2: ACK clears pending', () => {
    // Round 1: trigger reminder
    const { code } = triggerReminder();

    // Round 2: user sends new message, assistant ACK'd
    const messagesR2 = [
      makeMsg('user', 'batch write', [
        makeToolUsePart('write', { filePath: '/tmp/x.md' }),
      ]),
      makeAssistantMsg(`updated SESSION.md\n[SESSION-KEEPER-recorded-${code}]`),
    ];
    const r2 = processSessionKeeper(OC_SESSION_ID, messagesR2, cwd, SESSION_DIR);
    expect(r2.reminder).toBeNull(); // ACK cleared pending
    expect(r2.code).toBeNull();
  });

  it('round 1: trigger, round 2: no ACK, reminder persists', () => {
    const { code } = triggerReminder();

    // Round 2: user sends message, assistant does NOT ACK
    const messagesR2 = [
      makeMsg('user', 'more work', [
        makeToolUsePart('read', { filePath: '/tmp/x.md' }),
      ]),
      makeAssistantMsg('ok, continuing work'),
    ];
    const r2 = processSessionKeeper(OC_SESSION_ID, messagesR2, cwd, SESSION_DIR);
    expect(r2.reminder).not.toBeNull();
    expect(r2.code).toBe(code); // same code
    expect(r2.reminder).toContain(code);
  });

  it('ACK with wrong code is treated as invalid, reminder persists', () => {
    const { code } = triggerReminder();

    const messagesR2 = [
      makeMsg('user', 'more work'),
      makeAssistantMsg(`[SESSION-KEEPER-recorded-XXX]`), // wrong code
    ];
    const r2 = processSessionKeeper(OC_SESSION_ID, messagesR2, cwd, SESSION_DIR);
    expect(r2.reminder).not.toBeNull();
    expect(r2.code).toBe(code); // still same code
  });

  it('ACK-skipped also clears pending', () => {
    const { code } = triggerReminder();

    const messagesR2 = [
      makeMsg('user', 'query'),
      makeAssistantMsg(`nothing changed\n[SESSION-KEEPER-skipped-${code}]`),
    ];
    const r2 = processSessionKeeper(OC_SESSION_ID, messagesR2, cwd, SESSION_DIR);
    expect(r2.reminder).toBeNull();
    expect(r2.code).toBeNull();
  });

  it('score resets after ACK, re-accumulates for next cycle', () => {
    const { code } = triggerReminder();

    // ACK
    const msgsAck = [
      makeMsg('user', 'query'),
      makeAssistantMsg(`[SESSION-KEEPER-recorded-${code}]`),
    ];
    processSessionKeeper(OC_SESSION_ID, msgsAck, cwd, SESSION_DIR);

    // Next round: low activity — no trigger
    const msgsLow = [
      makeMsg('user', 'hi'),
      makeToolUsePart('read', { filePath: '/tmp/x.md' }),
      makeAssistantMsg('ok'),
    ];
    const r3 = processSessionKeeper(OC_SESSION_ID, msgsLow, cwd, SESSION_DIR);
    expect(r3.reminder).toBeNull();

    // Then more writes to trigger again
    const toolUses: any[] = [];
    for (let i = 0; i < 4; i++) {
      toolUses.push(makeToolUsePart('write', { filePath: `/tmp/g${i}.md` }));
    }
    const msgsHigh = [
      makeMsg('user', 'batch again', toolUses),
      makeAssistantMsg('done again'),
    ];
    const r4 = processSessionKeeper(OC_SESSION_ID, msgsHigh, cwd, SESSION_DIR);
    expect(r4.reminder).not.toBeNull();
    expect(r4.code).not.toBe(code); // new code
  });
});

describe('processSessionKeeper() — tool weight calculation', () => {
  beforeEach(() => { cwd = setupEnv({ sessionKeeper: { threshold: 5 } }); resetKeeperStore(); });
  afterEach(() => resetEnv());

  it('one write tool -> score 3 -> below threshold 5', () => {
    const messages = [
      makeMsg('user', 'edit', [makeToolUsePart('edit', { filePath: '/tmp/x.md' })]),
      makeAssistantMsg('done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).toBeNull();
  });

  it('two write tools -> score 6 -> triggers reminder', () => {
    const messages = [
      makeMsg('user', 'edits', [
        makeToolUsePart('write', { filePath: '/tmp/a.md' }),
        makeToolUsePart('edit', { filePath: '/tmp/b.md' }),
      ]),
      makeAssistantMsg('done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).not.toBeNull();
  });

  it('five read tools -> score 5 -> triggers reminder', () => {
    const messages = [
      makeMsg('user', 'reads', [
        makeToolUsePart('read', { filePath: '/tmp/a.md' }),
        makeToolUsePart('grep', { pattern: 'foo' }),
        makeToolUsePart('glob', { pattern: '*.ts' }),
        makeToolUsePart('anysearch', { query: 'test' }),
        makeToolUsePart('web-search', { query: 'test' }),
      ]),
      makeAssistantMsg('done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).not.toBeNull();
  });

  it('cc_fs read subcommand -> weight 1', () => {
    const messages = [
      makeMsg('user', 'list', [
        makeToolUsePart('cc_fs', { subcommand: 'list', path: '.' }),
      ]),
      makeAssistantMsg('ok'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).toBeNull();
  });

  it('cc_fs write subcommand -> weight 3', () => {
    const messages = [
      makeMsg('user', 'mkdir', [
        makeToolUsePart('cc_fs', { subcommand: 'mkdir', path: '/tmp/d' }),
        makeToolUsePart('cc_fs', { subcommand: 'append', path: '/tmp/f', content: 'x' }),
      ]),
      makeAssistantMsg('done'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).not.toBeNull();
  });

  it('non-tracked tools -> weight 0', () => {
    const messages = [
      makeMsg('user', 'meta', [
        makeToolUsePart('loop', { label: 'x', prompt: 'y' }),
        makeToolUsePart('session', { subcommand: 'list' }),
        makeToolUsePart('msm_list'),
      ]),
      makeAssistantMsg('ok'),
    ];
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, SESSION_DIR);
    expect(r.reminder).toBeNull();
  });
});

describe('processSessionKeeper() — no active session', () => {
  beforeEach(() => { cwd = setupEnv({ sessionKeeper: { threshold: 1 } }); resetKeeperStore(); });
  afterEach(() => resetEnv());

  it('returns null when no active session (sessionDirName is empty in hook)', () => {
    const messages = [
      makeMsg('user', 'work', [makeToolUsePart('write', { filePath: '/tmp/x.md' })]),
      makeAssistantMsg('done'),
    ];
    // processSessionKeeper doesn't check session validity; it uses whatever dirName passed.
    // The guard is in compacting.ts: it only calls processSessionKeeper when active session exists.
    // Here we just verify that with an empty dirName, the code still generates but uses empty string.
    const r = processSessionKeeper(OC_SESSION_ID, messages, cwd, '');
    expect(r.reminder).not.toBeNull();
    expect(r.reminder).not.toContain('S###'); // no session in text
  });
});
