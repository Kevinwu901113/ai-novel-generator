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
  type RequestCreationContractProposalDeps,
} from '@ai-novel/application';
import { executeCreationContractDraft, TaskExecutionError } from '@ai-novel/task-engine';
import {
  buildEngineDeps,
  buildRequestDeps,
  seedCompletedGrillSession,
  makeCanonicalSectionsJson,
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
