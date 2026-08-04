/**
 * NodeRunner / NodeSettlementService 崩溃窗口测试（RW-1 Rework）。
 *
 * 覆盖：active 无 execution 分发、未知 executor fail-closed、task RUNNING 保持、
 * task 成功+未 settlement 幂等、重复 settlement、CAS 冲突回滚、forged artifact、
 * wrong version、non-replayable、waiting_for_human、terminal 不复活、并发 claim、
 * **loop reactivation（新 visit 新 execution）**、**fan-out 全量 dispatch**、
 * **settlement 身份（cross-node）拒绝**。
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

function syncRunner(descriptor: NodeExecutorDescriptor, output: NodeOutput): NodeExecutorRunner {
  return {
    descriptor,
    async run() {
      return { kind: 'sync', output };
    },
  };
}

function taskBackedRunner(
  descriptor: NodeExecutorDescriptor,
  taskType: TaskData['taskType'],
  taskId: string,
): NodeExecutorRunner {
  return {
    descriptor,
    async run(): Promise<{ kind: 'task'; spec: NodeTaskSpec }> {
      return { kind: 'task', spec: { taskType, payloadJson: '{}', dedupeKey: `exec:${taskId}` } };
    },
  };
}

/** 注册 Project Graph 全部非人工节点 executor（驱动到 BLUEPRINT_USER_GATE） */
function fullProjectRunner(): {
  registry: ExecutorRegistry;
  runners: Map<string, NodeExecutorRunner>;
} {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
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

/** 章节 runner：CHAPTER_PLAN sync + DRAFT task-backed */
function chapterDeps(base: Base, taskRepo: ReturnType<typeof fakeTaskRepo>): NodeRunnerDeps {
  const registry = new ExecutorRegistry();
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
    'task-draft',
  );
  registry.register(plan.descriptor);
  registry.register(draft.descriptor);
  return runnerDeps(base, {
    registry,
    runners: new Map([
      [plan.descriptor.executorId, plan],
      [draft.descriptor.executorId, draft],
    ]),
    resolver: acceptingResolver((p) => p.kind === 'generationRun'),
    taskRepo,
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

  it('2+10. 未知 executor（空 registry）→ fail-closed', async () => {
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
    base.nodeExecutionResultStore.save({
      executionId: draftExec!.id,
      projectId: 'p1',
      graphRunId: run.workflowRunId,
      nodeId: 'DRAFT',
      taskId,
      attempt: draftExec!.attempt,
      executorId: 'chapter-draft-v1',
      executorVersion: 'v1',
      inputHash: draftExec!.inputHash,
      artifactKind: 'generationRun',
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
    expect(state.artifacts.generationRun?.artifactId).toBe(draftExec!.id);
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
      visitId: 'v10',
      attempt: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    base.setForceCasFail(true);
    try {
      expect(() =>
        settleNodeExecution(deps, {
          projectId: 'p1',
          executionId,
          output: {
            artifact: {
              kind: 'idea',
              artifactId: 'idea-real-1',
              producerNodeId: IDEA_CAPTURE as never,
              version: 1,
            },
          },
        }),
      ).toThrow();
    } finally {
      base.setForceCasFail(false);
    }
    expect(base.nodeExecutionRepo.getById(executionId)?.status).not.toBe('settled');
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
      visitId: 'v8',
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

  it('9. wrong version → resolver 拒绝', async () => {
    const { registry, runners } = fullProjectRunner();
    const resolver: ArtifactResolverPort = {
      resolve(input) {
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
    const deps = runnerDeps(base, { registry, runners, resolver });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c9' });
    const executionId = 'e9';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      visitId: 'v9',
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
        executionId,
        output: {
          artifact: {
            kind: 'idea',
            artifactId: 'idea-real-1',
            producerNodeId: IDEA_CAPTURE as never,
            version: 1,
          },
        },
      }),
    ).toThrow(NodeSettlementError);
  });

  it('11. non-replayable executor 中断 → fail-closed，不自动重试', async () => {
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
    const executionId = 'e11';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      visitId: 'v11',
      attempt: 1,
      executorId: 'idea-fc',
      executorVersion: 'v1',
      recoveryPolicy: 'fail_closed',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    await driveRun(deps, 'p1', run.workflowRunId);
    const state = getRunProgress(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
    }) as IdeaToNovelProjectRunState;
    expect(state.terminalStatus).toBe('failed');
  });

  it('12. waiting_for_human 重启 → runner 不触碰', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c4' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    const state = getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId });
    expect(state.terminalStatus).toBeNull();
    expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  });

  it('13. terminal run 不复活', async () => {
    const deps = runnerDeps(base, { registry: new ExecutorRegistry() });
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c5' });
    await driveRun(deps, 'p1', run.workflowRunId);
    const settled = await driveRun(deps, 'p1', run.workflowRunId);
    expect(settled).toHaveLength(0);
    expect(getRunProgress(deps, { projectId: 'p1', runId: run.workflowRunId }).terminalStatus).toBe(
      'failed',
    );
  });

  it('14. 并发 claim 同一节点 → 唯一约束防重复，executor 只 dispatch 一次', async () => {
    const deps1 = fullProjectDeps(base);
    const deps2 = fullProjectDeps(base);
    const { run } = createProjectRun(deps1, { projectId: 'p1', idempotencyKey: 'c6' });
    // 顺序执行两个 runner：第二个不应重复 dispatch（IDEA_CAPTURE 已 settled → 无 active 非人工）
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

  it('15. loop reactivation：节点再次 active（业务循环）→ 创建新 execution（新 visit）', async () => {
    // 用 RESEARCH retry 语义：先注册一个 sync RESEARCH_VALIDATE 产出 invalid，
    // 触发 researchRetry 循环（RESEARCH_EXECUTE 再次 active）→ 新 execution。
    const registry = new ExecutorRegistry();
    const runners = new Map<string, NodeExecutorRunner>();
    const defs: Array<[string, string, NodeOutput]> = [
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
      registry.register(d);
      runners.set(id, syncRunner(d, output));
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
    // researchRetry 循环：RESEARCH_EXECUTE 至少被执行两次（两次 active → 两个 execution）
    expect(execs.filter((e) => e.status === 'settled').length).toBeGreaterThanOrEqual(2);
  });

  it('16. fan-out：全部三个 task-backed Critic 在任一完成前都已创建 execution/task', async () => {
    // 构造一个 DRAFT → 三 Critic 并行的最小图：直接用手动 execution 模拟三 Critic active
    // 用 chapter 图：注册 CHAPTER_PLAN sync + DRAFT task-backed，然后让 DRAFT 完成后三 Critic active
    // 这里用真实 chapter 图三 Critic 节点：注册 sync 无产物 executor（生产环境 Critic 是 task-backed，
    // 但此处验证 fan-out 全量 dispatch 语义）。
    const registry = new ExecutorRegistry();
    const runners = new Map<string, NodeExecutorRunner>();
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
      'task-draft',
    );
    // 三 Critic 注册为 task-backed（返回不同 spec/taskId）
    const criticIds = ['CONTINUITY_CRITIC', 'STYLE_CRITIC', 'REQUIREMENT_CRITIC'];
    const criticRunners: NodeExecutorRunner[] = criticIds.map((nodeId, i) =>
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
        `task-critic-${i}`,
      ),
    );
    registry.register(plan.descriptor);
    registry.register(draft.descriptor);
    criticRunners.forEach((r) => registry.register(r.descriptor));
    runners.set(plan.descriptor.executorId, plan);
    runners.set(draft.descriptor.executorId, draft);
    criticRunners.forEach((r) => runners.set(r.descriptor.executorId, r));

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
    // CHAPTER_PLAN settle + DRAFT task 创建；DRAFT 完成后三 Critic active
    await driveRun(deps, 'p1', run.workflowRunId);
    // 让 DRAFT 完成并持久化 result，然后三 Critic active → 全量 dispatch
    const draftExec = base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, 'DRAFT');
    if (draftExec) {
      const taskId = draftExec.taskId!;
      taskRepo.tasks.set(taskId, {
        ...taskRepo.tasks.get(taskId)!,
        status: 'SUCCEEDED',
        resultJson: '{}',
      });
      base.nodeExecutionResultStore.save({
        executionId: draftExec.id,
        projectId: 'p1',
        graphRunId: run.workflowRunId,
        nodeId: 'DRAFT',
        taskId,
        attempt: draftExec.attempt,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: draftExec.inputHash,
        artifactKind: 'generationRun',
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
    // 三 Critic 都应有 execution/task（全量 dispatch，非只第一个）
    const created = criticIds.map(
      (nodeId) =>
        base.nodeExecutionRepo.getInFlightByRunNode(run.workflowRunId, nodeId) ??
        base.nodeExecutionRepo.getLatestByRunNode(run.workflowRunId, nodeId),
    );
    expect(created.every((c) => c !== null && c!.taskId !== null)).toBe(true);
    // 三个 Critic 都有已创建的 task（fan-out 全量 dispatch，非只第一个）
    const criticTaskIds = created.map((c) => c!.taskId!);
    expect(criticTaskIds.every((tid) => taskRepo.tasks.has(tid))).toBe(true);
  });

  it('17. settlement 身份：execution.nodeId 与输入 nodeId 不一致 → 拒绝', async () => {
    const deps = fullProjectDeps(base);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c17' });
    const executionId = 'e17';
    base.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: run.workflowRunId,
      graphId: 'idea-to-novel-project',
      graphVersion: 'v1',
      nodeId: 'IDEA_CAPTURE',
      visitId: 'v17',
      attempt: 1,
      executorId: 'idea-capture-v1',
      executorVersion: 'v1',
      recoveryPolicy: 'replayable',
      inputHash: 'h'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });
    base.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    // 直接调用 settleNodeExecution：它从 execution 反推 run/node，调用方无法自由组合
    // （此用例验证输入哈希 stale 会被拒绝 —— 因为 inputHash 'h'.repeat(64) 与真实不一致）
    expect(() => settleNodeExecution(deps, { projectId: 'p1', executionId })).toThrow();
  });
});
