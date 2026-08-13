/**
 * GE-6 / B9 章节生成端到端集成测试（真实 SQLite + 真实 executor + 生产 resolver +
 * 脚本化 invokeModel）。
 *
 * 覆盖 roadmap GE-6 退出条件"真实章节生成到 CANDIDATE_GATE 全链"：
 * 1. 全链 pass：PROJECT_READY 项目 → createChapterRun → CHAPTER_PLAN → DRAFT →
 *    **三 Critic 真并行**（同一轮 driveRun 内三个 execution 同时在途）→ CRITIQUE_JOIN
 *    确定性聚合 → CANDIDATE_GATE（waiting_for_human）；候选修订与三条审查结论落库；
 * 2. rewrite 循环：任一 Critic 判 needs_rewrite → REWRITE 产出新修订（artifactId 恒 null，
 *    generationRun artifact 不变）→ 三 Critic 复审同一修订 → pass → gate；
 * 3. rewrite 预算耗尽（maxIterations=3）：仍进 CANDIDATE_GATE，**不自动接受**；
 * 4. gate reject → DRAFT regenerate 循环：产出新 DRAFT 修订，generationRun artifact 变化；
 * 5. gate request_rewrite → REWRITE → 回 gate；
 * 6. candidateRewrite 预算耗尽 → CANDIDATE_ESCALATION → cancel → 'cancelled'（TD-029-4：
 *    章节终态 executor 生效，run 真正终态化而不是卡在 active）；
 * 7. escalation continue_later → 'blocked'；
 * 8. gate accept → MANUSCRIPT_COMMIT 无 executor（GE-7 才接线）→ 能力缺口跳过，
 *    run 保持非终态、不失败（如实锁定当前能力边界）；
 * 9. 重启恢复：任务 PENDING 时换全新 deps 实例，driveRun 幂等重新调度。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  applyHumanDecision,
  createChapterRun,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  getRunProgress,
  productionArtifactResolver,
  type GraphRunDeps,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type SecretStore,
  type ProviderProfileRepository,
} from '@ai-novel/application';
import {
  executeBlueprintGenerate,
  executeChapterCritique,
  executeChapterDraftNode,
  executeChapterPlan,
  executeChapterRewrite,
  executeSpecExtract,
  sha256Hex,
  type BlueprintGenerateExecutionDeps,
  type ChapterNodeExecutionDeps,
  type SpecExtractExecutionDeps,
} from '@ai-novel/task-engine';
import {
  BLUEPRINT_USER_GATE,
  CANDIDATE_ESCALATION,
  CANDIDATE_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  CHAPTER_PLAN,
  CONTINUITY_CRITIC,
  CRITIQUE_JOIN,
  DRAFT,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  MANUSCRIPT_COMMIT,
  REQUIREMENT_CRITIC,
  REWRITE,
  STYLE_CRITIC,
} from '@ai-novel/domain';
import type {
  ChapterGenerationRunState,
  IdeaToNovelProjectRunState,
  TaskType,
} from '@ai-novel/domain';
import { registerIntakeExecutors } from './intake-executors.js';
import { registerResearchExecutors } from './research-executors.js';
import { registerBlueprintExecutors } from './blueprint-executors.js';
import { registerProjectTerminalExecutors } from './project-terminal-executors.js';
import { registerChapterExecutors } from './chapter-executors.js';
import { registerManuscriptCommitExecutor } from './manuscript-commit-executor.js';
import { buildGrillSessionDeps } from './grill-handlers.js';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';

const NOW = '2026-08-13T00:00:00.000Z';

let tempDir: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

const dbPaths = new WeakMap<ProjectDatabase, string>();

function makeDb(initialIdea: string): ProjectDatabase {
  const dbPath = join(tempDir, `project-${++idCounter}.sqlite`);
  const db = new ProjectDatabase(dbPath);
  dbPaths.set(db, dbPath);
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '测试项目',
    initialIdea,
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

/** TD-023：sync executor 会关闭它拿到的连接，故每次新开（与生产 getProjectDb 一致） */
function openExecutorDb(db: ProjectDatabase): ProjectDatabase {
  return new ProjectDatabase(dbPaths.get(db)!);
}

/**
 * 纯幻想设定：`determineResearchDepth` 对它判 `none`，项目侧直达 BLUEPRINT_GENERATE。
 * 本文件验证的是章节生成链路，不重复覆盖调研分支（那是 B5/B6 的 E2E）。
 */
const SECTIONS = {
  premise: '主角在异世界经营一家连接多个位面的客栈',
  genre: ['fantasy'],
  tone: ['light'],
  targetAudience: 'adults',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: { characterKey: 'xiaoman', name: '店主小满' },
};

function specCompleteJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    decision: 'spec_complete',
    sections: SECTIONS,
    nextQuestions: [],
  });
}

function blueprintJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    premise: '店主小满在位面客栈迎来形形色色的旅人',
    characters: [{ name: '小满', role: '主角', description: '沉稳的客栈老板' }],
    relationships: ['小满——常客阿岩'],
    world: '连接多个位面的十字路口客栈',
    conflict: '客栈的位面通道逐渐不稳定',
    ending: '小满找到稳定通道的方法',
    plotlines: [{ name: '主线', summary: '追查通道不稳定的根源' }],
    chapters: [
      { title: '第一章 远客', goal: '引出客栈与主角' },
      { title: '第二章 异动', goal: '发现通道异常' },
    ],
  });
}

function planJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: '第一章 远客',
    scenes: [
      { summary: '雨夜里有人叩门', beats: ['擦拭酒杯', '开门'] },
      { summary: '旅人带来通道异常的消息', beats: ['交换情报', '小满决定查'] },
    ],
  });
}

/** 每次草稿/改写用可辨识内容，便于断言修订链取到的是哪一版 */
function proseJson(marker: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: '第一章 远客',
    content: `${marker}：雨砸在客栈的屋檐上。小满把最后一只酒杯擦干，没有抬头。`.repeat(8),
  });
}

function critiqueJson(verdict: 'pass' | 'needs_rewrite', marker: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict,
    summary: `${marker} 审查结论`,
    issues:
      verdict === 'needs_rewrite'
        ? [
            {
              severity: 'major',
              excerpt: '雨砸在客栈的屋檐上',
              problem: `${marker}：环境描写与人物动机脱节`,
              suggestion: '把雨声与小满的等待绑定',
            },
          ]
        : [],
  });
}

// ── 真实 executor 环境 ────────────────────────────────────────────

function buildRunnerEnv(db: ProjectDatabase) {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const ctx = { getProjectDb: () => openExecutorDb(db), idGenerator, clock };
  registerIntakeExecutors(registry, runners, ctx);
  registerResearchExecutors(registry, runners, ctx);
  registerBlueprintExecutors(registry, runners, ctx);
  registerProjectTerminalExecutors(registry, runners);
  registerChapterExecutors(registry, runners, ctx);
  registerManuscriptCommitExecutor(registry, runners, ctx);
  const scheduled: string[] = [];
  const skips: string[] = [];
  const deps: NodeRunnerDeps = {
    idGenerator,
    clock,
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    registry,
    runners,
    artifactResolver: productionArtifactResolver,
    runnerId: 'chapter-e2e-runner',
    scheduleTask: (taskId) => {
      scheduled.push(taskId);
    },
    onExecutorMissing: (nodeId, reason) => {
      skips.push(`${nodeId}:${reason}`);
    },
  };
  return { deps, scheduled, skips };
}

const FAKE_PROFILE = {
  id: 'default-provider',
  providerType: 'anthropic-messages',
  displayName: 'fake',
  baseUrl: 'https://fake.invalid',
  model: 'fake-model',
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
} as const;

const fakeProviderRepo = {
  getById: () => FAKE_PROFILE,
  list: () => [FAKE_PROFILE],
  getDefault: () => FAKE_PROFILE,
  getRoute: () => null,
  create: () => {},
  update: () => {},
  delete: () => {},
  setDefault: () => {},
  setRoute: () => {},
  deleteRoute: () => {},
  updateTestResult: () => {},
} as unknown as ProviderProfileRepository;

const fakeSecretStore: SecretStore = {
  hasSecret: async () => true,
  setSecret: async () => {},
  getSecret: async () => 'test-key',
  deleteSecret: async () => {},
};

function fakeInvokeModel(script: string[], capturedPrompts?: string[]) {
  return async (input: { readonly prompt: string }) => {
    capturedPrompts?.push(input.prompt);
    return {
      text: script.shift() ?? '',
      providerRequestId: 'req-1',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 30,
      },
      latencyMs: 5,
      errorCode: null,
      errorMessage: null,
    };
  };
}

function buildSpecDeps(db: ProjectDatabase): SpecExtractExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel([specCompleteJson()]),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    questionRepo: grillDeps.questionRepo,
    answerRepo: grillDeps.answerRepo,
    versionRepo: db.getCreationContractVersionRepository(),
    currentRepo: db.getCreationContractCurrentRepository(),
  };
}

function buildBlueprintDeps(db: ProjectDatabase): BlueprintGenerateExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel([blueprintJson()]),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    blueprintRepo: db.getStoryBlueprintRepository(),
    sourceExclusionRepo: db.getResearchSourceExclusionRepository(),
  };
}

function buildChapterDeps(
  db: ProjectDatabase,
  script: string[],
  capturedPrompts?: string[],
): ChapterNodeExecutionDeps {
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel(script, capturedPrompts),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    graphRunRepo: db.getGraphRunRepository(),
    blueprintRepo: db.getStoryBlueprintRepository(),
    specVersionRepo: db.getCreationContractVersionRepository(),
    scenePlanRepo: db.getChapterScenePlanRepository(),
    candidateRepo: db.getChapterCandidateRepository(),
    critiqueRepo: db.getChapterCritiqueRepository(),
    rewriteFeedbackRepo: db.getChapterRewriteFeedbackRepository(),
  };
}

function uniq(list: ReadonlyArray<string>): string[] {
  return [...new Set(list)];
}

function projectState(deps: NodeRunnerDeps, runId: string): IdeaToNovelProjectRunState {
  return getRunProgress(deps, { projectId: 'p1', runId }) as IdeaToNovelProjectRunState;
}

function chapterState(deps: NodeRunnerDeps, runId: string): ChapterGenerationRunState {
  return getRunProgress(deps, { projectId: 'p1', runId }) as ChapterGenerationRunState;
}

// ── 项目侧：驱动到 PROJECT_READY 并取回真实绑定 id ────────────────

interface ProjectReadyBinding {
  readonly creationSpecVersionId: string;
  readonly storyBlueprintId: string;
  readonly blueprintChapterId: string;
}

async function driveProjectToReady(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
): Promise<ProjectReadyBinding> {
  const { run } = createProjectRun(env.deps, {
    projectId: 'p1',
    idempotencyKey: `chapter-e2e-project-${idCounter}`,
  });
  const runId = run.workflowRunId;
  await driveRun(env.deps, 'p1', runId);
  await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]!);
  await driveRun(env.deps, 'p1', runId);

  const blueprintTaskId = uniq(env.scheduled).find((taskId) => {
    const task = db.getTaskRepository().getById(taskId);
    return task?.taskType === 'BLUEPRINT_GENERATE';
  });
  expect(blueprintTaskId).toBeTruthy();
  await executeBlueprintGenerate(buildBlueprintDeps(db), blueprintTaskId!);
  await driveRun(env.deps, 'p1', runId);

  const state = projectState(env.deps, runId);
  expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  applyHumanDecision(
    env.deps as GraphRunDeps,
    {
      kind: 'gate',
      runId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'accept',
      idempotencyKey: `accept-blueprint-${idCounter}`,
    } as never,
  );
  await driveRun(env.deps, 'p1', runId);

  const ready = projectState(env.deps, runId);
  expect(ready.terminalStatus).toBe('completed');
  const specVersionId = ready.artifacts.creationSpec?.artifactId;
  const blueprintId = ready.artifacts.storyBlueprint?.artifactId;
  expect(specVersionId).toBeTruthy();
  expect(blueprintId).toBeTruthy();
  const blueprint = db.getStoryBlueprintRepository().getById('p1', blueprintId!)!.blueprint;
  return {
    creationSpecVersionId: specVersionId!,
    storyBlueprintId: blueprintId!,
    blueprintChapterId: blueprint.chapters[0]!.id,
  };
}

// ── 章节侧：脚本化泵（按任务类型 + 节点分发到对应执行器）───────────

interface ChapterScript {
  /** 每个 Critic 每一轮的结论；round 自 1 起（第 N 次审查同一 run） */
  verdictFor(nodeId: string, round: number): 'pass' | 'needs_rewrite';
  capturedPrompts?: string[];
}

interface PumpStats {
  /** 每一轮 driveRun 之后新出现的任务数（用于断言三 Critic 真并行） */
  readonly roundTaskCounts: number[];
  /** 三 Critic 同时在途的最大数量 */
  maxConcurrentCritics: number;
  criticRounds: number;
  draftCount: number;
  rewriteCount: number;
}

const CRITIC_NODES: ReadonlyArray<string> = [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC];

/**
 * 驱动章节 run 直到停在人工 Gate 或终态：每轮 driveRun 后，把本轮新调度的任务按
 * 权威 execution.nodeId 分发给对应执行器执行，再进入下一轮。
 */
async function pumpChapterRun(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  script: ChapterScript,
  stats: PumpStats,
  executed: Set<string>,
): Promise<ChapterGenerationRunState> {
  let guard = 0;
  for (;;) {
    expect(++guard).toBeLessThan(40);
    await driveRun(env.deps, 'p1', runId);
    const state = chapterState(env.deps, runId);
    if (state.terminalStatus !== null || state.pendingHumanDecision !== null) return state;

    // env.scheduled 跨 run 共享（项目 run 的 SPEC_EXTRACT/BLUEPRINT_GENERATE 也在里面）：
    // 只取属于本章节 run 的任务，按权威 execution.graphRunId 判定。
    const execRepoAll = db.getNodeExecutionRepository();
    const pending = uniq(env.scheduled).filter(
      (id) => !executed.has(id) && execRepoAll.getByTaskId(id)?.graphRunId === runId,
    );
    if (pending.length === 0) return state;
    stats.roundTaskCounts.push(pending.length);

    // 三 Critic 并行的真实证据：本轮新任务里若含 Critic，统计同时在途数量
    const execRepo = db.getNodeExecutionRepository();
    const criticPending = pending.filter((taskId) => {
      const exec = execRepo.getByTaskId(taskId);
      return exec !== null && CRITIC_NODES.includes(exec.nodeId);
    });
    if (criticPending.length > 0) {
      const inFlight = criticPending.filter((taskId) => {
        const exec = execRepo.getByTaskId(taskId)!;
        return exec.status === 'running' || exec.status === 'pending';
      }).length;
      stats.maxConcurrentCritics = Math.max(stats.maxConcurrentCritics, inFlight);
      stats.criticRounds += 1;
    }

    for (const taskId of pending) {
      executed.add(taskId);
      const task = db.getTaskRepository().getById(taskId)!;
      const exec = execRepo.getByTaskId(taskId)!;
      const taskType = task.taskType as TaskType;
      if (taskType === 'CHAPTER_PLAN') {
        await executeChapterPlan(
          buildChapterDeps(db, [planJson()], script.capturedPrompts),
          taskId,
        );
      } else if (taskType === 'CHAPTER_DRAFT') {
        stats.draftCount += 1;
        await executeChapterDraftNode(
          buildChapterDeps(db, [proseJson(`DRAFT-${stats.draftCount}`)], script.capturedPrompts),
          taskId,
        );
      } else if (taskType === 'CHAPTER_CRITIQUE') {
        const verdict = script.verdictFor(exec.nodeId, stats.criticRounds);
        await executeChapterCritique(
          buildChapterDeps(
            db,
            [critiqueJson(verdict, `${exec.nodeId}-R${stats.criticRounds}`)],
            script.capturedPrompts,
          ),
          taskId,
        );
      } else if (taskType === 'CHAPTER_REWRITE') {
        stats.rewriteCount += 1;
        await executeChapterRewrite(
          buildChapterDeps(
            db,
            [proseJson(`REWRITE-${stats.rewriteCount}`)],
            script.capturedPrompts,
          ),
          taskId,
        );
      } else {
        throw new Error(`未预期的任务类型: ${taskType}`);
      }
    }
  }
}

function newStats(): PumpStats {
  return {
    roundTaskCounts: [],
    maxConcurrentCritics: 0,
    criticRounds: 0,
    draftCount: 0,
    rewriteCount: 0,
  };
}

const ALWAYS_PASS: ChapterScript = { verdictFor: () => 'pass' };

async function startChapterRun(
  env: ReturnType<typeof buildRunnerEnv>,
  binding: ProjectReadyBinding,
): Promise<string> {
  const { run } = createChapterRun(env.deps, {
    projectId: 'p1',
    creationSpecVersionId: binding.creationSpecVersionId,
    researchBundleId: null,
    storyBlueprintId: binding.storyBlueprintId,
    blueprintChapterId: binding.blueprintChapterId,
    idempotencyKey: `chapter-run-${++idCounter}`,
  });
  return run.workflowRunId;
}

function gateDecision(
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  outcome: 'accept' | 'reject' | 'request_rewrite',
  key: string,
): void {
  applyHumanDecision(
    env.deps as GraphRunDeps,
    {
      kind: 'gate',
      runId,
      nodeId: CANDIDATE_GATE,
      outcome,
      idempotencyKey: key,
    } as never,
  );
}

function escalationDecision(
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  outcome: 'accept_current' | 'modify_requirements' | 'cancel' | 'continue_later',
  key: string,
): void {
  applyHumanDecision(
    env.deps as GraphRunDeps,
    {
      kind: 'escalation',
      runId,
      nodeId: CANDIDATE_ESCALATION,
      outcome,
      idempotencyKey: key,
    } as never,
  );
}

describe('GE-6 章节生成 E2E（真实 SQLite + 真实 executor + 生产 resolver）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chapter-e2e-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. 全链：PLAN → DRAFT → 三 Critic 并行 → JOIN(pass) → CANDIDATE_GATE', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const stats = newStats();
      const state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, new Set());

      expect(state.terminalStatus).toBeNull();
      expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      expect(state.nodeStatuses[CHAPTER_PLAN]).toBe('succeeded');
      expect(state.nodeStatuses[DRAFT]).toBe('succeeded');
      expect(state.nodeStatuses[CRITIQUE_JOIN]).toBe('succeeded');

      // 三 Critic 真并行：同一轮里三个 execution 同时在途
      expect(stats.maxConcurrentCritics).toBe(3);
      expect(stats.roundTaskCounts).toContain(3);

      // JOIN 的 outcome 由 domain 从三个来源确定性聚合（executor 不产 outcome）
      expect(state.nodeOutcomes[CRITIQUE_JOIN]).toEqual({
        condition: 'critique_verdict',
        value: 'pass',
      });

      // 候选修订与审查结论落库
      const candidate = db.getChapterCandidateRepository().getLatestByRun('p1', runId)!;
      expect(candidate.revisionNo).toBe(1);
      expect(candidate.source).toBe('DRAFT');
      expect(candidate.content).toContain('DRAFT-1');
      // generationRun artifact 指向 DRAFT 修订本身
      expect(state.artifacts.generationRun?.artifactId).toBe(candidate.artifactId);
      const critiques = db
        .getChapterCritiqueRepository()
        .listByCandidateRevision('p1', runId, candidate.revisionNo);
      expect(critiques.map((c) => c.criticNodeId).sort()).toEqual([...CRITIC_NODES].sort());
      // 场景计划（内部 artifact）落库，且没有被登记成 Graph artifact
      expect(db.getChapterScenePlanRepository().getLatestByRun('p1', runId)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('2. rewrite 循环：needs_rewrite → REWRITE 新修订（不换 artifact）→ 复审 pass → gate', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const stats = newStats();
      const script: ChapterScript = {
        // 第一轮：风格 Critic 判需要改写；第二轮起全 pass
        verdictFor: (nodeId, round) =>
          round === 1 && nodeId === STYLE_CRITIC ? 'needs_rewrite' : 'pass',
      };
      const state = await pumpChapterRun(db, env, runId, script, stats, new Set());

      expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      expect(stats.rewriteCount).toBe(1);
      expect(stats.criticRounds).toBe(2);

      const candidates = db.getChapterCandidateRepository().listByRun('p1', runId);
      expect(candidates.map((c) => c.revisionNo)).toEqual([1, 2]);
      expect(candidates[1]!.source).toBe('REWRITE');
      // 图契约 noOut：改写不产生新 artifact，generationRun 仍指向 DRAFT 那一版
      expect(candidates[1]!.artifactId).toBeNull();
      expect(state.artifacts.generationRun?.artifactId).toBe(candidates[0]!.artifactId);

      // 复审针对的是改写后的修订（当前候选 = 最大修订号）
      const critiquesR2 = db.getChapterCritiqueRepository().listByCandidateRevision('p1', runId, 2);
      expect(critiquesR2).toHaveLength(3);
      expect(critiquesR2.every((c) => c.verdict === 'pass')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('3. rewrite 预算耗尽（3 次）→ 仍进 CANDIDATE_GATE，不自动接受', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const stats = newStats();
      const state = await pumpChapterRun(
        db,
        env,
        runId,
        { verdictFor: () => 'needs_rewrite' },
        stats,
        new Set(),
      );

      expect(stats.rewriteCount).toBe(3);
      expect(state.attemptBudget.rewrite).toBeGreaterThanOrEqual(3);
      // 预算耗尽不得自动接受：交人工 Gate
      expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[MANUSCRIPT_COMMIT]).not.toBe('succeeded');
    } finally {
      db.close();
    }
  });

  it('4. gate reject → DRAFT regenerate：新 DRAFT 修订，generationRun artifact 随之变化', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const executed = new Set<string>();
      const stats = newStats();
      let state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);
      const firstArtifact = state.artifacts.generationRun?.artifactId;
      expect(firstArtifact).toBeTruthy();

      gateDecision(env, runId, 'reject', 'reject-1');
      state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);

      expect(stats.draftCount).toBe(2);
      expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      const candidates = db.getChapterCandidateRepository().listByRun('p1', runId);
      expect(candidates.map((c) => c.source)).toEqual(['DRAFT', 'DRAFT']);
      expect(candidates[1]!.content).toContain('DRAFT-2');
      // 重新起草产出新的 generationRun artifact
      expect(state.artifacts.generationRun?.artifactId).toBe(candidates[1]!.artifactId);
      expect(state.artifacts.generationRun?.artifactId).not.toBe(firstArtifact);
    } finally {
      db.close();
    }
  });

  it('5. gate request_rewrite → REWRITE → 回 gate（用户发起的改写循环）', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const executed = new Set<string>();
      const stats = newStats();
      let state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);

      const capturedPrompts: string[] = [];
      gateDecision(env, runId, 'request_rewrite', 'user-rewrite-1');
      state = await pumpChapterRun(
        db,
        env,
        runId,
        { ...ALWAYS_PASS, capturedPrompts },
        stats,
        executed,
      );

      expect(stats.rewriteCount).toBe(1);
      expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      expect(state.attemptBudget.candidateRewrite).toBeGreaterThanOrEqual(1);

      // D-B9-6：用户请求的改写如实标注"未附意见"，不伪造用户意见
      const rewritePrompt = capturedPrompts.find((p) => p.includes('userRequestedRewrite'))!;
      const payload = JSON.parse(rewritePrompt) as {
        userRequestedRewrite: boolean;
        userFeedback: string | null;
      };
      expect(payload.userRequestedRewrite).toBe(true);
      expect(payload.userFeedback).toBeNull();
    } finally {
      db.close();
    }
  });

  it('6. candidateRewrite 预算耗尽 → CANDIDATE_ESCALATION → cancel → cancelled（TD-029-4）', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const executed = new Set<string>();
      const stats = newStats();
      let state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);

      let guard = 0;
      while (state.pendingHumanDecision?.nodeId !== CANDIDATE_ESCALATION) {
        expect(++guard).toBeLessThan(10);
        expect(state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
        gateDecision(env, runId, 'request_rewrite', `user-rewrite-${guard}`);
        state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);
      }
      expect(state.attemptBudget.candidateRewrite).toBeGreaterThanOrEqual(5);

      escalationDecision(env, runId, 'cancel', 'cancel-1');
      await driveRun(env.deps, 'p1', runId);
      state = chapterState(env.deps, runId);
      // TD-029-4：章节终态 executor 已注册，run 真正终态化（此前会卡在 active）
      expect(state.terminalStatus).toBe('cancelled');
      expect(env.skips.filter((s) => s.startsWith('CHAPTER_CANCELLED'))).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('7. escalation continue_later → blocked', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const executed = new Set<string>();
      const stats = newStats();
      let state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);

      let guard = 0;
      while (state.pendingHumanDecision?.nodeId !== CANDIDATE_ESCALATION) {
        expect(++guard).toBeLessThan(10);
        gateDecision(env, runId, 'request_rewrite', `later-rewrite-${guard}`);
        state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);
      }

      escalationDecision(env, runId, 'continue_later', 'later-1');
      await driveRun(env.deps, 'p1', runId);
      expect(chapterState(env.deps, runId).terminalStatus).toBe('blocked');
    } finally {
      db.close();
    }
  });

  it('8. gate accept → MANUSCRIPT_COMMIT 写入权威稿件 → CHAPTER_READY（GE-7）', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      const executed = new Set<string>();
      const stats = newStats();
      let state = await pumpChapterRun(db, env, runId, ALWAYS_PASS, stats, executed);
      const candidate = db.getChapterCandidateRepository().getLatestByRun('p1', runId)!;

      gateDecision(env, runId, 'accept', 'accept-1');
      await driveRun(env.deps, 'p1', runId);
      state = chapterState(env.deps, runId);

      // 锁定不变量第 5 条：只有经 MANUSCRIPT_COMMIT 才写权威稿件
      expect(state.nodeStatuses[MANUSCRIPT_COMMIT]).toBe('succeeded');
      expect(state.terminalStatus).toBe('completed');
      expect(state.artifacts.manuscript?.artifactId).toBeTruthy();

      // 稿件里真的有这一章，正文与被接受的候选一致
      const link = db.getManuscriptChapterLinkRepository().get('p1', binding.blueprintChapterId)!;
      expect(link).toBeTruthy();
      const chapterRow = db
        .getManuscriptTransaction()
        .runInTransaction((repos) => repos.chapterRepo.getById('p1', link.chapterId))!;
      expect(chapterRow.currentVersionId).toBe(state.artifacts.manuscript!.artifactId);
      const version = db
        .getManuscriptTransaction()
        .runInTransaction((repos) =>
          repos.chapterVersionRepo.getById('p1', link.chapterId, chapterRow.currentVersionId!),
        )!;
      expect(version.content).toBe(candidate.content);
      expect(version.sourceType).toBe('AI_GENERATION');
      // D-GE7-4：AI 来源版本能追溯到产出它的模型调用
      expect(version.createdByTaskId).toBeTruthy();
      expect(version.invocationId).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('8b. 同一蓝图章节重新生成后再次提交 → 追加新版本，不新建一章（D-GE7-1/3）', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);

      // 第一次生成并接受
      const firstRunId = await startChapterRun(env, binding);
      const executed = new Set<string>();
      const stats = newStats();
      await pumpChapterRun(db, env, firstRunId, ALWAYS_PASS, stats, executed);
      gateDecision(env, firstRunId, 'accept', 'accept-a');
      await driveRun(env.deps, 'p1', firstRunId);
      const link = db.getManuscriptChapterLinkRepository().get('p1', binding.blueprintChapterId)!;
      const firstVersionId = chapterState(env.deps, firstRunId).artifacts.manuscript!.artifactId;

      // 同一章再生成一次（新 run）并接受
      const secondRunId = await startChapterRun(env, binding);
      expect(secondRunId).not.toBe(firstRunId);
      await pumpChapterRun(db, env, secondRunId, ALWAYS_PASS, stats, executed);
      gateDecision(env, secondRunId, 'accept', 'accept-b');
      await driveRun(env.deps, 'p1', secondRunId);
      const secondVersionId = chapterState(env.deps, secondRunId).artifacts.manuscript!.artifactId;

      // 同一章：绑定不变、版本追加、旧版本仍在（不静默覆盖）
      const linkAfter = db
        .getManuscriptChapterLinkRepository()
        .get('p1', binding.blueprintChapterId)!;
      expect(linkAfter.chapterId).toBe(link.chapterId);
      expect(secondVersionId).not.toBe(firstVersionId);
      const versions = db
        .getManuscriptTransaction()
        .runInTransaction((repos) =>
          repos.chapterVersionRepo.listSummariesByChapter('p1', link.chapterId),
        );
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions.some((v) => v.id === firstVersionId)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('9. 重启恢复：任务 PENDING 时换全新 deps 实例，driveRun 幂等重新调度', async () => {
    const db = makeDb('一个位面客栈经营的故事');
    try {
      const env = buildRunnerEnv(db);
      const binding = await driveProjectToReady(db, env);
      const runId = await startChapterRun(env, binding);

      // 只 drive 不执行任务：CHAPTER_PLAN 任务留在 PENDING
      await driveRun(env.deps, 'p1', runId);
      const pendingTaskId = uniq(env.scheduled).at(-1)!;
      expect(db.getTaskRepository().getById(pendingTaskId)!.status).toBe('PENDING');

      // 全新 deps（模拟重启后的 worker）：重新调度同一 task，不新建 execution
      const restarted = buildRunnerEnv(db);
      await driveRun(restarted.deps, 'p1', runId);
      expect(restarted.scheduled).toContain(pendingTaskId);
      const state = chapterState(restarted.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[CHAPTER_PLAN]).toBe('active');

      // 执行后能正常继续推进
      const stats = newStats();
      const executed = new Set<string>();
      const finalState = await pumpChapterRun(db, restarted, runId, ALWAYS_PASS, stats, executed);
      expect(finalState.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
      expect(stats.draftCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('10. REWRITE 节点不产出 generationRun artifact（图契约 noOut 的结构性守卫）', () => {
    const rewriteNode = CHAPTER_GENERATION_GRAPH_V1.nodes.find((n) => n.id === REWRITE)!;
    expect(rewriteNode.output.allowedArtifactKind).toBeNull();
    expect(rewriteNode.output.requiredOutcomeCondition).toBeNull();
    const draftNode = CHAPTER_GENERATION_GRAPH_V1.nodes.find((n) => n.id === DRAFT)!;
    expect(draftNode.output.allowedArtifactKind).toBe('generationRun');
  });
});
