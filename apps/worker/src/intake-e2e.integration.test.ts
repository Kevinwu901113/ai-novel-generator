/**
 * GE-3 / B3 端到端集成测试（真实 SQLite + 真实 executor + 生产 resolver）。
 *
 * 覆盖 roadmap GE-3 原退出条件的后端部分：
 * 1. 模糊想法 → IDEA_CAPTURE 播种 → SPEC_EXTRACT（真实任务引擎，fake 模型脚本）
 *    → ask_more → ASK_QUESTION → COLLECT_ANSWER（answer receipt 契约）
 *    → SPEC_EXTRACT 回环 → spec_complete → CreationSpec v2 → 停在 RESEARCH_DECISION
 *    （GE-4 executor 未注册 → TD-020 跳过保持，run 不死）；
 * 2. finish 提前结束路径；
 * 3. 崩溃重启恢复：SPEC_EXTRACT 任务 PENDING 时"重启"（全新 deps 实例），
 *    恢复驱动后照常完成；
 * 4. CreationSpec 用户编辑 → 失效级联（propagateCreationSpecInvalidation）。
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
  propagateCreationSpecInvalidation,
  type GraphRunDeps,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type SecretStore,
  type ProviderProfileRepository,
} from '@ai-novel/application';
import {
  executeSpecExtract,
  sha256Hex,
  type SpecExtractExecutionDeps,
} from '@ai-novel/task-engine';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  RESEARCH_DECISION,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { registerIntakeExecutors } from './intake-executors.js';
import { buildGrillSessionDeps } from './grill-handlers.js';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';

const NOW = '2026-08-07T00:00:00.000Z';

let tempDir: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function makeDb(): ProjectDatabase {
  const db = new ProjectDatabase(join(tempDir, `project-${++idCounter}.sqlite`));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '测试项目',
    initialIdea: '一个在赛博都市里修仙的快递员的故事',
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

const SECTIONS = {
  premise: '赛博都市修仙快递员',
  genre: ['sci-fi'],
  tone: ['dark'],
  targetAudience: 'adults',
  narrativePov: 'FIRST',
  tense: 'PRESENT',
  protagonist: { characterKey: 'protag', name: '快递员阿真' },
};

function askMoreJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    decision: 'ask_more',
    sections: SECTIONS,
    nextQuestions: [
      { topic: '篇幅', text: '预期篇幅是短篇还是长篇连载？', rationale: '决定章节结构' },
    ],
  });
}

function specCompleteJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    decision: 'spec_complete',
    sections: SECTIONS,
    nextQuestions: [],
  });
}

/** 真实 executor 环境：registry/runners（intake 三节点）+ 生产 resolver + 任务收集 */
function buildRunnerEnv(db: ProjectDatabase) {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  registerIntakeExecutors(registry, runners, {
    getProjectDb: () => db,
    idGenerator,
    clock,
  });
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
    runnerId: 'e2e-runner',
    scheduleTask: (taskId) => {
      scheduled.push(taskId);
    },
    onExecutorMissing: (nodeId, reason) => {
      skips.push(`${nodeId}:${reason}`);
    },
  };
  return { deps, scheduled, skips };
}

/** SPEC_EXTRACT 任务引擎 deps：真实 DB 仓库 + 脚本化 fake 模型 */
function buildSpecDeps(db: ProjectDatabase, script: string[]): SpecExtractExecutionDeps {
  const secretStore: SecretStore = {
    hasSecret: async () => true,
    setSecret: async () => {},
    getSecret: async () => 'test-key',
    deleteSecret: async () => {},
  };
  const profile = {
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
  const providerRepo = {
    getById: () => profile,
    list: () => [profile],
    getDefault: () => profile,
    getRoute: () => null,
    create: () => {},
    update: () => {},
    delete: () => {},
    setDefault: () => {},
    setRoute: () => {},
    deleteRoute: () => {},
    updateTestResult: () => {},
  } as unknown as ProviderProfileRepository;
  const grillDeps = buildGrillSessionDeps(db, {
    getProjectDb: () => db,
    idGenerator,
    clock,
  });
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore,
    providerRepo,
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

describe('GE-3 Intake E2E（真实 SQLite + 真实 executor + 生产 resolver）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'intake-e2e-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. 主路径：想法→抽取→追问→回答→回环→spec_complete→停在 RESEARCH_DECISION', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const specDeps = buildSpecDeps(db, [askMoreJson(), specCompleteJson()]);

      const { run } = createProjectRun(env.deps, { projectId: 'p1', idempotencyKey: 'e2e-1' });
      const runId = run.workflowRunId;

      // 第一轮驱动：IDEA_CAPTURE 同步结算（idea=真实 session 行），SPEC_EXTRACT 建任务
      await driveRun(env.deps, 'p1', runId);
      let state = projectState(env.deps, runId);
      expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
      const sessionId = state.artifacts.idea?.artifactId;
      expect(sessionId).toBeTruthy();
      // idea artifact 指向真实 grill session 行
      const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
      expect(grillDeps.sessionRepo.getById(sessionId!)?.goal).toContain('修仙');
      expect(uniq(env.scheduled)).toHaveLength(1);

      // 执行 SPEC_EXTRACT 任务（脚本：ask_more + 1 问题）→ 驱动结算
      await executeSpecExtract(specDeps, uniq(env.scheduled)[0]);
      await driveRun(env.deps, 'p1', runId);
      state = projectState(env.deps, runId);
      // ask_more 走 clarification 循环边 → resetLoopBody 把 SPEC_EXTRACT 重置回 pending
      // 等待下一轮回环（图语义），ASK_QUESTION 在重置后完成故为 succeeded
      expect(state.nodeStatuses[SPEC_EXTRACT]).toBe('pending');
      expect(state.nodeStatuses[ASK_QUESTION]).toBe('succeeded');
      // COLLECT_ANSWER 由 parkHumanNodes 挂起
      expect(state.pendingHumanDecision?.nodeId).toBe(COLLECT_ANSWER);
      // CreationSpec v1 已持久化且为 current
      const specV1 = state.artifacts.creationSpec?.artifactId;
      expect(specV1).toBeTruthy();
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe(specV1);
      // 问题已被 markAsked
      const asked = grillDeps.questionRepo
        .listBySession(sessionId!)
        .filter((q) => q.status === 'ASKED');
      expect(asked).toHaveLength(1);

      // 回答（answer receipt 原子契约：先落 grill_answers 再推进 Graph）
      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'intake_answer',
          runId,
          nodeId: COLLECT_ANSWER,
          sessionId: sessionId!,
          questionId: asked[0].id,
          text: '长篇连载，每章三千字',
          idempotencyKey: 'e2e-1-answer',
        } as never,
      );
      expect(grillDeps.answerRepo.listCurrentBySession(sessionId!)).toHaveLength(1);

      // 回环驱动：SPEC_EXTRACT activation 2 → 新任务 → spec_complete → RESEARCH_DECISION
      await driveRun(env.deps, 'p1', runId);
      expect(uniq(env.scheduled)).toHaveLength(2);
      await executeSpecExtract(specDeps, uniq(env.scheduled)[1]);
      await driveRun(env.deps, 'p1', runId);

      state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      const specV2 = state.artifacts.creationSpec?.artifactId;
      expect(specV2).toBeTruthy();
      expect(specV2).not.toBe(specV1);
      expect(db.getCreationContractVersionRepository().getById('p1', specV2!)?.version).toBe(2);
      // GE-4 executor 未注册：RESEARCH_DECISION 保持 active（TD-020 跳过而非杀 run）
      expect(state.nodeStatuses[RESEARCH_DECISION]).toBe('active');
      expect(env.skips).toContain(`${RESEARCH_DECISION}:unregistered`);
    } finally {
      db.close();
    }
  });

  it('2. finish 提前结束：跳过追问直接用当前创作要求', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const specDeps = buildSpecDeps(db, [askMoreJson()]);
      const { run } = createProjectRun(env.deps, { projectId: 'p1', idempotencyKey: 'e2e-2' });
      const runId = run.workflowRunId;
      await driveRun(env.deps, 'p1', runId);
      await executeSpecExtract(specDeps, env.scheduled[0]);
      await driveRun(env.deps, 'p1', runId);
      const specV1 = projectState(env.deps, runId).artifacts.creationSpec?.artifactId;

      applyHumanDecision(
        env.deps as GraphRunDeps,
        {
          kind: 'intake_finish',
          runId,
          nodeId: COLLECT_ANSWER,
          idempotencyKey: 'e2e-2-finish',
        } as never,
      );
      await driveRun(env.deps, 'p1', runId);

      const state = projectState(env.deps, runId);
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[RESEARCH_DECISION]).toBe('active');
      // finish 不再回环抽取：creationSpec 保持 v1
      expect(state.artifacts.creationSpec?.artifactId).toBe(specV1);
    } finally {
      db.close();
    }
  });

  it('3. 崩溃重启恢复：SPEC_EXTRACT 任务 PENDING 时重启，恢复驱动后照常完成', async () => {
    const db = makeDb();
    try {
      const env1 = buildRunnerEnv(db);
      const { run } = createProjectRun(env1.deps, { projectId: 'p1', idempotencyKey: 'e2e-3' });
      const runId = run.workflowRunId;
      await driveRun(env1.deps, 'p1', runId);
      expect(uniq(env1.scheduled)).toHaveLength(1);
      // “崩溃”：任务尚未执行。重启 = 全新 env（新 registry/runners/deps 实例，同一 DB）
      const env2 = buildRunnerEnv(db);
      await driveRun(env2.deps, 'p1', runId); // 恢复驱动：PENDING 任务幂等重调度
      expect(env2.scheduled.length).toBeGreaterThanOrEqual(1);
      const specDeps = buildSpecDeps(db, [specCompleteJson()]);
      await executeSpecExtract(specDeps, uniq(env2.scheduled)[0] ?? uniq(env1.scheduled)[0]);
      await driveRun(env2.deps, 'p1', runId);
      const state = projectState(env2.deps, runId);
      expect(state.nodeStatuses[SPEC_EXTRACT]).toBe('succeeded');
      expect(state.artifacts.creationSpec?.artifactId).toBeTruthy();
      expect(state.terminalStatus).toBeNull();
    } finally {
      db.close();
    }
  });

  it('4. 用户编辑创作要求 → 失效级联传播到非终态 run', async () => {
    const db = makeDb();
    try {
      const env = buildRunnerEnv(db);
      const specDeps = buildSpecDeps(db, [specCompleteJson()]);
      const { run } = createProjectRun(env.deps, { projectId: 'p1', idempotencyKey: 'e2e-4' });
      const runId = run.workflowRunId;
      await driveRun(env.deps, 'p1', runId);
      await executeSpecExtract(specDeps, env.scheduled[0]);
      await driveRun(env.deps, 'p1', runId);
      expect(projectState(env.deps, runId).artifacts.creationSpec?.artifactId).toBeTruthy();

      const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
      const results = propagateCreationSpecInvalidation(
        { grillDeps, graphDeps: env.deps },
        { projectId: 'p1', creationSpecVersionId: 'user-edited-version' },
      );
      const entry = results.find((r) => r.runId === runId);
      expect(entry).toBeTruthy();
      // 失效后 run 内 creationSpec 指向新版本引用
      expect(projectState(env.deps, runId).artifacts.creationSpec?.artifactId).toBe(
        'user-edited-version',
      );
    } finally {
      db.close();
    }
  });
});
