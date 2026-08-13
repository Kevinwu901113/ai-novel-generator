/**
 * 真实模型全链实跑（gated；默认 skip）。
 *
 * 目的：`product-e2e` 用的是脚本化模型输出，验证的是**接线**；这条验证的是**真实
 * provider 下的行为**——模型是否按约定输出严格 JSON、一章中文正文会不会撞输出上限、
 * 三个 Critic 的判定是否可用、整条链能不能真的产出可导出的稿件。
 *
 * 本地启用（key 只从环境变量读，不落文件、不进仓库、不写 Keychain）：
 *
 * ```bash
 * MODEL_LIVE=1 \
 * MODEL_BASE_URL=https://api.deepseek.com \
 * MODEL_NAME=deepseek-chat \
 * MODEL_PROTOCOL=openai-chat \
 * MODEL_API_KEY=sk-xxx \
 * pnpm exec vitest run apps/worker/src/product-live.gated.test.ts
 * ```
 *
 * 可选：再给 `TAVILY_API_KEY` 就会走真实联网调研（否则用纯幻想设定，图会判
 * `research_decision=none` 而跳过调研，链路其余部分照跑）。
 *
 * 运行会真实计费。CI 不设置这些变量，永远 skip。
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
import { invokeModel } from '@ai-novel/model-gateway';
import { createSafeWebFetch, createTavilySearchProvider } from '@ai-novel/research-engine';
import {
  BLUEPRINT_USER_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  COLLECT_ANSWER,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState, TaskType } from '@ai-novel/domain';
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

const LIVE =
  process.env.MODEL_LIVE === '1' &&
  !!process.env.MODEL_API_KEY &&
  !!process.env.MODEL_BASE_URL &&
  !!process.env.MODEL_NAME;

const HAS_TAVILY = !!process.env.TAVILY_API_KEY;

/** 有 Tavily key 时用历史题材（触发真实调研），否则用纯幻想（图判 none 跳过调研） */
const INITIAL_IDEA = HAS_TAVILY
  ? '一个晚清邮差在乱世里送最后一封信的故事'
  : '一个在异世界经营客栈的故事，客栈连接多个位面';

const PROJECT_ID = 'p1';
const NOW = new Date('2026-08-13T00:00:00.000Z').toISOString();

let tempDir: string;
let idCounter = 0;

const clock = { now: () => new Date().toISOString() };
const idGenerator = { generate: () => `id-${++idCounter}` };

function makeDb(): ProjectDatabase {
  const db = new ProjectDatabase(join(tempDir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: PROJECT_ID,
    name: '真实链路实跑',
    initialIdea: INITIAL_IDEA,
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

const liveProfile = {
  id: 'live-provider',
  providerType: (process.env.MODEL_PROTOCOL ?? 'openai-chat') as string,
  displayName: 'live',
  baseUrl: process.env.MODEL_BASE_URL ?? '',
  model: process.env.MODEL_NAME ?? '',
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

const liveProviderRepo = {
  getById: () => liveProfile,
  list: () => [liveProfile],
  getDefault: () => liveProfile,
  getRoute: () => null,
  create: () => {},
  update: () => {},
  delete: () => {},
  setDefault: () => {},
  setRoute: () => {},
  deleteRoute: () => {},
  updateTestResult: () => {},
} as unknown as ProviderProfileRepository;

/** key 只在内存里传给网关，绝不写文件 / Keychain */
const envSecretStore: SecretStore = {
  hasSecret: async () => true,
  setSecret: async () => {},
  getSecret: async () => process.env.MODEL_API_KEY ?? '',
  deleteSecret: async () => {},
};

function buildRunnerEnv(db: ProjectDatabase) {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const ctx = {
    getProjectDb: () => new ProjectDatabase(join(tempDir, 'project.sqlite')),
    idGenerator,
    clock,
  };
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
    runnerId: 'product-live-runner',
    scheduleTask: (taskId) => {
      scheduled.push(taskId);
    },
  };
  return { deps, scheduled };
}

function buildTaskDeps(db: ProjectDatabase) {
  const grillDeps = buildGrillSessionDeps(db, {
    getProjectDb: () => db,
    idGenerator,
    clock,
  });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: envSecretStore,
    providerRepo: liveProviderRepo,
    idGenerator,
    clock,
    invokeModel: (async (input: {
      baseUrl: string;
      model: string;
      apiKey: string;
      prompt: string;
      systemPrompt?: string;
      protocol?: string;
      maxTokens?: number;
    }) => invokeModel({ fetch: globalThis.fetch, clock }, input as never)) as never,
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
    buildSearchPort: (apiKey: string) => createTavilySearchProvider({ apiKey }),
    webFetch: createSafeWebFetch(),
  };
}

/** 实跑诊断：每个任务的类型、耗时、输出规模、失败原因 */
interface LiveTrace {
  readonly taskType: TaskType;
  readonly ms: number;
  readonly status: string;
  readonly errorCode: string | null;
  readonly resultSummary: string | null;
}

async function pumpLive(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  executed: Set<string>,
  trace: LiveTrace[],
): Promise<void> {
  let guard = 0;
  for (;;) {
    expect(++guard).toBeLessThan(40);
    await driveRun(env.deps, PROJECT_ID, runId);
    const state = getRunProgress(env.deps, { projectId: PROJECT_ID, runId });
    if (state.terminalStatus !== null || state.pendingHumanDecision !== null) return;

    const execRepo = db.getNodeExecutionRepository();
    const pending = [...new Set(env.scheduled)].filter(
      (id) => !executed.has(id) && execRepo.getByTaskId(id)?.graphRunId === runId,
    );
    if (pending.length === 0) return;

    for (const taskId of pending) {
      executed.add(taskId);
      const task = db.getTaskRepository().getById(taskId)!;
      const taskType = task.taskType as TaskType;
      const deps = buildTaskDeps(db);
      const started = Date.now();
      switch (taskType) {
        case 'SPEC_EXTRACT':
          await executeSpecExtract(deps as never, taskId);
          break;
        case 'RESEARCH_RUN':
          await executeResearchRun(deps as never, taskId);
          break;
        case 'BLUEPRINT_GENERATE':
          await executeBlueprintGenerate(deps as never, taskId);
          break;
        case 'CHAPTER_PLAN':
          await executeChapterPlan(deps as never, taskId);
          break;
        case 'CHAPTER_DRAFT':
          await executeChapterDraftNode(deps as never, taskId);
          break;
        case 'CHAPTER_CRITIQUE':
          await executeChapterCritique(deps as never, taskId);
          break;
        case 'CHAPTER_REWRITE':
          await executeChapterRewrite(deps as never, taskId);
          break;
        default:
          throw new Error(`未预期的任务类型: ${taskType}`);
      }
      const finished = db.getTaskRepository().getById(taskId)!;
      trace.push({
        taskType,
        ms: Date.now() - started,
        status: finished.status,
        errorCode: finished.errorCode,
        resultSummary: finished.resultJson?.slice(0, 200) ?? finished.errorMessage,
      });
    }
  }
}

function printTrace(trace: ReadonlyArray<LiveTrace>): void {
  console.log('\n──── 真实链路实跑诊断 ────');
  for (const entry of trace) {
    console.log(
      `${entry.taskType.padEnd(18)} ${String(entry.ms).padStart(6)}ms  ${entry.status}` +
        `${entry.errorCode ? `  [${entry.errorCode}]` : ''}` +
        `${entry.resultSummary ? `  ${entry.resultSummary}` : ''}`,
    );
  }
}

function chapterCtx(): ChapterHandlerContext {
  return {
    getProjectDb: () => new ProjectDatabase(join(tempDir, 'project.sqlite')),
    idGenerator,
    clock,
  };
}

function manuscriptCtx(): ManuscriptHandlerContext {
  return {
    getProjectDb: () => new ProjectDatabase(join(tempDir, 'project.sqlite')),
    idGenerator,
    clock,
  };
}

describe.skipIf(!LIVE)('真实模型全链实跑（gated）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'product-live-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    '想法 → 追问 → 蓝图 → 一章正文 → 采用 → 导出（真实 provider）',
    async () => {
      const db = makeDb();
      const trace: LiveTrace[] = [];
      try {
        const env = buildRunnerEnv(db);
        const executed = new Set<string>();
        const { run } = createProjectRun(env.deps, {
          projectId: PROJECT_ID,
          idempotencyKey: 'live-1',
        });
        const runId = run.workflowRunId;

        // 想法 → 抽取（真实模型决定是追问还是直接完成）
        await pumpLive(db, env, runId, executed, trace);
        let state = getRunProgress(env.deps, {
          projectId: PROJECT_ID,
          runId,
        }) as IdeaToNovelProjectRunState;

        // 若模型选择追问，就回答一次再继续（真人路径）
        let answers = 0;
        while (state.pendingHumanDecision?.nodeId === COLLECT_ANSWER && answers < 3) {
          const sessionId = state.artifacts.idea!.artifactId;
          const grillDeps = buildGrillSessionDeps(db, {
            getProjectDb: () => db,
            idGenerator,
            clock,
          });
          const asked = grillDeps.questionRepo
            .listBySession(sessionId)
            .filter((q) => q.status === 'ASKED');
          expect(asked.length).toBeGreaterThan(0);
          applyHumanDecision(
            env.deps as GraphRunDeps,
            {
              kind: 'intake_answer',
              runId,
              nodeId: COLLECT_ANSWER,
              sessionId,
              questionId: asked[0]!.id,
              text: '长篇连载，每章三千字左右，主角沉默寡言，不要甜宠',
              idempotencyKey: `live-answer-${++answers}`,
            } as never,
          );
          await pumpLive(db, env, runId, executed, trace);
          state = getRunProgress(env.deps, {
            projectId: PROJECT_ID,
            runId,
          }) as IdeaToNovelProjectRunState;
        }

        printTrace(trace);
        expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'gate',
            runId,
            nodeId: BLUEPRINT_USER_GATE,
            outcome: 'accept',
            idempotencyKey: 'live-accept-bp',
          } as never,
        );
        await pumpLive(db, env, runId, executed, trace);
        expect(
          (getRunProgress(env.deps, { projectId: PROJECT_ID, runId }) as IdeaToNovelProjectRunState)
            .terminalStatus,
        ).toBe('completed');

        // 第一章真实生成
        const overview = dispatchChapterCommand(
          'chapter.getOverview',
          { projectId: PROJECT_ID },
          chapterCtx(),
        ) as ChapterOverviewDto;
        expect(overview.chapters.length).toBeGreaterThan(0);
        const started = dispatchChapterCommand(
          'chapter.startRun',
          {
            projectId: PROJECT_ID,
            blueprintChapterId: overview.chapters[0]!.blueprintChapterId,
          },
          chapterCtx(),
        ) as ChapterRunStateDto;
        await pumpLive(db, env, started.runId, executed, trace);
        printTrace(trace);

        const chapterState = dispatchChapterCommand(
          'chapter.getRunState',
          { projectId: PROJECT_ID, runId: started.runId },
          chapterCtx(),
        ) as ChapterRunStateDto;
        console.log(
          `\n候选正文：第 ${String(chapterState.candidate?.revisionNo)} 版，` +
            `${String(chapterState.candidate?.content.length)} 字符\n` +
            `审查结论：${chapterState.critiques
              .map((c) => `${c.dimension}=${c.verdict}`)
              .join(' / ')}\n`,
        );
        console.log(`${chapterState.candidate?.content.slice(0, 400) ?? ''}\n……`);

        expect(chapterState.phase).toBe('awaiting_decision');
        expect(chapterState.candidate).not.toBeNull();
        expect(chapterState.candidate!.content.length).toBeGreaterThan(500);
        expect(chapterState.critiques).toHaveLength(3);

        // 采用 → 写入稿件 → 导出
        dispatchChapterCommand(
          'chapter.submitDecision',
          {
            projectId: PROJECT_ID,
            runId: started.runId,
            kind: 'gate',
            outcome: 'accept',
            feedback: null,
            idempotencyKey: 'live-accept-ch',
          },
          chapterCtx(),
        );
        await driveRun(env.deps, PROJECT_ID, started.runId);

        const exported = dispatchManuscriptCommand(
          'manuscript.export',
          { projectId: PROJECT_ID, format: 'markdown' },
          manuscriptCtx(),
        ) as ManuscriptExportPayload;
        expect(exported.chapterCount).toBe(1);
        console.log(`\n导出：${exported.fileName}，${exported.content.length} 字符`);
      } finally {
        printTrace(trace);
        db.close();
      }
    },
    30 * 60 * 1000,
  );
});
