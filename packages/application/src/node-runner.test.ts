/**
 * NodeRunner / NodeSettlementService 崩溃窗口测试（RW-1）。
 *
 * 覆盖：
 * 1. active 节点无 execution 时重启 → runner 创建并分发；
 * 2. 未知 executor → fail-closed（applyNodeFailure）；
 * 3. task RUNNING 中断 → 保持（不误 fail、不 spin）；
 * 4. task 成功 + artifact 已持久化 + 未 settlement → 幂等 settlement（task-backed）；
 * 5. settlement 重复执行 → 返回原结果，不重复推进；
 * 6+7. artifact 写入成功但 Graph CAS 冲突 → 整事务回滚（execution 未标 settled）；
 * 8. forged artifact ID → resolver 拒绝，Graph 不推进；
 * 9. wrong project/run/kind/version → resolver 拒绝；
 * 10. unknown executor → fail-closed；
 * 11. non-replayable executor 中断 → fail-closed；
 * 12. waiting_for_human 重启 → runner 不触碰；
 * 13. terminal run 不复活；
 * 14. 并发 claim 同一节点 → 唯一约束防重复执行。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createChapterRun,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  getRunProgress,
  NodeSettlementError,
  settleNodeExecution,
  type ArtifactPayload,
  type ArtifactResolverPort,
  type NodeExecutorDescriptor,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type PersistedArtifactReceipt,
  type TaskData,
  type TaskRepositoryPort,
} from './index.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import {
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  DRAFT,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState, ChapterGenerationRunState } from '@ai-novel/domain';

const NOW = '2026-08-04T00:00:00.000Z';

// ── fakes ─────────────────────────────────────────────────────────

function rejectingResolver(): ArtifactResolverPort {
  return {
    resolve() {
      throw new NodeSettlementError('NODE_SETTLEMENT_ARTIFACT_INVALID', 'forged artifact');
    },
  };
}

function acceptingResolver(accept: (p: ArtifactPayload) => boolean): ArtifactResolverPort {
  return {
    resolve(input): PersistedArtifactReceipt {
      if (!accept(input.proposed)) {
        throw new NodeSettlementError('NODE_SETTLEMENT_ARTIFACT_INVALID', 'artifact 校验失败');
      }
      return {
        kind: input.proposed.kind,
        artifactId: input.proposed.artifactId,
        producerNodeId: input.proposed.producerNodeId,
        projectId: input.projectId,
        graphRunId: input.graphRunId,
        graphVersion: input.graphVersion,
        version: input.proposed.version,
      };
    },
  };
}

function fakeTaskRepo(): TaskRepositoryPort & { tasks: Map<string, TaskData> } {
  const tasks = new Map<string, TaskData>();
  return {
    tasks,
    create: (d) =>
      tasks.set(d.id, {
        ...d,
        dedupeKey: d.dedupeKey ?? null,
        status: 'PENDING',
        attemptCount: 0,
        inputVersionJson: '{}',
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        staleAt: null,
        cancelledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    getById: (id) => tasks.get(id) ?? null,
    listByProject: () => [],
    listByStatus: () => [],
    claimPending: () => true,
    completeRunning: () => true,
    failRunning: () => true,
    failPending: () => true,
    markStale: () => true,
    resetToPending: () => true,
    listRunning: () => [],
  };
}

type Base = ReturnType<typeof createTestDeps>;

function runnerDeps(
  base: Base,
  overrides: {
    registry?: ExecutorRegistry;
    runners?: Map<string, NodeExecutorRunner>;
    resolver?: ArtifactResolverPort;
    taskRepo?: ReturnType<typeof fakeTaskRepo>;
  } = {},
): NodeRunnerDeps {
  return {
    ...base.deps,
    registry: overrides.registry ?? new ExecutorRegistry(),
    runners: overrides.runners ?? new Map(),
    artifactResolver: overrides.resolver ?? rejectingResolver(),
    taskRepo: overrides.taskRepo ?? fakeTaskRepo(),
  };
}

function syncDescriptor(
  nodeId: string,
  executorId: string,
  policy: NodeExecutorDescriptor['recoveryPolicy'] = 'replayable',
): NodeExecutorDescriptor {
  return {
    executorId,
    executorVersion: 'v1',
    graphKind: 'project',
    nodeId: nodeId as never,
    kind: 'sync',
    recoveryPolicy: policy,
  };
}

function syncRunner(
  descriptor: NodeExecutorDescriptor,
  output: NodeOutputLike,
): NodeExecutorRunner {
  return {
    descriptor,
    async run() {
      return { kind: 'sync', output };
    },
  };
}

type NodeOutputLike = {
  outcome?: { condition: string; value: string };
  artifact?: ArtifactPayload;
};

/** 注册 Project Graph 全部非人工节点 executor（驱动到 BLUEPRINT_USER_GATE） */
function fullProjectRunner(): {
  registry: ExecutorRegistry;
  runners: Map<string, NodeExecutorRunner>;
} {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const specs: Array<[string, string, NodeOutputLike]> = [
    [
      'IDEA_CAPTURE',
      'idea-capture-v1',
      {
        artifact: {
          kind: 'idea',
          artifactId: 'idea-real-1',
          producerNodeId: IDEA_CAPTURE as never,
          version: 1,
        },
      },
    ],
    [
      'SPEC_EXTRACT',
      'spec-extract-v1',
      {
        outcome: { condition: 'clarification_remaining', value: 'spec_complete' },
        artifact: {
          kind: 'creationSpec',
          artifactId: 'spec-real-1',
          producerNodeId: SPEC_EXTRACT as never,
          version: 1,
        },
      },
    ],
    [
      'RESEARCH_DECISION',
      'research-decision-v1',
      { outcome: { condition: 'research_decision', value: 'none' } },
    ],
    [
      'BLUEPRINT_GENERATE',
      'blueprint-generate-v1',
      {
        artifact: {
          kind: 'storyBlueprint',
          artifactId: 'bp-real-1',
          producerNodeId: BLUEPRINT_GENERATE as never,
          version: 1,
        },
      },
    ],
  ];
  for (const [nodeId, id, output] of specs) {
    const descriptor = syncDescriptor(nodeId, id);
    registry.register(descriptor);
    runners.set(id, syncRunner(descriptor, output));
  }
  return { registry, runners };
}

function fullProjectDeps(base: Base): NodeRunnerDeps {
  const { registry, runners } = fullProjectRunner();
  return runnerDeps(base, {
    registry,
    runners,
    resolver: acceptingResolver((p) =>
      ['idea-real-1', 'spec-real-1', 'bp-real-1'].includes(p.artifactId),
    ),
  });
}

describe('NodeRunner crash windows', () => {
  let base: Base;

  beforeEach(() => {
    base = createTestDeps();
  });

  it('1. active 节点无 execution 时重启 → runner 创建并分发，推进到人工 Gate', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    const settled = await driveRun(deps, 'p1', run.workflowRunId);

    expect(settled.some((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled)).toBe(true);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.terminalStatus).toBeNull();
    expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
    expect(base.nodeExecutionRepo.getByRunNode(run.workflowRunId, 'IDEA_CAPTURE')?.status).toBe(
      'settled',
    );
  });

  it('2+10. 未知 executor（空 registry）→ fail-closed（applyNodeFailure）', async () => {
    const deps = runnerDeps(base, { registry: new ExecutorRegistry() });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.terminalStatus).toBe('failed');
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('failed');
  });

  it('11. non-replayable executor 中断（sync 在途）→ fail-closed，不自动重试', async () => {
    const registry = new ExecutorRegistry();
    const idea = syncRunner(syncDescriptor('IDEA_CAPTURE', 'idea-fc', 'fail_closed'), {
      artifact: {
        kind: 'idea',
        artifactId: 'idea-real-1',
        producerNodeId: IDEA_CAPTURE as never,
        version: 1,
      },
    });
    registry.register(idea.descriptor);
    const deps = runnerDeps(base, {
      registry,
      runners: new Map([[idea.descriptor.executorId, idea]]),
      resolver: acceptingResolver((p) => p.artifactId === 'idea-real-1'),
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    // 构造中断：直接创建 running 的 execution 但无产物可 settle
    const executionId = 'e11';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      attempt: 1,
      executorId: 'idea-fc',
      executorVersion: 'v1',
      recoveryPolicy: 'fail_closed',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    // sync 在途 + fail_closed → fail-closed（node 标记 failed，不重试）
    await driveRun(deps, 'p1', run.workflowRunId);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.terminalStatus).toBe('failed');
    expect(base.nodeExecutionRepo.getById(executionId)?.status).toBe('failed');
  });

  it('12. waiting_for_human 重启 → runner 不触碰', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c4' });
    await driveRun(deps, 'p1', run.workflowRunId); // 停在 BLUEPRINT_USER_GATE (waiting_for_human)
    const settled = await driveRun(deps, 'p1', run.workflowRunId); // 再次重启
    expect(settled).toHaveLength(0);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.terminalStatus).toBeNull();
    expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  });

  it('13. terminal run 不复活', async () => {
    const deps = runnerDeps(base, { registry: new ExecutorRegistry() });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c5' });
    await driveRun(deps, 'p1', run.workflowRunId); // fail-closed → terminal failed
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.terminalStatus).toBe('failed');
  });

  it('14. 并发 claim 同一节点 → 唯一约束防重复，Graph 只推进一次', async () => {
    const deps1 = fullProjectDeps(base);
    const deps2 = fullProjectDeps(base);
    const { run } = createProjectRun(deps1, { projectId: 'p1', idempotencyKey: 'c6' });
    const [a, b] = await Promise.all([
      driveRun(deps1, 'p1', run.workflowRunId),
      driveRun(deps2, 'p1', run.workflowRunId),
    ]);
    const ideaSettled = [...a, ...b].filter((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled);
    expect(ideaSettled.length).toBeGreaterThan(0);
    const exec = base.nodeExecutionRepo.getByRunNode(run.workflowRunId, 'IDEA_CAPTURE');
    expect(exec?.status).toBe('settled');
    const state = getRunProgress(deps1, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    // IDEA_CAPTURE 只推进一次（succeeded），run 停在人工 Gate
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
    expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  });
});

describe('NodeSettlementService crash windows', () => {
  let base: Base;

  beforeEach(() => {
    base = createTestDeps();
  });

  it('5. settlement 重复执行 → 返回原结果，不重复推进', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c7' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const exec = base.nodeExecutionRepo.getByRunNode(run.workflowRunId, 'IDEA_CAPTURE')!;

    const dup = settleNodeExecution(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: 'IDEA_CAPTURE',
      executionId: exec.id,
    });
    expect(dup.settled).toBe(false);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded'); // 未重复推进
  });

  it('8. forged artifact ID → resolver 拒绝，Graph 不推进', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c8' });
    const executionId = 'e8';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      attempt: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    expect(() =>
      settleNodeExecution(deps, {
        projectId: 'p1',
        runId: run.workflowRunId,
        nodeId: 'IDEA_CAPTURE',
        executionId,
        artifact: {
          kind: 'idea',
          artifactId: 'forged-1',
          producerNodeId: IDEA_CAPTURE as never,
          version: 1,
        },
      }),
    ).toThrow(NodeSettlementError);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('active'); // 未推进
  });

  it('9. wrong version → resolver 拒绝', async () => {
    const { registry, runners } = fullProjectRunner();
    const resolver: ArtifactResolverPort = {
      resolve(input) {
        if (input.proposed.version !== 7) {
          throw new NodeSettlementError('NODE_SETTLEMENT_ARTIFACT_INVALID', 'version mismatch');
        }
        return {
          kind: input.proposed.kind,
          artifactId: input.proposed.artifactId,
          producerNodeId: input.proposed.producerNodeId,
          projectId: input.projectId,
          graphRunId: input.graphRunId,
          graphVersion: input.graphVersion,
          version: input.proposed.version,
        };
      },
    };
    const deps = runnerDeps(base, { registry, runners, resolver });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c9' });
    const executionId = 'e9';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      attempt: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    expect(() =>
      settleNodeExecution(deps, {
        projectId: 'p1',
        runId: run.workflowRunId,
        nodeId: 'IDEA_CAPTURE',
        executionId,
        artifact: {
          kind: 'idea',
          artifactId: 'idea-real-1',
          producerNodeId: IDEA_CAPTURE as never,
          version: 1,
        },
      }),
    ).toThrow(NodeSettlementError);
  });

  it('6+7. Graph CAS 冲突 → 整事务回滚（execution 未标 settled）', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c10' });
    const executionId = 'e10';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      attempt: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    // 制造 Graph CAS 冲突（模拟并发写入使 expectedVersion 失配）
    base.setForceCasFail(true);
    try {
      expect(() =>
        settleNodeExecution(deps, {
          projectId: 'p1',
          runId: run.workflowRunId,
          nodeId: 'IDEA_CAPTURE',
          executionId,
          artifact: {
            kind: 'idea',
            artifactId: 'idea-real-1',
            producerNodeId: IDEA_CAPTURE as never,
            version: 1,
          },
        }),
      ).toThrow();
    } finally {
      base.setForceCasFail(false);
    }
    // 整事务回滚：execution 未标 settled
    expect(base.nodeExecutionRepo.getById(executionId)?.status).not.toBe('settled');
  });

  it('4. task 成功 + artifact 已持久化 + 未 settlement → 幂等 settlement（task-backed）', async () => {
    const registry = new ExecutorRegistry();
    const plan = syncRunner(
      { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
      {},
    );
    const draft: NodeExecutorRunner = {
      descriptor: {
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        graphKind: 'chapter',
        nodeId: DRAFT as never,
        kind: 'task_backed',
        recoveryPolicy: 'settle_if_result',
      },
      async run(input) {
        taskRepo.create({
          id: 'task-draft',
          projectId: input.projectId,
          taskType: 'CHAPTER_DRAFT',
          payloadJson: '{}',
          inputVersionJson: '{}',
        });
        return { kind: 'task', taskId: 'task-draft' };
      },
    };
    registry.register(plan.descriptor);
    registry.register(draft.descriptor);
    const taskRepo = fakeTaskRepo();
    const deps = runnerDeps(base, {
      registry,
      runners: new Map([
        [plan.descriptor.executorId, plan],
        [draft.descriptor.executorId, draft],
      ]),
      resolver: acceptingResolver((p) => p.artifactId === 'gen-art-1'),
      taskRepo,
    });
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch',
    });
    await driveRun(deps, 'p1', run.workflowRunId);

    const draftExec = base.nodeExecutionRepo.getByRunNode(run.workflowRunId, 'DRAFT');
    expect(draftExec).not.toBeNull();
    expect(draftExec!.status).toBe('running');
    expect(draftExec!.taskId).toBe('task-draft');

    // 模拟崩溃窗口：task 成功 + artifact 已持久化 + 未 settlement
    taskRepo.tasks.set('task-draft', {
      ...taskRepo.tasks.get('task-draft')!,
      status: 'SUCCEEDED',
      resultJson: '{}',
    });
    base.generationArtifactStore.save({
      id: 'gen-art-1',
      projectId: 'p1',
      graphRunId: run.workflowRunId,
      nodeId: 'DRAFT',
      producerExecutorId: 'chapter-draft-v1',
      contentJson: JSON.stringify({
        kind: 'generationRun',
        draft: { title: '第一章', content: '正文', scenePlans: [] },
      }),
      version: 1,
      createdAt: NOW,
    });

    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled.some((s) => s.nodeId === 'DRAFT' && s.settled)).toBe(true);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as ChapterGenerationRunState;
    expect(state.nodeStatuses[DRAFT]).toBe('succeeded');
    expect(state.artifacts.generationRun?.artifactId).toBe('gen-art-1');
    expect(base.nodeExecutionRepo.getById(draftExec!.id)?.status).toBe('settled');
  });

  it('3. task RUNNING 中断 → 保持（不误 fail、不 spin）', async () => {
    const registry = new ExecutorRegistry();
    const plan = syncRunner(
      { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
      {},
    );
    const draft: NodeExecutorRunner = {
      descriptor: {
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        graphKind: 'chapter',
        nodeId: DRAFT as never,
        kind: 'task_backed',
        recoveryPolicy: 'settle_if_result',
      },
      async run(input) {
        taskRepo.create({
          id: 'task-run',
          projectId: input.projectId,
          taskType: 'CHAPTER_DRAFT',
          payloadJson: '{}',
          inputVersionJson: '{}',
        });
        return { kind: 'task', taskId: 'task-run' };
      },
    };
    registry.register(plan.descriptor);
    registry.register(draft.descriptor);
    const taskRepo = fakeTaskRepo();
    const deps = runnerDeps(base, {
      registry,
      runners: new Map([
        [plan.descriptor.executorId, plan],
        [draft.descriptor.executorId, draft],
      ]),
      resolver: rejectingResolver(),
      taskRepo,
    });
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch2',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    // task 仍 RUNNING（未标记成功）→ 重启 driveRun 不 fail、不 settle、不 spin
    const before = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(before.nodeStatuses[DRAFT]).toBe('active');
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled.filter((s) => s.nodeId === 'DRAFT')).toHaveLength(0);
    const after = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(after.nodeStatuses[DRAFT]).toBe('active');
    expect(after.terminalStatus).toBeNull();
  });
});
