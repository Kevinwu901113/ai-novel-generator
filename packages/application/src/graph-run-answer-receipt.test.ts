/**
 * Idea Intake answer receipt 原子契约测试（GE-1）。
 *
 * - answer：先写权威 answer 存储，取得 receipt 再推进 Graph；graph 不保存回答正文；
 * - skip / finish：不写 answer；
 * - 决策节点不匹配 / 无待处理决策 → 状态冲突。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { advanceNode, applyHumanDecision, createProjectRun } from './graph-run.js';
import { GraphRunStateConflictError } from './graph-run-errors.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import { ASK_QUESTION, COLLECT_ANSWER, IDEA_CAPTURE, SPEC_EXTRACT } from '@ai-novel/domain';

type Deps = ReturnType<typeof createTestDeps>['deps'];
type Answers = ReturnType<typeof createTestDeps>['answers'];

function advanceToCollectAnswer(deps: Deps, prefix: string): string {
  const { run } = createProjectRun(deps, {
    projectId: 'p1',
    idempotencyKey: `${prefix}-create`,
  });
  advanceNode(deps, {
    projectId: 'p1',
    runId: run.workflowRunId,
    nodeId: IDEA_CAPTURE,
    artifactRef: { kind: 'idea', artifactId: 'idea-1' },
    idempotencyKey: `${prefix}-idea`,
  });
  advanceNode(deps, {
    projectId: 'p1',
    runId: run.workflowRunId,
    nodeId: SPEC_EXTRACT,
    outcome: { condition: 'clarification_remaining', value: 'ask_more' },
    artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
    idempotencyKey: `${prefix}-extract`,
  });
  advanceNode(deps, {
    projectId: 'p1',
    runId: run.workflowRunId,
    nodeId: ASK_QUESTION,
    idempotencyKey: `${prefix}-ask`,
  });
  return run.workflowRunId;
}

describe('Idea Intake answer receipt', () => {
  let deps: Deps;
  let answers: Answers;

  beforeEach(() => {
    const ctx = createTestDeps();
    deps = ctx.deps;
    answers = ctx.answers;
  });

  it('intake_answer 先写权威 answer 存储（receipt），再推进 Graph 回到 SPEC_EXTRACT', () => {
    const runId = advanceToCollectAnswer(deps, 'one');
    const result = applyHumanDecision(deps, {
      kind: 'intake_answer',
      runId,
      nodeId: COLLECT_ANSWER,
      sessionId: 's1',
      questionId: 'q1',
      text: '主角是一个侦探',
      idempotencyKey: 'ans1',
    }).run;

    // answer 已写入权威存储
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      sessionId: 's1',
      questionId: 'q1',
      text: '主角是一个侦探',
    });
    // graph 状态不保存回答正文；路由回到 SPEC_EXTRACT（intake_action=answer）
    expect(result.nodeStatuses[COLLECT_ANSWER]).toBe('succeeded');
    expect(result.nodeStatuses[SPEC_EXTRACT]).toBe('active');
    expect(result.pendingHumanDecision).toBeNull();
  });

  it('intake_skip / intake_finish 不写 answer', () => {
    const runId1 = advanceToCollectAnswer(deps, 'two');
    applyHumanDecision(deps, {
      kind: 'intake_skip',
      runId: runId1,
      nodeId: COLLECT_ANSWER,
      idempotencyKey: 'skip1',
    });
    const runId2 = advanceToCollectAnswer(deps, 'three');
    applyHumanDecision(deps, {
      kind: 'intake_finish',
      runId: runId2,
      nodeId: COLLECT_ANSWER,
      idempotencyKey: 'fin1',
    });
    expect(answers).toHaveLength(0);
  });

  it('无待处理决策时 applyHumanDecision → GRAPH_RUN_STATE_CONFLICT', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    expect(() =>
      applyHumanDecision(deps, {
        kind: 'intake_skip',
        runId: run.workflowRunId,
        nodeId: COLLECT_ANSWER,
        idempotencyKey: 'bad1',
      }),
    ).toThrow(GraphRunStateConflictError);
  });
});
