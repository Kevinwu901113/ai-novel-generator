/**
 * 创作契约草案真实 SQLite 并发测试。
 *
 * 两个独立连接访问同一 project.sqlite：
 * 1. 同一 draft request → 只一个 active task，loser 稳定重复错误；
 * 2. 同一 PENDING task 两个 runner → 只一个 claim / invocation / proposal；
 * 3. 模型调用期间 Grill session 更新 → task STALE + invocation SUCCEEDED，无 proposal；
 * 4. 模型调用期间 contract current 更新 → task STALE，无 proposal；
 * 5. proposal 最终提交：无 SUCCEEDED task + missing proposal、
 *    无 proposal + RUNNING task、无 orphan invocation。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { CreationContractTransactionPortImpl, sha256Utf8 } from '@ai-novel/database';
import {
  requestCreationContractProposal,
  acceptCreationContractProposal,
  lockCreationContractField,
  ContractDraftAlreadyRunningError,
  ContractDataCorruptionError,
  TaskDedupeConflictError,
  type RequestCreationContractProposalDeps,
} from '@ai-novel/application';
import { executeCreationContractDraft, TaskExecutionError } from '@ai-novel/task-engine';
import {
  buildEngineDeps,
  buildRequestDeps,
  seedCompletedGrillSession,
  makeCanonicalSectionsJson,
  TaskRepoAdapter,
  NOW,
  NOW2,
} from './contract-test-utils.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-conc-'));
  dbPath = join(tempDir, 'project.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function openDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'proj-1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

function mutationDepsFor(db: ProjectDatabase) {
  return {
    transactionPort: new CreationContractTransactionPortImpl(db.database),
    sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待条件成立（带超时）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(2);
  }
}

describe('真实 SQLite 并发', () => {
  it('1. 同一 draft request：只一个 active task，loser 稳定重复错误', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-conc-1',
      projectId: 'proj-1',
    });
    const dbB = openDb();

    const input = {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-1',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    };
    const depsA: RequestCreationContractProposalDeps = buildRequestDeps(dbA, {
      generate: () => 'task-a',
    });
    const depsB: RequestCreationContractProposalDeps = buildRequestDeps(dbB, {
      generate: () => 'task-b',
    });

    const r1 = requestCreationContractProposal(depsA, input);
    expect(r1.taskId).toBe('task-a');

    let thrown: unknown;
    try {
      requestCreationContractProposal(depsB, input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContractDraftAlreadyRunningError);
    expect((thrown as ContractDraftAlreadyRunningError).code).toBe(
      'CONTRACT_DRAFT_ALREADY_RUNNING',
    );

    // 只一个 active task
    const tasks = dbB.getTaskRepository().listByProject('proj-1');
    const active = tasks.filter((t) => t.status === 'PENDING' || t.status === 'RUNNING');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('task-a');
    dbA.close();
    dbB.close();
  });

  it('2. 同一 PENDING task 两个 runner：只一个 claim / invocation / proposal', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-conc-2',
      projectId: 'proj-1',
    });
    const depsA = buildRequestDeps(dbA, { generate: () => 'task-c' });
    requestCreationContractProposal(depsA, {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-2',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });

    const dbB = openDb();

    // runner A 使用 gate 阻塞在模型调用中
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let modelCalled = false;
    const invokeA = async (): Promise<import('@ai-novel/model-gateway').ModelInvocationOutput> => {
      modelCalled = true;
      await gate;
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          sections: JSON.parse(makeCanonicalSectionsJson()),
        }),
        providerRequestId: 'req-c',
        finishReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 15,
        },
        latencyMs: 100,
        errorCode: null,
        errorMessage: null,
      };
    };
    const engineA = buildEngineDeps(dbA, { invokeModel: invokeA });

    const runA = executeCreationContractDraft(engineA, 'task-c');
    await waitFor(() => modelCalled);

    // runner B：task 已被 A claim（RUNNING）→ TASK_STATE_CONFLICT，不调用模型
    let thrownB: unknown;
    try {
      await executeCreationContractDraft(buildEngineDeps(dbB), 'task-c');
    } catch (e) {
      thrownB = e;
    }
    expect(thrownB).toBeInstanceOf(TaskExecutionError);

    release();
    const resultA = await runA;
    expect(resultA.task.status).toBe('SUCCEEDED');

    // 只一个 claim / invocation / proposal
    const invocations = dbA.getModelInvocationRepository().listByTask('task-c');
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe('SUCCEEDED');
    const proposals = dbA.getCreationContractProposalRepository().listByGrillSession('gs-conc-2');
    expect(proposals).toHaveLength(1);
    const task = dbA.getTaskRepository().getById('task-c');
    expect(task?.attemptCount).toBe(1);
    dbA.close();
    dbB.close();
  });

  it('3. 模型调用期间 Grill session 更新 → task STALE + invocation SUCCEEDED，无 proposal', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-conc-3',
      projectId: 'proj-1',
    });
    const depsA = buildRequestDeps(dbA, { generate: () => 'task-d' });
    requestCreationContractProposal(depsA, {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-3',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });

    const dbB = openDb();
    // 模型调用期间，另一连接 bump session 版本
    const invokeBump = async (): Promise<
      import('@ai-novel/model-gateway').ModelInvocationOutput
    > => {
      dbB.getGrillSessionRepository().bumpVersion('gs-conc-3', sessionVersion, NOW2);
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          sections: JSON.parse(makeCanonicalSectionsJson()),
        }),
        providerRequestId: 'req-d',
        finishReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 15,
        },
        latencyMs: 100,
        errorCode: null,
        errorMessage: null,
      };
    };

    const result = await executeCreationContractDraft(
      buildEngineDeps(dbA, { invokeModel: invokeBump }),
      'task-d',
    );
    expect(result.task.status).toBe('STALE');
    expect(result.invocation?.status).toBe('SUCCEEDED');
    const proposals = dbA.getCreationContractProposalRepository().listByGrillSession('gs-conc-3');
    expect(proposals).toHaveLength(0);
    dbA.close();
    dbB.close();
  });

  it('4. 模型调用期间 contract current 更新 → task STALE，无 proposal', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-conc-4',
      projectId: 'proj-1',
    });
    const depsA = buildRequestDeps(dbA, { generate: () => 'task-r1' });
    const r1 = requestCreationContractProposal(depsA, {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-4',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });
    const res1 = await executeCreationContractDraft(buildEngineDeps(dbA), r1.taskId);
    const prop1 = dbA.getCreationContractProposalRepository().getById('proj-1', res1.proposalId!);
    acceptCreationContractProposal(mutationDepsFor(dbA), {
      projectId: 'proj-1',
      proposalId: res1.proposalId!,
      expectedProposalSectionsHash: prop1!.sectionsHash,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      operations: [],
      now: NOW2,
      newVersionId: 'ver-r1',
    });

    // 第二轮 request（baseline = version 1）
    const depsB = buildRequestDeps(dbA, { generate: () => 'task-r2' });
    const r2 = requestCreationContractProposal(depsB, {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-4',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: 1,
      providerProfileId: 'provider-1',
    });

    const dbB = openDb();
    // 模型调用期间，另一连接 lock 字段 → 创建 version 2，current pointer 变化
    const invokeLock = async (): Promise<
      import('@ai-novel/model-gateway').ModelInvocationOutput
    > => {
      lockCreationContractField(mutationDepsFor(dbB), {
        projectId: 'proj-1',
        expectedContractVersion: 1,
        fieldPath: '/protagonist/name',
        now: NOW2,
        newVersionId: 'ver-conc-lock',
        lockEventId: 'lock-conc',
      });
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          sections: JSON.parse(makeCanonicalSectionsJson()),
        }),
        providerRequestId: 'req-r2',
        finishReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 15,
        },
        latencyMs: 100,
        errorCode: null,
        errorMessage: null,
      };
    };

    const result2 = await executeCreationContractDraft(
      buildEngineDeps(dbA, { invokeModel: invokeLock }),
      r2.taskId,
    );
    expect(result2.task.status).toBe('STALE');
    expect(result2.invocation?.status).toBe('SUCCEEDED');
    const proposals2 = dbA.getCreationContractProposalRepository().listByGrillSession('gs-conc-4');
    expect(proposals2).toHaveLength(1); // 只有第一轮 proposal
    dbA.close();
    dbB.close();
  });

  it('6. Request 使用 BEGIN IMMEDIATE：事务持有写锁期间另一连接无法写 session', () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-lock-1',
      projectId: 'proj-1',
    });
    const dbB = openDb();
    dbB.database.exec('PRAGMA busy_timeout = 0');

    let busy = false;
    dbA.transactionImmediate(() => {
      // A 持有 BEGIN IMMEDIATE；B 写 session 立即失败（busy_timeout=0）
      try {
        dbB.getGrillSessionRepository().bumpVersion('gs-lock-1', sessionVersion, NOW2);
      } catch {
        busy = true;
      }
    });
    expect(busy).toBe(true);

    // 事务提交后 B 可正常写
    expect(dbB.getGrillSessionRepository().bumpVersion('gs-lock-1', sessionVersion, NOW2)).toBe(
      true,
    );
    dbA.close();
    dbB.close();
  });

  it('7. Request 在单个事务内捕获 session 与 contract 同一快照', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-snap-1',
      projectId: 'proj-1',
    });
    // 第一轮：首次契约 → proposal → accept 创建 version 1
    const depsReq0 = buildRequestDeps(dbA, { generate: () => 'task-snap-0' });
    const r0 = requestCreationContractProposal(depsReq0, {
      projectId: 'proj-1',
      grillSessionId: 'gs-snap-1',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });
    const res0 = await executeCreationContractDraft(buildEngineDeps(dbA), r0.taskId);
    const prop0 = dbA.getCreationContractProposalRepository().getById('proj-1', res0.proposalId!);
    acceptCreationContractProposal(mutationDepsFor(dbA), {
      projectId: 'proj-1',
      proposalId: res0.proposalId!,
      expectedProposalSectionsHash: prop0!.sectionsHash,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      operations: [],
      now: NOW2,
      newVersionId: 'ver-snap-1',
    });

    // 第二轮：已有契约，expectation 为 version 1
    const depsReq2 = buildRequestDeps(dbA, { generate: () => 'task-snap-1' });
    const r2 = requestCreationContractProposal(depsReq2, {
      projectId: 'proj-1',
      grillSessionId: 'gs-snap-1',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: 1,
      providerProfileId: 'provider-1',
    });
    const task = dbA.getTaskRepository().getById(r2.taskId);
    const input = JSON.parse(task!.inputVersionJson) as Record<string, unknown>;
    // 同一快照：baseGrillSessionVersion 与 baseline 引用一致，无混合状态
    expect(input.grillSessionId).toBe('gs-snap-1');
    expect(input.baseGrillSessionVersion).toBe(sessionVersion);
    const baseline = input.contractBaseline as Record<string, unknown>;
    expect(baseline.contractVersionId).toBe('ver-snap-1');
    expect(baseline.contractVersion).toBe(1);
    expect(typeof baseline.contractSnapshotHash).toBe('string');
    expect(String(baseline.contractSnapshotHash).length).toBe(64);
    dbA.close();
  });

  it('8. dedupe 冲突完整 rollback：loser 不留下任何 task', () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-rollback-1',
      projectId: 'proj-1',
    });
    const dbB = openDb();
    const input = {
      projectId: 'proj-1',
      grillSessionId: 'gs-rollback-1',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    };
    requestCreationContractProposal(buildRequestDeps(dbA, { generate: () => 'task-rb-1' }), input);
    expect(() =>
      requestCreationContractProposal(
        buildRequestDeps(dbB, { generate: () => 'task-rb-2' }),
        input,
      ),
    ).toThrow(ContractDraftAlreadyRunningError);

    const draftTasks = dbB
      .getTaskRepository()
      .listByProject('proj-1')
      .filter((t) => t.taskType === 'CREATION_CONTRACT_DRAFT');
    // 只有 winner 的 task，loser 事务完整回滚
    expect(draftTasks).toHaveLength(1);
    expect(draftTasks[0].id).toBe('task-rb-1');
    dbA.close();
    dbB.close();
  });

  it('9. corrupt canonical snapshot（hash 与自身 sections 不一致）→ request 抛数据损坏，不创建 task', () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-corrupt-1',
      projectId: 'proj-1',
    });
    // 绕过 version repo 的 hash 校验，用原始 SQL 写入 hash 与自身 sections 不一致的 version
    dbA.database
      .prepare(
        `INSERT INTO creation_contract_versions
           (id, project_id, version, schema_version, source_proposal_id,
            based_on_grill_session_id, based_on_grill_session_version,
            sections_json, locked_field_paths_json, contract_snapshot_hash,
            provenance_json, created_at, created_by)
         VALUES (?, ?, 1, 1, NULL, ?, ?, ?, '[]', ?, '[]', ?, 'ai-proposal-accepted')`,
      )
      .run(
        'ver-corrupt-1',
        'proj-1',
        'gs-corrupt-1',
        sessionVersion,
        makeCanonicalSectionsJson(),
        'b'.repeat(64), // 与自身 sections 不一致
        NOW,
      );
    dbA.getCreationContractCurrentRepository().insertFirst('proj-1', 'ver-corrupt-1', NOW);

    expect(() =>
      requestCreationContractProposal(buildRequestDeps(dbA, { generate: () => 'task-corr-1' }), {
        projectId: 'proj-1',
        grillSessionId: 'gs-corrupt-1',
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: 1,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(ContractDataCorruptionError);

    const draftTasks = dbA
      .getTaskRepository()
      .listByProject('proj-1')
      .filter((t) => t.taskType === 'CREATION_CONTRACT_DRAFT');
    expect(draftTasks).toHaveLength(0);
    dbA.close();
  });

  it('10. 精确 dedupe 分类：duplicate task ID（PK 冲突）不得映射为 TaskDedupeConflictError', () => {
    const dbA = openDb();
    const adapter = new TaskRepoAdapter(dbA);
    adapter.create({
      id: 'dup-id-1',
      projectId: 'proj-1',
      taskType: 'CREATION_CONTRACT_DRAFT',
      inputVersionJson: '{}',
      payloadJson: '{}',
      dedupeKey: 'dedupe-key-1',
    });
    let thrown: unknown;
    try {
      adapter.create({
        id: 'dup-id-1', // duplicate PK
        projectId: 'proj-1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        inputVersionJson: '{}',
        payloadJson: '{}',
        dedupeKey: 'dedupe-key-2', // 输入包含 dedupeKey 但冲突在 id
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(TaskDedupeConflictError);
    // 原始 SQLite 细节不进入 public 消息
    expect(thrown instanceof Error ? thrown.message : '').not.toContain('已存在相同 dedupe key');
    dbA.close();
  });

  it('11. 精确 dedupe 分类：相同 active dedupeKey → TaskDedupeConflictError', () => {
    const dbA = openDb();
    const adapter = new TaskRepoAdapter(dbA);
    adapter.create({
      id: 'dd-1',
      projectId: 'proj-1',
      taskType: 'CREATION_CONTRACT_DRAFT',
      inputVersionJson: '{}',
      payloadJson: '{}',
      dedupeKey: 'dedupe-key-same',
    });
    let thrown: unknown;
    try {
      adapter.create({
        id: 'dd-2',
        projectId: 'proj-1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        inputVersionJson: '{}',
        payloadJson: '{}',
        dedupeKey: 'dedupe-key-same', // 同一 active dedupeKey
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TaskDedupeConflictError);
    // public message 固定，不含原始 SQLite message / dedupe key
    const msg = thrown instanceof Error ? thrown.message : '';
    expect(msg).not.toContain('dedupe-key-same');
    expect(msg).not.toContain('UNIQUE constraint');
    dbA.close();
  });

  it('5. proposal 最终提交：无 SUCCEEDED task + missing proposal、无 orphan invocation', async () => {
    const dbA = openDb();
    const sessionVersion = seedCompletedGrillSession(dbA, {
      sessionId: 'gs-conc-5',
      projectId: 'proj-1',
    });
    const depsA = buildRequestDeps(dbA, { generate: () => 'task-f' });
    requestCreationContractProposal(depsA, {
      projectId: 'proj-1',
      grillSessionId: 'gs-conc-5',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });
    const result = await executeCreationContractDraft(buildEngineDeps(dbA), 'task-f');
    expect(result.task.status).toBe('SUCCEEDED');

    // 不变量：SUCCEEDED task 必有 proposal；proposal 必属于 SUCCEEDED task；无 orphan invocation
    const task = dbA.getTaskRepository().getById('task-f');
    const proposals = dbA.getCreationContractProposalRepository().listByGrillSession('gs-conc-5');
    expect(proposals).toHaveLength(1);
    expect(task?.status).toBe('SUCCEEDED');
    const invocations = dbA.getModelInvocationRepository().listByTask('task-f');
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe('SUCCEEDED');
    // 每个 invocation 都属于该 task
    expect(invocations.every((i) => i.taskId === 'task-f')).toBe(true);
    // proposal 引用同一 task/invocation
    expect(proposals[0].taskId).toBe('task-f');
    expect(proposals[0].invocationId).toBe(invocations[0].id);

    // 无 SUCCEEDED task + missing proposal（所有 SUCCEEDED 的 CREATION_CONTRACT_DRAFT 任务都有 proposal）
    const succeededDraftTasks = dbA
      .getTaskRepository()
      .listByProject('proj-1')
      .filter((t) => t.taskType === 'CREATION_CONTRACT_DRAFT' && t.status === 'SUCCEEDED');
    for (const t of succeededDraftTasks) {
      const props = dbA.getCreationContractProposalRepository().listByProject('proj-1');
      expect(props.some((p) => p.taskId === t.id)).toBe(true);
    }
    dbA.close();
  });
});
