/**
 * @ai-novel/domain - Manuscript domain tests
 *
 * 覆盖设计 §4（领域模型 / 校验）、§6.1（稀疏排序纯函数）、§6.2（长度与保真）：
 * - branded ID 工厂与闭合枚举校验；
 * - title / content / position / version number 校验；
 * - title trim 非空、content 允许空串、Unicode/换行不规范化、UTF-16 长度边界；
 * - append / prepend / 安全 midpoint / rebalance 布局纯函数（含 overflow 边界）。
 */

import { describe, it, expect } from 'vitest';
import {
  createManuscriptId,
  createChapterId,
  createChapterVersionId,
  isValidManuscriptStatus,
  isValidChapterStatus,
  isValidChapterVersionSourceType,
  validateManuscriptTitle,
  validateChapterContent,
  isValidPosition,
  isValidVersionNumber,
  isLowercaseSha256Hex,
  computeAppendPosition,
  computePrependPosition,
  computeInsertBeforePosition,
  computeRebalancedLayout,
  POSITION_GAP,
  POSITION_LIMIT,
  FIRST_POSITION,
  MANUSCRIPT_TITLE_MAX_LENGTH,
  CHAPTER_CONTENT_MAX_LENGTH,
  MANUSCRIPT_DEFAULT_TITLE,
} from './manuscript.js';
import { isLowercaseSha256Hex } from './creation-contract.js';

describe('branded ID 工厂', () => {
  it('合法 ID 创建成功', () => {
    expect(createManuscriptId('m1')).toBe('m1');
    expect(createChapterId('c1')).toBe('c1');
    expect(createChapterVersionId('v1')).toBe('v1');
  });

  it('空 / 空白 ID 被拒', () => {
    expect(() => createManuscriptId('')).toThrow();
    expect(() => createChapterId('   ')).toThrow();
    expect(() => createChapterVersionId('')).toThrow();
  });
});

describe('闭合枚举校验', () => {
  it('manuscript status', () => {
    expect(isValidManuscriptStatus('active')).toBe(true);
    expect(isValidManuscriptStatus('archived')).toBe(true);
    expect(isValidManuscriptStatus('deleted')).toBe(false);
    expect(isValidManuscriptStatus(1)).toBe(false);
  });

  it('chapter status', () => {
    expect(isValidChapterStatus('active')).toBe(true);
    expect(isValidChapterStatus('archived')).toBe(true);
    expect(isValidChapterStatus('draft')).toBe(false);
  });

  it('sourceType 闭合枚举', () => {
    for (const s of ['USER', 'AI_GENERATION', 'AI_REWRITE', 'IMPORT', 'RESTORE']) {
      expect(isValidChapterVersionSourceType(s)).toBe(true);
    }
    expect(isValidChapterVersionSourceType('AI_DRAFT')).toBe(false);
    expect(isValidChapterVersionSourceType('')).toBe(false);
  });
});

describe('标题校验', () => {
  it('trim 后非空，返回 trim 值', () => {
    expect(validateManuscriptTitle('  第一章  ')).toBe('第一章');
  });

  it('空白标题被拒', () => {
    expect(() => validateManuscriptTitle('   ')).toThrow();
    expect(() => validateManuscriptTitle('')).toThrow();
  });

  it('非字符串被拒', () => {
    expect(() => validateManuscriptTitle(42)).toThrow();
  });

  it('≤ 200 UTF-16 code units（String.length）', () => {
    expect(validateManuscriptTitle('章'.repeat(200)).length).toBe(200);
    expect(() => validateManuscriptTitle('章'.repeat(201))).toThrow();
  });

  it('边界用 astral 字符计数为 2 个 code units', () => {
    // '𝄞' 占 2 个 UTF-16 code units
    const s = '𝄞'.repeat(100);
    expect(s.length).toBe(200);
    expect(validateManuscriptTitle(s).length).toBe(200);
    expect(() => validateManuscriptTitle('𝄞'.repeat(101))).toThrow();
  });
});

describe('正文校验', () => {
  it('允许空字符串', () => {
    expect(validateChapterContent('')).toBe('');
    expect(validateChapterContent('   ')).toBe('   '); // 不 trim
  });

  it('不 trim、不规范化、保留原始换行', () => {
    const raw = '  第一行  \n\r\n  第二行\t';
    expect(validateChapterContent(raw)).toBe(raw);
    // 不做 NFC：组合字符原样保留
    const decomposed = 'é';
    expect(validateChapterContent(decomposed)).toBe(decomposed);
  });

  it('≤ 1,000,000 UTF-16 code units（String.length）', () => {
    expect(validateChapterContent('a'.repeat(CHAPTER_CONTENT_MAX_LENGTH)).length).toBe(
      CHAPTER_CONTENT_MAX_LENGTH,
    );
    expect(() => validateChapterContent('a'.repeat(CHAPTER_CONTENT_MAX_LENGTH + 1))).toThrow();
  });

  it('非字符串被拒', () => {
    expect(() => validateChapterContent(null)).toThrow();
  });
});

describe('position / versionNumber / hash 校验', () => {
  it('position 必须为正安全整数', () => {
    expect(isValidPosition(1)).toBe(true);
    expect(isValidPosition(POSITION_LIMIT)).toBe(true);
    expect(isValidPosition(0)).toBe(false);
    expect(isValidPosition(-1)).toBe(false);
    expect(isValidPosition(1.5)).toBe(false);
    expect(isValidPosition(POSITION_LIMIT + 1)).toBe(false); // unsafe
    expect(isValidPosition(NaN)).toBe(false);
    expect(isValidPosition('1')).toBe(false);
  });

  it('versionNumber 必须为正安全整数', () => {
    expect(isValidVersionNumber(1)).toBe(true);
    expect(isValidVersionNumber(0)).toBe(false);
    expect(isValidVersionNumber(1.5)).toBe(false);
    expect(isValidVersionNumber(POSITION_LIMIT)).toBe(true);
  });

  it('SHA-256 hex 校验', () => {
    expect(isLowercaseSha256Hex('a'.repeat(64))).toBe(true);
    expect(isLowercaseSha256Hex('A'.repeat(64))).toBe(false);
    expect(isLowercaseSha256Hex('a'.repeat(63))).toBe(false);
  });
});

describe('append 目标（§6.1）', () => {
  it('M 正常时返回 M + GAP', () => {
    expect(computeAppendPosition(FIRST_POSITION)).toBe(FIRST_POSITION + POSITION_GAP);
    expect(computeAppendPosition(0)).toBe(POSITION_GAP);
  });

  it('M 逼近 LIMIT 时返回 null（触发 rebalance / overflow 判定）', () => {
    // M = LIMIT - GAP + 1 > LIMIT - GAP → null
    expect(computeAppendPosition(POSITION_LIMIT - POSITION_GAP + 1)).toBeNull();
    expect(computeAppendPosition(POSITION_LIMIT)).toBeNull();
  });

  it('非法 M 返回 null', () => {
    expect(computeAppendPosition(-1)).toBeNull();
    expect(computeAppendPosition(POSITION_LIMIT + 1)).toBeNull();
    expect(computeAppendPosition(NaN)).toBeNull();
  });
});

describe('prepend 目标（§6.1）', () => {
  it('连续 prepend：2048 → 1024 → 512 → … → 1', () => {
    let first = FIRST_POSITION;
    const seen = [first];
    for (;;) {
      const next = computePrependPosition(first);
      if (next === null) break;
      seen.push(next);
      first = next;
    }
    expect(seen).toEqual([2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
  });

  it('F == 1 时返回 null（撞 0 → rebalance）', () => {
    expect(computePrependPosition(1)).toBeNull();
  });

  it('非法 F 返回 null', () => {
    expect(computePrependPosition(0)).toBeNull();
    expect(computePrependPosition(-1)).toBeNull();
    expect(computePrependPosition(NaN)).toBeNull();
  });
});

describe('insert-before 安全 midpoint（§6.1）', () => {
  it('用 P + floor((X - P) / 2)，大整数无 unsafe 中间和', () => {
    const P = POSITION_LIMIT - 200;
    const X = POSITION_LIMIT - 100;
    const mid = computeInsertBeforePosition(P, X);
    expect(mid).toBe(P + Math.floor((X - P) / 2));
    expect(mid).toBeGreaterThan(P);
    expect(mid).toBeLessThan(X);
  });

  it('gap >= 2 时返回严格中间值', () => {
    expect(computeInsertBeforePosition(2048, 2048 + 1024)).toBe(2048 + 512);
    expect(computeInsertBeforePosition(10, 15)).toBe(12); // floor((15-10)/2)=2 → 12
  });

  it('gap == 1 时返回 null（需要 rebalance）', () => {
    expect(computeInsertBeforePosition(10, 11)).toBeNull();
  });

  it('非法输入返回 null', () => {
    expect(computeInsertBeforePosition(10, 10)).toBeNull(); // P >= X
    expect(computeInsertBeforePosition(15, 10)).toBeNull();
    expect(computeInsertBeforePosition(-1, 10)).toBeNull();
    expect(computeInsertBeforePosition(POSITION_LIMIT + 1, 10)).toBeNull();
  });
});

describe('rebalance 布局（§6.1）', () => {
  it('n 个 rank 得到最终 (r + 2) * GAP', () => {
    const result = computeRebalancedLayout(3, FIRST_POSITION);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.layout.finalPositions).toEqual([
      3 * POSITION_GAP,
      4 * POSITION_GAP,
      5 * POSITION_GAP,
    ]);
    expect(result.layout.maxFinal).toBe(5 * POSITION_GAP);
  });

  it('临时值域精确为 TEMP_BASE .. TEMP_BASE + n - 1，且全部 > B', () => {
    const result = computeRebalancedLayout(4, 100);
    if (result.status !== 'ok') throw new Error('expected ok');
    const { tempPositions, tempBase, b } = result.layout;
    expect(tempBase).toBe(b + 1);
    expect(tempPositions).toEqual([tempBase, tempBase + 1, tempBase + 2, tempBase + 3]);
    // 最大临时值 = B + n <= LIMIT
    expect(tempPositions[tempPositions.length - 1]).toBeLessThanOrEqual(POSITION_LIMIT);
    // 全部临时值互异且 > 任何最终值（两阶段安全）
    expect(new Set(tempPositions).size).toBe(4);
    expect(Math.max(...tempPositions)).toBeLessThanOrEqual(POSITION_LIMIT);
  });

  it('B = max(M, maxFinal)', () => {
    // M 大于 maxFinal 时 B = M
    const r1 = computeRebalancedLayout(2, 100_000);
    if (r1.status !== 'ok') throw new Error('expected ok');
    expect(r1.layout.b).toBe(100_000);
    expect(r1.layout.maxFinal).toBe(4 * POSITION_GAP);
    // M 小于 maxFinal 时 B = maxFinal
    const r2 = computeRebalancedLayout(2, 10);
    if (r2.status !== 'ok') throw new Error('expected ok');
    expect(r2.layout.b).toBe(r2.layout.maxFinal);
  });

  it('final-count overflow：n 超过 floor(LIMIT / GAP) - 2', () => {
    const hugeN = Math.floor(POSITION_LIMIT / POSITION_GAP) - 1;
    const result = computeRebalancedLayout(hugeN, 0);
    expect(result).toEqual({ status: 'overflow', reason: 'final-count' });
  });

  it('temporary-domain overflow：B > LIMIT - n 整笔拒绝', () => {
    // n 合法但 B 逼近 LIMIT：n=6, M=LIMIT-5 → B=LIMIT-5 > LIMIT-6
    const result = computeRebalancedLayout(6, POSITION_LIMIT - 5);
    expect(result).toEqual({ status: 'overflow', reason: 'temporary-domain' });
  });

  it('临时值最大项 B + n 不越过 LIMIT（成功路径）', () => {
    // n=5, M=LIMIT-10 → B=LIMIT-10, LIMIT-n=LIMIT-5, 通过
    const result = computeRebalancedLayout(5, POSITION_LIMIT - 10);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const maxTemp = result.layout.tempPositions[4];
    expect(maxTemp).toBeLessThanOrEqual(POSITION_LIMIT);
  });

  it('非法 n / maxPosition 返回 overflow', () => {
    expect(computeRebalancedLayout(0, 0)).toEqual({ status: 'overflow', reason: 'final-count' });
    expect(computeRebalancedLayout(-1, 0)).toEqual({ status: 'overflow', reason: 'final-count' });
    expect(computeRebalancedLayout(2, -1)).toEqual({
      status: 'overflow',
      reason: 'temporary-domain',
    });
  });

  it('常量正确', () => {
    expect(FIRST_POSITION).toBe(2048);
    expect(MANUSCRIPT_DEFAULT_TITLE).toBe('未命名稿件');
    expect(MANUSCRIPT_TITLE_MAX_LENGTH).toBe(200);
  });
});
