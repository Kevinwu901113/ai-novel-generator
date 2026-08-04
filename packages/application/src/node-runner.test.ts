/**
 * NodeRunner / NodeSettlementService 崩溃窗口测试（RW-1-R5）。
 *
 * 覆盖：active 无 execution 分发、未知 executor fail-closed、task RUNNING 保持、
 * task 成功+未 settlement 幂等、重复 settlement、CAS 冲突回滚、forged artifact、
 * wrong version、non-replayable、waiting_for_human、terminal 不复活、并发 claim、
 * **loop reactivation（新 activation 新 execution）**、**fan-out 全量 dispatch**、
 * **settlement 身份拒绝**、**sync lease（未过期不重试 / 过期重试）**、
 * **task-backed infra retry（统一 claim：新 attempt 新 task）**、
 * **prepareTask 在真实身份后调用（无空 visitId/inputHash）**。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeNodeInputSnapshot,
  createChapterRun,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  getRunProgress,
  inputHashOf,
  NodeSettlementError,
  serializeInputSnapshot,
  settleNodeExecution,
  type ArtifactPayload,
  type ArtifactResolverPort,
  type NodeExecutionInputContext,
  type NodeExecutorDescriptor,
  type NodeOutput,
  type NodeRunnerDeps,
  type NodeTaskSpec,
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
    resolve(_repos, input): PersistedArtifactReceipt {
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
    runners?: Map<string, unknown>;
    resolver?: ArtifactResolverPort;
    taskRepo?: ReturnType<typeof fakeTaskRepo>;
    now?: () => string;
  } = {},
): NodeRunnerDeps {
  return {
    ...base.deps,
    clock: overrides.now ? { now: overrides.now } : base.deps.clock,
    registry: overrides.registry ?? new ExecutorRegistry(),
    runners: (overrides.runners ?? new Map()) as NodeRunnerDeps['runners'],
    artifactResolver: overrides.resolver ?? rejectingResolver(),
    taskRepo: overrides.taskRepo ?? fakeTaskRepo(),
    runnerId: 'test-runner',
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
  output: NodeOutput,
): { descriptor: NodeExecutorDescriptor; execute: (ctx: NodeExecutionInputContext) => NodeOutput } {
  return {
    descriptor,
    execute: () => output,
  };
}

function taskBackedRunner(
  descriptor: NodeExecutorDescriptor,
  taskType: TaskData['taskType'],
  prepareTask?: (ctx: NodeExecutionInputContext) => NodeTaskSpec,
): {
  descriptor: NodeExecutorDescriptor;
  prepareTask: (ctx: NodeExecutionInputContext) => NodeTaskSpec;
} {
  return {
    descriptor,
    prepareTask:
      prepareTask ??
      (() => {
        return { taskType, payloadJson: '{}' };
      }),
  };
}

function register(
  registry: ExecutorRegistry,
  runners: Map<string, unknown>,
  descriptor: NodeExecutorDescriptor,
  runner: { descriptor: NodeExecutorDescriptor; execute?: unknown; prepareTask?: unknown },
): void {
  registry.register(descriptor);
  runners.set(descriptor.executorId, runner);
}

/** 注册 Project Graph 全部非人工节点 executor（驱动到 BLUEPRINT_USER_GATE） */
function fullProjectRunner(): {
  registry: ExecutorRegistry;
  runners: Map<string, unknown>;
} {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, unknown>();
  const specs: Array<[string, string, NodeOutput]> = [
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
    register(registry, runners, descriptor, syncRunner(descriptor, output));
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

/** 章节 runner：CHAPTER_PLAN sync + DRAFT task-backed */
function chapterDeps(base: Base, taskRepo: ReturnType<typeof fakeTaskRepo>): NodeRunnerDeps {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, unknown>();
  const plan = syncRunner(
    { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
    {},
  );
  const draft = taskBackedRunner(
    {
      executorId: 'chapter-draft-v1',
      executorVersion: 'v1',
      graphKind: 'chapter',
      nodeId: DRAFT as never,
      kind: 'task_backed',
      recoveryPolicy: 'settle_if_result',
    },
    'CHAPTER_DRAFT',
  );
  register(registry, runners, plan.descriptor, plan);
  register(registry, runners, draft.descriptor, draft);
  return runnerDeps(base, {
    registry,
    runners,
    resolver: acceptingResolver((p) => p.kind === 'generationRun'),
    taskRepo,
  });
}

function ideaCaptureOutput(): NodeOutput {
  return {
    artifact: {
      kind: 'idea',
      artifactId: 'idea-real-1',
      producerNodeId: IDEA_CAPTURE as never,
      version: 1,
    },
  };
}

/** 手动创建 running execution（真实 inputHash），返回 executionId */
function seedRunningExecution(
  base: Base,
  runId: string,
  nodeId: string,
  executionId: string,
  opts: { activationNo?: number; attemptNo?: number } = {},
): void {
  const state = base.graphRunRepo.getById(runId)!.state;
  const activationNo = opts.activationNo ?? 1;
  const inputHash = inputHashOf(
    base.deps.hashPayload,
    computeNodeInputSnapshot(base.deps.projectGraph, state, nodeId, activationNo),
  );
  base.nodeExecutionRepo.create({
    id: executionId,
    graphRunId: runId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    nodeId,
    activationNo,
    attemptNo: opts.attemptNo ?? 1,
    executorId: 'idea-capture-v1',
    executorVersion: 'v1',
    recoveryPolicy: 'replayable',
    inputSnapshotJson: serializeInputSnapshot(
      computeNodeInputSnapshot(base.deps.projectGraph, state, nodeId, activationNo),
    ),
    inputHash,
    createdAt: NOW,
    updatedAt: NOW,
  });
  base.nodeExecutionRepo.markRunning(executionId, ['pending'], {
    taskId: null,
    claimedBy: 'test-runner',
    leaseExpiresAt: NOW,
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
    expect(
      base.nodeExecutionRepo.getLatestByRunNode(run.workflowRunId, 'IDEA_CAPTURE')?.status,
    ).toBe('settled');
  });

  it('2. 未知 executor（空 registry）→ fail-closed', async () => {
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

  it('3. task RUNNING 中断 → 保持（不误 fail、不 spin）', async () => {
    const taskRepo = fakeTaskRepo();
    const deps = chapterDeps(base, taskRepo);
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch2',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const before = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(before.nodeStatuses[DRAFT]).toBe('active');
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled.filter((s) => s.nodeId === 'DRAFT')).toHaveLength(0);
    expect(
      getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId }).nodeStatuses[DRAFT],
    ).toBe('active');
  });

  it('3b. task-backed infra retry：TASK_INTERRUPTED → 统一 claim 新 attempt 新 task（同 activation）', async () => {
    const taskRepo = fakeTaskRepo();
    const calls: NodeExecutionInputContext[] = [];
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const plan = syncRunner(
      { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
      {},
    );
    const draft = taskBackedRunner(
      {
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        graphKind: 'chapter',
        nodeId: DRAFT as never,
        kind: 'task_backed',
        recoveryPolicy: 'replayable',
      },
      'CHAPTER_DRAFT',
      (ctx) => {
        calls.push(ctx);
        return { taskType: 'CHAPTER_DRAFT', payloadJson: '{}' };
      },
    );
    register(registry, runners, plan.descriptor, plan);
    register(registry, runners, draft.descriptor, draft);
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver(() => true),
      taskRepo,
    });
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch-retry',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const exec1 = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT')!;
    const task1 = exec1.taskId!;
    expect(exec1.attemptNo).toBe(1);
    // 基础设施中断
    taskRepo.tasks.set(task1, {
      ...taskRepo.tasks.get(task1)!,
      status: 'FAILED',
      errorCode: 'TASK_INTERRUPTED',
      errorMessage: '中断',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const exec2 = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT')!;
    expect(exec2.id).not.toBe(exec1.id);
    expect(exec2.activationNo).toBe(exec1.activationNo); // 同 activation
    expect(exec2.attemptNo).toBe(2); // attempt+1
    expect(base.nodeExecutionRepo.getById(exec1.id)?.status).toBe('superseded');
    const task2 = exec2.taskId!;
    expect(task2).not.toBe(task1);
    expect(taskRepo.tasks.has(task2)).toBe(true);
    // prepareTask 在真实身份后调用（无空 visitId/inputHash）
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.executionId.length).toBeGreaterThan(0);
      expect(c.activationNo).toBeGreaterThanOrEqual(1);
      expect(c.attemptNo).toBeGreaterThanOrEqual(1);
      expect(c.inputHash.length).toBeGreaterThan(0); // 真实 persisted inputHash，非空
    }
  });

  it('4. task 成功 + durable result 已持久化 + 未 settlement → 幂等 settlement（task-backed）', async () => {
    const taskRepo = fakeTaskRepo();
    const deps = chapterDeps(base, taskRepo);
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch',
    });
    await driveRun(deps, 'p1', run.workflowRunId);

    const draftExec = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT');
    expect(draftExec).not.toBeNull();
    expect(draftExec!.status).toBe('running');
    const taskId = draftExec!.taskId!;
    expect(taskRepo.tasks.has(taskId)).toBe(true);

    // 模拟崩溃窗口：task 成功 + execution-bound durable result 已持久化 + 未 settlement
    taskRepo.tasks.set(taskId, {
      ...taskRepo.tasks.get(taskId)!,
      status: 'SUCCEEDED',
      resultJson: '{}',
    });
    base.nodeExecutionResultStore.saveOrVerifySame({
      executionId: draftExec!.id,
      projectId: 'p1',
      graphRunId: run.workflowRunId,
      nodeId: 'DRAFT',
      taskId,
      activationNo: draftExec!.activationNo,
      attemptNo: draftExec!.attemptNo,
      executorId: 'chapter-draft-v1',
      executorVersion: 'v1',
      inputHash: draftExec!.inputHash,
      artifactKind: 'generationRun',
      artifactId: 'gen-real-1',
      artifactVersion: 1,
      contentJson: JSON.stringify({
        kind: 'generationRun',
        draft: { title: '第一章', content: '正文', scenePlans: [] },
      }),
      outcome: null,
      createdAt: NOW,
    });

    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled.some((s) => s.nodeId === 'DRAFT' && s.settled)).toBe(true);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as ChapterGenerationRunState;
    expect(state.nodeStatuses[DRAFT]).toBe('succeeded');
    // 真实 artifactId（不是 executionId 伪校验）
    expect(state.artifacts.generationRun?.artifactId).toBe('gen-real-1');
    expect(base.nodeExecutionRepo.getById(draftExec!.id)?.status).toBe('settled');
  });

  it('5. settlement 重复执行 → 返回原结果，不重复推进', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c7' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const exec = base.nodeExecutionRepo.getLatestByRunNode(run.workflowRunId, 'IDEA_CAPTURE')!;
    const dup = settleNodeExecution(deps, { projectId: 'p1', executionId: exec.id });
    expect(dup.settled).toBe(false);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
  });

  it('6. Graph CAS 冲突 → 整事务回滚（execution 未标 settled）', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c10' });
    const executionId = 'e10';
    seedRunningExecution(base, run.workflowRunId, 'IDEA_CAPTURE', executionId);
    base.setForceCasFail(true);
    try {
      expect(() =>
        settleNodeExecution(deps, {
          projectId: 'p1',
          executionId,
          output: ideaCaptureOutput(),
        }),
      ).toThrow();
    } finally {
      base.setForceCasFail(false);
    }
    expect(base.nodeExecutionRepo.getById(executionId)?.status).not.toBe('settled');
  });

  it('7. forged artifact ID → resolver 拒绝，Graph 不推进', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c8' });
    const executionId = 'e8';
    seedRunningExecution(base, run.workflowRunId, 'IDEA_CAPTURE', executionId);
    expect(() =>
      settleNodeExecution(deps, {
        projectId: 'p1',
        executionId,
        output: {
          artifact: {
            kind: 'idea',
            artifactId: 'forged-1',
            producerNodeId: IDEA_CAPTURE as never,
            version: 1,
          },
        },
      }),
    ).toThrow(NodeSettlementError);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('active');
  });

  it('8. wrong version → resolver 拒绝', async () => {
    const { registry, runners } = fullProjectRunner();
    const resolver: ArtifactResolverPort = {
      resolve(_repos, input) {
        if (input.proposed.version !== 7)
          throw new NodeSettlementError('NODE_SETTLEMENT_ARTIFACT_INVALID', 'version mismatch');
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
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver,
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c9' });
    const executionId = 'e9';
    seedRunningExecution(base, run.workflowRunId, 'IDEA_CAPTURE', executionId);
    expect(() =>
      settleNodeExecution(deps, {
        projectId: 'p1',
        executionId,
        output: ideaCaptureOutput(),
      }),
    ).toThrow(NodeSettlementError);
  });

  it('9. non-replayable executor 中断 → fail-closed，不自动重试', async () => {
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const idea = syncRunner(syncDescriptor('IDEA_CAPTURE', 'idea-fc', 'fail_closed'), {
      artifact: {
        kind: 'idea',
        artifactId: 'idea-real-1',
        producerNodeId: IDEA_CAPTURE as never,
        version: 1,
      },
    });
    register(registry, runners, idea.descriptor, idea);
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver((p) => p.artifactId === 'idea-real-1'),
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    const executionId = 'e11';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      activationNo: 1,
      attemptNo: 1,
      executorId: 'idea-fc',
      executorVersion: 'v1',
      recoveryPolicy: 'fail_closed',
      inputSnapshotJson: '{}',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], {
      taskId: null,
      claimedBy: 'test-runner',
      leaseExpiresAt: NOW,
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.terminalStatus).toBe('failed');
  });

  it('10. waiting_for_human 重启 → runner 不触碰', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c4' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.terminalStatus).toBeNull();
    expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  });

  it('11. terminal run 不复活', async () => {
    const deps = runnerDeps(base, { registry: new ExecutorRegistry() });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c5' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    expect(getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId }).terminalStatus).toBe(
      'failed',
    );
  });

  it('12. 并发 claim 同一节点 → 唯一约束防重复，executor 只 dispatch 一次', async () => {
    const deps1 = fullProjectDeps(base);
    const deps2 = fullProjectDeps(base);
    const { run } = createProjectRun(deps1, { projectId: 'p1', idempotencyKey: 'c6' });
    const a = await driveRun(deps1, 'p1', run.workflowRunId);
    const b = await driveRun(deps2, 'p1', run.workflowRunId);
    expect(a.filter((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled).length).toBe(1);
    expect(b.filter((s) => s.nodeId === 'IDEA_CAPTURE')).toHaveLength(0);
    const execs = [...base.executions.values()].filter(
      (e) => e.nodeId === 'IDEA_CAPTURE' && e.status === 'settled',
    );
    expect(execs.length).toBe(1);
    const state = getRunProgress(deps1, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
  });

  it('13. loop reactivation：节点再次 active（业务循环）→ 新 execution（新 activation）', async () => {
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const defs: Array<[string, string, NodeOutput]> = [
      ['IDEA_CAPTURE', 'idea-capture-v1', ideaCaptureOutput()],
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
        { outcome: { condition: 'research_decision', value: 'deep' } },
      ],
      ['RESEARCH_PLAN', 'research-plan-v1', {}],
      [
        'RESEARCH_EXECUTE',
        'research-execute-v1',
        {
          artifact: {
            kind: 'researchBundle',
            artifactId: 'rb-1',
            producerNodeId: 'RESEARCH_EXECUTE' as never,
            version: 1,
          },
        },
      ],
      [
        'RESEARCH_VALIDATE',
        'research-validate-v1',
        { outcome: { condition: 'research_valid', value: 'invalid' } },
      ],
    ];
    for (const [nodeId, id, output] of defs) {
      const d = syncDescriptor(nodeId, id);
      register(registry, runners, d, syncRunner(d, output));
    }
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver((p) =>
        ['idea-real-1', 'spec-real-1', 'rb-1'].includes(p.artifactId),
      ),
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c15' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const execs = [...base.executions.values()].filter((e) => e.nodeId === 'RESEARCH_EXECUTE');
    // researchRetry 循环：RESEARCH_EXECUTE 至少被执行两次（两次 active → 两个 activation）
    expect(execs.filter((e) => e.status === 'settled').length).toBeGreaterThanOrEqual(2);
    // activation 递增、attempt 重置 1
    const activations = execs.map((e) => e.activationNo).sort((a, b) => a - b);
    expect(new Set(activations).size).toBe(activations.length);
    expect(activations[0]).toBe(1);
  });

  it('14. fan-out：全部三个 task-backed Critic 在任一完成前都已创建 execution/task', async () => {
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const plan = syncRunner(
      { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
      {},
    );
    const draft = taskBackedRunner(
      {
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        graphKind: 'chapter',
        nodeId: DRAFT as never,
        kind: 'task_backed',
        recoveryPolicy: 'settle_if_result',
      },
      'CHAPTER_DRAFT',
    );
    const criticIds = ['CONTINUITY_CRITIC', 'STYLE_CRITIC', 'REQUIREMENT_CRITIC'];
    const criticRunners = criticIds.map((nodeId, i) =>
      taskBackedRunner(
        {
          executorId: `critic-${i}-v1`,
          executorVersion: 'v1',
          graphKind: 'chapter',
          nodeId: nodeId as never,
          kind: 'task_backed',
          recoveryPolicy: 'settle_if_result',
        },
        'CHAPTER_DRAFT',
      ),
    );
    register(registry, runners, plan.descriptor, plan);
    register(registry, runners, draft.descriptor, draft);
    criticRunners.forEach((r) => register(registry, runners, r.descriptor, r));

    const taskRepo = fakeTaskRepo();
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver(() => true),
      taskRepo,
    });
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch-fanout',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const draftExec = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT');
    if (draftExec) {
      const taskId = draftExec.taskId!;
      taskRepo.tasks.set(taskId, {
        ...taskRepo.tasks.get(taskId)!,
        status: 'SUCCEEDED',
        resultJson: '{}',
      });
      base.nodeExecutionResultStore.saveOrVerifySame({
        executionId: draftExec.id,
        projectId: 'p1',
        graphRunId: run.workflowRunId,
        nodeId: 'DRAFT',
        taskId,
        activationNo: draftExec.activationNo,
        attemptNo: draftExec.attemptNo,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: draftExec.inputHash,
        artifactKind: 'generationRun',
        artifactId: 'gen-fanout',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'x', content: 'y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      });
      await driveRun(deps, 'p1', run.workflowRunId);
    }
    const created = criticIds.map(
      (nodeId) =>
        base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, nodeId) ??
        base.nodeExecutionRepo.getLatestByRunNode(run.workflowRunId, nodeId),
    );
    expect(created.every((c) => c !== null && c!.taskId !== null)).toBe(true);
    const criticTaskIds = created.map((c) => c!.taskId!);
    expect(criticTaskIds.every((tid) => taskRepo.tasks.has(tid))).toBe(true);
  });

  it('15. settlement 身份：stale input（真实 inputHash 与当前不一致）→ 拒绝', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c17' });
    const executionId = 'e17';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      activationNo: 1,
      attemptNo: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputSnapshotJson: '{}',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], {
      taskId: null,
      claimedBy: 'test-runner',
      leaseExpiresAt: NOW,
    });
    // inputHash 'h'.repeat(64) 与真实不一致 → stale 拒绝
    expect(() => settleNodeExecution(deps, { projectId: 'p1', executionId })).toThrow();
  });

  it('16. sync lease：未过期 → 其他 runner 保持（不重试）', async () => {
    const taskRepo = fakeTaskRepo();
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const idea = syncRunner(
      syncDescriptor('IDEA_CAPTURE', 'idea-lease', 'replayable'),
      ideaCaptureOutput(),
    );
    register(registry, runners, idea.descriptor, idea);
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver(() => true),
      taskRepo,
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c-lease1' });
    // 手动创建 running sync execution，lease 在未来（未过期）
    seedRunningExecution(base, run.workflowRunId, 'IDEA_CAPTURE', 'e-lease');
    // 推进 lease 到未来（不修改 clock，用固定未来时间）
    const exec = base.nodeExecutionRepo.getById('e-lease')!;
    base.nodeExecutionRepo.markRunning('e-lease', ['running'], {
      taskId: null,
      claimedBy: 'other-runner',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    void exec;
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    // 未被 supersede / 未创建新 attempt
    expect(base.nodeExecutionRepo.getById('e-lease')?.status).toBe('running');
    expect(base.executions.get('e-lease')?.attemptNo).toBe(1);
  });

  it('17. sync lease：已过期 → 同 activation 新 attempt（统一 claim）', async () => {
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const idea = syncRunner(
      syncDescriptor('IDEA_CAPTURE', 'idea-lease-exp', 'replayable'),
      ideaCaptureOutput(),
    );
    register(registry, runners, idea.descriptor, idea);
    // 可推进时钟
    let now = Date.parse(NOW);
    const clock = () => new Date(now).toISOString();
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver(() => true),
      now: clock,
    });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c-lease2' });
    // 手动创建 running sync execution，lease 在 now+lease（未过期）
    const state = base.graphRunRepo.getById(run.workflowRunId)!.state;
    const inputHash = inputHashOf(
      base.deps.hashPayload,
      computeNodeInputSnapshot(base.deps.projectGraph, state, 'IDEA_CAPTURE', 1),
    );
    base.nodeExecutionRepo.create({
      id: 'e-lease2',
      graphRunId: run.workflowRunId,
      graphId: state.graphId,
      graphVersion: state.graphVersion,
      nodeId: 'IDEA_CAPTURE',
      activationNo: 1,
      attemptNo: 1,
      executorId: 'idea-lease-exp',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputSnapshotJson: serializeInputSnapshot(
        computeNodeInputSnapshot(base.deps.projectGraph, state, 'IDEA_CAPTURE', 1),
      ),
      inputHash,
      createdAt: clock(),
      updatedAt: clock(),
    });
    base.nodeExecutionRepo.markRunning('e-lease2', ['pending'], {
      taskId: null,
      claimedBy: 'other-runner',
      leaseExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    });
    // lease 未过期 → 保持
    const hold = await driveRun(deps, 'p1', run.workflowRunId);
    expect(hold).toHaveLength(0);
    expect(base.nodeExecutionRepo.getById('e-lease2')?.status).toBe('running');
    // 推进时钟超过 lease → 重试（新 attempt，同 activation）
    now += 6 * 60 * 1000;
    const retried = await driveRun(deps, 'p1', run.workflowRunId);
    expect(retried.some((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled)).toBe(true);
    const newExec = base.nodeExecutionRepo.getLatestByRunNode(run.workflowRunId, 'IDEA_CAPTURE')!;
    expect(newExec.activationNo).toBe(1);
    expect(newExec.attemptNo).toBe(2);
    expect(base.nodeExecutionRepo.getById('e-lease2')?.status).toBe('superseded');
  });

  it('18. 确定性 task 失败（业务性错误码）→ 原子失败，不 infra retry', async () => {
    const taskRepo = fakeTaskRepo();
    const registry = new ExecutorRegistry();
    const runners = new Map<string, unknown>();
    const plan = syncRunner(
      { ...syncDescriptor('CHAPTER_PLAN', 'chapter-plan-v1'), graphKind: 'chapter' as const },
      {},
    );
    const draft = taskBackedRunner(
      {
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        graphKind: 'chapter',
        nodeId: DRAFT as never,
        kind: 'task_backed',
        recoveryPolicy: 'replayable',
      },
      'CHAPTER_DRAFT',
    );
    register(registry, runners, plan.descriptor, plan);
    register(registry, runners, draft.descriptor, draft);
    const deps = runnerDeps(base, {
      registry,
      runners,
      resolver: acceptingResolver(() => true),
      taskRepo,
    });
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch-det-fail',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const exec1 = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT')!;
    taskRepo.tasks.set(exec1.taskId!, {
      ...taskRepo.tasks.get(exec1.taskId!)!,
      status: 'FAILED',
      errorCode: 'MODEL_RESPONSE_INVALID',
      errorMessage: '输出非法',
    });
    await driveRun(deps, 'p1', run.workflowRunId);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as ChapterGenerationRunState;
    expect(state.terminalStatus).toBe('failed');
    expect(state.nodeStatuses[DRAFT]).toBe('failed');
    expect(base.nodeExecutionRepo.getById(exec1.id)?.status).toBe('failed');
    // 没有创建新 attempt
    const all = [...base.executions.values()].filter((e) => e.nodeId === 'DRAFT');
    expect(all.length).toBe(1);
  });
});
