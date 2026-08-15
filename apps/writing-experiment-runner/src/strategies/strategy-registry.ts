/**
 * writing-experiment 策略注册表。
 *
 * Runner 与 dry-run 从这里解析 --strategy，避免单策略硬编码。
 * 每个策略定义包含可追溯元数据（strategyId / strategyVersion / promptVersion）、
 * 默认参数与第一趟 prompt 构建函数。
 */

import type { WritingGenerationExperimentInput } from '@ai-novel/writing-evaluation';
import { CliUsageError } from '../safe-error.js';
import {
  BASELINE_ONE_SHOT_STRATEGY,
  BASELINE_STRATEGY_ID,
  buildBaselineOneShotPrompt,
  type BuiltPrompt,
} from './baseline-one-shot-v1.js';
import { ANTISLOP_STRATEGY_ID, ANTISLOP_V1_STRATEGY } from './antislop-v1.js';

export interface StrategyDefinition {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly promptVersion: string;
  readonly defaultTemperature: number;
  readonly defaultMaxTokens: number;
  readonly concurrency: number;
  readonly retries: number;
  readonly buildPrompt: (input: WritingGenerationExperimentInput) => BuiltPrompt;
}

export const STRATEGY_REGISTRY: Readonly<Record<string, StrategyDefinition>> = {
  [BASELINE_STRATEGY_ID]: {
    ...BASELINE_ONE_SHOT_STRATEGY,
    buildPrompt: buildBaselineOneShotPrompt,
  },
  [ANTISLOP_STRATEGY_ID]: {
    ...ANTISLOP_V1_STRATEGY,
    // antislop 第一趟与 baseline 同 prompt；第二趟由检测器定位出的证据驱动。
    buildPrompt: buildBaselineOneShotPrompt,
  },
};

export function listStrategyIds(): readonly string[] {
  return Object.keys(STRATEGY_REGISTRY);
}

/** 解析策略；未知 ID 在 provider / IO / 网络 / 生成之前前置拒绝。 */
export function resolveStrategy(strategyId: string): StrategyDefinition {
  const strategy = STRATEGY_REGISTRY[strategyId];
  if (strategy === undefined) {
    throw new CliUsageError(`未知 strategy "${strategyId}"；可用: ${listStrategyIds().join(', ')}`);
  }
  return strategy;
}
