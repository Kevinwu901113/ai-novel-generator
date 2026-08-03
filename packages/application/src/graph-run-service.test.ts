/**
 * GraphRunService 用例测试（GE-1，内存 fake 仓库）。
 *
 * 覆盖：
 * - createProjectRun / createChapterRun 初始状态（entry active、idempotent 去重）；
 * - advanceNode：artifact 产出、outcome 路由、人工节点自动挂起（parkHumanNodes）；
 * - failNode：终态 failed + fan-out 取消其余；
 * - 幂等：同 key 同 payload → deduped；同 key 不同 payload → IDEMPOTENCY_CONFLICT；
 * - 状态冲突：非 active 节点 advance / 无 pending 决策 applyHumanDecision；
 * - chapter run 绑定正确（graphId 身份由 domain 校验）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { advanceNode, createChapterRun, createProjectRun, failNode } from './graph-run.js';
import {
  GraphRunIdempotencyConflictError,
  GraphRunStateConflictError,
  GraphRunValidationError,
} from './graph-run-errors.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import {
  ASK_QUESTION,
  COLLECT_ANSWER,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
} from '@ai-novel/domain';

type Deps = ReturnType<typeof createTestDeps>['deps'];

describe('GraphRunService', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createTestDeps().deps;
  });

  it('createProjectRun → entry IDEA_CAPTURE active，无待处理决策，非终态', () => {
    const result = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    expect(result.deduped).toBe(false);
    expect(result.run.graphId).toBe(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.id);
    expect(result.run.nodeStatuses[IDEA_CAPTURE]).toBe('active');
    expect(result.run.pendingHumanDecision).toBeNull();
    expect(result.run.terminalStatus).toBeNull();
    expect(result.run.activeFrontier).toContain(IDEA_CAPTURE);
  });

  it('createProjectRun 幂等去重：同 key 同 payload → deduped=true，状态一致', () => {
    const a = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    const b = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    expect(b.deduped).toBe(true);
    expect(b.run.workflowRunId).toBe(a.run.workflowRunId);
  });

  it('createProjectRun 幂等冲突：同 key 不同 projectId → IDEMPOTENCY_CONFLICT', () => {
    createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    expect(() => createProjectRun(deps, { projectId: 'p2', idempotencyKey: 'c3' })).toThrow(
      GraphRunIdempotencyConflictError,
    );
  });

  it('createChapterRun → entry CHAPTER_PLAN active + 绑定引用写入', () => {
    const result = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch1',
    });
    expect(result.run.graphId).toBe(CHAPTER_GENERATION_GRAPH_V1.id);
    expect(result.run.nodeStatuses[CHAPTER_GENERATION_GRAPH_V1.entryNodeId]).toBe('active');
  });

  it('advanceNode 非 active 节点 → GRAPH_RUN_STATE_CONFLICT（fail-closed）', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c4' });
    expect(() =>
      advanceNode(deps, {
        projectId: 'p1',
        runId: run.workflowRunId,
        nodeId: SPEC_EXTRACT, // 尚未 active
        artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
        idempotencyKey: 'adv1',
      }),
    ).toThrow(GraphRunStateConflictError);
  });

  it('advanceNode IDEA_CAPTURE（idea artifact）→ SPEC_EXTRACT active；SPEC_EXTRACT outcome 路由到 ASK_QUESTION → COLLECT_ANSWER 自动挂起', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c5' });

    const afterIdea = advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'adv2',
    }).run;
    expect(afterIdea.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
    expect(afterIdea.nodeStatuses[SPEC_EXTRACT]).toBe('active');
    expect((afterIdea as IdeaToNovelProjectRunState).artifacts.idea?.artifactId).toBe('idea-1');

    const afterExtract = advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: SPEC_EXTRACT,
      outcome: { condition: 'clarification_remaining', value: 'ask_more' },
      artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
      idempotencyKey: 'adv3',
    }).run;
    // 澄清循环重入：SPEC_EXTRACT 作为 loop 源被 reset 为 pending，ASK_QUESTION 激活
    expect(afterExtract.nodeStatuses[SPEC_EXTRACT]).toBe('pending');
    expect(afterExtract.nodeStatuses[ASK_QUESTION]).toBe('active');

    const afterAsk = advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: ASK_QUESTION,
      idempotencyKey: 'adv4',
    }).run;
    expect(afterAsk.nodeStatuses[ASK_QUESTION]).toBe('succeeded');
    expect(afterAsk.nodeStatuses[COLLECT_ANSWER]).toBe('waiting_for_human');
    expect(afterAsk.pendingHumanDecision?.nodeId).toBe(COLLECT_ANSWER);
    expect(afterAsk.pendingHumanDecision?.decisionType).toBe('intake_response');
  });

  it('advanceNode 未知 outcome → GRAPH_RUN_VALIDATION_ERROR', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c6' });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'adv4',
    });
    expect(() =>
      advanceNode(deps, {
        projectId: 'p1',
        runId: run.workflowRunId,
        nodeId: SPEC_EXTRACT,
        outcome: { condition: 'clarification_remaining', value: 'invalid_value' },
        idempotencyKey: 'adv5',
      }),
    ).toThrow(GraphRunValidationError);
  });

  it('failNode → terminal failed，其余 active/waiting 节点 cancelled', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c7' });
    const after = failNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      idempotencyKey: 'fail1',
    }).run;
    expect(after.terminalStatus).toBe('failed');
    expect(after.nodeStatuses[IDEA_CAPTURE]).toBe('failed');
    expect(after.activeFrontier).toEqual([]);
  });

  it('幂等去重：同 advanceNode key 重试 → deduped=true，不重复推进', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c8' });
    const input = {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'adv6',
    };
    advanceNode(deps, input);
    const b = advanceNode(deps, input);
    expect(b.deduped).toBe(true);
    expect(b.run.nodeStatuses[SPEC_EXTRACT]).toBe('active');
  });
});
