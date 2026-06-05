/**
 * hashline 单测（v1-2）
 *
 * 覆盖：
 * 1. hashLine 同输入 → 同 ID
 * 2. hashLine 不同输入 → 大概率不同 ID（容许碰撞）
 * 3. annotateLine 格式正确
 * 4. annotateLines 多行 + 末尾空行
 * 5. parsePos 成功 / 失败
 * 6. verifyPos 成功 / 失败（行数不够 / 哈希不匹配）
 */

import { describe, it, expect } from 'vitest';
import {
  hashLine,
  annotateLine,
  annotateLines,
  parsePos,
  verifyPos,
  HashlinePosFormatError,
  HashlineMismatchError,
} from '../src/hashline/util.js';

describe('hashline (v1-2)', () => {
  describe('hashLine', () => {
    it('同输入 → 同 ID', () => {
      const a = hashLine(11, 'function hello() {');
      const b = hashLine(11, 'function hello() {');
      expect(a).toBe(b);
    });

    it('不同 lineNo → 不同 ID', () => {
      const a = hashLine(11, 'foo');
      const b = hashLine(12, 'foo');
      expect(a).not.toBe(b);
    });

    it('不同 content → 不同 ID（大概率）', () => {
      const a = hashLine(11, 'foo');
      const b = hashLine(11, 'bar');
      expect(a).not.toBe(b);
    });

    it('ID 长度 = 2 字符', () => {
      const id = hashLine(1, 'x');
      expect(id).toHaveLength(2);
    });
  });

  describe('annotateLine', () => {
    it('格式 = {lineNo}#{id}| {content}', () => {
      const out = annotateLine(11, 'function hello() {');
      expect(out).toMatch(/^11#\w{2}\| function hello\(\) \{$/);
    });
  });

  describe('annotateLines', () => {
    it('多行每行都带 prefix', () => {
      const content = 'a\nb\nc';
      const out = annotateLines(content);
      const lines = out.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^1#\w{2}\| a$/);
      expect(lines[1]).toMatch(/^2#\w{2}\| b$/);
      expect(lines[2]).toMatch(/^3#\w{2}\| c$/);
    });

    it('末尾换行保留', () => {
      const out = annotateLines('a\nb\n');
      expect(out.endsWith('\n')).toBe(true);
      // 末尾换行后 split 出 [annotated_a, annotated_b, '']
      const lines = out.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe('');
    });

    it('空字符串', () => {
      expect(annotateLines('')).toBe('');
    });
  });

  describe('parsePos', () => {
    it('成功解析合法 pos', () => {
      const p = parsePos('11#VK');
      expect(p).toEqual({ line: 11, id: 'VK' });
    });

    it('throw HashlinePosFormatError 当格式错误', () => {
      expect(() => parsePos('11-VK')).toThrow(HashlinePosFormatError);
      expect(() => parsePos('11#')).toThrow(HashlinePosFormatError);
      expect(() => parsePos('11#VKK')).toThrow(HashlinePosFormatError);
      expect(() => parsePos('abc#VK')).toThrow(HashlinePosFormatError);
    });
  });

  describe('verifyPos', () => {
    const content = 'a\nb\nc';

    it('成功当 pos 哈希匹配', () => {
      // 先算实际第 2 行的 ID
      const id = hashLine(2, 'b');
      expect(() => verifyPos({ line: 2, id }, content)).not.toThrow();
    });

    it('throw HashlineMismatchError 当哈希不匹配', () => {
      expect(() => verifyPos({ line: 2, id: 'XX' }, content)).toThrow(HashlineMismatchError);
    });

    it('throw HashlineMismatchError 当行数不够', () => {
      expect(() => verifyPos({ line: 99, id: 'XX' }, content)).toThrow(HashlineMismatchError);
    });
  });
});
