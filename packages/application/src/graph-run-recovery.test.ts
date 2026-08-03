/**
 * Graph Run 启动恢复测试（GE-1）。
 *
 * - active 节点 → 恢复为 failed（run 终态 failed，其余 cancelled）；
 * - waiting_for_human（人工停驻）→ 不触碰；
 * - 已终态 run → 不触碰；
 * - 恢复幂等（第二次 no-op）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { advanceNode, createProjectRun, recoverInFlightRuns } from './graph-run.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import { ASK_QUESTION, COLLECT_ANSWER, IDEA_CAPTURE, SPEC_EXTRACT } from '@ai-novel/domain';

type Deps = ReturnType<typeof createTestDeps>['deps'];

describe('recoverInFlightRuns', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createTestDeps().deps;
  });

  it('active 节点（执行器中断）→ 恢复为 failed，run 终态 failed', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    // 推进到 SPEC_EXTRACT active（模拟执行器已开始但未提交完成）
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'a1',
    });

    const recovered = recoverInFlightRuns(deps);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].runId).toBe(run.workflowRunId);

    const record = deps.tx.runInTransaction((repos) =>
      repos.graphRunRepo.getById(run.workflowRunId),
    );
    expect(record!.state.terminalStatus).toBe('failed');
    expect(record!.state.nodeStatuses[SPEC_EXTRACT]).toBe('failed');
    // 已成功的节点保持 succeeded；只有 active/waiting 才被 fan-out 取消
    expect(record!.state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
  });

  it('waiting_for_human（人工停驻）→ 不触碰，run 保持非终态', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'a2',
    });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: SPEC_EXTRACT,
      outcome: { condition: 'clarification_remaining', value: 'ask_more' },
      artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
      idempotencyKey: 'a3',
    });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: ASK_QUESTION,
      idempotencyKey: 'a4',
    });
    // 现在 COLLECT_ANSWER 停在 waiting_for_human

    const recovered = recoverInFlightRuns(deps);
    expect(recovered).toHaveLength(0);
    const record = deps.tx.runInTransaction((repos) =>
      repos.graphRunRepo.getById(run.workflowRunId),
    );
    expect(record!.state.terminalStatus).toBeNull();
    expect(record!.state.nodeStatuses[COLLECT_ANSWER]).toBe('waiting_for_human');
  });

  it('已终态 run → 不触碰；恢复幂等', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'a4',
    });
    recoverInFlightRuns(deps); // 第一次恢复：SPEC_EXTRACT failed

    // 第二次恢复：无 active 节点 → no-op
    const again = recoverInFlightRuns(deps);
    expect(again).toHaveLength(0);
  });
});
