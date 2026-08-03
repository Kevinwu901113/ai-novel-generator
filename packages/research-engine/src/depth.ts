/**
 * 调研强度判断（none / light / deep）。
 *
 * 决定因素：题材是否依赖现实事实、用户是否要求真实性、是否涉及具体时代/地域/职业/事件、
 * 现有输入是否足够、调研成本与创作收益。
 */

import type { ResearchDepth, ResearchInput } from './research-types.js';

const REAL_WORLD_REQUIRING_KEYWORDS: ReadonlyArray<string> = [
  '真实',
  '历史',
  '时代',
  '朝代',
  '晚清',
  '民国',
  '古代',
  '中世纪',
  '二战',
  '史实',
  '职业',
  '地区',
  '城市',
  '国家',
  '事件',
  '背景设定',
  '考据',
  '细节',
];

/** 简单关键字判断题材是否依赖现实事实 */
export function dependsOnRealWorldFacts(text: string): boolean {
  const lower = text.toLowerCase();
  return REAL_WORLD_REQUIRING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 判断调研强度。
 * - 用户要求真实性 → light/deep；
 * - 题材依赖现实事实 → deep（涉及具体时代/地域/职业/事件）；
 * - 否则 → none。
 */
export function determineResearchDepth(input: ResearchInput): ResearchDepth {
  if (
    !input.requiresFactuality &&
    !dependsOnRealWorldFacts(input.idea + input.creationSpecSummary)
  ) {
    return 'none';
  }
  // 轻量 vs 深度：深度调研覆盖具体事实依赖；轻量覆盖一般真实性诉求
  const deepSignals = [
    '历史',
    '时代',
    '朝代',
    '晚清',
    '民国',
    '古代',
    '中世纪',
    '职业',
    '地区',
    '城市',
    '国家',
    '事件',
  ];
  const combined = input.idea + input.creationSpecSummary;
  if (deepSignals.some((s) => combined.includes(s))) return 'deep';
  return 'light';
}
