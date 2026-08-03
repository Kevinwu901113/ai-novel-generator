/**
 * Graph Run 命令输入校验器测试（GE-1）。
 */

import { describe, it, expect } from 'vitest';
import {
  isValidCreateProjectRunInput,
  isValidCreateChapterRunInput,
  isValidGetRunProgressInput,
  isValidApplyHumanDecisionInput,
  isValidListRunsInput,
  isValidAdvanceNodeInput,
  isValidFailNodeInput,
} from './index.js';

describe('Graph Run command validators', () => {
  it('createProjectRun：合法/非法', () => {
    expect(isValidCreateProjectRunInput({ projectId: 'p1', idempotencyKey: 'k1' })).toBe(true);
    expect(isValidCreateProjectRunInput({ projectId: '', idempotencyKey: 'k1' })).toBe(false);
    expect(isValidCreateProjectRunInput({ projectId: 'p1' })).toBe(false);
    expect(isValidCreateProjectRunInput(null)).toBe(false);
  });

  it('createChapterRun：researchBundleId 可空；缺绑定拒绝', () => {
    expect(
      isValidCreateChapterRunInput({
        projectId: 'p1',
        creationSpecVersionId: 'spec-1',
        researchBundleId: null,
        storyBlueprintId: 'bp-1',
        blueprintChapterId: 'ch-1',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    expect(
      isValidCreateChapterRunInput({
        projectId: 'p1',
        creationSpecVersionId: 'spec-1',
        researchBundleId: 'rb-1',
        storyBlueprintId: 'bp-1',
        blueprintChapterId: 'ch-1',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    // 缺少 blueprintChapterId
    expect(
      isValidCreateChapterRunInput({
        projectId: 'p1',
        creationSpecVersionId: 'spec-1',
        researchBundleId: null,
        storyBlueprintId: 'bp-1',
        idempotencyKey: 'k1',
      } as never),
    ).toBe(false);
  });

  it('getRunProgress / listRuns', () => {
    expect(isValidGetRunProgressInput({ projectId: 'p1', runId: 'r1' })).toBe(true);
    expect(isValidGetRunProgressInput({ projectId: 'p1' })).toBe(false);
    expect(isValidListRunsInput({ projectId: 'p1' })).toBe(true);
    expect(isValidListRunsInput({})).toBe(false);
  });

  it('applyHumanDecision：intake_answer 需 sessionId/questionId/text；skip 不需；gate 需 outcome', () => {
    expect(
      isValidApplyHumanDecisionInput({
        kind: 'intake_answer',
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        sessionId: 's1',
        questionId: 'q1',
        text: '回答',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    // answer 缺 text → 拒绝
    expect(
      isValidApplyHumanDecisionInput({
        kind: 'intake_answer',
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        sessionId: 's1',
        questionId: 'q1',
        idempotencyKey: 'k1',
      } as never),
    ).toBe(false);
    expect(
      isValidApplyHumanDecisionInput({
        kind: 'intake_skip',
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    expect(
      isValidApplyHumanDecisionInput({
        kind: 'gate',
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        outcome: 'accept',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    // gate 缺 outcome → 拒绝
    expect(
      isValidApplyHumanDecisionInput({
        kind: 'gate',
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        idempotencyKey: 'k1',
      } as never),
    ).toBe(false);
    // 未知 kind → 拒绝
    expect(isValidApplyHumanDecisionInput({ kind: 'bogus', projectId: 'p1' })).toBe(false);
  });

  it('advanceNode：outcome/artifactRef 可选；类型错误拒绝', () => {
    expect(
      isValidAdvanceNodeInput({
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    expect(
      isValidAdvanceNodeInput({
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        outcome: { condition: 'intake_action', value: 'answer' },
        artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
        idempotencyKey: 'k1',
      }),
    ).toBe(true);
    expect(
      isValidAdvanceNodeInput({
        projectId: 'p1',
        runId: 'r1',
        nodeId: 'n1',
        outcome: { condition: 42 },
        idempotencyKey: 'k1',
      } as never),
    ).toBe(false);
  });

  it('failNode', () => {
    expect(
      isValidFailNodeInput({ projectId: 'p1', runId: 'r1', nodeId: 'n1', idempotencyKey: 'k1' }),
    ).toBe(true);
    expect(isValidFailNodeInput({ projectId: 'p1', runId: 'r1', nodeId: 'n1' })).toBe(false);
  });
});
