/**
 * Canonical serialization for the writing evaluation suite.
 *
 * 设计说明：domain 包内部的 canonicalize 只针对 CreationContractSections，
 * 未导出且语义不同（这里需要 canonicalize 整个 suite 对象，包含 case/constraint/
 * scene brief/candidate 等），因此在本包实现 suite 专用的 canonical serializer。
 * 算法约定与 domain 保持一致：NFC、key 按 code point 排序、拒绝 undefined。
 * 数组保持原顺序 —— suiteHash 是对“该套件原样”的指纹，顺序属于输入的一部分。
 */

import { codePointCompare } from '@ai-novel/domain';

/** 递归 canonicalize 为纯 JSON 值（NFC 字符串、稳定对象 key 顺序）。 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new Error('canonical 序列化不支持 undefined');
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical 序列化不允许非有限数');
    return value;
  }
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'bigint') throw new Error('canonical 序列化不支持 BigInt');
  if (typeof value === 'symbol') throw new Error('canonical 序列化不支持 Symbol');
  if (typeof value === 'function') throw new Error('canonical 序列化不支持 function');
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const rawKeys = Object.keys(obj);
    const nfcKeys = rawKeys.map((k) => ({ raw: k, nfc: k.normalize('NFC') }));
    const nfcSet = new Set<string>();
    for (const { nfc: nk } of nfcKeys) {
      if (nfcSet.has(nk)) throw new Error(`canonical 序列化: NFC 后 key 冲突 "${nk}"`);
      nfcSet.add(nk);
    }
    nfcKeys.sort((a, b) => codePointCompare(a.nfc, b.nfc));
    const result: Record<string, unknown> = {};
    for (const { raw, nfc: nk } of nfcKeys) {
      const v = obj[raw];
      if (v === undefined) throw new Error(`canonical 序列化不允许 key "${nk}" 为 undefined`);
      result[nk] = canonicalize(v);
    }
    return result;
  }
  throw new Error(`canonical 序列化不支持类型: ${typeof value}`);
}

/** 将已验证（normalized）的 suite 序列化为稳定 JSON 字符串。 */
export function canonicalSerializeSuite(suite: unknown): string {
  return JSON.stringify(canonicalize(suite));
}
