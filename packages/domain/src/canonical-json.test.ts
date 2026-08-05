/**
 * 仓库统一 canonical JSON 序列化测试（RW-1-R5, Blocker 7）。
 *
 * 验证强语义：NFC 等价、code-point 排序（astral）、NFC 后 key 冲突拒绝、
 * undefined / 非有限数 / BigInt / Symbol / function 拒绝。
 */

import { describe, it, expect } from 'vitest';
import { canonicalJson, codePointCompare } from './index.js';

describe('canonicalJson', () => {
  it('对象键按 code-point 排序（非 localeCompare）', () => {
    const out = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(out).toBe('{"a":2,"m":3,"z":1}');
  });

  it('NFC 等价：组合字符与预组合字符序列化一致', () => {
    // 'e' + combining acute (NFD) vs 'é' (NFC)
    expect(canonicalJson({ key: 'é' })).toBe(canonicalJson({ key: 'é' }));
  });

  it('astral code-point 排序正确（codePointCompare 而非 charCode）', () => {
    // '😀' (U+1F600) vs 'z' (U+007A)：code-point 上 z < 😀
    expect(codePointCompare('z', '😀')).toBeLessThan(0);
    expect(codePointCompare('😀', 'z')).toBeGreaterThan(0);
  });

  it('NFC 后 key 冲突 → 抛错', () => {
    // raw key 'é' 与 'é' NFC 后同为 'é' → 冲突
    expect(() => canonicalJson({ é: 1, é: 2 })).toThrow(/NFC 后 key 冲突/);
  });

  it('undefined 值 → 抛错', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
  });

  it('非有限数（NaN / Infinity）→ 抛错', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/非有限数/);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/非有限数/);
  });

  it('BigInt / Symbol / function → 抛错', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/BigInt/);
    expect(() => canonicalJson({ a: Symbol('x') })).toThrow(/Symbol/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
  });

  it('数组保序、null/boolean/number/string 基本类型', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
  });
});
