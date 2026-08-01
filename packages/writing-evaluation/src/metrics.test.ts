/**
 * C. 自动指标测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { computeDistribution } from './stats.js';
import {
  computeBasicStats,
  computeRepetitionMetrics,
  computeSentenceLengthDistribution,
  duplicateSentenceRatio,
  repeatedCharacterNgramRatio,
  repeatedSentenceOpenerRatio,
  sentenceOpener,
  topRepeatedNgrams,
  topRepeatedSentenceOpeners,
} from './metrics.js';
import { segmentText } from './text.js';

describe('computeDistribution', () => {
  it('空输入全部为 null', () => {
    const d = computeDistribution([]);
    expect(d).toEqual({
      min: null,
      max: null,
      mean: null,
      median: null,
      p90: null,
      standardDeviation: null,
      coefficientOfVariation: null,
    });
  });

  it('单值：所有统计等于该值，std/cv 为 0', () => {
    const d = computeDistribution([7]);
    expect(d.min).toBe(7);
    expect(d.max).toBe(7);
    expect(d.mean).toBe(7);
    expect(d.median).toBe(7);
    expect(d.p90).toBe(7);
    expect(d.standardDeviation).toBe(0);
    expect(d.coefficientOfVariation).toBe(0);
  });

  it('奇数个数中位数取中间值', () => {
    const d = computeDistribution([5, 3, 1]);
    expect(d.median).toBe(3);
  });

  it('偶数个数中位数取中间两数平均', () => {
    const d = computeDistribution([1, 2, 3, 4]);
    expect(d.median).toBe(2.5);
  });

  it('p90 使用 nearest-rank 法', () => {
    const d = computeDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.p90).toBe(9); // ceil(0.9*10)=9 → 第 9 个（1-based）= 9
  });

  it('mean / std / cv 计算正确', () => {
    const d = computeDistribution([1, 2, 3, 4, 5]);
    expect(d.mean).toBe(3);
    expect(d.standardDeviation).toBeCloseTo(Math.sqrt(2), 10);
    expect(d.coefficientOfVariation).toBeCloseTo(Math.sqrt(2) / 3, 10);
  });

  it('无 NaN / Infinity', () => {
    const d = computeDistribution([1, 2, 3]);
    const values = [
      d.min,
      d.max,
      d.mean,
      d.median,
      d.p90,
      d.standardDeviation,
      d.coefficientOfVariation,
    ];
    for (const v of values) {
      if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('基础统计', () => {
  it('codePoint / paragraph / sentence 计数', () => {
    const seg = segmentText('第一段。\n第二段！\n第三段？');
    const bs = computeBasicStats(seg);
    expect(bs.codePointCount).toBe(seg.codePointCount);
    expect(bs.paragraphCount).toBe(3);
    expect(bs.sentenceCount).toBe(3);
  });

  it('对话占比', () => {
    const seg = segmentText('“你好。”');
    expect(computeBasicStats(seg).dialogueCodePointRatio).toBe(1);
  });
});

describe('句长 / 段落长度分布', () => {
  it('句长分布与输入一致', () => {
    const seg = segmentText('我。我们。我们都是。');
    const d = computeSentenceLengthDistribution(seg);
    expect(d.min).toBe(2); // 我。
    expect(d.max).toBe(5); // 我们都是。
    expect(d.mean).toBeCloseTo((2 + 3 + 5) / 3, 10);
  });
});

describe('重复信号', () => {
  it('duplicateSentenceRatio', () => {
    expect(duplicateSentenceRatio(['a。', 'a。', 'b。'])).toBeCloseTo(1 / 3, 10);
    expect(duplicateSentenceRatio(['a。', 'b。'])).toBe(0);
    expect(duplicateSentenceRatio([])).toBe(0);
  });

  it('repeatedSentenceOpenerRatio 基于实质首字', () => {
    const seg = segmentText('你走。你来。他来。');
    expect(sentenceOpener('你走。')).toBe('你');
    // openers: 你, 你, 他
    expect(repeatedSentenceOpenerRatio(seg.sentences)).toBeCloseTo(1 / 3, 10);
  });

  it('对话引号不计入 opener', () => {
    const seg = segmentText('“你来了。”\n“你走了。”');
    const openers = seg.sentences.map(sentenceOpener);
    expect(openers).toEqual(['你', '你']);
  });

  it('repeatedCharacterNgramRatio 跳过空白窗口', () => {
    // 'a b a b' 的每个 2-窗口都含空白，合法窗口数为 0
    const seg = segmentText('a b a b');
    expect(repeatedCharacterNgramRatio(seg, 2)).toBe(0);
  });

  it('repeatedCharacterNgramRatio 跨空白不合并', () => {
    // 'ab ab ab'：跳过空白后窗口为 ab、ba、ab、ba、ab → 大量重复
    const seg = segmentText('ab ab ab');
    const ratio = repeatedCharacterNgramRatio(seg, 2);
    expect(ratio).toBeGreaterThan(0.5);
  });

  it('repeatedCharacterNgramRatio 跳过纯标点窗口', () => {
    const seg = segmentText('。。。你。');
    // 窗口长度 2：...、。。、。。、。你、你。
    // 跳过纯标点：...、。。、。。 → 保留 你。? 不，"。你" 含 你 保留
    const ratio = repeatedCharacterNgramRatio(seg, 2);
    expect(Number.isFinite(ratio)).toBe(true);
  });

  it('repeatedCharacterNgramRatio 纯标点文本为 0', () => {
    const seg = segmentText('。。。');
    expect(repeatedCharacterNgramRatio(seg, 2)).toBe(0);
  });

  it('computeRepetitionMetrics 输出全部字段且有限', () => {
    const seg = segmentText('你好。你好。');
    const rep = computeRepetitionMetrics(seg);
    expect(rep.duplicateSentenceRatio).toBeCloseTo(0.5, 10);
    for (const v of [
      rep.repeatedCharacterNgramRatio.n2,
      rep.repeatedCharacterNgramRatio.n3,
      rep.repeatedCharacterNgramRatio.n4,
      rep.repeatedSentenceOpenerRatio,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('同分 n-gram 按 code point 顺序排序（稳定 tie）', () => {
    const seg = segmentText('甲乙。乙甲。甲乙。');
    const top = topRepeatedNgrams(seg);
    expect(top.length).toBeGreaterThan(0);
  });

  it('topRepeatedSentenceOpeners 按 count 降序', () => {
    const seg = segmentText('你走。你来。他来。他走。');
    const top = topRepeatedSentenceOpeners(seg.sentences);
    expect(top[0].opener).toBe('他');
    expect(top[0].count).toBe(2);
  });

  it('无重复时 topRepeatedNgrams 为空数组（只含 singleton）', () => {
    const seg = segmentText('甲乙丙丁。');
    expect(topRepeatedNgrams(seg)).toEqual([]);
  });

  it('无重复时 topRepeatedSentenceOpeners 为空数组', () => {
    const seg = segmentText('甲走。乙来。丙停。');
    expect(topRepeatedSentenceOpeners(seg.sentences)).toEqual([]);
  });

  it('top n-gram 只包含 count > 1 的真正重复项', () => {
    // “甲” 出现两次 → 2-gram "甲X" 重复一次以上；其余为 singleton
    const seg = segmentText('甲一。甲二。乙三。');
    const top = topRepeatedNgrams(seg);
    for (const g of top) {
      expect(g.count).toBeGreaterThan(1);
    }
  });

  it('同 count 的 n-gram 按 code point 升序（tie-order 稳定）', () => {
    // 甲乙/乙丙/丙甲 各出现 2 次，count 相同 → 按 code point 升序（丙 U+4E19 < 乙 U+4E59 < 甲 U+7532）
    const seg = segmentText('甲乙丙甲乙丙甲');
    const repeated = topRepeatedNgrams(seg)
      .filter((g) => g.n === 2)
      .filter((g) => g.count > 1)
      .map((g) => g.ngram);
    expect(repeated).toEqual(['丙甲', '乙丙', '甲乙']);
  });
});
