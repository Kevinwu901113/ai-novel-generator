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
import {
  BLUEPRINT_ESCALATION,
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  PROJECT_READY,
  RESEARCH_DECISION,
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
    questions: [{ text: '晚清邮政系统如何运作' }],
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

function fakeInvokeModel(script: string[]) {
  return async () => ({
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
      fetch: async (input: { url: string }): Promise<FetchedDocument> => ({
        url: input.url,
        title: '来源页面',
        extractedText: '与问题相关的事实内容。',
        fetchedAt: NOW,
      }),
    },
  };
}

/** BLUEPRINT_GENERATE 任务 deps（D-B7-5 版本号取 MAX+1 依赖 blueprintRepo） */
function buildBlueprintDeps(db: ProjectDatabase, script: string[]): BlueprintGenerateExecutionDeps {
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    invokeModel: fakeInvokeModel(script),
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
    sessionRepo: grillDeps.sessionRepo,
    specVersionRepo: db.getCreationContractVersionRepository(),
    researchRepo: db.getResearchBundleRepository(),
    blueprintRepo: db.getStoryBlueprintRepository(),
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

/** 在 BLUEPRINT_GENERATE 任务已建的前提下执行它并驱动到 BLUEPRINT_USER_GATE */
async function executeBlueprintAndDriveToGate(
  db: ProjectDatabase,
  env: ReturnType<typeof buildRunnerEnv>,
  runId: string,
  script: string[] = [blueprintJson()],
): Promise<void> {
  const taskIds = uniq(env.scheduled);
  const blueprintTaskId = taskIds[taskIds.length - 1];
  const result = await executeBlueprintGenerate(buildBlueprintDeps(db, script), blueprintTaskId);
  expect(result.blueprintId).toBeTruthy();
  await driveRun(env.deps, 'p1', runId);
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
      await executeBlueprintAndDriveToGate(db, env, runId);

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
        await executeBlueprintAndDriveToGate(db, env, runId, [blueprintJson()]);
        state = projectState(env.deps, runId);
      }
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_ESCALATION);
      expect(state.attemptBudget.blueprintRewrite ?? 0).toBeGreaterThanOrEqual(3);

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
      // 这条用例在未实现 D-B7-1 原子 accept 的代码上会失败（accept 会绕开 markAccepted
      // 直接推进 transition，run 被打成 completed 而 accepted 仍是 0）——先红后绿，
      // 详见本文件顶部报告 / 任务交付说明里记录的红绿两次运行。
      const realTx = db.getGraphRunTransaction();
      const brokenTx: GraphRunTransactionPort = {
        runInTransaction: (fn) =>
          realTx.runInTransaction((repos) =>
            fn({
              ...repos,
              storyBlueprintRepo: {
                ...repos.storyBlueprintRepo,
                markAccepted: () => {
                  throw new Error('注入失败：markAccepted（D-B7-1 原子性回归测试）');
                },
              },
            }),
          ),
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
});
