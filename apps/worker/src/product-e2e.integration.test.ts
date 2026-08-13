/**
 * GE-8 产品 1.0 端到端验收（真实 SQLite + 全部真实 executor + 生产 resolver +
 * 脚本化 invokeModel / 搜索 / 抓取）。
 *
 * roadmap §13 的验收路径与验证目标：
 *
 * 1. **全链**：模糊想法 → 追问一次 → 回答 → CreationSpec → 深度调研 → ResearchBundle
 *    → StoryBlueprint → 接受 → PROJECT_READY → 第一章生成 → 接受 → 写入稿件 →
 *    **用户手改正文** → 第二章生成 → 接受 → 导出（导出内容含用户的手改）；
 * 2. **用户原始输入不丢失**：初始想法与用户回答在链路末端仍能原样取回；
 * 3. **手写正文不被静默覆盖**：用户改过的那一章再次被 AI 提交后，用户那一版仍在
 *    版本链里；且用过期基线保存会被拒绝；
 * 4. **任意阶段可恢复**：任务 PENDING 时换全新 deps（模拟应用重启）仍能继续；
 *    模型中断导致章节 run 终态失败后，用户可重新发起本章生成，稿件不受影响。
 *
 * 与各阶段自己的 E2E（intake / research / blueprint / chapter）的分工：那些验证
 * 各自的分支与边界，本文件只验证**一条端到端的真实路径**能走通，以及四条产品级
 * 保证不被破坏。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  applyHumanDecision,
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
  executeResearchRun,
  executeSpecExtract,
  sha256Hex,
} from '@ai-novel/task-engine';
import type { FetchedDocument, SearchResult } from '@ai-novel/research-engine';
import {
  BLUEPRINT_USER_GATE,
  CANDIDATE_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  COLLECT_ANSWER,
  CONTINUITY_CRITIC,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  REQUIREMENT_CRITIC,
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
import { dispatchChapterCommand, type ChapterHandlerContext } from './chapter-handlers.js';
import {
  dispatchManuscriptCommand,
  type ManuscriptExportPayload,
  type ManuscriptHandlerContext,
} from './manuscript-handlers.js';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';
import type { ChapterOverviewDto, ChapterRunStateDto } from '@ai-novel/contracts';

const NOW = '2026-08-13T00:00:00.000Z';
const PROJECT_ID = 'p1';
const INITIAL_IDEA = '一个关于晚清邮差在乱世里送最后一封信的故事';
const USER_ANSWER = '长篇连载，每章三千字，主角要沉默寡言';

let tempDir: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

const dbPaths = new WeakMap<ProjectDatabase, string>();

function makeDb(): ProjectDatabase {
  const dbPath = join(tempDir, `project-${++idCounter}.sqlite`);
  const db = new ProjectDatabase(dbPath);
  dbPaths.set(db, dbPath);
  db.getProjectMetadataRepository().create({
    id: PROJECT_ID,
    name: '端到端验收项目',
    initialIdea: INITIAL_IDEA,
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

function openExecutorDb(db: ProjectDatabase): ProjectDatabase {
  return new ProjectDatabase(dbPaths.get(db)!);
}

// ── 脚本化模型输出 ────────────────────────────────────────────────

const SECTIONS = {
  premise: '晚清邮差在乱世里送最后一封信',
  genre: ['历史'],
  tone: ['冷硬'],
  targetAudience: '成年读者',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: { characterKey: 'youchai', name: '邮差陈九' },
};

const askMoreJson = JSON.stringify({
  schemaVersion: 1,
  decision: 'ask_more',
  sections: SECTIONS,
  nextQuestions: [
    { topic: '篇幅', text: '预期篇幅是短篇还是长篇连载？', rationale: '决定章节结构' },
  ],
});

const specCompleteJson = JSON.stringify({
  schemaVersion: 1,
  decision: 'spec_complete',
  sections: SECTIONS,
  nextQuestions: [],
});

const researchPlanJson = JSON.stringify({
  schemaVersion: 1,
  questions: [{ text: '晚清邮政系统如何运作' }, { text: '晚清驿站与新式邮局的关系' }],
});

const blueprintJson = JSON.stringify({
  schemaVersion: 1,
  premise: '邮差陈九要在乱世里送出最后一封信',
  characters: [{ name: '陈九', role: '主角', description: '沉默寡言的邮差' }],
  relationships: ['陈九与旧同僚决裂'],
  world: '晚清边地驿路',
  conflict: '信件牵扯要命的秘密',
  ending: '信送到了，人没回来',
  plotlines: [{ name: '主线', summary: '接信到送达' }],
  chapters: [
    { title: '第一章 接信', goal: '交代人物与信件的来历' },
    { title: '第二章 上路', goal: '离城遇险' },
  ],
});

const planJson = JSON.stringify({
  schemaVersion: 1,
  title: '第一章 接信',
  scenes: [
    { summary: '驿站深夜有人叩门', beats: ['点灯', '接信'] },
    { summary: '来人说明这封信的分量', beats: ['交代秘密', '陈九答应'] },
  ],
});

function proseJson(marker: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: '第一章 接信',
    content: `${marker}：灯芯爆了一下。陈九把信按在桌面上，没有抬头。`.repeat(8),
  });
}

const critiquePassJson = JSON.stringify({
  schemaVersion: 1,
  verdict: 'pass',
  summary: '没有阻塞问题',
  issues: [],
});

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
    runnerId: 'product-e2e-runner',
    scheduleTask: (taskId) => {
      scheduled.push(taskId);
    },
  };
  return { deps, scheduled };
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

function fakeInvokeModel(text: string) {
  return async () => ({
    text,
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
  });
}

function throwingInvokeModel(message: string) {
  return async () => {
    throw new Error(message);
  };
}

/** 全部任务类型共用的一份 deps（按需注入不同的 invokeModel） */
function buildTaskDeps(db: ProjectDatabase, invokeModel: unknown) {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: invokeModel as never,
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    questionRepo: grillDeps.questionRepo,
    answerRepo: grillDeps.answerRepo,
    versionRepo: db.getCreationContractVersionRepository(),
    currentRepo: db.getCreationContractCurrentRepository(),
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    blueprintRepo: db.getStoryBlueprintRepository(),
    sourceExclusionRepo: db.getResearchSourceExclusionRepository(),
    graphRunRepo: db.getGraphRunRepository(),
    scenePlanRepo: db.getChapterScenePlanRepository(),
    candidateRepo: db.getChapterCandidateRepository(),
    critiqueRepo: db.getChapterCritiqueRepository(),
    rewriteFeedbackRepo: db.getChapterRewriteFeedbackRepository(),
    buildSearchPort: () => ({
      search: async (input: { query: string }): Promise<SearchResult[]> => [
        {
          url: `https://facts.example/${encodeURIComponent(input.query.slice(0, 8))}`,
          title: `资料：${input.query.slice(0, 8)}`,
          snippet: '摘要',
          publishedAt: null,
        },
      ],
    }),
    webFetch: {
      fetch: async (input: { url: string }): Promise<FetchedDocument> => ({
        url: input.url,
        title: '来源页面',
        extractedText: '晚清邮政由驿站与新式邮局并行运作。',
        fetchedAt: NOW,
      }),
    },
  };
}

interface PumpOptions {
  /** 让某个任务类型的模型调用抛错（故障注入） */
  readonly failTaskType?: TaskType;
  /** 记录本轮实际执行过的任务类型（断言链路真的走过这些阶段） */
  readonly seen?: TaskType[];
  /** 已执行过的任务（跨多次 pump 复用） */
  readonly executed: Set<string>;
  /** 只处理属于该 run 的任务 */
  readonly runId: string;
}

/** 模型输出脚本：按任务类型 + 节点决定返回什么 */
function scriptFor(
  db: ProjectDatabase,
  taskType: TaskType,
  nodeId: string,
  draftNo: number,
): string {
  switch (taskType) {
    case 'SPEC_EXTRACT': {
      // 第一次追问，之后完成（会话里已有回答即视为第二轮）
      const sessions = db.getGrillSessionRepository().listByProject(PROJECT_ID);
      const active = sessions.find((s) => s.status === 'ACTIVE');
      const answered =
        active !== undefined &&
        db.getGrillAnswerRepository().listCurrentBySession(active.id).length > 0;
      return answered ? specCompleteJson : askMoreJson;
    }
    case 'RESEARCH_RUN':
      return researchPlanJson;
    case 'BLUEPRINT_GENERATE':
      return blueprintJson;
    case 'CHAPTER_PLAN':
      return planJson;
    case 'CHAPTER_DRAFT':
      return proseJson(`DRAFT-${draftNo}`);
    case 'CHAPTER_CRITIQUE':
      return critiquePassJson;
    case 'CHAPTER_REWRITE':
      return proseJson(`REWRITE-${draftNo}`);
    default:
      throw new Error(`未预期的任务类型: ${taskType}${nodeId}`);
  }
}

/**
 * 驱动一条 run 直到停在人工 Gate 或终态：每轮 driveRun 后执行本轮新调度的任务。
 * 覆盖全部任务类型，故可同时用于 project run 与 chapter run。
 */
async function pump(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  options: PumpOptions,
): Promise<void> {
  let draftNo = 0;
  let guard = 0;
  for (;;) {
    expect(++guard).toBeLessThan(40);
    await driveRun(env.deps, PROJECT_ID, options.runId);
    const state = getRunProgress(env.deps, { projectId: PROJECT_ID, runId: options.runId });
    if (state.terminalStatus !== null || state.pendingHumanDecision !== null) return;

    const execRepo = db.getNodeExecutionRepository();
    const pending = [...new Set(env.scheduled)].filter(
      (id) => !options.executed.has(id) && execRepo.getByTaskId(id)?.graphRunId === options.runId,
    );
    if (pending.length === 0) return;

    for (const taskId of pending) {
      options.executed.add(taskId);
      const task = db.getTaskRepository().getById(taskId)!;
      const exec = execRepo.getByTaskId(taskId)!;
      const taskType = task.taskType as TaskType;
      options.seen?.push(taskType);
      if (taskType === 'CHAPTER_DRAFT') draftNo += 1;
      const failing = options.failTaskType === taskType;
      const deps = buildTaskDeps(
        db,
        failing
          ? throwingInvokeModel('模型服务中断')
          : fakeInvokeModel(scriptFor(db, taskType, exec.nodeId, draftNo)),
      );
      switch (taskType) {
        case 'SPEC_EXTRACT':
          await executeSpecExtract(deps, taskId);
          break;
        case 'RESEARCH_RUN':
          await executeResearchRun(deps, taskId);
          break;
        case 'BLUEPRINT_GENERATE':
          await executeBlueprintGenerate(deps, taskId);
          break;
        case 'CHAPTER_PLAN':
          await executeChapterPlan(deps, taskId);
          break;
        case 'CHAPTER_DRAFT':
          await executeChapterDraftNode(deps, taskId);
          break;
        case 'CHAPTER_CRITIQUE':
          await executeChapterCritique(deps, taskId);
          break;
        case 'CHAPTER_REWRITE':
          await executeChapterRewrite(deps, taskId);
          break;
        default:
          throw new Error(`未预期的任务类型: ${taskType}`);
      }
    }
  }
}

function projectState(env: ReturnType<typeof buildRunnerEnv>, runId: string) {
  return getRunProgress(env.deps, { projectId: PROJECT_ID, runId }) as IdeaToNovelProjectRunState;
}

function chapterHandlerCtx(db: ProjectDatabase): ChapterHandlerContext {
  return { getProjectDb: () => openExecutorDb(db), idGenerator, clock };
}

function manuscriptHandlerCtx(db: ProjectDatabase): ManuscriptHandlerContext {
  return { getProjectDb: () => openExecutorDb(db), idGenerator, clock };
}

/** 想法 → 追问 → 回答 → spec → 调研 → 蓝图 → 接受 → PROJECT_READY */
async function driveProjectToReady(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  seen: TaskType[],
): Promise<string> {
  const { run } = createProjectRun(env.deps, {
    projectId: PROJECT_ID,
    idempotencyKey: `product-e2e-${idCounter}`,
  });
  const runId = run.workflowRunId;
  const executed = new Set<string>();

  // 第一轮：IDEA_CAPTURE → SPEC_EXTRACT（ask_more）→ 停在 COLLECT_ANSWER
  await pump(db, env, { executed, runId, seen });
  let state = projectState(env, runId);
  expect(state.pendingHumanDecision?.nodeId).toBe(COLLECT_ANSWER);

  // 用户回答（answer receipt 契约：先落权威存储再推进 Graph）
  const sessionId = state.artifacts.idea!.artifactId;
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  const asked = grillDeps.questionRepo.listBySession(sessionId).filter((q) => q.status === 'ASKED');
  expect(asked).toHaveLength(1);
  applyHumanDecision(
    env.deps as GraphRunDeps,
    {
      kind: 'intake_answer',
      runId,
      nodeId: COLLECT_ANSWER,
      sessionId,
      questionId: asked[0]!.id,
      text: USER_ANSWER,
      idempotencyKey: `answer-${idCounter}`,
    } as never,
  );

  // 继续：spec_complete → 调研 → 蓝图 → 停在蓝图 Gate
  await pump(db, env, { executed, runId, seen });
  state = projectState(env, runId);
  expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

  applyHumanDecision(
    env.deps as GraphRunDeps,
    {
      kind: 'gate',
      runId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'accept',
      idempotencyKey: `accept-bp-${idCounter}`,
    } as never,
  );
  await pump(db, env, { executed, runId, seen });

  state = projectState(env, runId);
  expect(state.terminalStatus).toBe('completed');
  return runId;
}

/** 用产品通道发起一章生成并驱动到候选 Gate；返回 chapter runId */
async function generateChapterToGate(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  blueprintChapterId: string,
  executed: Set<string>,
  seen: TaskType[],
  failTaskType?: TaskType,
): Promise<string> {
  const started = dispatchChapterCommand(
    'chapter.startRun',
    { projectId: PROJECT_ID, blueprintChapterId },
    chapterHandlerCtx(db),
  ) as ChapterRunStateDto;
  await pump(db, env, { executed, runId: started.runId, seen, failTaskType });
  return started.runId;
}

function chapterOverview(db: ProjectDatabase): ChapterOverviewDto {
  return dispatchChapterCommand(
    'chapter.getOverview',
    { projectId: PROJECT_ID },
    chapterHandlerCtx(db),
  ) as ChapterOverviewDto;
}

describe('GE-8 产品 1.0 端到端验收', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'product-e2e-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('全链：想法 → 追问 → 调研 → 蓝图 → 两章生成 → 用户手改 → 导出', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const seen: TaskType[] = [];
      await driveProjectToReady(db, env, seen);

      // 链路真的走过了各阶段的真实任务（不是被跳过的空壳）
      expect(seen).toContain('SPEC_EXTRACT');
      expect(seen).toContain('RESEARCH_RUN');
      expect(seen).toContain('BLUEPRINT_GENERATE');

      const overview = chapterOverview(db);
      expect(overview.blueprintId).toBeTruthy();
      expect(overview.chapters).toHaveLength(2);

      // ── 第一章：生成 → 接受 → 写入稿件 ──
      const executed = new Set<string>();
      const chapter1 = overview.chapters[0]!.blueprintChapterId;
      const run1 = await generateChapterToGate(db, env, chapter1, executed, seen);
      expect(seen).toContain('CHAPTER_PLAN');
      expect(seen).toContain('CHAPTER_DRAFT');
      expect(seen).toContain('CHAPTER_CRITIQUE');

      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run1,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-ch1',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run1);
      const run1State = getRunProgress(env.deps, {
        projectId: PROJECT_ID,
        runId: run1,
      }) as ChapterGenerationRunState;
      expect(run1State.terminalStatus).toBe('completed');

      // ── 用户手改正文（稿件工作区）──
      const workspace = dispatchManuscriptCommand(
        'manuscript.getWorkspace',
        { projectId: PROJECT_ID },
        manuscriptHandlerCtx(db),
      ) as { manuscriptId: string | null; chapters: ReadonlyArray<{ chapterId: string }> };
      expect(workspace.manuscriptId).toBeTruthy();
      const detail = dispatchManuscriptCommand(
        'manuscript.getChapter',
        { projectId: PROJECT_ID, chapterId: workspace.chapters[0]!.chapterId },
        manuscriptHandlerCtx(db),
      ) as { currentVersionId: string | null; content: string };
      dispatchManuscriptCommand(
        'manuscript.saveChapter',
        {
          projectId: PROJECT_ID,
          chapterId: workspace.chapters[0]!.chapterId,
          title: '第一章 接信',
          content: `${detail.content}\n这一句是作者自己加的。`,
          expectedCurrentVersionId: detail.currentVersionId,
        },
        manuscriptHandlerCtx(db),
      );

      // ── 第二章：继续生成 → 接受 ──
      const chapter2 = overview.chapters[1]!.blueprintChapterId;
      const run2 = await generateChapterToGate(db, env, chapter2, executed, seen);
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run2,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-ch2',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run2);

      // ── 导出：两章都在，且含用户手改的那一句 ──
      const exported = dispatchManuscriptCommand(
        'manuscript.export',
        { projectId: PROJECT_ID, format: 'markdown' },
        manuscriptHandlerCtx(db),
      ) as ManuscriptExportPayload;
      expect(exported.chapterCount).toBe(2);
      expect(exported.content).toContain('这一句是作者自己加的。');
      expect(exported.fileName.endsWith('.md')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('稿件章节按蓝图顺序排列，即使用户跳着写（TD-033-1）', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const seen: TaskType[] = [];
      await driveProjectToReady(db, env, seen);
      const overview = chapterOverview(db);
      const executed = new Set<string>();

      // 先写第二章
      const run2 = await generateChapterToGate(
        db,
        env,
        overview.chapters[1]!.blueprintChapterId,
        executed,
        seen,
      );
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run2,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-second-first',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run2);

      // 再写第一章
      const run1 = await generateChapterToGate(
        db,
        env,
        overview.chapters[0]!.blueprintChapterId,
        executed,
        seen,
      );
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run1,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-first-second',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run1);

      // 稿件里的顺序必须是蓝图顺序（第一章在前），而不是写作先后
      const links = db.getManuscriptChapterLinkRepository().listByProject(PROJECT_ID);
      const firstLink = links.find(
        (l) => l.blueprintChapterId === overview.chapters[0]!.blueprintChapterId,
      )!;
      const workspace = dispatchManuscriptCommand(
        'manuscript.getWorkspace',
        { projectId: PROJECT_ID },
        manuscriptHandlerCtx(db),
      ) as { chapters: ReadonlyArray<{ chapterId: string }> };
      expect(workspace.chapters).toHaveLength(2);
      expect(workspace.chapters[0]!.chapterId).toBe(firstLink.chapterId);
    } finally {
      db.close();
    }
  });

  it('用户原始输入不丢失：初始想法与用户回答在链路末端仍可原样取回', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const seen: TaskType[] = [];
      const runId = await driveProjectToReady(db, env, seen);

      const state = projectState(env, runId);
      const sessionId = state.artifacts.idea!.artifactId;
      const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
      // 初始想法：播种进 intake 会话，全链结束后仍原样
      expect(grillDeps.sessionRepo.getById(sessionId)?.goal).toContain('晚清邮差');
      // 用户回答：answer receipt 写入的权威存储里仍原样
      const answers = grillDeps.answerRepo.listCurrentBySession(sessionId);
      expect(answers).toHaveLength(1);
      expect(answers[0]!.text).toBe(USER_ANSWER);
    } finally {
      db.close();
    }
  });

  it('手写正文不被静默覆盖：AI 再次提交后用户那一版仍在版本链里', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const seen: TaskType[] = [];
      await driveProjectToReady(db, env, seen);
      const overview = chapterOverview(db);
      const chapterId = overview.chapters[0]!.blueprintChapterId;
      const executed = new Set<string>();

      const run1 = await generateChapterToGate(db, env, chapterId, executed, seen);
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run1,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-a',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run1);

      const link = db.getManuscriptChapterLinkRepository().get(PROJECT_ID, chapterId)!;
      const before = dispatchManuscriptCommand(
        'manuscript.getChapter',
        { projectId: PROJECT_ID, chapterId: link.chapterId },
        manuscriptHandlerCtx(db),
      ) as { currentVersionId: string | null };

      // 用户手改
      const userSaved = dispatchManuscriptCommand(
        'manuscript.saveChapter',
        {
          projectId: PROJECT_ID,
          chapterId: link.chapterId,
          title: '第一章 接信',
          content: '这一版完全是作者手写的正文，必须保留。',
          expectedCurrentVersionId: before.currentVersionId,
        },
        manuscriptHandlerCtx(db),
      ) as { currentVersionId: string | null };

      // 同一章再生成一次并接受（AI 再次提交）
      const run2 = await generateChapterToGate(db, env, chapterId, executed, seen);
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId: run2,
          kind: 'gate',
          outcome: 'accept',
          feedback: null,
          idempotencyKey: 'accept-b',
        },
        chapterHandlerCtx(db),
      );
      await driveRun(env.deps, PROJECT_ID, run2);

      // 用户手写的那一版仍在版本链里（current 指针移动了，历史一条不删）
      const versions = db
        .getChapterVersionRepository()
        .listSummariesByChapter(PROJECT_ID, link.chapterId);
      expect(versions.some((v) => v.id === userSaved.currentVersionId)).toBe(true);
      const userVersion = db
        .getChapterVersionRepository()
        .getById(PROJECT_ID, link.chapterId, userSaved.currentVersionId!)!;
      expect(userVersion.content).toBe('这一版完全是作者手写的正文，必须保留。');
      expect(userVersion.sourceType).toBe('USER');

      // 过期基线保存被拒（不静默覆盖的另一半）
      expect(() =>
        dispatchManuscriptCommand(
          'manuscript.saveChapter',
          {
            projectId: PROJECT_ID,
            chapterId: link.chapterId,
            title: '第一章 接信',
            content: '基于旧版本的修改。',
            expectedCurrentVersionId: before.currentVersionId,
          },
          manuscriptHandlerCtx(db),
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('可恢复：任务 PENDING 时换全新 deps（模拟重启）仍能继续推进', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const { run } = createProjectRun(env.deps, {
        projectId: PROJECT_ID,
        idempotencyKey: `restart-${idCounter}`,
      });
      const runId = run.workflowRunId;
      // 只驱动不执行：SPEC_EXTRACT 任务停在 PENDING
      await driveRun(env.deps, PROJECT_ID, runId);
      const pendingTaskId = [...new Set(env.scheduled)].at(-1)!;
      expect(db.getTaskRepository().getById(pendingTaskId)!.status).toBe('PENDING');

      // 全新 deps（模拟重启后的 worker）：同一 task 被幂等重新调度
      const restarted = buildRunnerEnv(db);
      await driveRun(restarted.deps, PROJECT_ID, runId);
      expect(restarted.scheduled).toContain(pendingTaskId);

      // 执行后能继续推进到人工 Gate
      const seen: TaskType[] = [];
      await pump(db, restarted, { executed: new Set(), runId, seen });
      const state = projectState(restarted, runId);
      expect(state.pendingHumanDecision?.nodeId).toBe(COLLECT_ANSWER);
    } finally {
      db.close();
    }
  });

  it('可恢复：章节生成中模型中断 → run 终态失败 → 重新发起本章生成可成功，稿件不受影响', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const seen: TaskType[] = [];
      await driveProjectToReady(db, env, seen);
      const overview = chapterOverview(db);
      const chapterId = overview.chapters[0]!.blueprintChapterId;
      const executed = new Set<string>();

      // 故障注入：DRAFT 的模型调用抛错
      const failedRun = await generateChapterToGate(
        db,
        env,
        chapterId,
        executed,
        seen,
        'CHAPTER_DRAFT',
      );
      const failedState = getRunProgress(env.deps, {
        projectId: PROJECT_ID,
        runId: failedRun,
      }) as ChapterGenerationRunState;
      expect(failedState.terminalStatus).toBe('failed');
      // 稿件里还没有任何东西（候选未被接受，不得写入权威稿件）
      expect(db.getManuscriptChapterLinkRepository().get(PROJECT_ID, chapterId)).toBeNull();

      // 用户重新发起本章生成：新 run 正常走通
      const retryRun = await generateChapterToGate(db, env, chapterId, executed, seen);
      expect(retryRun).not.toBe(failedRun);
      const retryState = getRunProgress(env.deps, {
        projectId: PROJECT_ID,
        runId: retryRun,
      }) as ChapterGenerationRunState;
      expect(retryState.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);

      // 三个 Critic 都跑过（fan-out 在重试 run 里同样完整）
      const candidate = db.getChapterCandidateRepository().getLatestByRun(PROJECT_ID, retryRun)!;
      const critiques = db
        .getChapterCritiqueRepository()
        .listByCandidateRevision(PROJECT_ID, retryRun, candidate.revisionNo);
      expect(critiques.map((c) => c.criticNodeId).sort()).toEqual(
        [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort(),
      );
    } finally {
      db.close();
    }
  });
});
