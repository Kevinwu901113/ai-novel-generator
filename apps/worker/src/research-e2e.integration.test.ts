/**
 * GE-4 / B5 端到端集成测试（真实 SQLite + 真实 executor + 生产 resolver + fake 搜索/抓取端口）。
 *
 * 覆盖 roadmap GE-4 退出条件的确定性部分：
 * 1. none：无事实依赖想法 → RESEARCH_DECISION=none → 直达 BLUEPRINT_GENERATE（不建任务）；
 * 2. deep 全链：晚清历史想法 → decision=deep → PLAN(marker) → RESEARCH_RUN 任务
 *    （模型脚本产问题计划 + fake Tavily/fetch）→ bundle 落库 → VALIDATE=valid → 停在
 *    BLUEPRINT_GENERATE（GE-5 executor 未注册 → TD-020 跳过保持，run 不死）；
 * 3. invalid 回环：抓取全失败 → validate=invalid → researchRetry 回环（复用问题计划，
 *    不再调模型）→ 预算耗尽 → RESEARCH_ESCALATION 人工 Gate → skip_research 放行；
 * 4. 配置类 PENDING：Tavily key 缺失 → 任务保持 PENDING（SEARCH_KEY_REQUIRED），run 不死；
 *    key 补齐后重执行成功（D-B5-6/7 语义的任务侧半边）。
 *
 * light/deep 的深度判定单测在 research-engine 包；Tavily 真调用见 gated live 测试。
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
  TAVILY_SEARCH_SECRET_REF,
  type GraphRunDeps,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type SecretStore,
  type ProviderProfileRepository,
} from '@ai-novel/application';
import {
  executeResearchRun,
  executeSpecExtract,
  sha256Hex,
  TaskExecutionError,
  type ResearchRunExecutionDeps,
  type SpecExtractExecutionDeps,
} from '@ai-novel/task-engine';
import type { FetchedDocument, SearchResult } from '@ai-novel/research-engine';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  BLUEPRINT_GENERATE,
  RESEARCH_DECISION,
  RESEARCH_ESCALATION,
  RESEARCH_EXECUTE,
  RESEARCH_PLAN,
  RESEARCH_VALIDATE,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { registerIntakeExecutors } from './intake-executors.js';
import { registerResearchExecutors } from './research-executors.js';
import { buildGrillSessionDeps } from './grill-handlers.js';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';

const NOW = '2026-08-10T00:00:00.000Z';

let tempDir: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function makeDb(initialIdea: string): ProjectDatabase {
  const db = new ProjectDatabase(join(tempDir, `project-${++idCounter}.sqlite`));
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

const SECTIONS = {
  premise: '主角在异世界经营一家客栈',
  genre: ['fantasy'],
  tone: ['light'],
  targetAudience: 'adults',
  narrativePov: 'FIRST',
  tense: 'PRESENT',
  protagonist: { characterKey: 'protag', name: '店主小满' },
};

function specCompleteJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    decision: 'spec_complete',
    sections: SECTIONS,
    nextQuestions: [],
  });
}

function researchPlanJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    questions: [{ text: '晚清邮政系统如何运作' }, { text: '晚清城市治安机构有哪些' }],
  });
}

/** 真实 executor 环境（intake + research 全注册）+ 生产 resolver + 任务收集 */
function buildRunnerEnv(db: ProjectDatabase) {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const ctx = { getProjectDb: () => db, idGenerator, clock };
  registerIntakeExecutors(registry, runners, ctx);
  registerResearchExecutors(registry, runners, ctx);
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
    runnerId: 'research-e2e-runner',
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

/** secretStore：provider key 恒有；Tavily key 可控 */
function makeSecretStore(hasTavilyKey: boolean): SecretStore {
  return {
    hasSecret: async () => true,
    setSecret: async () => {},
    getSecret: async (service: string) =>
      service === TAVILY_SEARCH_SECRET_REF.service ? (hasTavilyKey ? 'tv-key' : null) : 'model-key',
    deleteSecret: async () => {},
  };
}

interface ResearchDepsOptions {
  readonly modelScript?: string[];
  readonly hasTavilyKey?: boolean;
  readonly fetchFails?: boolean;
}

function buildResearchDeps(
  db: ProjectDatabase,
  opts: ResearchDepsOptions = {},
): ResearchRunExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  const script = opts.modelScript ?? [researchPlanJson()];
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: makeSecretStore(opts.hasTavilyKey ?? true),
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: async () => ({
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
    }),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    buildSearchPort: () => ({
      search: async (input: { query: string; maxResults: number }): Promise<SearchResult[]> => [
        {
          url: `https://facts.example/${encodeURIComponent(input.query.slice(0, 10))}`,
          title: `资料：${input.query.slice(0, 10)}`,
          snippet: '摘要',
          publishedAt: null,
        },
      ],
    }),
    webFetch: {
      fetch: async (input: { url: string }): Promise<FetchedDocument> => {
        if (opts.fetchFails) throw new Error('抓取失败（测试注入）');
        return {
          url: input.url,
          title: '来源页面',
          extractedText: '与问题相关的事实内容。',
          fetchedAt: NOW,
        };
      },
    },
  };
}

/** SPEC_EXTRACT 任务 deps（沿用 intake-e2e 模式，脚本 spec_complete 一步到位） */
function buildSpecDeps(db: ProjectDatabase): SpecExtractExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: makeSecretStore(true),
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: async () => ({
      text: specCompleteJson(),
      providerRequestId: 'req-0',
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
    }),
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

function uniq(list: ReadonlyArray<string>): string[] {
  return [...new Set(list)];
}

function projectState(deps: NodeRunnerDeps, runId: string): IdeaToNovelProjectRunState {
  return getRunProgress(deps, { projectId: 'p1', runId }) as IdeaToNovelProjectRunState;
}

/** 想法 → spec_complete → 停在 RESEARCH_DECISION 之后（返回 runId） */
async function driveThroughIntake(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
): Promise<string> {
  const { run } = createProjectRun(env.deps, { projectId: 'p1', idempotencyKey: 'research-e2e' });
  const runId = run.workflowRunId;
  await driveRun(env.deps, 'p1', runId);
  await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]);
  await driveRun(env.deps, 'p1', runId);
  return runId;
}

describe('GE-4 Research E2E（真实 SQLite + 真实 executor + 生产 resolver）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-e2e-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. none：无事实依赖 → 直达 BLUEPRINT_GENERATE，不建调研任务', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveThroughIntake(db, env);

      const state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[RESEARCH_DECISION]).toBe('succeeded');
      expect(state.nodeOutcomes[RESEARCH_DECISION]?.value).toBe('none');
      // 跳过 PLAN/EXECUTE/VALIDATE，直达蓝图（GE-5 executor 未注册 → TD-020 跳过保持）
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');
      expect(env.skips).toContain(`${BLUEPRINT_GENERATE}:unregistered`);
      // 只有 SPEC_EXTRACT 一个任务，没有 RESEARCH_RUN
      expect(uniq(env.scheduled)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('2. deep 全链：decision=deep → PLAN → RESEARCH_RUN 任务 → bundle → VALIDATE=valid → 蓝图', async () => {
    const db = makeDb('一个晚清历史背景的侦探故事，注重史实细节');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveThroughIntake(db, env);

      let state = projectState(env.deps, runId);
      expect(state.nodeOutcomes[RESEARCH_DECISION]?.value).toBe('deep');
      expect(state.nodeStatuses[RESEARCH_PLAN]).toBe('succeeded');
      // RESEARCH_RUN 任务已建（第二个任务）
      const taskIds = uniq(env.scheduled);
      expect(taskIds).toHaveLength(2);

      const result = await executeResearchRun(buildResearchDeps(db), taskIds[1]);
      expect(result.bundleId).toBeTruthy();
      expect(result.questionCount).toBe(2);
      expect(result.factNoteCount).toBeGreaterThanOrEqual(1);

      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[RESEARCH_EXECUTE]).toBe('succeeded');
      expect(state.nodeStatuses[RESEARCH_VALIDATE]).toBe('succeeded');
      expect(state.nodeOutcomes[RESEARCH_VALIDATE]?.value).toBe('valid');
      expect(state.artifacts.researchBundle?.artifactId).toBe(result.bundleId);
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

      // bundle 真实落库：问题绑定来源、事实笔记绑定 URL
      const bundle = db.getResearchBundleRepository().getById('p1', result.bundleId!)!;
      expect(bundle.depth).toBe('deep');
      expect(bundle.questions.every((q) => q.sources.length >= 1)).toBe(true);
      expect(bundle.factNotes.every((n) => n.sourceUrls.length >= 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('3. invalid 回环：抓取全失败 → 重试（复用问题计划，不再调模型）→ 预算耗尽 → 人工 Gate → skip_research', async () => {
    const db = makeDb('一个晚清历史背景的侦探故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveThroughIntake(db, env);

      // 模型脚本只有一份问题计划：重试路径复用上一轮问题，多调模型会得到空脚本而失败
      const script = [researchPlanJson()];
      let guard = 0;
      for (;;) {
        expect(++guard).toBeLessThan(8);
        const state = projectState(env.deps, runId);
        if (state.pendingHumanDecision?.nodeId === RESEARCH_ESCALATION) break;
        expect(state.terminalStatus).toBeNull();
        const taskIds = uniq(env.scheduled);
        const latestTask = taskIds[taskIds.length - 1];
        await executeResearchRun(
          buildResearchDeps(db, { modelScript: script, fetchFails: true }),
          latestTask,
        );
        await driveRun(env.deps, 'p1', runId);
      }

      // 人工升级：skip_research 放行到蓝图
      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'escalation',
          runId,
          nodeId: RESEARCH_ESCALATION,
          outcome: 'skip_research',
          idempotencyKey: 'esc-skip',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      const state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');
    } finally {
      db.close();
    }
  });

  it('4. Tavily key 缺失 → 任务保持 PENDING（SEARCH_KEY_REQUIRED），key 补齐后成功', async () => {
    const db = makeDb('一个晚清历史背景的侦探故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveThroughIntake(db, env);
      const taskIds = uniq(env.scheduled);
      const researchTaskId = taskIds[1];

      await expect(
        executeResearchRun(buildResearchDeps(db, { hasTavilyKey: false }), researchTaskId),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof TaskExecutionError && err.code === 'SEARCH_KEY_REQUIRED',
      );
      // 配置类错误：任务保持 PENDING、attempt 不增、run 不死（BLK-2 同语义）
      const task = new TaskRepositoryAdapter(db).getById(researchTaskId)!;
      expect(task.status).toBe('PENDING');
      expect(task.attemptCount).toBe(0);
      expect(projectState(env.deps, runId).terminalStatus).toBeNull();

      // key 补齐后重执行成功
      const result = await executeResearchRun(buildResearchDeps(db), researchTaskId);
      expect(result.bundleId).toBeTruthy();
      await driveRun(env.deps, 'p1', runId);
      expect(projectState(env.deps, runId).nodeOutcomes[RESEARCH_VALIDATE]?.value).toBe('valid');
    } finally {
      db.close();
    }
  });
});
