/**
 * 创作契约草案最终提交原子性测试（真实 SQLite BEGIN IMMEDIATE）。
 *
 * 任一最终事务步骤失败 → 全回滚：
 * - proposal create 失败；
 * - invocation SUCCEEDED CAS 失败；
 * - task complete CAS 失败；
 * 不留下 SUCCEEDED task + missing proposal / proposal + RUNNING task / orphan invocation。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { requestCreationContractProposal } from '@ai-novel/application';
import { TaskExecutionError, executeCreationContractDraft } from '@ai-novel/task-engine';
import {
  buildEngineDeps,
  buildRequestDeps,
  seedCompletedGrillSession,
  NOW,
} from './contract-test-utils.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-atomic-'));
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

/** seed + requestDraft，返回 { db, taskId, sessionVersion }。 */
function prepareDraft(): { db: ProjectDatabase; taskId: string } {
  const db = openDb();
  const sessionVersion = seedCompletedGrillSession(db, {
    sessionId: 'gs-atomic',
    projectId: 'proj-1',
  });
  const requested = buildRequestDeps(db, { generate: () => 'task-atomic' });
  const r = requestCreationContractProposal(requested, {
    projectId: 'proj-1',
    grillSessionId: 'gs-atomic',
    expectedGrillSessionVersion: sessionVersion,
    expectedContractVersion: null,
    providerProfileId: 'provider-1',
  });
  return { db, taskId: r.taskId };
}

describe('最终提交原子性', () => {
  it('proposal create 失败 → 全回滚：无 proposal，task/invocation 保持 RUNNING', async () => {
    const { db, taskId } = prepareDraft();
    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.create = () => {
      throw new Error('injected proposal create failure');
    };
    // 引擎已 claim（RUNNING）；最终事务中 proposal create 抛错 → 回滚
    await expect(executeCreationContractDraft(buildEngineDeps(db), taskId)).rejects.toThrow();
    const task = db.getTaskRepository().getById(taskId);
    expect(task?.status).toBe('RUNNING');
    const invs = db.getModelInvocationRepository().listByTask(taskId);
    expect(invs).toHaveLength(1);
    expect(invs[0].status).toBe('RUNNING');
    expect(db.getCreationContractProposalRepository().listByProject('proj-1')).toHaveLength(0);
  });

  it('invocation SUCCEEDED CAS 失败 → 全回滚', async () => {
    const { db, taskId } = prepareDraft();
    const invRepo = db.getModelInvocationRepository();
    const origMarkSucceeded = invRepo.markSucceeded.bind(invRepo);
    invRepo.markSucceeded = () => false;
    await expect(executeCreationContractDraft(buildEngineDeps(db), taskId)).rejects.toThrow(
      TaskExecutionError,
    );
    void origMarkSucceeded;
    const task = db.getTaskRepository().getById(taskId);
    expect(task?.status).toBe('RUNNING');
    const invs = db.getModelInvocationRepository().listByTask(taskId);
    expect(invs[0].status).toBe('RUNNING');
    expect(db.getCreationContractProposalRepository().listByProject('proj-1')).toHaveLength(0);
  });

  it('task complete CAS 失败 → 全回滚', async () => {
    const { db, taskId } = prepareDraft();
    const taskRepo = db.getTaskRepository();
    const origComplete = taskRepo.completeRunning.bind(taskRepo);
    taskRepo.completeRunning = () => false;
    await expect(executeCreationContractDraft(buildEngineDeps(db), taskId)).rejects.toThrow(
      TaskExecutionError,
    );
    void origComplete;
    const task = db.getTaskRepository().getById(taskId);
    expect(task?.status).toBe('RUNNING');
    const invs = db.getModelInvocationRepository().listByTask(taskId);
    expect(invs[0].status).toBe('RUNNING');
    expect(db.getCreationContractProposalRepository().listByProject('proj-1')).toHaveLength(0);
  });

  it('成功路径：proposal + invocation SUCCEEDED + task SUCCEEDED 同事务提交', async () => {
    const { db, taskId } = prepareDraft();
    const result = await executeCreationContractDraft(buildEngineDeps(db), taskId);
    expect(result.task.status).toBe('SUCCEEDED');
    const proposal = db.getCreationContractProposalRepository().listByProject('proj-1');
    expect(proposal).toHaveLength(1);
    expect(proposal[0].status).toBe('PROPOSED');
    const inv = db.getModelInvocationRepository().getById(result.invocation!.id);
    expect(inv?.status).toBe('SUCCEEDED');
    // 无 orphan：proposal 引用存在的 task/invocation
    expect(proposal[0].taskId).toBe(taskId);
    expect(proposal[0].invocationId).toBe(result.invocation!.id);
    db.close();
  });
});
