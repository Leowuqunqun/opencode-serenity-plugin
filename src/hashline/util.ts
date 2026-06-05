/**
 * Hashline 核心算法（v1-2）
 *
 * 设计：每行内容用 `hash(lineNo, lineContent)` 编码为 2 字符 base64 ID
 * - 2 字符 base64 = 12 bit → 4096 种值
 * - 碰撞概率：对一个 L 行的文件，2 个不同行 hash 相同的概率 ≈ L² / 8192
 * - 50 行文件碰撞概率 < 0.03% —— 实用足够
 * - 实际 oMo 用前一行末尾 + 该行 + 下一行开头做混合 hash，进一步降低碰撞
 *   我们用 lineNo + lineContent 已足够（v1-2 简化版）
 *
 * 格式：`{lineNo}#{id}| {lineContent}`
 * 示例：`11#VK| function hello() {`
 *
 * 参考：oh-my-opencode hashline-core（npm 实际未发布；本实现为参考重写）
 */

/** 2 字符 base64 ID 字符表 */
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 计算单行 hash ID。
 * 算法：FNV-1a 32-bit hash（lineNo + lineContent）→ 取高 12 bit → base64 字符 2 个
 */
export function hashLine(lineNo: number, lineContent: string): string {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  const input = `${lineNo}\0${lineContent}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // 取高 12 bit → 0-4095 → 2 个 base64 字符
  const v1 = (hash >>> 12) & 0x3f;
  const v2 = (hash >>> 6) & 0x3f;
  return ID_CHARS[v1]! + ID_CHARS[v2]!;
}

/** 注释一行：`{lineNo}#{id}| {lineContent}` */
export function annotateLine(lineNo: number, lineContent: string): string {
  return `${lineNo}#${hashLine(lineNo, lineContent)}| ${lineContent}`;
}

/** 注释全文：每行带 prefix，空行也带（hash 基于空字符串） */
export function annotateLines(content: string): string {
  // 保留原末尾换行风格
  const lines = content.split('\n');
  const lastIsEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  if (lastIsEmpty) lines.pop();

  const annotated = lines.map((line, idx) => annotateLine(idx + 1, line));
  if (lastIsEmpty) annotated.push('');
  return annotated.join('\n');
}

/** pos 格式：`{lineNo}#{id}`，如 `11#VK` */
const POS_PATTERN = /^(\d+)#([A-Za-z0-9+/]{2})$/;

export type ParsedPos = { line: number; id: string };

/**
 * 解析 pos 字符串为 {line, id}。
 * 失败：throw HashlinePosFormatError
 */
export function parsePos(pos: string): ParsedPos {
  const m = POS_PATTERN.exec(pos);
  if (!m) {
    throw new HashlinePosFormatError(pos);
  }
  return { line: Number.parseInt(m[1]!, 10), id: m[2]! };
}

/** 验证 pos 是否匹配实际文件内容。失败：throw HashlineMismatchError */
export function verifyPos(pos: ParsedPos, content: string): void {
  const lines = content.split('\n');
  const actualLine = lines[pos.line - 1];
  if (actualLine === undefined) {
    throw new HashlineMismatchError(
      `pos ${pos.line}#${pos.id} references line ${pos.line}, but file has only ${lines.length} lines`,
    );
  }
  const expectedId = hashLine(pos.line, actualLine);
  if (expectedId !== pos.id) {
    throw new HashlineMismatchError(
      `pos ${pos.line}#${pos.id} mismatch: file line ${pos.line} has id ${expectedId} (file changed since read)`,
    );
  }
}

/* ===== 错误类 ===== */

class HashlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashlineError';
  }
}

export class HashlinePosFormatError extends HashlineError {
  constructor(pos: string) {
    super(`invalid pos format "${pos}"; expected "{lineNo}#{id}" (e.g. "11#VK")`);
    this.name = 'HashlinePosFormatError';
  }
}

export class HashlineMismatchError extends HashlineError {
  constructor(reason: string) {
    super(`hashline mismatch: ${reason}; re-read the file and use the new pos`);
    this.name = 'HashlineMismatchError';
  }
}
