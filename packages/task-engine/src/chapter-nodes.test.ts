/**
 * 章节生成四类任务执行器测试（GE-6 / B9）。
 *
 * - 严格解析：场景计划 / 正文 / 审查结论的边界（含 needs_rewrite 必须带问题）；
 * - executeChapterPlan：场景计划落库 + envelope 无 artifact 无 outcome（图契约 noOut）；
 * - executeChapterDraftNode：候选修订 1 + envelope generationRun artifact（id/版本一致）；
 * - executeChapterCritique：审查结论绑定**当前候选修订**；角色由权威 execution.nodeId
 *   派生（payload 里的伪造角色无效）；outcome 为 critique_verdict；
 * - executeChapterRewrite：新增 REWRITE 修订（artifactId 恒 null，图契约 noOut），
 *   prompt 携带上一轮审查问题；
 * - 上下文缺失（蓝图/章节/创作要求）→ 任务确定性 FAILED，不留半成品；
 * - 最终事务失败 → 补偿标记仍 RUNNING 的 invocation/task FAILED。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  TaskRepositoryPort,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  ProviderProfileData,
  IdGenerator,
  Clock,
  TaskData,
  ModelInvocationData,
  CreateInvocationInput,
  InvocationSuccessResult,
  NodeExecutionRepositoryPort,
  NodeExecutionRecord,
  NodeExecutionResultEnvelope,
  NodeExecutionResultStorePort,
  GraphRunRepositoryPort,
  StoryBlueprintRepositoryPort,
  CreationContractVersionRepositoryPort,
  ChapterScenePlanRepositoryPort,
  ChapterCandidateRepositoryPort,
  ChapterCritiqueRepositoryPort,
  ChapterRewriteFeedbackRepositoryPort,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import type {
  ChapterCandidate,
  ChapterCritique,
  ChapterRewriteFeedback,
  ChapterScenePlan,
  StoryBlueprint,
  TaskType,
} from '@ai-novel/domain';
import { CONTINUITY_CRITIC, STYLE_CRITIC } from '@ai-novel/domain';
import {
  executeChapterCritique,
  executeChapterDraftNode,
  executeChapterPlan,
  executeChapterRewrite,
  parseChapterCritiqueV1,
  parseChapterPlanV1,
  parseChapterProseV1,
  TaskExecutionError,
  type ChapterNodeExecutionDeps,
} from './index.js';

const NOW = '2026-08-13T00:00:00.000Z';
const RUN_ID = 'run-1';
const PROJECT_ID = 'p1';
const BLUEPRINT_ID = 'bp-1';
const CHAPTER_ID = 'ch-2';
const SPEC_VERSION_ID = 'spec-v1';
const LONG_CONTENT = '正文'.repeat(200);

function execution(nodeId: string): NodeExecutionRecord {
  return {
    id: 'exec-1',
    graphRunId: RUN_ID,
    graphId: 'chapter-generation',
    graphVersion: 'v1',
    nodeId,
    activationNo: 1,
    attemptNo: 1,
    executorId: `executor-${nodeId}`,
    executorVersion: 'v1',
    recoveryPolicy: 'settle_if_result',
    inputSnapshotJson: '{}',
    inputHash: 'h'.repeat(64),
    taskId: 't1',
    claimedBy: 'test-runner',
    leaseExpiresAt: null,
    status: 'running',
    artifactReceiptJson: null,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    settledAt: null,
  };
}

function mockTask(taskType: TaskType, payloadJson = '{}'): TaskData {
  return {
    id: 't1',
    projectId: PROJECT_ID,
    taskType,
    status: 'PENDING',
    inputVersionJson: '{}',
    payloadJson,
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: null,
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
  };
}

function mockProviderProfile(): ProviderProfileData {
  return {
    id: 'mimo-token-plan-cn',
    providerType: 'anthropic-messages',
    displayName: 'MiMo',
    baseUrl: 'https://x',
    model: 'mimo-v2.5-pro',
    keychainService: 'svc',
    keychainAccount: 'acc',
    enabled: true,
    isDefault: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  };
}

function createFakeProviderRepo(): ProviderProfileRepository {
  const profile = mockProviderProfile();
  return {
    getById: vi.fn((id: string) => (id === profile.id ? profile : null)),
    list: vi.fn(() => [profile]),
    getDefault: vi.fn(() => profile),
    create: vi.fn(() => {
      throw new Error('未使用：create');
    }),
    update: vi.fn(() => {
      throw new Error('未使用：update');
    }),
    delete: vi.fn(() => {
      throw new Error('未使用：delete');
    }),
    setDefault: vi.fn(() => {
      throw new Error('未使用：setDefault');
    }),
    getRoute: vi.fn(() => null),
    setRoute: vi.fn(() => {
      throw new Error('未使用：setRoute');
    }),
    deleteRoute: vi.fn(() => {
      throw new Error('未使用：deleteRoute');
    }),
    updateTestResult: vi.fn(),
  };
}

function mockInvocation(data: CreateInvocationInput): ModelInvocationData {
  return {
    ...data,
    status: 'PENDING',
    createdAt: NOW,
    responseMetadataJson: null,
    finishedAt: null,
    startedAt: null,
    latencyMs: null,
    errorCode: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    finishReason: null,
    providerRequestId: null,
  };
}

function blueprintFixture(): StoryBlueprint {
  return {
    id: BLUEPRINT_ID,
    projectId: PROJECT_ID,
    version: 1,
    premise: '边境小城的走私者被迫接下一桩不能失败的活',
    characters: [{ name: '林荞', role: '主角', description: '走私者' }],
    relationships: ['林荞与旧搭档决裂'],
    world: '架空民国边城',
    conflict: '货物是禁运品',
    ending: '林荞交出货物换回搭档',
    plotlines: [{ name: '主线', summary: '接活到交货' }],
    chapters: [
      { id: 'ch-1', title: '第一章 接头', goal: '交代人物与困境' },
      { id: CHAPTER_ID, title: '第二章 越境', goal: '越境途中遭遇伏击' },
    ],
    createdAt: NOW,
  };
}

function successOutput(text: string): ModelInvocationOutput {
  return {
    text,
    providerRequestId: 'req-1',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
    },
    latencyMs: 100,
    errorCode: null,
    errorMessage: null,
  };
}

interface Harness {
  readonly deps: ChapterNodeExecutionDeps;
  readonly taskStore: Map<string, TaskData>;
  readonly invocationStore: Map<string, ModelInvocationData>;
  readonly resultStore: Map<string, NodeExecutionResultEnvelope>;
  readonly candidates: ChapterCandidate[];
  readonly critiques: ChapterCritique[];
  readonly scenePlans: ChapterScenePlan[];
  readonly invokeModel: ReturnType<typeof vi.fn>;
}

function buildHarness(options: {
  taskType: TaskType;
  nodeId: string;
  responseText: string;
  payloadJson?: string;
  blueprint?: StoryBlueprint | null;
  specSectionsJson?: string | null;
  candidates?: ChapterCandidate[];
  critiques?: ChapterCritique[];
  feedbacks?: ChapterRewriteFeedback[];
  scenePlans?: ChapterScenePlan[];
  preexistingResult?: NodeExecutionResultEnvelope;
}): Harness {
  const taskStore = new Map<string, TaskData>([
    ['t1', mockTask(options.taskType, options.payloadJson ?? '{}')],
  ]);
  const invocationStore = new Map<string, ModelInvocationData>();
  const candidates = [...(options.candidates ?? [])];
  const critiques = [...(options.critiques ?? [])];
  const scenePlans = [...(options.scenePlans ?? [])];

  const taskRepo: TaskRepositoryPort = {
    create: vi.fn(),
    getById: vi.fn((id: string) => taskStore.get(id) ?? null),
    listByProject: vi.fn(() => []),
    listByStatus: vi.fn(() => []),
    claimPending: vi.fn((id: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'PENDING') return false;
      taskStore.set(id, { ...t, status: 'RUNNING', attemptCount: t.attemptCount + 1 });
      return true;
    }),
    completeRunning: vi.fn((id: string, resultJson: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'SUCCEEDED', resultJson });
      return true;
    }),
    failRunning: vi.fn((id: string, errorCode: string, errorMessage: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    }),
    failPending: vi.fn(() => true),
    markStale: vi.fn(() => true),
    resetToPending: vi.fn(() => true),
    listRunning: vi.fn(() => []),
  };

  const invocationRepo: ModelInvocationRepositoryPort = {
    create: vi.fn((data: CreateInvocationInput) =>
      invocationStore.set(data.id, mockInvocation(data)),
    ),
    getById: vi.fn((id: string) => invocationStore.get(id) ?? null),
    listByTask: vi.fn(() => []),
    markRunning: vi.fn((id: string) => {
      const inv = invocationStore.get(id);
      if (!inv || inv.status !== 'PENDING') return false;
      invocationStore.set(id, { ...inv, status: 'RUNNING' });
      return true;
    }),
    markSucceeded: vi.fn((id: string, _s: 'RUNNING', result: InvocationSuccessResult) => {
      const inv = invocationStore.get(id);
      if (!inv || inv.status !== 'RUNNING') return false;
      invocationStore.set(id, { ...inv, status: 'SUCCEEDED', ...result });
      return true;
    }),
    markFailed: vi.fn(
      (id: string, expected: ReadonlyArray<string>, errorCode: string, errorMessage: string) => {
        const inv = invocationStore.get(id);
        if (!inv || !expected.includes(inv.status)) return false;
        invocationStore.set(id, { ...inv, status: 'FAILED', errorCode, errorMessage });
        return true;
      },
    ),
    getStatsByProject: vi.fn(() => ({
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    })),
    listRunning: vi.fn(() => []),
  };

  const resultStore = new Map<string, NodeExecutionResultEnvelope>();
  if (options.preexistingResult) {
    resultStore.set(options.preexistingResult.executionId, options.preexistingResult);
  }
  const nodeExecutionResultStore: NodeExecutionResultStorePort = {
    save: (r) => resultStore.set(r.executionId, r),
    saveOrVerifySame: (r) => {
      const existing = resultStore.get(r.executionId);
      if (existing === undefined) {
        resultStore.set(r.executionId, r);
        return;
      }
      if (JSON.stringify(existing) !== JSON.stringify(r)) {
        throw new Error(`execution ${r.executionId} 已有不同内容的权威 result，拒绝覆盖`);
      }
    },
    getByExecutionId: (id) => resultStore.get(id) ?? null,
    getByArtifactId: (artifactId) =>
      [...resultStore.values()].find((r) => r.artifactId === artifactId) ?? null,
  };

  const exec = execution(options.nodeId);
  const nodeExecutionRepo: NodeExecutionRepositoryPort = {
    create: vi.fn(() => true),
    getById: vi.fn(() => null),
    getByTaskId: vi.fn((taskId: string) => (taskId === 't1' ? exec : null)),
    getLatestByRunNode: vi.fn(() => null),
    getInFlightByRunNode: vi.fn(() => null),
    listActiveByRun: vi.fn(() => []),
    markRunning: vi.fn(() => true),
    markSettled: vi.fn(() => true),
    markFailed: vi.fn(() => true),
    markSuperseded: vi.fn(() => true),
  };

  const graphRunRepo = {
    create: vi.fn(),
    getById: vi.fn((runId: string) =>
      runId === RUN_ID
        ? {
            kind: 'chapter' as const,
            expectedVersion: 1,
            state: {
              projectId: PROJECT_ID,
              graphId: 'chapter-generation',
              creationSpecVersionId: SPEC_VERSION_ID,
              researchBundleId: null,
              storyBlueprintId: BLUEPRINT_ID,
              blueprintChapterId: CHAPTER_ID,
            },
          }
        : null,
    ),
    listByProject: vi.fn(() => []),
    saveWithCas: vi.fn(() => true),
  } as unknown as GraphRunRepositoryPort;

  const blueprint = options.blueprint === undefined ? blueprintFixture() : options.blueprint;
  const blueprintRepo = {
    save: vi.fn(),
    getById: vi.fn(() => (blueprint ? { blueprint, accepted: true } : null)),
    listByProject: vi.fn(() => (blueprint ? [blueprint] : [])),
    markAccepted: vi.fn(() => true),
    getMaxVersion: vi.fn(() => 1),
  } as unknown as StoryBlueprintRepositoryPort;

  const sectionsJson =
    options.specSectionsJson === undefined
      ? JSON.stringify({
          premise: '走私者被迫接下一桩不能失败的活',
          genre: ['悬疑'],
          tone: ['冷硬'],
          targetAudience: '成年读者',
          narrativePov: 'THIRD_LIMITED',
          tense: 'PAST',
          protagonist: { characterKey: 'linqiao', name: '林荞' },
        })
      : options.specSectionsJson;
  const specVersionRepo = {
    getById: vi.fn(() =>
      sectionsJson === null
        ? null
        : {
            id: SPEC_VERSION_ID,
            projectId: PROJECT_ID,
            version: 1,
            sectionsJson,
            createdAt: NOW,
          },
    ),
  } as unknown as CreationContractVersionRepositoryPort;

  const scenePlanRepo: ChapterScenePlanRepositoryPort = {
    save: vi.fn((plan: ChapterScenePlan) => {
      scenePlans.push(plan);
    }),
    getLatestByRun: vi.fn(() => scenePlans.at(-1) ?? null),
  };

  const candidateRepo: ChapterCandidateRepositoryPort = {
    save: vi.fn((candidate: ChapterCandidate) => {
      candidates.push(candidate);
    }),
    getLatestByRun: vi.fn(
      () => [...candidates].sort((a, b) => b.revisionNo - a.revisionNo)[0] ?? null,
    ),
    getMaxRevisionNo: vi.fn(() => candidates.reduce((max, c) => Math.max(max, c.revisionNo), 0)),
    listByRun: vi.fn(() => candidates),
    getByArtifactId: vi.fn(
      (_projectId: string, artifactId: string) =>
        candidates.find((c) => c.artifactId === artifactId) ?? null,
    ),
  };

  const feedbacks: ChapterRewriteFeedback[] = [...(options.feedbacks ?? [])];
  const rewriteFeedbackRepo: ChapterRewriteFeedbackRepositoryPort = {
    save: vi.fn((feedback: ChapterRewriteFeedback) => {
      feedbacks.push(feedback);
    }),
    getLatestForRevision: vi.fn(
      (_p: string, _r: string, revisionNo: number) =>
        [...feedbacks].reverse().find((f) => f.candidateRevisionNo === revisionNo) ?? null,
    ),
  };

  const critiqueRepo: ChapterCritiqueRepositoryPort = {
    save: vi.fn((critique: ChapterCritique) => {
      critiques.push(critique);
    }),
    listByCandidateRevision: vi.fn((_p: string, _r: string, revisionNo: number) =>
      critiques.filter((c) => c.candidateRevisionNo === revisionNo),
    ),
  };

  const secretStore: SecretStore = {
    hasSecret: vi.fn(async () => true),
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async () => 'test-key'),
    deleteSecret: vi.fn(async () => {}),
  };

  let idCounter = 0;
  const idGenerator: IdGenerator = { generate: vi.fn(() => `id-${++idCounter}`) };
  const clock: Clock = { now: vi.fn(() => NOW) };
  const invokeModel = vi.fn(async () => successOutput(options.responseText));

  const deps: ChapterNodeExecutionDeps = {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo: createFakeProviderRepo(),
    idGenerator,
    clock,
    invokeModel,
    transaction: <T>(fn: () => T) => fn(),
    nodeExecutionResultStore,
    nodeExecutionRepo,
    graphRunRepo,
    blueprintRepo,
    specVersionRepo,
    scenePlanRepo,
    candidateRepo,
    critiqueRepo,
    rewriteFeedbackRepo,
  };

  return {
    deps,
    taskStore,
    invocationStore,
    resultStore,
    candidates,
    critiques,
    scenePlans,
    invokeModel,
  };
}

function draftCandidate(revisionNo = 1): ChapterCandidate {
  return {
    id: `cand-${revisionNo}`,
    projectId: PROJECT_ID,
    graphRunId: RUN_ID,
    revisionNo,
    source: 'DRAFT',
    artifactId: `cand-${revisionNo}`,
    title: '第二章 越境',
    content: LONG_CONTENT,
    createdAt: NOW,
  };
}

const PLAN_RESPONSE = JSON.stringify({
  schemaVersion: 1,
  title: '第二章 越境',
  scenes: [{ summary: '夜渡冰河', beats: ['踩点', '下水'] }],
});

const PROSE_RESPONSE = JSON.stringify({
  schemaVersion: 1,
  title: '第二章 越境',
  content: LONG_CONTENT,
});

// ── 解析边界 ──────────────────────────────────────────────────────

describe('章节输出严格解析', () => {
  it('场景计划：合法 JSON → 解析；多余字段/空 scenes/超量 scenes 拒绝', () => {
    const plan = parseChapterPlanV1(PLAN_RESPONSE);
    expect(plan.title).toBe('第二章 越境');
    expect(plan.scenes).toHaveLength(1);

    expect(() => parseChapterPlanV1('not json')).toThrow(TaskExecutionError);
    expect(() =>
      parseChapterPlanV1(JSON.stringify({ schemaVersion: 1, title: 'a', scenes: [], extra: 1 })),
    ).toThrow(TaskExecutionError);
    expect(() =>
      parseChapterPlanV1(JSON.stringify({ schemaVersion: 1, title: 'a', scenes: [] })),
    ).toThrow(TaskExecutionError);
    expect(() =>
      parseChapterPlanV1(
        JSON.stringify({
          schemaVersion: 2,
          title: 'a',
          scenes: [{ summary: 's', beats: [] }],
        }),
      ),
    ).toThrow(TaskExecutionError);
  });

  it('正文：过短内容判非法（截断/占位不得当作一章正文）', () => {
    const prose = parseChapterProseV1(PROSE_RESPONSE, '章节草稿');
    expect(prose.content).toBe(LONG_CONTENT);

    expect(() =>
      parseChapterProseV1(
        JSON.stringify({ schemaVersion: 1, title: 'a', content: '太短' }),
        '章节草稿',
      ),
    ).toThrow(TaskExecutionError);
  });

  it('审查结论：needs_rewrite 必须至少一条问题，否则判非法', () => {
    const pass = parseChapterCritiqueV1(
      JSON.stringify({ schemaVersion: 1, verdict: 'pass', summary: '没有阻塞问题', issues: [] }),
    );
    expect(pass.verdict).toBe('pass');

    expect(() =>
      parseChapterCritiqueV1(
        JSON.stringify({
          schemaVersion: 1,
          verdict: 'needs_rewrite',
          summary: '有问题',
          issues: [],
        }),
      ),
    ).toThrow(TaskExecutionError);

    const needsRewrite = parseChapterCritiqueV1(
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'needs_rewrite',
        summary: '人物动机不一致',
        issues: [
          { severity: 'major', excerpt: '林荞笑了', problem: '与设定不符', suggestion: '改为沉默' },
        ],
      }),
    );
    expect(needsRewrite.issues).toHaveLength(1);
  });
});

// ── CHAPTER_PLAN ──────────────────────────────────────────────────

describe('executeChapterPlan', () => {
  it('成功：场景计划落库 + envelope 无 artifact 无 outcome（图契约 noOut）', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_PLAN',
      nodeId: 'CHAPTER_PLAN',
      responseText: PLAN_RESPONSE,
    });
    const result = await executeChapterPlan(h.deps, 't1');

    expect(result.task.status).toBe('SUCCEEDED');
    expect(h.scenePlans).toHaveLength(1);
    expect(h.scenePlans[0]!.blueprintChapterId).toBe(CHAPTER_ID);
    const envelope = h.resultStore.get('exec-1')!;
    expect(envelope.artifactKind).toBeNull();
    expect(envelope.artifactId).toBeNull();
    expect(envelope.outcome).toBeNull();
  });

  it('prompt 只含本 run 绑定的目标章节与其之前的章节（不泄漏后续章节正文任务）', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_PLAN',
      nodeId: 'CHAPTER_PLAN',
      responseText: PLAN_RESPONSE,
    });
    await executeChapterPlan(h.deps, 't1');
    const call = h.invokeModel.mock.calls[0]![0] as { prompt: string };
    const payload = JSON.parse(call.prompt) as {
      chapter: { title: string; precedingChapterGoals: ReadonlyArray<{ title: string }> };
    };
    expect(payload.chapter.title).toBe('第二章 越境');
    expect(payload.chapter.precedingChapterGoals.map((c) => c.title)).toEqual(['第一章 接头']);
  });

  it('蓝图缺失 → 任务确定性 FAILED，不留半成品', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_PLAN',
      nodeId: 'CHAPTER_PLAN',
      responseText: PLAN_RESPONSE,
      blueprint: null,
    });
    const result = await executeChapterPlan(h.deps, 't1');
    expect(result.task.status).toBe('FAILED');
    expect(h.scenePlans).toHaveLength(0);
    expect(h.resultStore.size).toBe(0);
    // 上下文装配失败发生在模型调用之前：一次模型调用都不该发出
    expect(h.invokeModel).not.toHaveBeenCalled();
  });

  it('创作要求版本缺失 → 任务确定性 FAILED', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_PLAN',
      nodeId: 'CHAPTER_PLAN',
      responseText: PLAN_RESPONSE,
      specSectionsJson: null,
    });
    const result = await executeChapterPlan(h.deps, 't1');
    expect(result.task.status).toBe('FAILED');
    expect(h.invokeModel).not.toHaveBeenCalled();
  });
});

// ── DRAFT ─────────────────────────────────────────────────────────

describe('executeChapterDraftNode', () => {
  it('成功：候选修订 1 + envelope generationRun artifact（artifactId 与候选行一致）', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_DRAFT',
      nodeId: 'DRAFT',
      responseText: PROSE_RESPONSE,
    });
    const result = await executeChapterDraftNode(h.deps, 't1');

    expect(result.task.status).toBe('SUCCEEDED');
    expect(h.candidates).toHaveLength(1);
    const candidate = h.candidates[0]!;
    expect(candidate.revisionNo).toBe(1);
    expect(candidate.source).toBe('DRAFT');
    expect(candidate.artifactId).toBe(candidate.id);

    const envelope = h.resultStore.get('exec-1')!;
    expect(envelope.artifactKind).toBe('generationRun');
    expect(envelope.artifactId).toBe(candidate.id);
    expect(envelope.artifactVersion).toBe(1);
    expect(envelope.outcome).toBeNull();
  });

  it('regenerate 循环：已有修订时新草稿取下一修订号，版本号随之递增', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_DRAFT',
      nodeId: 'DRAFT',
      responseText: PROSE_RESPONSE,
      candidates: [
        draftCandidate(1),
        { ...draftCandidate(2), source: 'REWRITE', artifactId: null },
      ],
    });
    await executeChapterDraftNode(h.deps, 't1');
    const latest = h.candidates.at(-1)!;
    expect(latest.revisionNo).toBe(3);
    expect(h.resultStore.get('exec-1')!.artifactVersion).toBe(3);
  });

  it('正文任务显式抬高输出上限（默认 4096 会截断一章中文正文）', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_DRAFT',
      nodeId: 'DRAFT',
      responseText: PROSE_RESPONSE,
    });
    await executeChapterDraftNode(h.deps, 't1');
    const call = h.invokeModel.mock.calls[0]![0] as { maxTokens?: number };
    expect(call.maxTokens).toBeGreaterThan(4096);
  });

  it('模型输出不合法 → 任务 FAILED，候选与 envelope 都不留', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_DRAFT',
      nodeId: 'DRAFT',
      responseText: '{"schemaVersion":1,"title":"a"}',
    });
    const result = await executeChapterDraftNode(h.deps, 't1');
    expect(result.task.status).toBe('FAILED');
    expect(h.candidates).toHaveLength(0);
    expect(h.resultStore.size).toBe(0);
    expect(h.invocationStore.get('id-1')!.errorCode).toBe('MODEL_RESPONSE_INVALID');
  });

  it('最终事务失败（envelope 内容冲突）→ 补偿标记仍 RUNNING 的 invocation/task FAILED', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_DRAFT',
      nodeId: 'DRAFT',
      responseText: PROSE_RESPONSE,
      preexistingResult: {
        executionId: 'exec-1',
        projectId: PROJECT_ID,
        graphRunId: RUN_ID,
        nodeId: 'DRAFT',
        taskId: 't1',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'executor-DRAFT',
        executorVersion: 'v1',
        inputHash: 'h'.repeat(64),
        artifactKind: 'generationRun',
        artifactId: 'other-artifact',
        artifactVersion: 1,
        contentJson: '{"kind":"generationRun"}',
        outcome: null,
        createdAt: NOW,
      },
    });
    await expect(executeChapterDraftNode(h.deps, 't1')).rejects.toThrow();
    expect(h.taskStore.get('t1')!.status).toBe('FAILED');
    expect(h.invocationStore.get('id-1')!.status).toBe('FAILED');
  });
});

// ── Critic ────────────────────────────────────────────────────────

const CRITIQUE_RESPONSE = JSON.stringify({
  schemaVersion: 1,
  verdict: 'needs_rewrite',
  summary: '语言有 AI 腔',
  issues: [
    { severity: 'major', excerpt: '空气仿佛凝固', problem: '套话', suggestion: '换成具体动作' },
  ],
});

describe('executeChapterCritique', () => {
  it('成功：审查结论绑定当前候选修订 + outcome 为 critique_verdict', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_CRITIQUE',
      nodeId: STYLE_CRITIC,
      responseText: CRITIQUE_RESPONSE,
      candidates: [
        draftCandidate(1),
        { ...draftCandidate(2), source: 'REWRITE', artifactId: null },
      ],
    });
    const result = await executeChapterCritique(h.deps, 't1');

    expect(result.task.status).toBe('SUCCEEDED');
    expect(h.critiques).toHaveLength(1);
    // 当前候选 = 最大修订号（REWRITE 那一版），不是 artifact 指向的 DRAFT 版
    expect(h.critiques[0]!.candidateRevisionNo).toBe(2);
    expect(h.critiques[0]!.criticNodeId).toBe(STYLE_CRITIC);
    const envelope = h.resultStore.get('exec-1')!;
    expect(envelope.outcome).toEqual({ condition: 'critique_verdict', value: 'needs_rewrite' });
    expect(envelope.artifactKind).toBeNull();
  });

  it('审查角色由权威 execution.nodeId 派生，payload 伪造的角色无效', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_CRITIQUE',
      nodeId: CONTINUITY_CRITIC,
      responseText: CRITIQUE_RESPONSE,
      payloadJson: JSON.stringify({ criticRole: 'style', rewriteAttempt: 0 }),
      candidates: [draftCandidate(1)],
    });
    await executeChapterCritique(h.deps, 't1');

    expect(h.critiques[0]!.criticNodeId).toBe(CONTINUITY_CRITIC);
    const call = h.invokeModel.mock.calls[0]![0] as { systemPrompt: string };
    expect(call.systemPrompt).toContain('连续性');
    expect(call.systemPrompt).not.toContain('审查维度：语言与风格');
  });

  it('没有候选正文时 → 任务确定性 FAILED（不对空正文发起审查）', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_CRITIQUE',
      nodeId: STYLE_CRITIC,
      responseText: CRITIQUE_RESPONSE,
      candidates: [],
    });
    const result = await executeChapterCritique(h.deps, 't1');
    expect(result.task.status).toBe('FAILED');
    expect(h.invokeModel).not.toHaveBeenCalled();
  });
});

// ── REWRITE ───────────────────────────────────────────────────────

describe('executeChapterRewrite', () => {
  it('成功：新增 REWRITE 修订（artifactId 恒 null）+ envelope 无 artifact 无 outcome', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_REWRITE',
      nodeId: 'REWRITE',
      responseText: PROSE_RESPONSE,
      candidates: [draftCandidate(1)],
      critiques: [
        {
          id: 'cr-1',
          projectId: PROJECT_ID,
          graphRunId: RUN_ID,
          candidateRevisionNo: 1,
          criticNodeId: STYLE_CRITIC,
          verdict: 'needs_rewrite',
          summary: '语言有 AI 腔',
          issues: [
            {
              severity: 'major',
              excerpt: '空气仿佛凝固',
              problem: '套话',
              suggestion: '换成具体动作',
            },
          ],
          createdAt: NOW,
        },
      ],
    });
    const result = await executeChapterRewrite(h.deps, 't1');

    expect(result.task.status).toBe('SUCCEEDED');
    const latest = h.candidates.at(-1)!;
    expect(latest.revisionNo).toBe(2);
    expect(latest.source).toBe('REWRITE');
    expect(latest.artifactId).toBeNull();

    const envelope = h.resultStore.get('exec-1')!;
    expect(envelope.artifactKind).toBeNull();
    expect(envelope.outcome).toBeNull();

    // 改写 prompt 必须带上被审查出的问题，否则改写没有可执行输入
    const call = h.invokeModel.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain('空气仿佛凝固');
  });

  it('用户在候选 Gate 请求的改写：如实标注"用户未附意见"，不伪造用户意见', async () => {
    const h = buildHarness({
      taskType: 'CHAPTER_REWRITE',
      nodeId: 'REWRITE',
      responseText: PROSE_RESPONSE,
      payloadJson: JSON.stringify({ candidateRewriteAttempt: 1 }),
      candidates: [draftCandidate(1)],
    });
    await executeChapterRewrite(h.deps, 't1');
    const call = h.invokeModel.mock.calls[0]![0] as { prompt: string };
    const payload = JSON.parse(call.prompt) as {
      userRequestedRewrite: boolean;
      userFeedback: string | null;
    };
    expect(payload.userRequestedRewrite).toBe(true);
    expect(payload.userFeedback).toBeNull();
  });
});
