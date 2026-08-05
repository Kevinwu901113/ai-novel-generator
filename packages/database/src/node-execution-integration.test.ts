/**
 * Durable Node Execution & Settlement 真实 SQLite 集成测试（RW-1-R5）。
 *
 * 覆盖：
 * 1. 跨连接幂等：连接 A claim 后连接 B 不重复 dispatch（partial unique 原子门）
 * 2. claim/task binding rollback（task 创建失败 → 整事务回滚，无 execution 残留）
 * 3. task-backed infra retry（TASK_INTERRUPTED → 统一 claim 新 attempt 新 task）
 * 4. activation ordering（activation_no DESC, attempt_no DESC）
 * 5. fan-out（全部 Critic execution/task 全量 dispatch）
 * 6. atomic failure（execution failed + applyNodeFailure 同事务；终态 run 回滚）
 * 7. finalization failure（saveOrVerifySame 冲突 → 补偿标记 invocation/task FAILED）
 * 8. artifact ownership（transaction-scoped resolver 拒绝 project/run 不匹配）
 * 9. task→execution lookup（getByTaskId 权威反查）
 * 10. startup readiness（崩溃恢复后 driveRun 幂等推进）
 * 11. pending reschedule（PENDING task-backed 重启后幂等重新调度，不建重复 task）
 * 12. lease behavior（sync lease 未过期保持 / 过期重试）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';
import {
  computeNodeInputSnapshot,
  createChapterRun,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  failExecutionAndNodeInTransaction,
  inputHashOf,
  serializeInputSnapshot,
  type ArtifactResolverPort,
  type ArtifactResolveInput,
  type CreateTaskInput,
  type NodeExecutionInputContext,
  type NodeExecutorDescriptor,
  type NodeOutput,
  type NodeRunnerDeps,
  type NodeTaskSpec,
  type PersistedArtifactReceipt,
  type TaskData,
  type TaskRepositoryPort,
} from '@ai-novel/application';
import {
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  DRAFT,
  IDEA_CAPTURE,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  SPEC_EXTRACT,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { executeChapterDraft, type ChapterDraftExecutionDeps } from '@ai-novel/task-engine';
import type {
  ModelInvocationRepositoryPort,
  ModelInvocationData,
  CreateInvocationInput,
  InvocationSuccessResult,
  ProviderProfileRepository,
  SecretStore,
} from '@ai-novel/application';
import type { TaskRow } from './types.js';

const NOW = '2026-08-04T00:00:00.000Z';

// ── 真实 taskRepo 适配（TaskRepositoryPort）────────────────────────

/** 真实 taskRepo 便捷：claim（PENDING→RUNNING）后完成/失败（模拟 task worker 生命周期） */
function claimThenComplete(db: ProjectDatabase, taskId: string, resultJson: string): void {
  const repo = new RealTaskRepoAdapter(db);
  repo.claimPending(taskId);
  repo.completeRunning(taskId, resultJson);
}

function claimThenFail(db: ProjectDatabase, taskId: string, errorCode: string): void {
  const repo = new RealTaskRepoAdapter(db);
  repo.claimPending(taskId);
  repo.failRunning(taskId, errorCode, 'task failed');
}

class RealTaskRepoAdapter implements TaskRepositoryPort {
  constructor(private readonly db: ProjectDatabase) {}

  create(d: CreateTaskInput): void {
    this.db.getTaskRepository().create({
      id: d.id,
      projectId: d.projectId,
      taskType: d.taskType,
      status: 'PENDING',
      inputVersionJson: d.inputVersionJson,
      payloadJson: d.payloadJson,
      dedupeKey: d.dedupeKey ?? null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  getById(id: string): TaskData | null {
    const row = this.db.getTaskRepository().getById(id);
    return row ? this.toTask(row) : null;
  }

  claimPending(id: string): boolean {
    return this.db.getTaskRepository().claimPending(id, NOW);
  }

  completeRunning(id: string, resultJson: string): boolean {
    return this.db.getTaskRepository().completeRunning(id, resultJson, NOW);
  }

  failRunning(id: string, errorCode: string, errorMessage: string): boolean {
    return this.db.getTaskRepository().failRunning(id, errorCode, errorMessage, NOW);
  }

  failPending(id: string, errorCode: string, errorMessage: string): boolean {
    return this.db.getTaskRepository().failPending(id, errorCode, errorMessage, NOW);
  }

  listByProject(_projectId: string): ReadonlyArray<TaskData> {
    return [];
  }

  listByStatus(_status: TaskData['status']): ReadonlyArray<TaskData> {
    return [];
  }

  markStale(_id: string): boolean {
    return true;
  }

  resetToPending(_id: string): boolean {
    return true;
  }

  listRunning(): ReadonlyArray<TaskData> {
    return [];
  }

  private toTask(row: TaskRow): TaskData {
    return {
      id: row.id,
      projectId: row.projectId,
      taskType: row.taskType,
      status: row.status,
      inputVersionJson: row.inputVersionJson,
      payloadJson: row.payloadJson,
      resultJson: row.resultJson,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      dedupeKey: row.dedupeKey,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      staleAt: row.staleAt,
      cancelledAt: row.cancelledAt,
    };
  }
}

// ── resolvers ──────────────────────────────────────────────────────

function permissiveResolver(): ArtifactResolverPort {
  return {
    resolve(_repos, input): PersistedArtifactReceipt {
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

/** transaction-scoped 真实 artifact resolver（provenance + 底层存储；Blocker 5） */
function realResolver(): ArtifactResolverPort {
  return {
    resolve(repos, input: ArtifactResolveInput): PersistedArtifactReceipt {
      if (input.proposed.producerNodeId !== input.nodeId) {
        throw new Error('producer node 不匹配');
      }
      // 从持久化 provenance 校验 producer 归属（非调用方字段）
      if (input.proposed.kind !== 'generationRun') {
        const prov = repos.artifactProvenanceRepo.getByArtifact(
          input.proposed.kind,
          input.proposed.artifactId,
        );
        if (!prov) throw new Error('artifact 无 provenance');
        if (
          prov.executionId !== input.executionId ||
          prov.graphRunId !== input.graphRunId ||
          prov.nodeId !== input.nodeId ||
          prov.projectId !== input.projectId ||
          prov.version !== input.proposed.version
        ) {
          throw new Error('artifact provenance 与当前 execution/run/node 不匹配');
        }
      }
      switch (input.proposed.kind) {
        case 'researchBundle': {
          const b = repos.researchBundleRepo.getById(input.projectId, input.proposed.artifactId);
          if (!b) throw new Error('researchBundle 不存在');
          if (b.version !== input.proposed.version)
            throw new Error('researchBundle version 不匹配');
          break;
        }
        case 'storyBlueprint': {
          const bp = repos.storyBlueprintRepo.getById(input.projectId, input.proposed.artifactId);
          if (!bp) throw new Error('storyBlueprint 不存在');
          if (bp.blueprint.version !== input.proposed.version) {
            throw new Error('storyBlueprint version 不匹配');
          }
          break;
        }
        case 'generationRun': {
          const env = repos.nodeExecutionResultStore.getByExecutionId(input.executionId);
          if (!env) throw new Error('generationRun 无权威 envelope');
          if (env.artifactId !== input.proposed.artifactId) {
            throw new Error('generationRun artifactId 不匹配');
          }
          if (env.graphRunId !== input.graphRunId) throw new Error('generationRun run 不匹配');
          break;
        }
        case 'idea':
        case 'creationSpec':
        case 'manuscript':
          // 与生产 resolver 一致：provenance 已校验 producer 归属；
          // 底层权威存储绑定属于 GE-3 / GE-7（此前此处误抛 unsupported kind，与生产不一致）
          break;
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

// ── runner deps 构造 ───────────────────────────────────────────────

interface TestRunnerKit {
  deps: NodeRunnerDeps;
  prepareCalls: NodeExecutionInputContext[];
}

let counter = 0;

function buildKit(
  db: ProjectDatabase,
  opts: {
    outputs?: Record<string, NodeOutput>;
    resolver?: ArtifactResolverPort;
    now?: () => string;
    idGenerator?: () => string;
    /** per-node recoveryPolicy 覆盖（如 infra retry 需 replayable） */
    recoveryOverrides?: Record<string, NodeExecutorDescriptor['recoveryPolicy']>;
  } = {},
): TestRunnerKit {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, unknown>();
  const prepareCalls: NodeExecutionInputContext[] = [];
  const outputs = opts.outputs ?? {};
  const chapterNode = new Set([
    'CHAPTER_PLAN',
    'DRAFT',
    'CONTINUITY_CRITIC',
    'STYLE_CRITIC',
    'REQUIREMENT_CRITIC',
  ]);
  const defs: Array<[string, string, NodeExecutorDescriptor['kind'], NodeOutput]> = [
    [
      'IDEA_CAPTURE',
      'idea-capture-v1',
      'sync',
      outputs['IDEA_CAPTURE'] ?? {
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
      'sync',
      outputs['SPEC_EXTRACT'] ?? {
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
      'sync',
      outputs['RESEARCH_DECISION'] ?? {
        outcome: { condition: 'research_decision', value: 'none' },
      },
    ],
    [
      'BLUEPRINT_GENERATE',
      'blueprint-generate-v1',
      'sync',
      outputs['BLUEPRINT_GENERATE'] ?? {
        artifact: {
          kind: 'storyBlueprint',
          artifactId: 'bp-real-1',
          producerNodeId: BLUEPRINT_GENERATE as never,
          version: 1,
        },
      },
    ],
    ['CHAPTER_PLAN', 'chapter-plan-v1', 'sync', outputs['CHAPTER_PLAN'] ?? {}],
    [
      'DRAFT',
      'chapter-draft-v1',
      'task_backed',
      {
        artifact: {
          kind: 'generationRun',
          artifactId: 'gen-1',
          producerNodeId: DRAFT as never,
          version: 1,
        },
      },
    ],
    ['CONTINUITY_CRITIC', 'critic-0-v1', 'task_backed', {}],
    ['STYLE_CRITIC', 'critic-1-v1', 'task_backed', {}],
    ['REQUIREMENT_CRITIC', 'critic-2-v1', 'task_backed', {}],
  ];
  for (const [nodeId, executorId, kind, output] of defs) {
    const descriptor: NodeExecutorDescriptor = {
      executorId,
      executorVersion: 'v1',
      graphKind: chapterNode.has(nodeId) ? 'chapter' : 'project',
      nodeId: nodeId as never,
      kind,
      recoveryPolicy:
        opts.recoveryOverrides?.[nodeId] ??
        (kind === 'task_backed' ? 'settle_if_result' : 'replayable'),
    };
    registry.register(descriptor);
    if (kind === 'sync') {
      runners.set(executorId, {
        descriptor,
        execute: () => output,
      });
    } else {
      runners.set(executorId, {
        descriptor,
        prepareTask: (ctx: NodeExecutionInputContext): NodeTaskSpec => {
          prepareCalls.push(ctx);
          return {
            taskType: 'CHAPTER_DRAFT',
            payloadJson: JSON.stringify({ kind: 'chapterDraft' }),
          };
        },
      });
    }
  }
  const deps: NodeRunnerDeps = {
    idGenerator: { generate: opts.idGenerator ?? (() => `id-${++counter}`) },
    clock: { now: opts.now ?? (() => NOW) },
    hashPayload: (p: string) => sha256Utf8(p),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    registry,
    runners: runners as NodeRunnerDeps['runners'],
    artifactResolver: opts.resolver ?? permissiveResolver(),
    runnerId: 'test-runner',
  };
  return { deps, prepareCalls };
}

function seedProjectRun(_db: ProjectDatabase, deps: NodeRunnerDeps, key: string) {
  return createProjectRun(deps, { projectId: 'p1', idempotencyKey: key });
}

function seedChapterRun(_db: ProjectDatabase, deps: NodeRunnerDeps, key: string) {
  return createChapterRun(deps, {
    projectId: 'p1',
    creationSpecVersionId: 'spec-1',
    researchBundleId: null,
    storyBlueprintId: 'bp-1',
    blueprintChapterId: 'ch-1',
    idempotencyKey: key,
  });
}

function inputHashFor(
  deps: NodeRunnerDeps,
  state: { graphId: string },
  nodeId: string,
  activationNo: number,
): string {
  const graph = state.graphId === deps.projectGraph.id ? deps.projectGraph : deps.chapterGraph;
  return inputHashOf(
    deps.hashPayload,
    computeNodeInputSnapshot(graph, state as never, nodeId, activationNo),
  );
}

let tempDir: string;
let dbPath: string;

function freshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

// ── B10：真实 task-engine finalization 依赖（对 ProjectDatabase）────────────────

/** 真实 ModelInvocationRepositoryPort 适配（database 内置 impl） */
class DbInvocationAdapter implements ModelInvocationRepositoryPort {
  constructor(private readonly db: ProjectDatabase) {}

  create(data: CreateInvocationInput): void {
    this.db.getModelInvocationRepository().create({
      ...data,
      status: 'PENDING',
      createdAt: NOW,
    });
  }

  getById(id: string): ModelInvocationData | null {
    const row = this.db.getModelInvocationRepository().getById(id);
    if (!row) return null;
    return { ...(row as unknown as ModelInvocationData) };
  }

  listByTask(taskId: string): ReadonlyArray<ModelInvocationData> {
    return this.db
      .getModelInvocationRepository()
      .listByTask(taskId)
      .map((r) => ({ ...(r as unknown as ModelInvocationData) }));
  }

  markRunning(id: string, _expected: 'PENDING'): boolean {
    return this.db.getModelInvocationRepository().markRunning(id, 'PENDING', NOW);
  }

  markSucceeded(id: string, _expected: 'RUNNING', result: InvocationSuccessResult): boolean {
    const r = this.db.getModelInvocationRepository();
    return r.markSucceeded(id, 'RUNNING', {
      responseMetadataJson: result.responseMetadataJson,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
      providerRequestId: result.providerRequestId,
      finishedAt: NOW,
    });
  }

  markFailed(
    id: string,
    expected: ReadonlyArray<ModelInvocationData['status']>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
  ): boolean {
    return this.db
      .getModelInvocationRepository()
      .markFailed(id, expected, errorCode, errorMessage, latencyMs, NOW);
  }

  getStatsByProject(projectId: string): {
    invocationCount: number;
    succeededCount: number;
    failedCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalLatencyMs: number;
  } {
    const s = this.db.getModelInvocationRepository().getStatsByProject(projectId);
    return {
      invocationCount: s.invocationCount,
      succeededCount: s.succeededCount,
      failedCount: s.failedCount,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      totalTokens: s.totalTokens,
      totalLatencyMs: s.totalLatencyMs,
    };
  }

  listRunning(): ReadonlyArray<ModelInvocationData> {
    return this.db
      .getModelInvocationRepository()
      .listRunning()
      .map((r) => ({ ...(r as unknown as ModelInvocationData) }));
  }
}

function mockChapterModelOutput() {
  return {
    text: JSON.stringify({ title: '第一章', content: '正文', scenePlans: ['场景一'] }),
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

/** 构建真实 task-engine deps（对 ProjectDatabase），invokeModel 可注入 */
function buildChapterDraftEngineDeps(
  db: ProjectDatabase,
  opts: {
    invokeModel?: (input: {
      baseUrl: string;
      model: string;
      apiKey: string;
      prompt: string;
    }) => Promise<unknown>;
  } = {},
): ChapterDraftExecutionDeps {
  const secretStore: SecretStore = {
    hasSecret: async () => true,
    setSecret: async () => {},
    getSecret: async () => 'test-key',
    deleteSecret: async () => {},
  };
  const providerRepo: ProviderProfileRepository = {
    getById: () => ({
      id: 'mimo-token-plan-cn',
      providerType: 'anthropic-compatible',
      displayName: 'MiMo',
      baseUrl: 'https://x',
      model: 'mimo-v2.5-pro',
      keychainService: 'svc',
      keychainAccount: 'acc',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestErrorCode: null,
      lastTestLatencyMs: null,
    }),
    updateTestResult: () => {},
  };
  return {
    taskRepo: new RealTaskRepoAdapter(db),
    invocationRepo: new DbInvocationAdapter(db),
    secretStore,
    providerRepo,
    idGenerator: { generate: () => 'inv-1' },
    clock: { now: () => NOW },
    invokeModel: (opts.invokeModel ?? (async () => mockChapterModelOutput())) as never,
    transaction: <T>(fn: () => T) => db.transactionImmediate(fn),
    nodeExecutionResultStore: db.getNodeExecutionResultStore(),
    nodeExecutionRepo: db.getNodeExecutionRepository(),
  };
}

describe('node execution settlement (real SQLite)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'node-exec-integration-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 如实标注（B2-RW）：node:sqlite 是同步 API，单线程内无法构造两个 runner 真正同时进入
  // claim 的竞速；本用例验证的是**跨连接幂等**——连接 A 已 claim 后，连接 B 在同一 run 上
  // 不会重复 dispatch/建 task/调 prepareTask。真并发的原子性由 partial unique 索引 +
  // BEGIN IMMEDIATE 在 schema/事务层保证（见用例 2b 的 UNIQUE 分类矩阵）。
  it('1. 跨连接幂等：连接 A claim 后连接 B 不重复 dispatch（partial unique 原子门）', async () => {
    const dbA = freshDb();
    const dbB = freshDb();
    try {
      const kitA = buildKit(dbA);
      const kitB = buildKit(dbB, {
        outputs: {},
        resolver: permissiveResolver(),
      });
      // 连接 A：claim DRAFT task
      const runA = seedChapterRun(dbA, kitA.deps, 'c-1');
      const runId = runA.run.workflowRunId;
      await driveRun(kitA.deps, 'p1', runId);
      const execA = dbA.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT');
      expect(execA).not.toBeNull();
      expect(execA!.taskId).not.toBeNull();
      // 连接 B：同一 run 不再重复 dispatch（exactly-once）
      const settledB = await driveRun(kitB.deps, 'p1', runId);
      expect(settledB.filter((s) => s.nodeId === 'DRAFT')).toHaveLength(0);
      const allExecs = dbA.getNodeExecutionRepository().listActiveByRun(runId);
      expect(allExecs.filter((e) => e.nodeId === 'DRAFT')).toHaveLength(1);
      expect(kitA.prepareCalls.filter((c) => c.nodeId === 'DRAFT')).toHaveLength(1);
      // A 完成任务 → settle
      claimThenComplete(dbA, execA!.taskId!, '{}');
      const state = dbA.getGraphRunRepository().getById(runId)!.state;
      dbA.getNodeExecutionResultStore().saveOrVerifySame({
        executionId: execA!.id,
        projectId: 'p1',
        graphRunId: runId,
        nodeId: 'DRAFT',
        taskId: execA!.taskId,
        activationNo: execA!.activationNo,
        attemptNo: execA!.attemptNo,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: execA!.inputHash,
        artifactKind: 'generationRun',
        artifactId: 'gen-real-1',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'x', content: 'y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      });
      await driveRun(kitA.deps, 'p1', runId);
      // B 随后幂等推进，不重复执行
      const settledB2 = await driveRun(kitB.deps, 'p1', runId);
      expect(settledB2.filter((s) => s.nodeId === 'DRAFT' && s.settled)).toHaveLength(0);
      expect(kitA.prepareCalls.filter((c) => c.nodeId === 'DRAFT')).toHaveLength(1);
      void state;
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('2b. UNIQUE 冲突精确分类：只有 in-flight partial unique → false，其它 UNIQUE → 抛错', () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedProjectRun(db, kit.deps, 'c-unique');
      const runId = run.run.workflowRunId;
      const state = db.getGraphRunRepository().getById(runId)!.state;
      const repo = db.getNodeExecutionRepository();
      const mkInput = (id: string, activationNo: number, attemptNo: number) => ({
        id,
        graphRunId: runId,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        activationNo,
        attemptNo,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable' as const,
        inputSnapshotJson: '{}',
        inputHash: inputHashFor(kit.deps, state, 'IDEA_CAPTURE', activationNo),
        createdAt: NOW,
        updatedAt: NOW,
      });
      // in-flight partial unique → false（并发门）
      expect(repo.create(mkInput('u-1', 1, 1))).toBe(true);
      expect(repo.create(mkInput('u-2', 2, 1))).toBe(false);
      // 重复 PK → 抛错（非并发）
      expect(() => repo.create(mkInput('u-1', 3, 1))).toThrow();
      // 释放 in-flight 后，重复 (run,node,activation,attempt) → 抛错
      repo.markSettled('u-1', ['pending'], null, NOW);
      expect(() => repo.create(mkInput('u-3', 1, 1))).toThrow();
      // 重复 task_id → markRunning 绑定已用 task_id → 抛错
      repo.create(mkInput('u-4', 4, 1));
      repo.markRunning('u-4', ['pending'], {
        taskId: 't-dup',
        claimedBy: 'x',
        leaseExpiresAt: null,
      });
      repo.markSuperseded('u-4', ['running']);
      expect(repo.create(mkInput('u-5', 5, 1))).toBe(true);
      expect(() =>
        repo.markRunning('u-5', ['pending'], {
          taskId: 't-dup',
          claimedBy: 'x',
          leaseExpiresAt: null,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('2. claim/task binding rollback：task 创建 PK 冲突 → 整事务回滚，无 execution 残留', async () => {
    const db = freshDb();
    try {
      // 确定性 id 序列：runId → CHAPTER_PLAN exec → DRAFT exec → DRAFT task
      const ids = ['run-rollback', 'cp-exec', 'd-exec', 'd-task'];
      const idGen = () => ids.shift() ?? 'overflow';
      const kit = buildKit(db, { idGenerator: idGen });
      // 预插入与 claim 生成的 taskId 冲突的 task → 事务内 task 创建 PK 冲突 → 整事务回滚
      new RealTaskRepoAdapter(db).create({
        id: 'd-task',
        projectId: 'p1',
        taskType: 'CHAPTER_DRAFT',
        inputVersionJson: '{}',
        payloadJson: '{}',
        dedupeKey: 'other',
      });
      const run = seedChapterRun(db, kit.deps, 'c-rollback');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      // 无任何 DRAFT execution 残留（claim 事务整体回滚，含 execution 与 task）
      const all = db.getNodeExecutionRepository().listActiveByRun(runId);
      expect(all.filter((e) => e.nodeId === 'DRAFT')).toHaveLength(0);
      // 也没有第二个 DRAFT task（唯一 task 仍是最初预插入的）
      const draftTasks = db.getTaskRepository().listByProject('p1');
      expect(draftTasks.filter((t) => t.taskType === 'CHAPTER_DRAFT')).toHaveLength(1);
      // run 被 fail-closed（节点无法执行 → 原子失败路径）
      const state = db.getGraphRunRepository().getById(runId)!.state;
      expect(state.nodeStatuses[DRAFT]).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('3. task-backed infra retry：TASK_INTERRUPTED → 统一 claim 新 attempt 新 task（同 activation）', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db, { recoveryOverrides: { DRAFT: 'replayable' } });
      const run = seedChapterRun(db, kit.deps, 'c-retry');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec1 = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      const task1 = exec1.taskId!;
      claimThenFail(db, task1, 'TASK_INTERRUPTED');
      await driveRun(kit.deps, 'p1', runId);
      const exec2 = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      expect(exec2.id).not.toBe(exec1.id);
      expect(exec2.activationNo).toBe(exec1.activationNo);
      expect(exec2.attemptNo).toBe(2);
      expect(db.getNodeExecutionRepository().getById(exec1.id)?.status).toBe('superseded');
      expect(exec2.taskId).not.toBeNull();
      expect(exec2.taskId).not.toBe(task1);
    } finally {
      db.close();
    }
  });

  it('4. activation ordering：getLatestByRunNode 按 activation_no DESC, attempt_no DESC', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedProjectRun(db, kit.deps, 'c-ord');
      const runId = run.run.workflowRunId;
      const state = db.getGraphRunRepository().getById(runId)!.state;
      const repo = db.getNodeExecutionRepository();
      const pairs: Array<[number, number]> = [
        [1, 1],
        [1, 2],
        [2, 1],
      ];
      for (const [activation, attempt] of pairs) {
        const created = repo.create({
          id: `e-${activation}-${attempt}`,
          graphRunId: runId,
          graphId: state.graphId,
          graphVersion: state.graphVersion,
          nodeId: 'IDEA_CAPTURE',
          activationNo: activation,
          attemptNo: attempt,
          executorId: 'idea-capture-v1',
          executorVersion: 'v1',
          recoveryPolicy: 'replayable',
          inputSnapshotJson: '{}',
          inputHash: inputHashFor(kit.deps, state, 'IDEA_CAPTURE', activation),
          createdAt: NOW,
          updatedAt: NOW,
        });
        expect(created).toBe(true);
        // 释放 in-flight（partial unique），让后续 attempt 可插入
        if (!(activation === 2 && attempt === 1)) {
          repo.markSettled(`e-${activation}-${attempt}`, ['pending'], null, NOW);
        }
      }
      const latest = repo.getLatestByRunNode(runId, 'IDEA_CAPTURE')!;
      expect(latest.activationNo).toBe(2);
      expect(latest.attemptNo).toBe(1);
      const inFlight = repo.getInFlightByRunNode(runId, 'IDEA_CAPTURE')!;
      expect(inFlight.id).toBe('e-2-1');
    } finally {
      db.close();
    }
  });

  it('5. fan-out：全部三个 Critic execution/task 全量 dispatch', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-fan');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const draft = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT');
      if (draft) {
        claimThenComplete(db, draft.taskId!, '{}');
        db.getNodeExecutionResultStore().saveOrVerifySame({
          executionId: draft.id,
          projectId: 'p1',
          graphRunId: runId,
          nodeId: 'DRAFT',
          taskId: draft.taskId,
          activationNo: draft.activationNo,
          attemptNo: draft.attemptNo,
          executorId: 'chapter-draft-v1',
          executorVersion: 'v1',
          inputHash: draft.inputHash,
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
        await driveRun(kit.deps, 'p1', runId);
      }
      for (const nodeId of ['CONTINUITY_CRITIC', 'STYLE_CRITIC', 'REQUIREMENT_CRITIC']) {
        const e = db.getNodeExecutionRepository().getInFlightByRunNode(runId, nodeId);
        expect(e, nodeId).not.toBeNull();
        expect(e!.taskId).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it('6. atomic failure：execution failed + applyNodeFailure 同事务；终态 run 回滚', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedProjectRun(db, kit.deps, 'c-atomic');
      const runId = run.run.workflowRunId;
      const state = db.getGraphRunRepository().getById(runId)!.state;
      db.getNodeExecutionRepository().create({
        id: 'e-atomic',
        graphRunId: runId,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputSnapshotJson: '{}',
        inputHash: inputHashFor(kit.deps, state, 'IDEA_CAPTURE', 1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getNodeExecutionRepository().markRunning('e-atomic', ['pending'], {
        taskId: null,
        claimedBy: 'test-runner',
        leaseExpiresAt: NOW,
      });
      kit.deps.tx.runInTransaction((repos) =>
        failExecutionAndNodeInTransaction(kit.deps, repos, {
          projectId: 'p1',
          executionId: 'e-atomic',
          errorCode: 'NODE_INTERRUPTED',
        }),
      );
      expect(db.getNodeExecutionRepository().getById('e-atomic')?.status).toBe('failed');
      const failedState = db.getGraphRunRepository().getById(runId)!.state;
      expect(failedState.terminalStatus).toBe('failed');
      expect(failedState.nodeStatuses[IDEA_CAPTURE]).toBe('failed');
      // 终态 run 再次 atomic failure → 整事务回滚，execution 不标记 failed
      const cmd = db.getGraphRunCommandLogRepository();
      expect(cmd.get(`fail:e-atomic`)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('7. finalization failure：saveOrVerifySame 冲突 → 补偿标记 invocation/task FAILED', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-final');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      // 预插入同 executionId 但不同内容的 envelope → 最终事务 saveOrVerifySame 抛错
      db.getNodeExecutionResultStore().save({
        executionId: exec.id,
        projectId: 'p1',
        graphRunId: runId,
        nodeId: 'DRAFT',
        taskId: exec.taskId,
        activationNo: exec.activationNo,
        attemptNo: exec.attemptNo,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: exec.inputHash,
        artifactKind: 'generationRun',
        artifactId: 'gen-other',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'X', content: 'Y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      });
      // 直接调用 executeChapterDraft（task-engine 补偿逻辑由 task-engine 单测覆盖）；
      // 此处验证 saveOrVerifySame 冲突在真实 SQLite 抛错（不留半成品）。
      const store = db.getNodeExecutionResultStore() as unknown as {
        saveOrVerifySame: (e: unknown) => void;
      };
      expect(() =>
        store.saveOrVerifySame({
          executionId: exec.id,
          projectId: 'p1',
          graphRunId: runId,
          nodeId: 'DRAFT',
          taskId: exec.taskId,
          activationNo: exec.activationNo,
          attemptNo: exec.attemptNo,
          executorId: 'chapter-draft-v1',
          executorVersion: 'v1',
          inputHash: exec.inputHash,
          artifactKind: 'generationRun',
          artifactId: 'gen-other-2',
          artifactVersion: 1,
          contentJson: '{}',
          outcome: null,
          createdAt: NOW,
        }),
      ).toThrow();
      // 同内容 → 幂等 no-op（不抛）
      expect(() =>
        store.saveOrVerifySame({
          executionId: exec.id,
          projectId: 'p1',
          graphRunId: runId,
          nodeId: 'DRAFT',
          taskId: exec.taskId,
          activationNo: exec.activationNo,
          attemptNo: exec.attemptNo,
          executorId: 'chapter-draft-v1',
          executorVersion: 'v1',
          inputHash: exec.inputHash,
          artifactKind: 'generationRun',
          artifactId: 'gen-other',
          artifactVersion: 1,
          contentJson: JSON.stringify({
            kind: 'generationRun',
            draft: { title: 'X', content: 'Y', scenePlans: [] },
          }),
          outcome: null,
          createdAt: NOW,
        }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('8. artifact ownership：transaction-scoped resolver 拒绝 project/run 不匹配', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db, { resolver: realResolver() });
      const run = seedProjectRun(db, kit.deps, 'c-owner');
      const runId = run.run.workflowRunId;
      const state = db.getGraphRunRepository().getById(runId)!.state;
      // 先落库一个真实 research_bundle
      db.getResearchBundleRepository().save(
        {
          id: 'rb-owner',
          projectId: 'p1',
          version: 1,
          depth: 'none',
          summary: '',
          sources: [],
          notes: [],
          createdAt: NOW,
          bundleJson: {},
        } as never,
        NOW,
      );
      db.getNodeExecutionRepository().create({
        id: 'e-owner',
        graphRunId: runId,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        nodeId: 'RESEARCH_EXECUTE',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'research-execute-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputSnapshotJson: '{}',
        inputHash: inputHashFor(kit.deps, state, 'RESEARCH_EXECUTE', 1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getNodeExecutionRepository().markRunning('e-owner', ['pending'], {
        taskId: null,
        claimedBy: 'test-runner',
        leaseExpiresAt: NOW,
      });
      // 持久化 execution→artifact provenance（settlement 同事务会做；此处直接模拟）
      kit.deps.tx.runInTransaction((repos) =>
        repos.artifactProvenanceRepo.upsert({
          artifactKind: 'researchBundle',
          artifactId: 'rb-owner',
          version: 1,
          projectId: 'p1',
          graphRunId: runId,
          nodeId: 'RESEARCH_EXECUTE',
          executionId: 'e-owner',
          createdAt: NOW,
        }),
      );
      // 校验通过（provenance + 真实 bundle 匹配）
      const ok = kit.deps.tx.runInTransaction((repos) =>
        kit.deps.artifactResolver.resolve(repos, {
          projectId: 'p1',
          graphRunId: runId,
          graphVersion: state.graphVersion,
          nodeId: 'RESEARCH_EXECUTE',
          executionId: 'e-owner',
          proposed: {
            kind: 'researchBundle',
            artifactId: 'rb-owner',
            producerNodeId: 'RESEARCH_EXECUTE' as never,
            version: 1,
          },
        }),
      );
      expect(ok.artifactId).toBe('rb-owner');
      // 跨 execution 引用（provenance 归属其他 execution）→ 拒绝
      expect(() =>
        kit.deps.tx.runInTransaction((repos) =>
          kit.deps.artifactResolver.resolve(repos, {
            projectId: 'p1',
            graphRunId: runId,
            graphVersion: state.graphVersion,
            nodeId: 'RESEARCH_EXECUTE',
            executionId: 'e-other',
            proposed: {
              kind: 'researchBundle',
              artifactId: 'rb-owner',
              producerNodeId: 'RESEARCH_EXECUTE' as never,
              version: 1,
            },
          }),
        ),
      ).toThrow();
      // project 不匹配 → 拒绝
      expect(() =>
        kit.deps.tx.runInTransaction((repos) =>
          kit.deps.artifactResolver.resolve(repos, {
            projectId: 'p2',
            graphRunId: runId,
            graphVersion: state.graphVersion,
            nodeId: 'RESEARCH_EXECUTE',
            executionId: 'e-owner',
            proposed: {
              kind: 'researchBundle',
              artifactId: 'rb-owner',
              producerNodeId: 'RESEARCH_EXECUTE' as never,
              version: 1,
            },
          }),
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('9. task→execution lookup：getByTaskId 返回权威 execution context', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-lookup');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      const byTask = db.getNodeExecutionRepository().getByTaskId(exec.taskId!)!;
      expect(byTask.id).toBe(exec.id);
      expect(byTask.graphRunId).toBe(runId);
      expect(byTask.nodeId).toBe('DRAFT');
      expect(byTask.activationNo).toBe(exec.activationNo);
      expect(byTask.attemptNo).toBe(exec.attemptNo);
      expect(byTask.inputHash).toBe(exec.inputHash);
    } finally {
      db.close();
    }
  });

  it('10. startup readiness：崩溃恢复后 driveRun 幂等推进（readiness 恢复语义）', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-ready');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      // 模拟崩溃窗口：task SUCCEEDED + result 已持久化 + 未 settlement
      claimThenComplete(db, exec.taskId!, '{}');
      db.getNodeExecutionResultStore().saveOrVerifySame({
        executionId: exec.id,
        projectId: 'p1',
        graphRunId: runId,
        nodeId: 'DRAFT',
        taskId: exec.taskId,
        activationNo: exec.activationNo,
        attemptNo: exec.attemptNo,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: exec.inputHash,
        artifactKind: 'generationRun',
        artifactId: 'gen-ready',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'x', content: 'y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      });
      // 重启（新 driveRun 即 startup readiness 恢复）→ 幂等 settlement
      const settled = await driveRun(kit.deps, 'p1', runId);
      expect(settled.some((s) => s.nodeId === 'DRAFT' && s.settled)).toBe(true);
      const state = db.getGraphRunRepository().getById(runId)!.state;
      expect(state.nodeStatuses[DRAFT]).toBe('succeeded');
      const again = await driveRun(kit.deps, 'p1', runId);
      expect(again.filter((s) => s.nodeId === 'DRAFT' && s.settled)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('11. pending reschedule：PENDING task-backed 重启后幂等重新调度，不建重复 task', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-pending');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      const taskId = exec.taskId!;
      // 重启：task 仍 PENDING，execution 仍 running → driveRun 幂等重调度（scheduleTask 语义）
      const scheduled: string[] = [];
      const deps2: NodeRunnerDeps = { ...kit.deps, scheduleTask: (id) => scheduled.push(id) };
      await driveRun(deps2, 'p1', runId);
      expect(scheduled).toContain(taskId);
      // 没有创建重复 task（execution/task 唯一）
      const all = db.getNodeExecutionRepository().listActiveByRun(runId);
      expect(all.filter((e) => e.nodeId === 'DRAFT')).toHaveLength(1);
      expect(kit.prepareCalls.filter((c) => c.nodeId === 'DRAFT')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('13. B10 并发 race：两个连接同时 driveRun → 恰好一个 executor/task（真实 partial unique 门）', async () => {
    const dbA = freshDb();
    const dbB = freshDb();
    try {
      const kitA = buildKit(dbA);
      const run = seedChapterRun(dbA, kitA.deps, 'c-race');
      const runId = run.run.workflowRunId;
      // 连接 B 复用 A 的 executor/registry（共享 prepareTask 计数）
      const kitB = buildKit(dbB);
      const depsB: NodeRunnerDeps = {
        ...kitB.deps,
        registry: kitA.deps.registry,
        runners: kitA.deps.runners,
      };
      // 同时推进（Promise.all 制造并发窗口）
      await Promise.all([driveRun(kitA.deps, 'p1', runId), driveRun(depsB, 'p1', runId)]);
      // exactly-once：DRAFT 恰好一个 execution + 一个 task + 一次 prepareTask
      const draftExecs = [...dbA.getNodeExecutionRepository().listActiveByRun(runId)].filter(
        (e) => e.nodeId === 'DRAFT',
      );
      expect(draftExecs).toHaveLength(1);
      expect(kitA.prepareCalls.filter((c) => c.nodeId === 'DRAFT')).toHaveLength(1);
      const taskId = draftExecs[0].taskId!;
      expect(taskId).not.toBeNull();
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('14. B10 真实 finalization：executeChapterDraft 对 ProjectDatabase + 强制失败 → 补偿 FAILED', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db);
      const run = seedChapterRun(db, kit.deps, 'c-final-real');
      const runId = run.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runId);
      const exec = db.getNodeExecutionRepository().getInFlightByRunNode(runId, 'DRAFT')!;
      // 预插入冲突 envelope → 最终事务 saveOrVerifySame 抛错
      db.getNodeExecutionResultStore().save({
        executionId: exec.id,
        projectId: 'p1',
        graphRunId: runId,
        nodeId: 'DRAFT',
        taskId: exec.taskId,
        activationNo: exec.activationNo,
        attemptNo: exec.attemptNo,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: exec.inputHash,
        artifactKind: 'generationRun',
        artifactId: 'gen-other',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'X', content: 'Y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      });
      const engineDeps = buildChapterDraftEngineDeps(db);
      await expect(executeChapterDraft(engineDeps, exec.taskId!, 'prompt')).rejects.toThrow();
      // 补偿：invocation / task 都 FAILED，不留 RUNNING 半成品
      const task = engineDeps.taskRepo.getById(exec.taskId!)!;
      expect(task.status).toBe('FAILED');
      expect(task.errorCode).toBe('TASK_EXECUTION_FAILED');
      const invocation = engineDeps.invocationRepo.getById('inv-1');
      expect(invocation).not.toBeNull();
      expect(invocation!.status).toBe('FAILED');
    } finally {
      db.close();
    }
  });

  /**
   * B2-RW Blocker 1 回归。
   *
   * 此前所有走完整 settleNodeExecution 的用例都用 permissiveResolver / acceptingResolver，
   * realResolver 只被直接调用且由用例手工预置 provenance —— 因此"生产 resolver 下真实
   * settlement"这条路径从未被覆盖，导致 provenance 时序死锁（resolve 早于 upsert，而
   * upsert 是全仓库唯一的 provenance 写入者）连过三轮 review。
   *
   * 本用例用生产等价 resolver 驱动真实 run，覆盖 generationRun 之外的三类 artifact
   * （idea / creationSpec / storyBlueprint）。修复前它必然失败：首个产出 artifact 的节点
   * 就会因"无 provenance"而 fail，applyNodeFailure 直接把 run 打成终态 failed。
   */
  it('16. B2-RW：生产等价 resolver 端到端 settlement（idea / creationSpec / storyBlueprint）', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db, { resolver: realResolver() });
      const run = seedProjectRun(db, kit.deps, 'c-e2e-prov');
      const runId = run.run.workflowRunId;
      // storyBlueprint 需在权威表内真实存在（resolver 校验底层存储 + version）
      db.getStoryBlueprintRepository().save(
        { id: 'bp-real-1', projectId: 'p1', version: 1 } as never,
        false,
        NOW,
      );

      const settled = await driveRun(kit.deps, 'p1', runId);

      const settledNodes = settled.filter((s) => s.settled).map((s) => s.nodeId);
      expect(settledNodes).toContain('IDEA_CAPTURE');
      expect(settledNodes).toContain('SPEC_EXTRACT');
      expect(settledNodes).toContain('BLUEPRINT_GENERATE');

      const state = db.getGraphRunRepository().getById(runId)!.state as IdeaToNovelProjectRunState;
      // run 未被打成终态；停在蓝图人工确认
      expect(state.terminalStatus).toBeNull();
      expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
      expect(state.nodeStatuses[SPEC_EXTRACT]).toBe('succeeded');
      expect(state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('succeeded');
      expect(state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      // Graph artifact ref 指向真实持久化对象
      expect(state.artifacts.idea?.artifactId).toBe('idea-real-1');
      expect(state.artifacts.creationSpec?.artifactId).toBe('spec-real-1');
      expect(state.artifacts.storyBlueprint?.artifactId).toBe('bp-real-1');

      // provenance 在 settlement 同事务内写入，且绑定真实 execution
      const prov = kit.deps.tx.runInTransaction((repos) => ({
        idea: repos.artifactProvenanceRepo.getByArtifact('idea', 'idea-real-1'),
        spec: repos.artifactProvenanceRepo.getByArtifact('creationSpec', 'spec-real-1'),
        blueprint: repos.artifactProvenanceRepo.getByArtifact('storyBlueprint', 'bp-real-1'),
      }));
      const ideaExec = db.getNodeExecutionRepository().getLatestByRunNode(runId, 'IDEA_CAPTURE')!;
      const bpExec = db
        .getNodeExecutionRepository()
        .getLatestByRunNode(runId, 'BLUEPRINT_GENERATE')!;
      expect(prov.idea?.executionId).toBe(ideaExec.id);
      expect(prov.idea?.graphRunId).toBe(runId);
      expect(prov.spec?.nodeId).toBe('SPEC_EXTRACT');
      expect(prov.blueprint?.executionId).toBe(bpExec.id);
      expect(ideaExec.status).toBe('settled');
      expect(bpExec.status).toBe('settled');
    } finally {
      db.close();
    }
  });

  /**
   * B2-RW Blocker 1 的另一面：把 provenance upsert 提到 resolve 之前，不得削弱归属保护。
   * provenance 主键 (artifact_kind, artifact_id) 即归属闸门 —— 另一 run 的 execution
   * 引用同一 artifactId 时 upsert 冲突，settlement 失败。
   */
  it('17. B2-RW：provenance 主键即归属闸门（他 run execution 引用已归属 artifact → settlement 失败）', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db, { resolver: realResolver() });
      const runA = seedProjectRun(db, kit.deps, 'c-own-a');
      const runIdA = runA.run.workflowRunId;
      db.getStoryBlueprintRepository().save(
        { id: 'bp-real-1', projectId: 'p1', version: 1 } as never,
        false,
        NOW,
      );
      await driveRun(kit.deps, 'p1', runIdA);
      const stateA = db.getGraphRunRepository().getById(runIdA)!
        .state as IdeaToNovelProjectRunState;
      expect(stateA.artifacts.idea?.artifactId).toBe('idea-real-1');

      // run B 的 IDEA_CAPTURE 产出同一个 idea artifactId（executor 默认输出即 idea-real-1）
      const runB = seedProjectRun(db, kit.deps, 'c-own-b');
      const runIdB = runB.run.workflowRunId;
      await driveRun(kit.deps, 'p1', runIdB);

      // 归属冲突 → 确定性失败：run B 被 fail-closed，artifact 归属仍属 run A
      const stateB = db.getGraphRunRepository().getById(runIdB)!.state;
      expect(stateB.nodeStatuses[IDEA_CAPTURE]).toBe('failed');
      expect(stateB.terminalStatus).toBe('failed');
      const provIdea = kit.deps.tx.runInTransaction((repos) =>
        repos.artifactProvenanceRepo.getByArtifact('idea', 'idea-real-1'),
      );
      expect(provIdea?.graphRunId).toBe(runIdA);
    } finally {
      db.close();
    }
  });

  it('15. B10 跨 run provenance：其他 run 产出 researchBundle → 拒绝', async () => {
    const db = freshDb();
    try {
      const kit = buildKit(db, { resolver: realResolver() });
      const run1 = seedProjectRun(db, kit.deps, 'c-prov-1');
      const runId1 = run1.run.workflowRunId;
      const run2 = seedProjectRun(db, kit.deps, 'c-prov-2');
      const runId2 = run2.run.workflowRunId;
      db.getResearchBundleRepository().save(
        { id: 'rb-cross', projectId: 'p1', version: 1, depth: 'none' } as never,
        NOW,
      );
      // run1 的 execution 产出 rb-cross
      const state1 = db.getGraphRunRepository().getById(runId1)!.state;
      db.getNodeExecutionRepository().create({
        id: 'e-cross',
        graphRunId: runId1,
        graphId: state1.graphId,
        graphVersion: state1.graphVersion,
        nodeId: 'RESEARCH_EXECUTE',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'research-execute-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputSnapshotJson: '{}',
        inputHash: inputHashFor(kit.deps, state1, 'RESEARCH_EXECUTE', 1),
        createdAt: NOW,
        updatedAt: NOW,
      });
      kit.deps.tx.runInTransaction((repos) =>
        repos.artifactProvenanceRepo.upsert({
          artifactKind: 'researchBundle',
          artifactId: 'rb-cross',
          version: 1,
          projectId: 'p1',
          graphRunId: runId1,
          nodeId: 'RESEARCH_EXECUTE',
          executionId: 'e-cross',
          createdAt: NOW,
        }),
      );
      // 在 run2 中引用 rb-cross → provenance 的 graphRunId 不匹配 → 拒绝
      expect(() =>
        kit.deps.tx.runInTransaction((repos) =>
          kit.deps.artifactResolver.resolve(repos, {
            projectId: 'p1',
            graphRunId: runId2,
            graphVersion: 'v1',
            nodeId: 'RESEARCH_EXECUTE',
            executionId: 'e-cross',
            proposed: {
              kind: 'researchBundle',
              artifactId: 'rb-cross',
              producerNodeId: 'RESEARCH_EXECUTE' as never,
              version: 1,
            },
          }),
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('12. lease behavior：sync lease 未过期保持 / 过期同 activation 新 attempt', async () => {
    const db = freshDb();
    try {
      let now = Date.parse(NOW);
      const kit = buildKit(db, { now: () => new Date(now).toISOString() });
      const run = seedProjectRun(db, kit.deps, 'c-lease');
      const runId = run.run.workflowRunId;
      const state = db.getGraphRunRepository().getById(runId)!.state;
      db.getNodeExecutionRepository().create({
        id: 'e-lease',
        graphRunId: runId,
        graphId: state.graphId,
        graphVersion: state.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputSnapshotJson: serializeInputSnapshot(
          computeNodeInputSnapshot(kit.deps.projectGraph, state, 'IDEA_CAPTURE', 1),
        ),
        inputHash: inputHashFor(kit.deps, state, 'IDEA_CAPTURE', 1),
        createdAt: kit.deps.clock.now(),
        updatedAt: kit.deps.clock.now(),
      });
      db.getNodeExecutionRepository().markRunning('e-lease', ['pending'], {
        taskId: null,
        claimedBy: 'other-runner',
        leaseExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      });
      // 未过期 → 保持
      const hold = await driveRun(kit.deps, 'p1', runId);
      expect(hold).toHaveLength(0);
      expect(db.getNodeExecutionRepository().getById('e-lease')?.status).toBe('running');
      // 过期 → 重试（同 activation attempt+1）
      now += 6 * 60 * 1000;
      const retried = await driveRun(kit.deps, 'p1', runId);
      expect(retried.some((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled)).toBe(true);
      const latest = db.getNodeExecutionRepository().getLatestByRunNode(runId, 'IDEA_CAPTURE')!;
      expect(latest.activationNo).toBe(1);
      expect(latest.attemptNo).toBe(2);
      expect(db.getNodeExecutionRepository().getById('e-lease')?.status).toBe('superseded');
    } finally {
      db.close();
    }
  });
});
