/**
 * baseline-one-shot-v1 prompt 构建测试。
 *
 * - prompt 结构固定（system 稳定、user 逐 case 变化）；
 * - 同输入 → 同 prompt bytes → 同 promptHash；
 * - manual-criterion 不进入生成约束；
 * - 完整 prompt 只存在于代码 / 内存，不落盘。
 */

import { describe, it, expect } from 'vitest';
import {
  getBaselineSuite,
  type WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import {
  BASELINE_ONE_SHOT_STRATEGY,
  buildBaselineOneShotPrompt,
  computePromptHash,
} from './baseline-one-shot-v1.js';

function inputForCase(caseId: string): WritingGenerationExperimentInput {
  const suite = getBaselineSuite();
  const c = suite.cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error(`case ${caseId} 不存在`);
  return {
    suiteId: suite.suiteId,
    caseId,
    sceneBrief: c.sceneBrief,
    contract: c.contract,
    constraints: c.constraints,
  };
}

describe('baseline-one-shot-v1 固定参数', () => {
  it('strategy / version / promptVersion / 默认参数锁定', () => {
    expect(BASELINE_ONE_SHOT_STRATEGY).toMatchObject({
      strategyId: 'baseline-one-shot-v1',
      strategyVersion: '1',
      promptVersion: 'baseline-one-shot-v1.p1',
      defaultTemperature: 0.7,
      defaultMaxTokens: 8192,
      concurrency: 1,
      retries: 0,
    });
  });
});

describe('prompt 构建', () => {
  it('system 跨 case 稳定，user 逐 case 变化', () => {
    const a = buildBaselineOneShotPrompt(inputForCase('restrained-reunion'));
    const b = buildBaselineOneShotPrompt(inputForCase('suspense-corridor'));
    expect(a.system).toBe(b.system);
    expect(a.user).not.toBe(b.user);
  });

  it('包含全部 prompt 区块', () => {
    const { system, user } = buildBaselineOneShotPrompt(inputForCase('restrained-reunion'));
    expect(system).toContain('角色');
    expect(system).toContain('禁止内容');
    expect(system).toContain('输出规则');
    expect(user).toContain('【创作契约】');
    expect(user).toContain('【场景简报】');
    expect(user).toContain('【硬性约束】');
    expect(user).toContain('请直接输出正文');
  });

  it('manual-criterion 不进入硬性约束', () => {
    const { user } = buildBaselineOneShotPrompt(inputForCase('restrained-reunion'));
    expect(user).not.toContain('manual-criterion');
    expect(user).not.toContain('情绪是否通过动作而非解释传达');
  });

  it('硬性约束按类型渲染成自然语言', () => {
    const { user } = buildBaselineOneShotPrompt(inputForCase('restrained-reunion'));
    expect(user).toContain('至少出现短语“站台”1 次');
    expect(user).toContain('不得出现短语“空气仿佛凝固”');
    expect(user).toContain('正文长度应为 200–400 个字符（code points）');
  });

  it('同输入 → 同 prompt bytes → 同 promptHash', () => {
    const a = buildBaselineOneShotPrompt(inputForCase('two-voice-dialogue'));
    const b = buildBaselineOneShotPrompt(inputForCase('two-voice-dialogue'));
    expect(a.system + a.user).toBe(b.system + b.user);
    expect(computePromptHash(a)).toBe(computePromptHash(b));
    expect(computePromptHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
