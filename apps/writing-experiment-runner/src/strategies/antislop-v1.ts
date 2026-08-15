/**
 * antislop-v1 策略：baseline 初稿 + AI-smell 检测驱动的定点改写。
 *
 * 设计原则（docs/development/ai-writing-quality.md §4）：
 * 检测 → 给出可定位问题 → 定点改写 → 再审查。
 *
 * 第一趟复用 baseline 的 prompt 构建（同输入 → 同初稿 prompt）。
 * 第二趟只把 computeAiSmellSignals 定位到的具体句子/词组交给模型做定点修改，
 * 不要求模型“笼统地写得别像 AI”，也不重写整段。
 */

export const ANTISLOP_V1_STRATEGY = {
  strategyId: 'antislop-v1',
  strategyVersion: '1',
  promptVersion: 'antislop-v1.p1',
  defaultTemperature: 0.7,
  defaultMaxTokens: 8192,
  concurrency: 1,
  retries: 0,
} as const;

export const ANTISLOP_STRATEGY_ID = ANTISLOP_V1_STRATEGY.strategyId;

export {
  buildAntislopRevisionPrompt,
  collectAntislopEvidence,
  type AntislopEvidence,
} from './antislop-shared.js';
