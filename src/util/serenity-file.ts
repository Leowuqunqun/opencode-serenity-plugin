/**
 * /.serenity 文件工具 — RR1 验证 + CCC 名读写
 *
 * 文件格式：纯文本，单行，内容 = CCC 名
 * 例：文件内容 "home-serenity" → CCC 名 = "home-serenity"
 *
 * v1.10：新增 write/remove（RR7 init 用）
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SerenityFileEmptyError, SerenityFileNotFoundError } from '../errors.js';

export const SERENITY_FILENAME = '.serenity';

/**
 * 从 git root 读取 /.serenity 文件，trim 后返回 CCC 名
 * @throws SerenityFileNotFoundError 文件不存在
 * @throws SerenityFileEmptyError 文件内容为空
 */
export function readSerenityFile(cwdRoot: string): string {
  const path = join(cwdRoot, SERENITY_FILENAME);
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SerenityFileNotFoundError(cwdRoot);
    }
    throw err;
  }
  const name = content.trim();
  if (name === '') {
    throw new SerenityFileEmptyError(path);
  }
  return name;
}

/** 判断文件是否存在（不抛错版本，用于 chat.message hook 探测） */
export function serenityFileExists(cwdRoot: string): boolean {
  try {
    readFileSync(join(cwdRoot, SERENITY_FILENAME), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 写 `/.serenity`（创建或覆盖）。
 * 内容 = cccName + '\n'（保持文件以换行结尾）。
 * v1.10：RR7 init 主路径使用。
 * @throws 如果 cwdRoot 不可写则透传 fs 错误
 */
export function writeSerenityFile(cwdRoot: string, cccName: string): void {
  const path = join(cwdRoot, SERENITY_FILENAME);
  writeFileSync(path, cccName + '\n', 'utf8');
}

/**
 * 删 `/.serenity`（v1.10：RR7 init rollback 用）。
 * 文件不存在（ENOENT）静默忽略；其他错误透传。
 */
export function removeSerenityFile(cwdRoot: string): void {
  try {
    unlinkSync(join(cwdRoot, SERENITY_FILENAME));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
