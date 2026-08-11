/**
 * GE-5 / B7 端到端集成测试（真实 SQLite + 真实 executor + 生产 resolver + 脚本化 invokeModel）。
 *
 * 覆盖 roadmap GE-5 退出条件：
 * 1. PROJECT_READY 全链：模糊想法 → SPEC_EXTRACT → research_decision=none 直达 →
 *    BLUEPRINT_GENERATE 任务（脚本产合法蓝图 JSON）→ 停在 BLUEPRINT_USER_GATE
 *    （waiting_for_human）→ applyHumanDecision(gate, accept) → terminalStatus==='completed'
 *    且 storyBlueprint.accepted===true（D-B7-1 原子性正向断言）；
 * 2. PROJECT_CANCELLED：到 gate → request_rewrite ×3（每次回环重新执行蓝图任务）→
 *    预算耗尽落 BLUEPRINT_ESCALATION → cancel → terminalStatus==='cancelled'；
 * 3. PROJECT_BLOCKED：到 escalation → continue_later → terminalStatus==='blocked'；
 * 4. accept_current 覆盖（D-B7-2）：经 BLUEPRINT_ESCALATION 的 accept_current → PROJECT_READY，
 *    同样断言 accepted===true；
 * 5. 原子性回归（D-B7-1）：注入让 markAccepted 抛错的 fake repo → run 仍停在
 *    waiting_for_human、terminalStatus===null、未终态化（先红后绿，见测试内注释）；
 * 6. 失效拒绝（D-B7-8）：用真实 applyArtifactChange 路径让 invalidatedArtifacts 含
 *    storyBlueprint → accept 被拒，run 未终态；随后 request_rewrite 可正常回环；
 * 7. deep research 全链 → 蓝图（覆盖有 researchBundle 的 prompt 分支）→ READY；
 * 8. 重启恢复：蓝图任务 PENDING 时换全新 deps 实例，driveRun 幂等重新调度（照
 *    intake-e2e 的先例）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  applyArtifactChange,
  applyHumanDecision,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  getRunProgress,
  productionArtifactResolver,
  type GraphRunDeps,
  type GraphRunTransactionPort,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type SecretStore,
  type ProviderProfileRepository,
} from '@ai-novel/application';
import {
  executeBlueprintGenerate,
  executeResearchRun,
  executeSpecExtract,
  sha256Hex,
  type BlueprintGenerateExecutionDeps,
  type ResearchRunExecutionDeps,
  type SpecExtractExecutionDeps,
} from '@ai-novel/task-engine';
import type { FetchedDocument, SearchResult } from '@ai-novel/research-engine';
import type { ErrorCode } from '@ai-novel/contracts';
import {
  BLUEPRINT_ESCALATION,
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  PROJECT_READY,
  RESEARCH_DECISION,
  RESEARCH_ESCALATION,
  RESEARCH_VALIDATE,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { registerIntakeExecutors } from './intake-executors.js';
import { registerResearchExecutors } from './research-executors.js';
import { registerBlueprintExecutors } from './blueprint-executors.js';
import { registerProjectTerminalExecutors } from './project-terminal-executors.js';
import { buildGrillSessionDeps } from './grill-handlers.js';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';

const NOW = '2026-08-11T00:00:00.000Z';

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
    // BLK-1（B7 复查修复）：每个问题至少 2 条来源，才能走真实的"部分来源被排除"路径——
    // 单来源恒走"整条剔除"分支，测不出 D-B7-13 消费点是否正确处理"同一笔记聚合多个
    // 来源正文"的情形。两个问题分别用于验证：q1 的笔记因排除其中一个来源而整条消失
    // （含未被排除来源的正文），q2 的笔记完全未涉及排除来源、应原样进入 prompt。
    questions: [{ text: '晚清邮政系统如何运作' }, { text: '晚清租界巡捕房制度' }],
  });
}

function blueprintJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    premise: '店主小满在异世界客栈迎来形形色色的旅人',
    characters: [{ name: '小满', role: '主角', description: '沉稳的客栈老板' }],
    relationships: ['小满——常客阿岩'],
    world: '连接多个位面的十字路口客栈',
    conflict: '客栈的位面通道逐渐不稳定',
    ending: '小满找到稳定通道的方法，客栈成为旅人的港湾',
    plotlines: [{ name: '主线', summary: '追查通道不稳定的根源' }],
    chapters: [
      { title: '第一章：远客', goal: '引出客栈与主角' },
      { title: '第二章：异动', goal: '发现通道异常' },
    ],
    ...overrides,
  });
}

/** 真实 executor 环境（intake + research + blueprint 全注册）+ 生产 resolver + 任务收集 */
function buildRunnerEnv(db: ProjectDatabase) {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const ctx = { getProjectDb: () => db, idGenerator, clock };
  registerIntakeExecutors(registry, runners, ctx);
  registerResearchExecutors(registry, runners, ctx);
  registerBlueprintExecutors(registry, runners, ctx);
  registerProjectTerminalExecutors(registry, runners);
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
    runnerId: 'blueprint-e2e-runner',
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

/** capturedPrompts：可选——收集每次调用实际发给模型的 prompt（D-B7-13 断言用） */
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

/** 复查随行修复 note 4：invokeModel 抛错分支（网络/协议异常，非 provider 显式 errorCode） */
function fakeInvokeModelThrows(message: string) {
  return async () => {
    throw new Error(message);
  };
}

/** 复查随行修复 note 4：invokeModel 正常返回但携带 provider errorCode 分支 */
function fakeInvokeModelWithErrorCode(errorCode: ErrorCode, errorMessage: string) {
  return async () => ({
    text: '',
    providerRequestId: 'req-err',
    finishReason: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    },
    latencyMs: 7,
    errorCode,
    errorMessage,
  });
}

/** SPEC_EXTRACT 任务 deps（沿用 intake-e2e/research-e2e 模式） */
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

/** RESEARCH_RUN 任务 deps（沿用 research-e2e 模式：fake Tavily + fetch） */
function buildResearchDeps(db: ProjectDatabase): ResearchRunExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel([researchPlanJson()]),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    // BLK-1（B7 复查修复）：每个问题返回 2 条来源（deep 深度 maxFetch=4，都能被抓取），
    // 使 orchestrateResearch 产出的每条 factNote 聚合 2 篇文档正文——这是生产常态
    // （orchestrator.ts 按问题拼接全部抓取文档），单来源 fake 会让"部分排除"分支
    // 端到端从未被执行。fetch 内容按 url 打上可辨识标记，便于测试断言"哪段正文出现/
    // 不出现在最终 prompt 里"。
    buildSearchPort: () => ({
      search: async (input: { query: string; maxResults: number }): Promise<SearchResult[]> => {
        const base = encodeURIComponent(input.query.slice(0, 10));
        return [
          {
            url: `https://facts.example/${base}-1`,
            title: `资料一：${input.query.slice(0, 10)}`,
            snippet: '摘要',
            publishedAt: null,
          },
          {
            url: `https://facts.example/${base}-2`,
            title: `资料二：${input.query.slice(0, 10)}`,
            snippet: '摘要',
            publishedAt: null,
          },
        ];
      },
    }),
    webFetch: {
      fetch: async (input: { url: string }): Promise<FetchedDocument> => ({
        url: input.url,
        title: '来源页面',
        extractedText: `与问题相关的事实内容，正文标记 CONTENT-FOR[${input.url}]。`,
        fetchedAt: NOW,
      }),
    },
  };
}

/**
 * D-B7-14：走到 RESEARCH_ESCALATION 的问题计划——两个问题里恰好一个"永远查无结果"
 * （search 返回空数组），另一个正常有来源。这样产出的 bundle 有真实可辨识的事实
 * 笔记内容（不是抓取全失败的空 bundle），但因为有一个问题零来源，
 * `validateBundleDeterministic`（D-B5-4：每问题 >=1 来源）判定 invalid，走
 * researchRetry 回环直至预算耗尽，停在 RESEARCH_ESCALATION——bundle 内容可用于
 * D-B7-14 两条对照 E2E 断言 prompt 是否包含它。
 */
function escalationResearchPlanJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    questions: [{ text: '晚清邮政系统如何运作' }, { text: '永远查无结果的问题' }],
  });
}

/**
 * RESEARCH_RUN 任务 deps，走向 D-B7-14 escalation 场景：'永远查无结果的问题' 恒无
 * 搜索结果，另一个问题恒有 1 条可抓取来源，产出内容用可辨识标记
 * `ESCALATION-BUNDLE-CONTENT` 便于断言。同一 fake 在初次执行与两次 researchRetry
 * 重试（复用问题计划，不再调模型）下行为一致，确保每次都判定 invalid。
 */
function buildEscalationResearchDeps(db: ProjectDatabase): ResearchRunExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel([escalationResearchPlanJson()]),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    buildSearchPort: () => ({
      search: async (input: { query: string; maxResults: number }): Promise<SearchResult[]> => {
        if (input.query.includes('永远查无结果')) return [];
        return [
          {
            url: 'https://facts.example/postal-system',
            title: '资料：晚清邮政',
            snippet: '摘要',
            publishedAt: null,
          },
        ];
      },
    }),
    webFetch: {
      fetch: async (input: { url: string }): Promise<FetchedDocument> => ({
        url: input.url,
        title: '来源页面',
        extractedText: 'ESCALATION-BUNDLE-CONTENT：晚清邮政系统采用驿站与新式邮局并行的制度。',
        fetchedAt: NOW,
      }),
    },
  };
}

/**
 * BLUEPRINT_GENERATE 任务 deps（D-B7-5 版本号取 MAX+1 依赖 blueprintRepo；D-B7-13
 * 来源排除依赖 sourceExclusionRepo）。`capturedPrompts` 可选，D-B7-13 用例借此断言
 * 实际发给模型的 prompt 不含被排除 URL。`overrides` 可选——失败分支用例（复查随行
 * 修复 note 4）借此注入会抛错的 invokeModel / blueprintRepo，覆盖 buildBlueprintDeps
 * 默认给出的部分。
 */
function buildBlueprintDeps(
  db: ProjectDatabase,
  script: string[],
  capturedPrompts?: string[],
  overrides: Partial<BlueprintGenerateExecutionDeps> = {},
): BlueprintGenerateExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
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
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    blueprintRepo: db.getStoryBlueprintRepository(),
    sourceExclusionRepo: db.getResearchSourceExclusionRepository(),
    ...overrides,
  };
}

function uniq(list: ReadonlyArray<string>): string[] {
  return [...new Set(list)];
}

function projectState(deps: NodeRunnerDeps, runId: string): IdeaToNovelProjectRunState {
  return getRunProgress(deps, { projectId: 'p1', runId }) as IdeaToNovelProjectRunState;
}

/** 想法（none 路径）→ spec_complete → 直达 BLUEPRINT_GENERATE 任务（返回 runId） */
async function driveToBlueprintTaskNone(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
): Promise<string> {
  const { run } = createProjectRun(env.deps, {
    projectId: 'p1',
    idempotencyKey: `blueprint-e2e-${idCounter}`,
  });
  const runId = run.workflowRunId;
  await driveRun(env.deps, 'p1', runId);
  await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]);
  await driveRun(env.deps, 'p1', runId);
  return runId;
}

/**
 * D-B7-14：想法（deep 路径）→ spec_complete → RESEARCH_EXECUTE（问题计划里一个问题
 * 恒无来源）→ research_valid=invalid → researchRetry 预算耗尽（maxIterations=2，
 * 共执行 3 次）→ 停在 RESEARCH_ESCALATION。返回 runId 与最后一次产出的 bundleId
 * （此时即 `artifacts.researchBundle` 指向的那条，escalation 决策后 BLUEPRINT_GENERATE
 * 会以它为输入）。
 */
async function driveToResearchEscalationWithRealBundle(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
): Promise<{ readonly runId: string; readonly bundleId: string }> {
  const { run } = createProjectRun(env.deps, {
    projectId: 'p1',
    idempotencyKey: `blueprint-e2e-escalation-${idCounter}`,
  });
  const runId = run.workflowRunId;
  await driveRun(env.deps, 'p1', runId);
  await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]);
  await driveRun(env.deps, 'p1', runId);

  let bundleId = '';
  let guard = 0;
  let state = projectState(env.deps, runId);
  for (;;) {
    expect(++guard).toBeLessThan(8);
    if (state.pendingHumanDecision?.nodeId === RESEARCH_ESCALATION) break;
    expect(state.terminalStatus).toBeNull();
    const taskIds = uniq(env.scheduled);
    const latestTask = taskIds[taskIds.length - 1];
    const result = await executeResearchRun(buildEscalationResearchDeps(db), latestTask);
    expect(result.bundleId).toBeTruthy();
    bundleId = result.bundleId!;
    await driveRun(env.deps, 'p1', runId);
    state = projectState(env.deps, runId);
  }
  expect(state.pendingHumanDecision?.nodeId).toBe(RESEARCH_ESCALATION);
  expect(bundleId).toBeTruthy();
  return { runId, bundleId };
}

/**
 * 在 BLUEPRINT_GENERATE 任务已建的前提下执行它并驱动到 BLUEPRINT_USER_GATE。
 * 返回本次产出的 blueprintId/version——D-B7-5 版本号断言（复查随行修复 note 5）
 * 需要调用方在改写循环里逐次收集版本号，锁定 MAX+1 语义。
 */
async function executeBlueprintAndDriveToGate(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  script: string[] = [blueprintJson()],
  capturedPrompts?: string[],
): Promise<{ readonly blueprintId: string; readonly version: number }> {
  const taskIds = uniq(env.scheduled);
  const blueprintTaskId = taskIds[taskIds.length - 1];
  const result = await executeBlueprintGenerate(
    buildBlueprintDeps(db, script, capturedPrompts),
    blueprintTaskId,
  );
  expect(result.blueprintId).toBeTruthy();
  expect(result.version).toBeTruthy();
  await driveRun(env.deps, 'p1', runId);
  return { blueprintId: result.blueprintId!, version: result.version! };
}

describe('GE-5 Blueprint E2E（真实 SQLite + 真实 executor + 生产 resolver）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'blueprint-e2e-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. PROJECT_READY 全链：none → 蓝图生成 → gate accept → completed 且 accepted===true', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      let state = projectState(env.deps, runId);
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

      await executeBlueprintAndDriveToGate(db, env, runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      const blueprintId = state.artifacts.storyBlueprint?.artifactId;
      expect(blueprintId).toBeTruthy();
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(false);

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);

      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBe('completed');
      expect(state.nodeStatuses[PROJECT_READY]).toBe('succeeded');
      // 核心验收：原子闭环——蓝图权威存储真被标 accepted
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('2. PROJECT_CANCELLED：request_rewrite ×3（每次回环重新生成）→ 预算耗尽 → escalation → cancel', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      // D-B7-5 版本号断言（复查随行修复 note 5）：逐次收集改写循环产出的版本号，
      // 锁定 MAX(version)+1 语义——4 次生成（1 次初始 + 3 次改写）应恰好产出 1..4，
      // blueprintId 也应互不相同（每次都是新蓝图行，不是原地改写）。
      const versions: number[] = [];
      const blueprintIds: string[] = [];
      const first = await executeBlueprintAndDriveToGate(db, env, runId);
      versions.push(first.version);
      blueprintIds.push(first.blueprintId);

      let guard = 0;
      let state = projectState(env.deps, runId);
      while (state.pendingHumanDecision?.nodeId !== BLUEPRINT_ESCALATION) {
        expect(++guard).toBeLessThan(8);
        expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'gate',
            runId,
            nodeId: BLUEPRINT_USER_GATE,
            outcome: 'request_rewrite',
            idempotencyKey: `rewrite-${guard}`,
          } as never,
        );
        await driveRun(env.deps, 'p1', runId);
        state = projectState(env.deps, runId);
        if (state.pendingHumanDecision?.nodeId === BLUEPRINT_ESCALATION) break;
        // 循环体内 BLUEPRINT_GENERATE 重新 active：执行任务并驱动
        const rewritten = await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()]);
        versions.push(rewritten.version);
        blueprintIds.push(rewritten.blueprintId);
        state = projectState(env.deps, runId);
      }
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_ESCALATION);
      expect(state.attemptBudget.blueprintRewrite ?? 0).toBeGreaterThanOrEqual(3);

      // 核心断言（D-B7-5）：MAX(version)+1 语义——4 次生成产出版本号恰好 1,2,3,4
      // （项目级严格递增，无重复无跳号），且每次都是新的 blueprintId（新行，非原地改写）。
      expect(versions).toEqual([1, 2, 3, 4]);
      expect(new Set(blueprintIds).size).toBe(blueprintIds.length);
      expect(db.getStoryBlueprintRepository().listByProject('p1')).toHaveLength(4);

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'escalation',
          runId,
          nodeId: BLUEPRINT_ESCALATION,
          outcome: 'cancel',
          idempotencyKey: 'cancel-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBe('cancelled');
    } finally {
      db.close();
    }
  });

  it('3. PROJECT_BLOCKED：escalation → continue_later → blocked', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      await executeBlueprintAndDriveToGate(db, env, runId);

      let guard = 0;
      let state = projectState(env.deps, runId);
      while (state.pendingHumanDecision?.nodeId !== BLUEPRINT_ESCALATION) {
        expect(++guard).toBeLessThan(8);
        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'gate',
            runId,
            nodeId: BLUEPRINT_USER_GATE,
            outcome: 'request_rewrite',
            idempotencyKey: `rewrite-b-${guard}`,
          } as never,
        );
        await driveRun(env.deps, 'p1', runId);
        state = projectState(env.deps, runId);
        if (state.pendingHumanDecision?.nodeId === BLUEPRINT_ESCALATION) break;
        await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()]);
        state = projectState(env.deps, runId);
      }
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_ESCALATION);

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'escalation',
          runId,
          nodeId: BLUEPRINT_ESCALATION,
          outcome: 'continue_later',
          idempotencyKey: 'later-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBe('blocked');
    } finally {
      db.close();
    }
  });

  it('4. accept_current 覆盖（D-B7-2）：经 BLUEPRINT_ESCALATION 的 accept_current → READY 且 accepted===true', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      await executeBlueprintAndDriveToGate(db, env, runId);

      let guard = 0;
      let state = projectState(env.deps, runId);
      while (state.pendingHumanDecision?.nodeId !== BLUEPRINT_ESCALATION) {
        expect(++guard).toBeLessThan(8);
        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'gate',
            runId,
            nodeId: BLUEPRINT_USER_GATE,
            outcome: 'request_rewrite',
            idempotencyKey: `rewrite-c-${guard}`,
          } as never,
        );
        await driveRun(env.deps, 'p1', runId);
        state = projectState(env.deps, runId);
        if (state.pendingHumanDecision?.nodeId === BLUEPRINT_ESCALATION) break;
        await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()]);
        state = projectState(env.deps, runId);
      }
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_ESCALATION);
      const blueprintId = state.artifacts.storyBlueprint?.artifactId;
      expect(blueprintId).toBeTruthy();
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(false);

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'escalation',
          runId,
          nodeId: BLUEPRINT_ESCALATION,
          outcome: 'accept_current',
          idempotencyKey: 'accept-current-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBe('completed');
      expect(state.nodeStatuses[PROJECT_READY]).toBe('succeeded');
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('5. 原子性回归（D-B7-1）：markAccepted 抛错 → run 仍停在 waiting_for_human，未终态化', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      await executeBlueprintAndDriveToGate(db, env, runId);

      const before = projectState(env.deps, runId);
      expect(before.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      const blueprintId = before.artifacts.storyBlueprint?.artifactId;
      expect(blueprintId).toBeTruthy();

      // 注入：同一底层 db 连接，包一层把 storyBlueprintRepo.markAccepted 换成必抛错的假实现。
      // 用 Object.create(原型链) 而非 `{...repos.storyBlueprintRepo}` 展开——被展开的
      // 是 class 实例，方法挂在原型上，对象字面量展开只复制自有可枚举属性（这里只有
      // 私有字段 db），getById/save/getMaxVersion 等方法会全部丢失变成 undefined
      // （复查 note 1：眼下这条用例无害，因为它没用到那些方法，但这是空断言陷阱——
      // 未来 accept 分支若新增一次 getById 调用，注入对象会因方法缺失 TypeError，
      // 用例会"继续通过"却测不出真正的回归）。Object.create 保留原型方法，只在
      // 实例自身覆盖 markAccepted 这一个方法。
      // 这条用例在未实现 D-B7-1 原子 accept 的代码上会失败（accept 会绕开 markAccepted
      // 直接推进 transition，run 被打成 completed 而 accepted 仍是 0）——先红后绿，
      // 详见任务交付说明里记录的红绿两次运行。
      const realTx = db.getGraphRunTransaction();
      const brokenTx: GraphRunTransactionPort = {
        runInTransaction: (fn) =>
          realTx.runInTransaction((repos) => {
            const brokenBlueprintRepo = Object.create(
              repos.storyBlueprintRepo,
            ) as typeof repos.storyBlueprintRepo;
            (brokenBlueprintRepo as { markAccepted: unknown }).markAccepted = () => {
              throw new Error('注入失败：markAccepted（D-B7-1 原子性回归测试）');
            };
            return fn({ ...repos, storyBlueprintRepo: brokenBlueprintRepo });
          }),
      };
      const brokenDeps = { ...(env.deps as GraphRunDeps), tx: brokenTx };

      expect(() =>
        applyHumanDecision(brokenDeps, {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-broken-1',
        } as never),
      ).toThrow();

      // 整事务回滚：run 未终态化，蓝图仍未被标记为 accepted
      const after = projectState(env.deps, runId);
      expect(after.terminalStatus).toBeNull();
      expect(after.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      expect(after.nodeStatuses[PROJECT_READY]).not.toBe('succeeded');
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(false);

      // 幂等键未被污染：换回真实 tx，accept 仍能正常完成
      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-retry-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      const final = projectState(env.deps, runId);
      expect(final.terminalStatus).toBe('completed');
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('5b. 原子性回归（反方向，D-B7-1 核心承诺）：markAccepted 真实成功后，同事务内后续步骤失败 → 已写入的 accepted 被回滚为 false', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      await executeBlueprintAndDriveToGate(db, env, runId);

      const before = projectState(env.deps, runId);
      expect(before.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      const blueprintId = before.artifacts.storyBlueprint?.artifactId;
      expect(blueprintId).toBeTruthy();

      // 用例 5 的注入点在 graph 写入（saveWithCas）之前抛错——此时 markAccepted 根本
      // 还没被调用，"回滚"无事可回滚，只证明了顺序（markAccepted 先于 graph 写入），
      // 没有证明原子性。真正的原子性证明必须反过来：markAccepted 先**真实成功写入**
      // （accepted 已经落到 story_blueprints 表），再让同一事务内的**后续**步骤
      // （graphRunRepo.saveWithCas，applyHumanDecision 里紧接在 markAccepted 之后
      // 的下一次写操作）失败——只有这样，"accepted 被回滚回 false"才是 BEGIN
      // IMMEDIATE 同事务回滚的直接证据，而不是"压根没写过"。
      const realTx = db.getGraphRunTransaction();
      const brokenTx: GraphRunTransactionPort = {
        runInTransaction: (fn) =>
          realTx.runInTransaction((repos) => {
            const brokenGraphRunRepo = Object.create(
              repos.graphRunRepo,
            ) as typeof repos.graphRunRepo;
            (brokenGraphRunRepo as { saveWithCas: unknown }).saveWithCas = () => {
              throw new Error('注入失败：saveWithCas（D-B7-1 反向原子性回归测试）');
            };
            return fn({ ...repos, graphRunRepo: brokenGraphRunRepo });
          }),
      };
      const brokenDeps = { ...(env.deps as GraphRunDeps), tx: brokenTx };

      expect(() =>
        applyHumanDecision(brokenDeps, {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-broken-5b',
        } as never),
      ).toThrow();

      // 核心断言：markAccepted 在事务内已经真实执行过（写入了 accepted=1），但因为
      // 同一事务的后续步骤（saveWithCas）失败而 ROLLBACK，权威存储里的 accepted
      // 被撤销回 false —— 这才是"同事务原子"的直接证据（而不是用例 5 那种"还没
      // 来得及写"）。
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(false);
      // run 状态行本身也没有被 brokenTx 写入过（saveWithCas 被短路），仍停在 gate。
      const after = projectState(env.deps, runId);
      expect(after.terminalStatus).toBeNull();
      expect(after.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      // 换回真实 tx，accept 仍能正常完成（幂等键未被污染的broken 尝试污染）
      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-retry-5b',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      const final = projectState(env.deps, runId);
      expect(final.terminalStatus).toBe('completed');
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('6. 失效拒绝（D-B7-8）：真实 applyArtifactChange 使 storyBlueprint 失效 → accept 被拒；随后 request_rewrite 可回环', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env);
      await executeBlueprintAndDriveToGate(db, env, runId);

      const before = projectState(env.deps, runId);
      expect(before.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      const specId = before.artifacts.creationSpec?.artifactId;
      expect(specId).toBeTruthy();

      // 真实路径：creationSpec 变化（模拟用户改了创作要求）→ 按 artifactDownstreamOrder
      // 级联失效 storyBlueprint（researchBundle 在 none 路径下本就是 null，不受影响）。
      applyArtifactChange(env.deps as GraphRunDeps, {
        projectId: 'p1',
        runId,
        artifactKind: 'creationSpec',
        artifactId: `${specId}-revised`,
        idempotencyKey: 'invalidate-1',
      });
      const invalidated = projectState(env.deps, runId);
      expect(invalidated.invalidatedArtifacts.some((r) => r.kind === 'storyBlueprint')).toBe(true);
      // gate 仍是待决（invalidation 不改 pendingHumanDecision）
      expect(invalidated.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      expect(() =>
        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'gate',
            runId,
            nodeId: BLUEPRINT_USER_GATE,
            outcome: 'accept',
            idempotencyKey: 'accept-invalidated-1',
          } as never,
        ),
      ).toThrow(/失效/);

      const afterReject = projectState(env.deps, runId);
      expect(afterReject.terminalStatus).toBeNull();
      expect(afterReject.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      // 用户出路：request_rewrite 仍可正常回环（重新生成新蓝图）
      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'request_rewrite',
          idempotencyKey: 'rewrite-after-invalidate-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      const state = projectState(env.deps, runId);
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');
    } finally {
      db.close();
    }
  });

  it('7. deep research 全链 → 蓝图（带 researchBundle 的 prompt 分支）→ READY', async () => {
    const db = makeDb('一个晚清历史背景的侦探故事，注重史实细节');
    try {
      const env = buildRunnerEnv(db);
      const { run } = createProjectRun(env.deps, {
        projectId: 'p1',
        idempotencyKey: `blueprint-e2e-deep-${idCounter}`,
      });
      const runId = run.workflowRunId;
      await driveRun(env.deps, 'p1', runId);
      await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]);
      await driveRun(env.deps, 'p1', runId);

      let state = projectState(env.deps, runId);
      expect(state.nodeOutcomes[RESEARCH_DECISION]?.value).toBe('deep');
      const researchTaskId = uniq(env.scheduled)[1];
      const researchResult = await executeResearchRun(buildResearchDeps(db), researchTaskId);
      expect(researchResult.bundleId).toBeTruthy();
      await driveRun(env.deps, 'p1', runId);

      state = projectState(env.deps, runId);
      expect(state.nodeOutcomes[RESEARCH_VALIDATE]?.value).toBe('valid');
      expect(state.artifacts.researchBundle?.artifactId).toBe(researchResult.bundleId);
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

      await executeBlueprintAndDriveToGate(db, env, runId);
      state = projectState(env.deps, runId);
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      const blueprintId = state.artifacts.storyBlueprint?.artifactId;
      expect(blueprintId).toBeTruthy();

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'gate',
          runId,
          nodeId: BLUEPRINT_USER_GATE,
          outcome: 'accept',
          idempotencyKey: 'accept-deep-1',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBe('completed');
      expect(db.getStoryBlueprintRepository().getById('p1', blueprintId!)?.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('9. D-B7-13/BLK-1：deep 调研全链 + 排除某笔记的其中一个来源 → 整条笔记（含未被排除来源的正文）不进 prompt，其余笔记不受影响', async () => {
    const db = makeDb('一个晚清历史背景的侦探故事，注重史实细节');
    try {
      const env = buildRunnerEnv(db);
      const { run } = createProjectRun(env.deps, {
        projectId: 'p1',
        idempotencyKey: `blueprint-e2e-exclusion-${idCounter}`,
      });
      const runId = run.workflowRunId;
      await driveRun(env.deps, 'p1', runId);
      await executeSpecExtract(buildSpecDeps(db), uniq(env.scheduled)[0]);
      await driveRun(env.deps, 'p1', runId);

      const researchTaskId = uniq(env.scheduled)[1];
      const researchResult = await executeResearchRun(buildResearchDeps(db), researchTaskId);
      await driveRun(env.deps, 'p1', runId);

      // 真实落库的 bundle：两个问题各自的 factNote 都聚合了 2 个来源的正文（fake 搜索
      // 每问题返回 2 条来源，deep 深度 maxFetch=4 全部可抓取）。只排除第一条笔记的
      // 其中一个来源——这是"部分来源被排除"的真实路径（BLK-1 之前唯一没被端到端
      // 执行过的分支），断言整条笔记（含另一个未被排除来源的正文）都不进 prompt，
      // 而完全未涉及排除来源的第二条笔记应原样出现。
      const bundle = db.getResearchBundleRepository().getById('p1', researchResult.bundleId!)!;
      expect(bundle.factNotes.length).toBeGreaterThanOrEqual(2);
      const excludedNote = bundle.factNotes[0];
      const survivingNote = bundle.factNotes[1];
      expect(excludedNote.sourceUrls.length).toBeGreaterThanOrEqual(2);
      const excludedUrl = excludedNote.sourceUrls[0];
      const survivingUrlInExcludedNote = excludedNote.sourceUrls[1];
      db.getResearchSourceExclusionRepository().setExclusion('p1', excludedUrl, true);

      const capturedPrompts: string[] = [];
      await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()], capturedPrompts);

      expect(capturedPrompts).toHaveLength(1);
      const prompt = capturedPrompts[0];
      // 核心断言 1：被排除的 URL 本身不出现
      expect(prompt).not.toContain(excludedUrl);
      // 核心断言 2（BLK-1）：整条笔记的正文标记完全不出现——即使其中一部分内容来自
      // 未被排除的来源（survivingUrlInExcludedNote）。这才证明"任一来源被排除即
      // 整条剔除"真正生效，而不是只裁剪掉那一个 URL 却把聚合正文原样留下。
      // （逐标记比对而非整段 excludedNote.text 比对：prompt 是 JSON.stringify 后的
      // 字符串，其中的换行会被转义成字面 `\n`，与 bundle 里的真实换行字符不是同一
      // 字节序列，整段比对在 not.toContain 方向会永远"误判通过"，测不出真实缺陷。）
      expect(prompt).not.toContain(`CONTENT-FOR[${excludedUrl}]`);
      expect(prompt).not.toContain(`CONTENT-FOR[${survivingUrlInExcludedNote}]`);
      // 核心断言 3：完全未涉及排除来源的另一条笔记应原样进入 prompt（证明这是真实的
      // "部分排除"而非误伤全部）。不直接比较 survivingNote.text 整段——prompt 是
      // JSON.stringify 后的字符串，其中的换行会被转义成字面 `\n`，与 bundle 里的真实
      // 换行字符不是同一字节序列；逐来源比对标记内容才是可靠断言。
      for (const url of survivingNote.sourceUrls) {
        expect(prompt).toContain(url);
        expect(prompt).toContain(`CONTENT-FOR[${url}]`);
      }
      // bundle 行本身未被改写（artifact 不可变，D-B5-2）——排除只影响 prompt 可见内容
      const bundleAfter = db.getResearchBundleRepository().getById('p1', researchResult.bundleId!)!;
      expect(bundleAfter).toEqual(bundle);
    } finally {
      db.close();
    }
  });

  it('8. 崩溃重启恢复：BLUEPRINT_GENERATE 任务 PENDING 时换全新 deps 实例，driveRun 幂等重新调度', async () => {
    const db = makeDb('一个纯幻想的客栈经营故事');
    try {
      const env1 = buildRunnerEnv(db);
      const runId = await driveToBlueprintTaskNone(db, env1);
      expect(env1.scheduled.length).toBeGreaterThanOrEqual(2);
      const state1 = projectState(env1.deps, runId);
      expect(state1.nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

      // "崩溃"：蓝图任务尚未执行。重启 = 全新 env（新 registry/runners/deps 实例，同一 DB）
      const env2 = buildRunnerEnv(db);
      await driveRun(env2.deps, 'p1', runId); // 恢复驱动：PENDING 任务幂等重调度
      expect(env2.scheduled.length).toBeGreaterThanOrEqual(1);

      const taskIds = uniq([...env1.scheduled, ...env2.scheduled]);
      const blueprintTaskId = taskIds[taskIds.length - 1];
      const result = await executeBlueprintGenerate(
        buildBlueprintDeps(db, [blueprintJson()]),
        blueprintTaskId,
      );
      expect(result.blueprintId).toBeTruthy();
      await driveRun(env2.deps, 'p1', runId);

      const state2 = projectState(env2.deps, runId);
      expect(state2.nodeStatuses[BLUEPRINT_GENERATE]).toBe('succeeded');
      expect(state2.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
      expect(state2.terminalStatus).toBeNull();
    } finally {
      db.close();
    }
  });

  // 复查随行修复 note 4：设计 §6 承诺"失败三分支 + 最终事务 all-or-nothing"单测但未
  // 交付，两路复查都提到。补齐：invokeModel 抛错 / result.errorCode / 解析失败三条，
  // 以及最终事务抛错后不留孤儿蓝图行。
  describe('执行链路失败分支（复查随行修复 note 4）', () => {
    it('10. invokeModel 抛错（网络/协议异常）→ invocation=PROVIDER_CONNECTION_FAILED，task=TASK_EXECUTION_FAILED，不留孤儿蓝图行', async () => {
      const db = makeDb('一个纯幻想的客栈经营故事');
      try {
        const env = buildRunnerEnv(db);
        const runId = await driveToBlueprintTaskNone(db, env);
        void runId;
        const taskIds = uniq(env.scheduled);
        const blueprintTaskId = taskIds[taskIds.length - 1];

        const deps = buildBlueprintDeps(db, []);
        const brokenDeps: BlueprintGenerateExecutionDeps = {
          ...deps,
          invokeModel: fakeInvokeModelThrows('ECONNRESET：模拟网络异常'),
        };
        const result = await executeBlueprintGenerate(brokenDeps, blueprintTaskId);

        expect(result.blueprintId).toBeNull();
        expect(result.task.status).toBe('FAILED');
        expect(result.task.errorCode).toBe('TASK_EXECUTION_FAILED');
        expect(result.invocation?.status).toBe('FAILED');
        expect(result.invocation?.errorCode).toBe('PROVIDER_CONNECTION_FAILED');
        expect(db.getStoryBlueprintRepository().listByProject('p1')).toHaveLength(0);
      } finally {
        db.close();
      }
    });

    it('11. result.errorCode（provider 显式错误）→ invocation 携带该 errorCode，task=TASK_EXECUTION_FAILED，不留孤儿蓝图行', async () => {
      const db = makeDb('一个纯幻想的客栈经营故事');
      try {
        const env = buildRunnerEnv(db);
        const runId = await driveToBlueprintTaskNone(db, env);
        void runId;
        const taskIds = uniq(env.scheduled);
        const blueprintTaskId = taskIds[taskIds.length - 1];

        const deps = buildBlueprintDeps(db, []);
        const brokenDeps: BlueprintGenerateExecutionDeps = {
          ...deps,
          invokeModel: fakeInvokeModelWithErrorCode('PROVIDER_RATE_LIMITED', '模拟限流'),
        };
        const result = await executeBlueprintGenerate(brokenDeps, blueprintTaskId);

        expect(result.blueprintId).toBeNull();
        expect(result.task.status).toBe('FAILED');
        expect(result.task.errorCode).toBe('TASK_EXECUTION_FAILED');
        expect(result.invocation?.status).toBe('FAILED');
        expect(result.invocation?.errorCode).toBe('PROVIDER_RATE_LIMITED');
        expect(db.getStoryBlueprintRepository().listByProject('p1')).toHaveLength(0);
      } finally {
        db.close();
      }
    });

    it('12. 模型输出解析失败（非法 JSON）→ invocation=MODEL_RESPONSE_INVALID，task=TASK_EXECUTION_FAILED，不留孤儿蓝图行', async () => {
      const db = makeDb('一个纯幻想的客栈经营故事');
      try {
        const env = buildRunnerEnv(db);
        const runId = await driveToBlueprintTaskNone(db, env);
        void runId;
        const taskIds = uniq(env.scheduled);
        const blueprintTaskId = taskIds[taskIds.length - 1];

        const result = await executeBlueprintGenerate(
          buildBlueprintDeps(db, ['这不是合法 JSON {{{']),
          blueprintTaskId,
        );

        expect(result.blueprintId).toBeNull();
        expect(result.task.status).toBe('FAILED');
        expect(result.task.errorCode).toBe('TASK_EXECUTION_FAILED');
        expect(result.invocation?.status).toBe('FAILED');
        expect(result.invocation?.errorCode).toBe('MODEL_RESPONSE_INVALID');
        expect(db.getStoryBlueprintRepository().listByProject('p1')).toHaveLength(0);
      } finally {
        db.close();
      }
    });

    it('13. 最终事务抛错（all-or-nothing）→ 已在事务内真实执行的 blueprintRepo.save 被回滚，不留孤儿蓝图行，invocation/task 走补偿标记失败', async () => {
      const db = makeDb('一个纯幻想的客栈经营故事');
      try {
        const env = buildRunnerEnv(db);
        const runId = await driveToBlueprintTaskNone(db, env);
        void runId;
        const taskIds = uniq(env.scheduled);
        const blueprintTaskId = taskIds[taskIds.length - 1];

        // 注入点选在 nodeExecutionResultStore.saveOrVerifySame——它在最终事务内紧接在
        // blueprintRepo.save 之后执行（见 executeBlueprintGenerate 源码）。让
        // blueprintRepo.save 真实执行（真的 INSERT 一行），再让同一事务内的下一步
        // 抛错，才能证明"事务回滚撤销了已经真实写入的蓝图行"，而不是"压根没写过"
        // （与 5b 用例证明 D-B7-1 原子性同一模式）。
        const realResultStore = db.getNodeExecutionResultStore();
        const brokenResultStore = Object.create(realResultStore) as typeof realResultStore;
        (brokenResultStore as { saveOrVerifySame: unknown }).saveOrVerifySame = () => {
          throw new Error('注入失败：saveOrVerifySame（最终事务 all-or-nothing 回归测试）');
        };
        const deps = buildBlueprintDeps(db, [blueprintJson()]);
        const brokenDeps: BlueprintGenerateExecutionDeps = {
          ...deps,
          nodeExecutionResultStore: brokenResultStore,
        };

        await expect(executeBlueprintGenerate(brokenDeps, blueprintTaskId)).rejects.toThrow();

        // 核心断言：blueprintRepo.save 在事务内已经真实 INSERT 过一行（否则下面这条
        // 断言即使实现不满足"同事务"也会平凡地通过），但整事务回滚后不留孤儿行。
        expect(db.getStoryBlueprintRepository().listByProject('p1')).toHaveLength(0);

        // 补偿：invocation/task 被标记失败（compensateFinalization，TASK_EXECUTION_FAILED）
        const task = new TaskRepositoryAdapter(db).getById(blueprintTaskId)!;
        expect(task.status).toBe('FAILED');
        expect(task.errorCode).toBe('TASK_EXECUTION_FAILED');
      } finally {
        db.close();
      }
    });
  });

  // D-B7-14（架构师明确授权的图契约追加）：skip_research 与 use_current_research
  // 此前在 BLUEPRINT_GENERATE 侧完全不可区分（BLK-2）——两条对照 E2E 证明修复后
  // 用户"跳过调研"的决定真正影响 prompt。
  describe('D-B7-14：research escalation 决策真正影响 prompt', () => {
    it('14a. skip_research → 蓝图 prompt 不含该 bundle 的任何事实笔记内容，且标注用户已跳过', async () => {
      const db = makeDb('一个晚清历史背景的侦探故事，注重史实细节');
      try {
        const env = buildRunnerEnv(db);
        const { runId, bundleId } = await driveToResearchEscalationWithRealBundle(db, env);

        const bundle = db.getResearchBundleRepository().getById('p1', bundleId)!;
        expect(bundle.factNotes.length).toBeGreaterThan(0);
        expect(bundle.factNotes[0].text).toContain('ESCALATION-BUNDLE-CONTENT');

        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'escalation',
            runId,
            nodeId: RESEARCH_ESCALATION,
            outcome: 'skip_research',
            idempotencyKey: 'esc-skip-14a',
          } as never,
        );
        await driveRun(env.deps, 'p1', runId);
        expect(projectState(env.deps, runId).nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

        const capturedPrompts: string[] = [];
        await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()], capturedPrompts);
        expect(capturedPrompts).toHaveLength(1);
        const prompt = capturedPrompts[0];

        // 核心断言：用户跳过调研后，bundle 的事实笔记内容完全不出现在 prompt 里
        expect(prompt).not.toContain('ESCALATION-BUNDLE-CONTENT');
        expect(prompt).not.toContain(bundleId);
        // 且措辞如实——标注"用户已跳过"，不是"根本没做调研"（reason 字段可区分）
        expect(prompt).toContain('"reason":"skipped_by_user"');
        expect(prompt).toContain('"conducted":true');
      } finally {
        db.close();
      }
    });

    it('14b. use_current_research → 蓝图 prompt 含该 bundle 的事实笔记内容（对照组）', async () => {
      const db = makeDb('一个晚清历史背景的侦探故事，注重史实细节');
      try {
        const env = buildRunnerEnv(db);
        const { runId, bundleId } = await driveToResearchEscalationWithRealBundle(db, env);

        const bundle = db.getResearchBundleRepository().getById('p1', bundleId)!;
        expect(bundle.factNotes.length).toBeGreaterThan(0);
        expect(bundle.factNotes[0].text).toContain('ESCALATION-BUNDLE-CONTENT');

        applyHumanDecision(
          env.deps as GraphRunDeps,
          {
            kind: 'escalation',
            runId,
            nodeId: RESEARCH_ESCALATION,
            outcome: 'use_current_research',
            idempotencyKey: 'esc-use-14b',
          } as never,
        );
        await driveRun(env.deps, 'p1', runId);
        expect(projectState(env.deps, runId).nodeStatuses[BLUEPRINT_GENERATE]).toBe('active');

        const capturedPrompts: string[] = [];
        await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()], capturedPrompts);
        expect(capturedPrompts).toHaveLength(1);
        const prompt = capturedPrompts[0];

        // 核心断言（对照组）：用户选择沿用当前调研时，bundle 的事实笔记内容原样进入 prompt
        expect(prompt).toContain('ESCALATION-BUNDLE-CONTENT');
        expect(prompt).toContain('"conducted":true');
        expect(prompt).toContain('"availableAfterExclusion":true');
      } finally {
        db.close();
      }
    });
  });
});
