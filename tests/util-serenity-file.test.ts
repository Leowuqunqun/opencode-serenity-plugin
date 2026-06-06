/**
 * serenity-file 工具单测
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSerenityFile,
  removeSerenityFile,
  serenityFileExists,
  writeSerenityFile,
  SERENITY_FILENAME,
} from '../src/util/serenity-file.js';
import { SerenityFileEmptyError, SerenityFileNotFoundError } from '../src/errors.js';

describe('util/serenity-file', () => {
  it('SERENITY_FILENAME = ".serenity"', () => {
    expect(SERENITY_FILENAME).toBe('.serenity');
  });

  it('readSerenityFile 抛错当文件不存在', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-fnf-'));
    expect(() => readSerenityFile(tmp)).toThrow(SerenityFileNotFoundError);
  });

  it('readSerenityFile 抛错当文件为空', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-empty-'));
    writeFileSync(join(tmp, '.serenity'), '');
    expect(() => readSerenityFile(tmp)).toThrow(SerenityFileEmptyError);
  });

  it('readSerenityFile 抛错当文件只有空白', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-ws-'));
    writeFileSync(join(tmp, '.serenity'), '  \n\t  \n');
    expect(() => readSerenityFile(tmp)).toThrow(SerenityFileEmptyError);
  });

  it('readSerenityFile 返回 trim 后的实例名', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-ok-'));
    writeFileSync(join(tmp, '.serenity'), '  home-serenity  \n');
    expect(readSerenityFile(tmp)).toBe('home-serenity');
  });

  it('serenityFileExists 探测', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-probe-'));
    expect(serenityFileExists(tmp)).toBe(false);
    writeFileSync(join(tmp, '.serenity'), 'x');
    expect(serenityFileExists(tmp)).toBe(true);
  });

  // v1.10 RR7: writeSerenityFile + removeSerenityFile
  it('writeSerenityFile 落盘内容正确', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-write-'));
    writeSerenityFile(tmp, 'xx-serenity');
    expect(serenityFileExists(tmp)).toBe(true);
    expect(readSerenityFile(tmp)).toBe('xx-serenity');
  });

  it('removeSerenityFile 存在时删除', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-rm-'));
    writeSerenityFile(tmp, 'existing-serenity');
    expect(serenityFileExists(tmp)).toBe(true);
    removeSerenityFile(tmp);
    expect(serenityFileExists(tmp)).toBe(false);
  });

  it('removeSerenityFile 不存在时不抛错（idempotent）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-rm2-'));
    expect(() => removeSerenityFile(tmp)).not.toThrow();
  });
});
