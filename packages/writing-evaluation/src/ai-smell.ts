/**
 * AI-smell 启发式词表信号。
 *
 * 限制（必须保持）：
 * - 出现这些词不等于文章差；
 * - 指标名称体现 heuristic / signal 定位；
 * - 不命名为 AI_DETECTED，不输出“人类概率”/“AI 概率”；
 * - 词表可配置，默认提供中文初始词表。
 */

import { codePointCompare } from '@ai-novel/domain';
import type { AiSmellEntrySignal, AiSmellEvidence, AiSmellSignals } from './schema.js';
import { findPairOccurrences, findPhraseOccurrences, makeExcerpt } from './match.js';
import type { TextSegmentation } from './text.js';

export interface AiSmellLexiconEntry {
  readonly id: string;
  /** 简单短语词条（与 pair 二选一） */
  readonly phrase?: string;
  /** 成对词条，例如 不是……而是…… */
  readonly pair?: { readonly first: string; readonly second: string };
}

export interface AiSmellLexicon {
  readonly version: string;
  readonly entries: readonly AiSmellLexiconEntry[];
}

export const DEFAULT_AI_SMELL_LEXICON: AiSmellLexicon = {
  version: 'v1',
  entries: [
    { id: 'bu-jin', phrase: '不禁' },
    { id: 'fang-fu', phrase: '仿佛' },
    { id: 'si-hu', phrase: '似乎' },
    { id: 'wei-wei', phrase: '微微' },
    { id: 'qiao-ran', phrase: '悄然' },
    { id: 'zhe-yi-ke', phrase: '这一刻' },
    { id: 'bu-zhi-wei-he', phrase: '不知为何' },
    { id: 'yu-ci-tong-shi', phrase: '与此同时' },
    { id: 'jing-ran', phrase: '竟然' },
    { id: 'mo-ming', phrase: '莫名' },
    { id: 'xin-zhong-yi-zhen', phrase: '心中一阵' },
    { id: 'kong-qi-fang-fu-ning-gu', phrase: '空气仿佛凝固' },
    { id: 'nan-yi-yan-yu', phrase: '难以言喻' },
    { id: 'shuo-bu-qing-dao-bu-ming', phrase: '说不清道不明' },
    { id: 'mou-zhong-dong-xi', phrase: '某种东西' },
    { id: 'ruo-you-ruo-wu', phrase: '若有若无' },
    { id: 'yi-shi-zhi-jian', phrase: '一时之间' },
    { id: 'ming-yun-chi-lun', phrase: '命运的齿轮' },
    { id: 'fang-fu-zai-su-shuo', phrase: '仿佛在诉说' },
    { id: 'zheng-ge-shi-jie-an-jing', phrase: '整个世界都安静' },
    { id: 'bu-shi-er-shi', pair: { first: '不是', second: '而是' } },
    { id: 'bu-jin-er-qie', pair: { first: '不仅', second: '而且' } },
  ],
};

/** 每个词条最多记录的 evidence 条数。 */
export const MAX_AI_SMELL_EVIDENCE_PER_ENTRY = 5;

/** 渲染词条匹配模式。 */
export function renderLexiconPattern(entry: AiSmellLexiconEntry): string {
  if (entry.pair) return `${entry.pair.first}……${entry.pair.second}`;
  return entry.phrase ?? entry.id;
}

function evidenceFromMatch(
  lexiconId: string,
  match: {
    paragraphIndex: number;
    sentenceIndex: number;
    sentence: string;
    matchStart: number;
    matchEnd: number;
  },
): AiSmellEvidence {
  return {
    lexiconId,
    paragraphIndex: match.paragraphIndex,
    sentenceIndex: match.sentenceIndex,
    excerpt: makeExcerpt(match.sentence, match.matchStart, match.matchEnd),
  };
}

export function computeAiSmellSignals(
  segmentation: TextSegmentation,
  lexicon: AiSmellLexicon = DEFAULT_AI_SMELL_LEXICON,
): AiSmellSignals {
  const codePointCount = segmentation.codePointCount;
  const entries: AiSmellEntrySignal[] = [];

  let totalCount = 0;

  for (const entry of lexicon.entries) {
    let count = 0;
    let evidence: AiSmellEvidence[] = [];

    if (entry.pair) {
      const matches = findPairOccurrences(segmentation, entry.pair.first, entry.pair.second);
      count = matches.length;
      evidence = matches
        .slice(0, MAX_AI_SMELL_EVIDENCE_PER_ENTRY)
        .map((m) => evidenceFromMatch(entry.id, m));
    } else {
      const phrase = entry.phrase ?? entry.id;
      const matches = findPhraseOccurrences(segmentation, phrase);
      count = matches.length;
      evidence = matches
        .slice(0, MAX_AI_SMELL_EVIDENCE_PER_ENTRY)
        .map((m) => evidenceFromMatch(entry.id, m));
    }

    totalCount += count;
    const perThousandCodePoints = codePointCount > 0 ? (count / codePointCount) * 1000 : 0;

    entries.push({
      lexiconId: entry.id,
      pattern: renderLexiconPattern(entry),
      count,
      perThousandCodePoints,
      evidence,
    });
  }

  entries.sort((a, b) => codePointCompare(a.lexiconId, b.lexiconId));

  const totalPerThousandCodePoints = codePointCount > 0 ? (totalCount / codePointCount) * 1000 : 0;

  return {
    lexiconVersion: lexicon.version,
    entries,
    totalCount,
    totalPerThousandCodePoints,
  };
}
