/**
 * 短语匹配（句子级）。
 *
 * 为 evidence 提供 paragraph/sentence 定位。匹配基于句子内部，
 * 因此 count 与 evidence 天然一致。短语必须先 trim。
 */

import type { TextSegmentation } from './text.js';

/** 短 excerpt 的最大 code points。 */
export const MAX_EXCERPT_CODE_POINTS = 40;

export interface PhraseMatch {
  readonly paragraphIndex: number;
  readonly sentenceIndex: number;
  readonly sentence: string;
  /** 在句子 code point 数组中的匹配起点 */
  readonly matchStart: number;
  /** 在句子 code point 数组中的匹配终点（不含） */
  readonly matchEnd: number;
}

/** 在单个句子内做非重叠匹配。 */
function findInSentence(sentence: string, phrase: string): Array<{ start: number; end: number }> {
  const sCps = Array.from(sentence);
  const pCps = Array.from(phrase);
  if (pCps.length === 0) throw new Error('短语不能为空');
  const result: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i <= sCps.length - pCps.length) {
    let matched = true;
    for (let k = 0; k < pCps.length; k += 1) {
      if (sCps[i + k] !== pCps[k]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      result.push({ start: i, end: i + pCps.length });
      i += pCps.length;
    } else {
      i += 1;
    }
  }
  return result;
}

/** 在 segmentation 中查找短语的所有出现（句子级，非重叠）。 */
export function findPhraseOccurrences(
  segmentation: TextSegmentation,
  phrase: string,
): PhraseMatch[] {
  const result: PhraseMatch[] = [];
  for (let pi = 0; pi < segmentation.sentenceGroups.length; pi += 1) {
    const group = segmentation.sentenceGroups[pi];
    for (let si = 0; si < group.length; si += 1) {
      const sentence = group[si];
      for (const { start, end } of findInSentence(sentence, phrase)) {
        result.push({
          paragraphIndex: pi,
          sentenceIndex: si,
          sentence,
          matchStart: start,
          matchEnd: end,
        });
      }
    }
  }
  return result;
}

/**
 * 查找成对模式（例如“不是……而是……”）的出现。
 * 每个匹配为一次 first→second 配对扫描；一次配对算一次出现。
 */
export function findPairOccurrences(
  segmentation: TextSegmentation,
  first: string,
  second: string,
): PhraseMatch[] {
  const result: PhraseMatch[] = [];
  for (let pi = 0; pi < segmentation.sentenceGroups.length; pi += 1) {
    const group = segmentation.sentenceGroups[pi];
    for (let si = 0; si < group.length; si += 1) {
      const sentence = group[si];
      const sCps = Array.from(sentence);
      const fCps = Array.from(first);
      const sndCps = Array.from(second);
      let i = 0;
      while (i <= sCps.length - Math.max(fCps.length, sndCps.length)) {
        const firstStart = indexOfFrom(sCps, fCps, i);
        if (firstStart === -1) break;
        const secondStart = indexOfFrom(sCps, sndCps, firstStart + fCps.length);
        if (secondStart === -1) break;
        result.push({
          paragraphIndex: pi,
          sentenceIndex: si,
          sentence,
          matchStart: firstStart,
          matchEnd: secondStart + sndCps.length,
        });
        i = secondStart + sndCps.length;
      }
    }
  }
  return result;
}

function indexOfFrom(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) throw new Error('短语不能为空');
  for (let i = from; i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/** 生成短 excerpt：以匹配为中心取窗口，默认不超过 MAX_EXCERPT_CODE_POINTS。 */
export function makeExcerpt(
  sentence: string,
  matchStart: number,
  matchEnd: number,
  maxLength: number = MAX_EXCERPT_CODE_POINTS,
): string {
  const sCps = Array.from(sentence);
  const phraseLen = matchEnd - matchStart;
  if (sCps.length <= maxLength) return sentence;
  const half = Math.floor((maxLength - phraseLen) / 2);
  let start = Math.max(0, matchStart - half);
  const end = Math.min(sCps.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  return sCps.slice(start, end).join('');
}
