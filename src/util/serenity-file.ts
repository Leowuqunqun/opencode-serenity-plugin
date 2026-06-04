/**
 * /.serenity 文件工具 — RR1 验证 + 实例名读取
 *
 * 文件格式：纯文本，单行，内容 = 实例名
 * 例：文件内容 "home-serenity" → 实例名 = "home-serenity"
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SerenityFileEmptyError, SerenityFileNotFoundError } from '../errors.js';

export const SERENITY_FILENAME = '.serenity';

/**
 * 从 git root 读取 /.serenity 文件，trim 后返回实例名
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
