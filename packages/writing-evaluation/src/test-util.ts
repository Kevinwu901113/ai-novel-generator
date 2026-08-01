/**
 * 测试工具（仅测试用）。
 * 注意：本文件会被 tsc 编译进 dist（package 为 private，不影响发布）。
 */

import { createCharacterKey } from '@ai-novel/domain';
import type { WritingEvaluationCaseV1, WritingEvaluationSuiteV1 } from './schema.js';

export const FIXED_CLOCK_ISO = '2026-08-01T00:00:00.000Z';

export function fixedClockIso(): string {
  return FIXED_CLOCK_ISO;
}

/** JSON 深拷贝（不依赖结构化克隆，兼容纯 JSON 数据）。 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeCandidate(
  candidateId: string,
  text: string,
  overrides: Partial<{
    strategyId: string;
    modelId: string;
    promptVersion: string;
  }> = {},
): WritingEvaluationCaseV1['candidates'][number] {
  return {
    candidateId,
    strategyId: overrides.strategyId ?? `strategy-${candidateId}`,
    modelId: overrides.modelId ?? 'fake-model',
    promptVersion: overrides.promptVersion ?? `prompt-${candidateId}`,
    generationParameters: { temperature: 0.7, maxTokens: 512, seed: null },
    text,
  };
}

export function makeSceneBrief(): WritingEvaluationCaseV1['sceneBrief'] {
  return {
    sceneGoal: '完成一个测试场景',
    participants: ['甲'],
    location: '某处',
    entryState: ['初始状态'],
    exitState: ['结束状态'],
    conflict: '一个冲突',
    requiredFacts: [],
    forbiddenFacts: [],
    targetLength: { minCodePoints: 1, maxCodePoints: 100_000 },
  };
}

export function makeContract(): WritingEvaluationCaseV1['contract'] {
  return {
    premise: '一个用于测试的创作前提。',
    genre: ['测试'],
    tone: ['平实'],
    targetAudience: '测试读者',
    narrativePov: 'THIRD_LIMITED',
    tense: 'PAST',
    protagonist: {
      characterKey: createCharacterKey('protagonist'),
      name: '主角',
      role: '主角',
    },
  };
}

export function makeCase(
  overrides: Partial<WritingEvaluationCaseV1> = {},
): WritingEvaluationCaseV1 {
  return {
    caseId: 'case-a',
    title: '用例 A',
    description: '测试用例',
    contract: makeContract(),
    sceneBrief: makeSceneBrief(),
    constraints: [],
    candidates: [makeCandidate('c1', '你好。'), makeCandidate('c2', '再见。')],
    ...overrides,
  };
}

export function makeSuite(
  overrides: Partial<WritingEvaluationSuiteV1> = {},
): WritingEvaluationSuiteV1 {
  return {
    schemaVersion: 1,
    suiteId: 'test-suite',
    title: '测试套件',
    description: '测试用套件',
    locale: 'zh-CN',
    cases: [makeCase()],
    ...overrides,
  };
}
