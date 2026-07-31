/**
 * 哈希工具 —— 使用 Node 内置 crypto，无网络、无外部依赖。
 */

import { createHash } from 'node:crypto';

/** lowercase SHA-256 hex。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 安全校验是否 lowercase SHA-256 hex。 */
export function isLowercaseSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
