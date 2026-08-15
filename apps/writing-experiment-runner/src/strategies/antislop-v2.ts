/**
 * antislop-v2 策略：baseline prompt + 显式反 AI 味文风规则，再加检测器驱动的定点改写。
 *
 * 与 v1 的关键区别发生在第一趟：v1 与 baseline 第一趟 prompt 完全相同，
 * v2 在 system prompt 中增加 docs/development/ai-writing-quality.md §4 已确立的
 * Prompt 纪律。第二趟仍与 v1 共享 antislop-shared.ts 中的证据构造与定点改写 prompt。
 */

import type { WritingGenerationExperimentInput } from '@ai-novel/writing-evaluation';
import { buildBaselineOneShotPrompt, type BuiltPrompt } from './baseline-one-shot-v1.js';

export const ANTISLOP_V2_STRATEGY = {
  strategyId: 'antislop-v2',
  strategyVersion: '1',
  promptVersion: 'antislop-v2.p1',
  defaultTemperature: 0.7,
  defaultMaxTokens: 8192,
  concurrency: 1,
  retries: 0,
} as const;

export const ANTISLOP_V2_STRATEGY_ID = ANTISLOP_V2_STRATEGY.strategyId;

/** docs/development/ai-writing-quality.md §4 的 Prompt 纪律，原样进入 v2 system prompt。 */
export const ANTISLOP_V2_STYLE_RULES = [
  '【反 AI 味文风规则】',
  '- 要求具体动作、对白和感官事实；',
  '- 限制连续使用“像/仿佛/似乎”；',
  '- 禁止清单式环境陈列；',
  '- 禁止模板化微表情；',
  '- 禁止空泛套话；',
  '- 禁止模糊拐杖词；',
  '- 禁止否定式排比；',
  '- 禁止强行三段式；',
  '- 禁止解释比喻；',
  '- 禁止结尾强行升华。',
].join('\n');

/**
 * v2 第一趟 prompt = baseline prompt（system + user）在 system 末尾追加反 AI 味规则。
 * user 保持不变，确保逐 case 事实渲染与 baseline 一致，同时 promptHash 必然不同。
 */
export function buildAntislopV2Prompt(input: WritingGenerationExperimentInput): BuiltPrompt {
  const baselinePrompt = buildBaselineOneShotPrompt(input);
  return {
    system: `${baselinePrompt.system}\n\n${ANTISLOP_V2_STYLE_RULES}`,
    user: baselinePrompt.user,
  };
}
