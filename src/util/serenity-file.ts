/**
 * /.serenity 文件工具 — RR1 验证 + CCC 名读写
 *
 * 文件格式：纯文本，单行，内容 = CCC 名
 * 例：文件内容 "home-serenity" → CCC 名 = "home-serenity"
 *
 * v1.10：新增 write/remove（RR7 init 用）
 */

import { readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SerenityFileEmptyError, SerenityFileNotFoundError, InvalidCccNameError } from '../errors.js';

export const SERENITY_FILENAME = '.serenity';
/**
 * 目录形态标记文件名（2026-08-17 起支持）。
 * 背景：~/.serenity 目录形态被天工凭据目录占用（credentials.json），
 * 屁屁号 CCC 根标记移入目录内同名标记文件。
 */
export const SERENITY_DIR_MARKER = 'ccc-name';

/**
 * 解析 CCC 名来源路径：
 * - 文件形态：<cwdRoot>/.serenity
 * - 目录形态：<cwdRoot>/.serenity/ccc-name（目录内含标记文件）
 * 返回 { path, isDir }
 */
function resolveSerenityMarker(cwdRoot: string): { path: string; isDir: boolean } {
  const base = join(cwdRoot, SERENITY_FILENAME);
  try {
    const st = statSync(base);
    if (st.isDirectory()) {
      return { path: join(base, SERENITY_DIR_MARKER), isDir: true };
    }
  } catch {
    // 不存在或不可读 → 按文件形态处理（readFileSync 会抛 ENOENT）
  }
  return { path: base, isDir: false };
}

/**
 * 从 git root 读取 /.serenity 标记（文件或目录内含 ccc-name），trim 后返回 CCC 名
 * @throws SerenityFileNotFoundError 标记不存在
 * @throws SerenityFileEmptyError 标记内容为空
 */
export function readSerenityFile(cwdRoot: string): string {
  const { path } = resolveSerenityMarker(cwdRoot);
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
  // 验证 CCC 名称为 kebab-case（与 isValidCccName 一致）
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new InvalidCccNameError(name);
  }
  return name;
}

/** 判断标记是否存在（不抛错版本，用于 chat.message hook 探测） */
export function serenityFileExists(cwdRoot: string): boolean {
  const { path } = resolveSerenityMarker(cwdRoot);
  try {
    return existsSync(path);
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
