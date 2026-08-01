/**
 * 自动指标 V1。
 *
 * 客观统计与启发式信号。指标名称体现 heuristic / signal 定位，
 * 不输出“人类概率”或“AI 概率”，不提供单一总分。
 */

import { codePointCompare } from '@ai-novel/domain';
import type {
  BasicStats,
  DistributionStats,
  RepeatedNgram,
  RepeatedOpener,
  RepetitionMetrics,
} from './schema.js';
import { computeDistribution } from './stats.js';
import { containsWhitespace, hasSubstantiveContent, type TextSegmentation } from './text.js';

// ── 基础统计 ──────────────────────────────────────────────────────

export function computeBasicStats(segmentation: TextSegmentation): BasicStats {
  return {
    codePointCount: segmentation.codePointCount,
    paragraphCount: segmentation.paragraphs.length,
    sentenceCount: segmentation.sentences.length,
    dialogueCodePointRatio: segmentation.dialogueCodePointRatio,
  };
}

// ── 分布指标 ──────────────────────────────────────────────────────

export function computeSentenceLengthDistribution(
  segmentation: TextSegmentation,
): DistributionStats {
  const lengths = segmentation.sentences.map((s) => Array.from(s).length);
  return computeDistribution(lengths);
}

export function computeParagraphLengthDistribution(
  segmentation: TextSegmentation,
): DistributionStats {
  const lengths = segmentation.paragraphs.map((p) => Array.from(p).length);
  return computeDistribution(lengths);
}

// ── 重复信号 ──────────────────────────────────────────────────────

const TOP_NGRAMS_PER_N = 3;
const TOP_OPENERS = 5;

/**
 * 句子开词：句子中第一个实质字符（跳过前导引号、省略号、空白）。
 * 这样对话引号不会把所有台词都归入同一 opener，保留人物声音差异。
 */
export function sentenceOpener(sentence: string): string {
  for (const c of sentence) {
    if (hasSubstantiveContent(c)) return c;
  }
  // 句子已经过实质内容过滤，理论上到不了这里；兜底返回首字符。
  return Array.from(sentence)[0] ?? '';
}

/** 重复句子比例：1 - 唯一句子数 / 句子数。空文本为 0。 */
export function duplicateSentenceRatio(sentences: readonly string[]): number {
  if (sentences.length === 0) return 0;
  const unique = new Set(sentences).size;
  return (sentences.length - unique) / sentences.length;
}

/** 句子开词重复比例：1 - 唯一 opener 数 / 句子数。 */
export function repeatedSentenceOpenerRatio(sentences: readonly string[]): number {
  if (sentences.length === 0) return 0;
  const openers = sentences.map(sentenceOpener);
  const unique = new Set(openers).size;
  return (sentences.length - unique) / sentences.length;
}

/**
 * 字符 n-gram 重复比例。
 *
 * 规则（已记录）：
 * - 基于 code points，不使用 UTF-16 index；
 * - 跳过包含空白字符的窗口；
 * - 跳过纯标点窗口（无实质内容）；
 * - ratio = (窗口总数 - 唯一窗口数) / 窗口总数；无窗口时为 0。
 */
export function repeatedCharacterNgramRatio(segmentation: TextSegmentation, n: number): number {
  if (n <= 0) throw new Error(`n-gram 的 n 必须是正整数: ${n}`);
  const cps = Array.from(segmentation.normalizedText);
  if (cps.length < n) return 0;

  const windows: string[] = [];
  for (let i = 0; i <= cps.length - n; i += 1) {
    const window = cps.slice(i, i + n).join('');
    if (containsWhitespace(window)) continue;
    if (!hasSubstantiveContent(window)) continue;
    windows.push(window);
  }
  if (windows.length === 0) return 0;

  const unique = new Set(windows).size;
  return (windows.length - unique) / windows.length;
}

/**
 * 跨 n ∈ {2,3,4} 的 top n-gram 列表。
 * 排序：n 升序，count 降序，code point 升序。
 */
export function topRepeatedNgrams(segmentation: TextSegmentation): RepeatedNgram[] {
  const result: RepeatedNgram[] = [];
  for (const n of [2, 3, 4]) {
    const cps = Array.from(segmentation.normalizedText);
    const counts = new Map<string, number>();
    if (cps.length >= n) {
      for (let i = 0; i <= cps.length - n; i += 1) {
        const window = cps.slice(i, i + n).join('');
        if (containsWhitespace(window)) continue;
        if (!hasSubstantiveContent(window)) continue;
        counts.set(window, (counts.get(window) ?? 0) + 1);
      }
    }
    const sorted = [...counts.entries()]
      .map(([ngram, count]) => ({ n, ngram, count }))
      // 只保留真正的重复项（count > 1）；无重复时返回空数组
      .filter((x) => x.count > 1)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return codePointCompare(a.ngram, b.ngram);
      })
      .slice(0, TOP_NGRAMS_PER_N);
    result.push(...sorted);
  }
  return result;
}

/** top 句子开词（count 降序，code point 升序）。 */
export function topRepeatedSentenceOpeners(sentences: readonly string[]): RepeatedOpener[] {
  const counts = new Map<string, number>();
  for (const s of sentences) {
    const opener = sentenceOpener(s);
    counts.set(opener, (counts.get(opener) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .map(([opener, count]) => ({ opener, count }))
      // 只保留真正的重复开词（count > 1）；无重复时返回空数组
      .filter((x) => x.count > 1)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return codePointCompare(a.opener, b.opener);
      })
      .slice(0, TOP_OPENERS)
  );
}

export function computeRepetitionMetrics(segmentation: TextSegmentation): RepetitionMetrics {
  return {
    duplicateSentenceRatio: duplicateSentenceRatio(segmentation.sentences),
    repeatedCharacterNgramRatio: {
      n2: repeatedCharacterNgramRatio(segmentation, 2),
      n3: repeatedCharacterNgramRatio(segmentation, 3),
      n4: repeatedCharacterNgramRatio(segmentation, 4),
    },
    repeatedSentenceOpenerRatio: repeatedSentenceOpenerRatio(segmentation.sentences),
    topRepeatedNgrams: topRepeatedNgrams(segmentation),
    topRepeatedSentenceOpeners: topRepeatedSentenceOpeners(segmentation.sentences),
  };
}
