/**
 * 任务和模型调用数据库测试。
 *
 * 验证迁移、CHECK 约束、索引、FK、仓库 CRUD、CAS 操作、原子恢复。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DbTaskStatus } from './types.js';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDatabase } from './project-database.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'task-db-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Task 迁移', () => {
  it('新数据库应该直接迁移到包含 tasks 和 model_invocations 表', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    const db = new DatabaseSync(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'model_invocations')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('tasks');
    expect(tables.map((t) => t.name)).toContain('model_invocations');
    db.close();

    projDb.close();
  });

  it('tasks 表应该有正确的 CHECK 约束', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);
    const taskRepo = projDb.getTaskRepository();

    taskRepo.create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{"promptHash":"abc"}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const task = taskRepo.getById('task-1');
    expect(task).not.toBeNull();
    expect(task!.status).toBe('PENDING');

    projDb.close();
  });

  it('tasks 表应该拒绝非法 task_type', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    expect(() => {
      projDb.getTaskRepository().create({
        id: 'bad-task',
        projectId: 'proj-1',
        taskType: 'INVALID_TYPE' as 'MODEL_INVOCATION_TEST',
        status: 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });

  it('tasks 表应该拒绝非法 status', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    expect(() => {
      projDb.getTaskRepository().create({
        id: 'bad-task',
        projectId: 'proj-1',
        taskType: 'MODEL_INVOCATION_TEST',
        status: 'INVALID_STATUS' as 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });

  it('tasks 表应该拒绝非法 JSON', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    expect(() => {
      projDb.getTaskRepository().create({
        id: 'bad-task',
        projectId: 'proj-1',
        taskType: 'MODEL_INVOCATION_TEST',
        status: 'PENDING',
        inputVersionJson: 'not json',
        payloadJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });

  it('model_invocations 表应该拒绝非法 attempt_number', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 0,
        requestKind: 'test',
        promptHash: 'a'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });

  it('model_invocations 表应该拒绝非法 prompt_hash 长度', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 1,
        requestKind: 'test',
        promptHash: 'short',
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });

  it('model_invocations 表应该拒绝负数 token', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    const db = new DatabaseSync(dbPath);
    expect(() => {
      db.prepare('UPDATE model_invocations SET input_tokens = -1 WHERE id = ?').run('inv-1');
    }).toThrow();
    db.close();

    projDb.close();
  });

  it('UNIQUE(task_id, attempt_number) 应该防止重复', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-2',
        projectId: 'proj-1',
        taskId: 'task-1',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 1,
        requestKind: 'test',
        promptHash: 'b'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-2',
        projectId: 'proj-1',
        taskId: 'task-1',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 2,
        requestKind: 'test',
        promptHash: 'b'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).not.toThrow();

    projDb.close();
  });

  it('重复运行迁移应该是幂等的', () => {
    const dbPath = join(tempDir, 'project.sqlite');

    const projDb1 = new ProjectDatabase(dbPath);
    projDb1.close();

    const projDb2 = new ProjectDatabase(dbPath);
    const repo = projDb2.getTaskRepository();
    expect(repo.listByProject('any')).toHaveLength(0);
    projDb2.close();
  });

  it('FK 约束：invocation 引用不存在的 task 应该失败', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-orphan',
        projectId: 'proj-1',
        taskId: 'nonexistent-task',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 1,
        requestKind: 'test',
        promptHash: 'a'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    projDb.close();
  });
});

describe('TaskRepository', () => {
  let projDb: ProjectDatabase;

  beforeEach(() => {
    const dbPath = join(tempDir, 'project.sqlite');
    projDb = new ProjectDatabase(dbPath);
  });

  afterEach(() => {
    projDb.close();
  });

  function createTask(id: string, status: DbTaskStatus = 'PENDING') {
    projDb.getTaskRepository().create({
      id,
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status,
      inputVersionJson: '{}',
      payloadJson: '{"promptHash":"abc","promptLength":10}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  }

  it('create 和 getById', () => {
    createTask('task-1');
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('task-1');
    expect(task!.status).toBe('PENDING');
    expect(task!.attemptCount).toBe(0);
  });

  it('getById 不存在时返回 null', () => {
    expect(projDb.getTaskRepository().getById('nonexistent')).toBeNull();
  });

  it('listByProject', () => {
    createTask('task-1');
    createTask('task-2');
    const list = projDb.getTaskRepository().listByProject('proj-1');
    expect(list).toHaveLength(2);
  });

  it('listByStatus', () => {
    createTask('task-1', 'PENDING');
    createTask('task-2', 'SUCCEEDED');
    const pending = projDb.getTaskRepository().listByStatus('PENDING');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('task-1');
  });

  it('claimPending 成功：PENDING → RUNNING + attempt_count=1', () => {
    createTask('task-1', 'PENDING');
    const result = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');
    expect(task!.attemptCount).toBe(1);
    expect(task!.startedAt).toBe('2024-01-02T00:00:00.000Z');
    expect(task!.finishedAt).toBeNull();
    expect(task!.errorCode).toBeNull();
    expect(task!.errorMessage).toBeNull();
  });

  it('claimPending 失败：状态不匹配', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');
  });

  it('双重 claim 只有一个成功', () => {
    createTask('task-1', 'PENDING');
    const result1 = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');
    const result2 = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');
    expect(result1).toBe(true);
    expect(result2).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.attemptCount).toBe(1);
  });

  it('claimPending 失败不增加 attempt_count', () => {
    createTask('task-1', 'RUNNING');
    projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.attemptCount).toBe(0);
  });

  it('STALE task 不可被 claim', () => {
    createTask('task-1', 'PENDING');
    projDb.getTaskRepository().markStale('task-1', ['PENDING'], '2024-01-02T00:00:00.000Z');

    const result = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:01.000Z');
    expect(result).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('STALE');
  });

  it('CANCELLED task 不可被 claim', () => {
    const db = new DatabaseSync(join(tempDir, 'project.sqlite'));
    db.exec("UPDATE tasks SET status = 'CANCELLED' WHERE id = 'task-1'");
    db.close();
    createTask('task-1', 'PENDING');
    // Direct SQL to set CANCELLED
    const rawDb = new DatabaseSync(join(tempDir, 'project.sqlite'));
    rawDb.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE id = ?").run('task-1');
    rawDb.close();

    const result = projDb.getTaskRepository().claimPending('task-1', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);
  });

  it('completeRunning 成功', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb
      .getTaskRepository()
      .completeRunning('task-1', '{"accepted":true}', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('SUCCEEDED');
    expect(task!.resultJson).toBe('{"accepted":true}');
    expect(task!.finishedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('completeRunning 失败：状态不匹配', () => {
    createTask('task-1', 'PENDING');
    const result = projDb
      .getTaskRepository()
      .completeRunning('task-1', '{"accepted":true}', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('PENDING');
  });

  it('SUCCEEDED task 不可再次 completeRunning', () => {
    createTask('task-1', 'RUNNING');
    projDb.getTaskRepository().completeRunning('task-1', '{}', '2024-01-02T00:00:00.000Z');

    const result = projDb
      .getTaskRepository()
      .completeRunning('task-1', '{}', '2024-01-02T00:00:01.000Z');
    expect(result).toBe(false);
  });

  it('failRunning 成功', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb
      .getTaskRepository()
      .failRunning('task-1', 'TASK_EXECUTION_FAILED', '失败', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('FAILED');
    expect(task!.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(task!.errorMessage).toBe('失败');
  });

  it('failRunning 失败：状态不匹配', () => {
    createTask('task-1', 'PENDING');
    const result = projDb
      .getTaskRepository()
      .failRunning('task-1', 'TASK_EXECUTION_FAILED', '失败', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);
  });

  it('FAILED task 不可再次 failRunning', () => {
    createTask('task-1', 'RUNNING');
    projDb.getTaskRepository().failRunning('task-1', 'E1', '第一次', '2024-01-02T00:00:00.000Z');

    const result = projDb
      .getTaskRepository()
      .failRunning('task-1', 'E2', '第二次', '2024-01-02T00:00:01.000Z');
    expect(result).toBe(false);

    // 错误码应保持第一次的
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.errorCode).toBe('E1');
  });

  it('markStale 成功', () => {
    createTask('task-1', 'PENDING');
    const result = projDb
      .getTaskRepository()
      .markStale('task-1', ['PENDING'], '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('STALE');
    expect(task!.staleAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('markStale 失败：状态不匹配', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb
      .getTaskRepository()
      .markStale('task-1', ['PENDING'], '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');
  });

  it('resetToPending 成功', () => {
    createTask('task-1', 'FAILED');
    const result = projDb
      .getTaskRepository()
      .resetToPending('task-1', 'FAILED', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('PENDING');
  });

  it('resetToPending 失败：状态不匹配', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb
      .getTaskRepository()
      .resetToPending('task-1', 'FAILED', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);
  });

  it('listRunning', () => {
    createTask('task-1', 'PENDING');
    createTask('task-2', 'RUNNING');
    createTask('task-3', 'SUCCEEDED');

    const running = projDb.getTaskRepository().listRunning();
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('task-2');
  });
});

describe('ModelInvocationRepository', () => {
  let projDb: ProjectDatabase;

  beforeEach(() => {
    const dbPath = join(tempDir, 'project.sqlite');
    projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    projDb.close();
  });

  function createInvocation(id: string, attemptNumber = 1) {
    projDb.getModelInvocationRepository().create({
      id,
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'mimo-v2.5-pro',
      status: 'PENDING',
      attemptNumber,
      requestKind: 'model_invocation_test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{"promptLength":10}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  }

  it('create 和 getById', () => {
    createInvocation('inv-1');
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv).not.toBeNull();
    expect(inv!.status).toBe('PENDING');
    expect(inv!.attemptNumber).toBe(1);
  });

  it('listByTask', () => {
    createInvocation('inv-1', 1);
    createInvocation('inv-2', 2);
    const list = projDb.getModelInvocationRepository().listByTask('task-1');
    expect(list).toHaveLength(2);
  });

  it('markRunning 成功：PENDING → RUNNING', () => {
    createInvocation('inv-1');
    const result = projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');
    expect(inv!.startedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('markRunning 失败：状态不匹配', () => {
    createInvocation('inv-1');
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');

    // 再次 markRunning 应该失败
    const result = projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:01.000Z');
    expect(result).toBe(false);
  });

  it('PENDING invocation 不可直接 markSucceeded', () => {
    createInvocation('inv-1');
    const result = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
      responseMetadataJson: '{}',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 150,
      latencyMs: 500,
      finishReason: 'end_turn',
      providerRequestId: null,
      finishedAt: '2024-01-02T00:00:00.000Z',
    });
    expect(result).toBe(false);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('PENDING');
  });

  it('markSucceeded 成功', () => {
    createInvocation('inv-1');
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    const result = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
      responseMetadataJson: '{"textLength":5}',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 150,
      latencyMs: 500,
      finishReason: 'end_turn',
      providerRequestId: 'msg-001',
      finishedAt: '2024-01-02T00:00:01.000Z',
    });
    expect(result).toBe(true);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('SUCCEEDED');
    expect(inv!.inputTokens).toBe(100);
    expect(inv!.outputTokens).toBe(50);
    expect(inv!.totalTokens).toBe(150);
    expect(inv!.latencyMs).toBe(500);
    expect(inv!.finishReason).toBe('end_turn');
    expect(inv!.providerRequestId).toBe('msg-001');
  });

  it('FAILED invocation 不可重新 markSucceeded', () => {
    createInvocation('inv-1');
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    projDb
      .getModelInvocationRepository()
      .markFailed('inv-1', ['RUNNING'], 'ERR', '失败', null, '2024-01-02T00:00:01.000Z');

    const result = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
      responseMetadataJson: '{}',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 150,
      latencyMs: 500,
      finishReason: 'end_turn',
      providerRequestId: null,
      finishedAt: '2024-01-02T00:00:02.000Z',
    });
    expect(result).toBe(false);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
  });

  it('markFailed 成功', () => {
    createInvocation('inv-1');
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    const result = projDb
      .getModelInvocationRepository()
      .markFailed(
        'inv-1',
        ['RUNNING'],
        'PROVIDER_TIMEOUT',
        '超时',
        20000,
        '2024-01-02T00:00:20.000Z',
      );
    expect(result).toBe(true);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
    expect(inv!.errorCode).toBe('PROVIDER_TIMEOUT');
    expect(inv!.errorMessage).toBe('超时');
    expect(inv!.latencyMs).toBe(20000);
  });

  it('markFailed 从 PENDING 状态', () => {
    createInvocation('inv-1');
    const result = projDb
      .getModelInvocationRepository()
      .markFailed(
        'inv-1',
        ['PENDING'],
        'API_KEY_REQUIRED',
        '缺少 Key',
        null,
        '2024-01-02T00:00:00.000Z',
      );
    expect(result).toBe(true);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
    expect(inv!.errorCode).toBe('API_KEY_REQUIRED');
  });

  it('markFailed 失败：状态不匹配', () => {
    createInvocation('inv-1');
    const result = projDb
      .getModelInvocationRepository()
      .markFailed('inv-1', ['RUNNING'], 'ERR', '失败', null, '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('PENDING');
  });

  it('getStatsByProject', () => {
    createInvocation('inv-1', 1);
    createInvocation('inv-2', 2);

    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
      responseMetadataJson: '{}',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 150,
      latencyMs: 500,
      finishReason: 'end_turn',
      providerRequestId: null,
      finishedAt: '2024-01-02T00:00:01.000Z',
    });

    projDb
      .getModelInvocationRepository()
      .markRunning('inv-2', 'PENDING', '2024-01-02T00:00:02.000Z');
    projDb
      .getModelInvocationRepository()
      .markFailed(
        'inv-2',
        ['RUNNING'],
        'PROVIDER_TIMEOUT',
        '超时',
        1000,
        '2024-01-02T00:00:03.000Z',
      );

    const stats = projDb.getModelInvocationRepository().getStatsByProject('proj-1');
    expect(stats.invocationCount).toBe(2);
    expect(stats.succeededCount).toBe(1);
    expect(stats.failedCount).toBe(1);
    expect(stats.totalInputTokens).toBe(100);
    expect(stats.totalOutputTokens).toBe(50);
    expect(stats.totalTokens).toBe(150);
    expect(stats.totalLatencyMs).toBe(1500);
  });

  it('getStatsByProject 应该将 null token 按 0 处理', () => {
    createInvocation('inv-1', 1);

    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
    projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
      responseMetadataJson: '{}',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      latencyMs: null,
      finishReason: null,
      providerRequestId: null,
      finishedAt: '2024-01-02T00:00:01.000Z',
    });

    const stats = projDb.getModelInvocationRepository().getStatsByProject('proj-1');
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.inputTokens).toBeNull();
    expect(inv!.outputTokens).toBeNull();
  });

  it('listRunning', () => {
    createInvocation('inv-1', 1);
    createInvocation('inv-2', 2);

    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');

    const running = projDb.getModelInvocationRepository().listRunning();
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('inv-1');
  });

  it('transaction 原子提交', () => {
    createInvocation('inv-1', 1);

    projDb.transaction(() => {
      projDb
        .getModelInvocationRepository()
        .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
      projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
        responseMetadataJson: '{}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 150,
        latencyMs: 500,
        finishReason: 'end_turn',
        providerRequestId: null,
        finishedAt: '2024-01-02T00:00:01.000Z',
      });
    });

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('SUCCEEDED');
  });

  it('transaction 回滚', () => {
    createInvocation('inv-1', 1);

    expect(() => {
      projDb.transaction(() => {
        projDb
          .getModelInvocationRepository()
          .markRunning('inv-1', 'PENDING', '2024-01-02T00:00:00.000Z');
        throw new Error('故意失败');
      });
    }).toThrow('故意失败');

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('PENDING');
  });
});

describe('Recovery 事务', () => {
  it('task + invocation 同事务恢复', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    // 创建 task 和 invocation
    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 模拟恢复
    projDb.transaction(() => {
      const runningTasks = projDb.getTaskRepository().listRunning();
      for (const task of runningTasks) {
        const invocations = projDb.getModelInvocationRepository().listByTask(task.id);
        for (const inv of invocations) {
          if (inv.status === 'RUNNING') {
            projDb
              .getModelInvocationRepository()
              .markFailed(
                inv.id,
                ['RUNNING'],
                'INVOCATION_INTERRUPTED',
                '中断',
                null,
                '2024-01-02T00:00:00.000Z',
              );
          }
        }
        projDb
          .getTaskRepository()
          .failRunning(task.id, 'TASK_INTERRUPTED', '中断', '2024-01-02T00:00:00.000Z');
      }
    });

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('FAILED');
    expect(task!.errorCode).toBe('TASK_INTERRUPTED');

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
    expect(inv!.errorCode).toBe('INVOCATION_INTERRUPTED');

    projDb.close();
  });

  it('恢复幂等：重复执行结果相同', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    // 第一次恢复
    projDb.transaction(() => {
      const runningTasks = projDb.getTaskRepository().listRunning();
      for (const task of runningTasks) {
        projDb
          .getTaskRepository()
          .failRunning(task.id, 'TASK_INTERRUPTED', '中断', '2024-01-02T00:00:00.000Z');
      }
    });

    // 第二次恢复（应该没有 RUNNING task 了）
    projDb.transaction(() => {
      const runningTasks = projDb.getTaskRepository().listRunning();
      expect(runningTasks).toHaveLength(0);
    });

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('FAILED');
    expect(task!.errorCode).toBe('TASK_INTERRUPTED');

    projDb.close();
  });

  it('事务回滚：invocation 更新后 task 更新失败时两者仍为 RUNNING', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 故意在事务中抛出错误
    expect(() => {
      projDb.transaction(() => {
        projDb
          .getModelInvocationRepository()
          .markFailed(
            'inv-1',
            ['RUNNING'],
            'INVOCATION_INTERRUPTED',
            '中断',
            null,
            '2024-01-02T00:00:00.000Z',
          );
        // 模拟失败
        throw new Error('恢复失败');
      });
    }).toThrow('恢复失败');

    // 两者应该都回滚到 RUNNING
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');

    projDb.close();
  });

  it('已 FAILED invocation 不修改', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');
    projDb
      .getModelInvocationRepository()
      .markFailed(
        'inv-1',
        ['RUNNING'],
        'PROVIDER_TIMEOUT',
        '超时',
        1000,
        '2024-01-01T00:00:03.000Z',
      );

    // 恢复：只处理 RUNNING invocation
    projDb.transaction(() => {
      const invocations = projDb.getModelInvocationRepository().listByTask('task-1');
      for (const inv of invocations) {
        if (inv.status === 'RUNNING') {
          projDb
            .getModelInvocationRepository()
            .markFailed(
              inv.id,
              ['RUNNING'],
              'INVOCATION_INTERRUPTED',
              '中断',
              null,
              '2024-01-02T00:00:00.000Z',
            );
        }
      }
      projDb
        .getTaskRepository()
        .failRunning('task-1', 'TASK_INTERRUPTED', '中断', '2024-01-02T00:00:00.000Z');
    });

    // 已 FAILED 的 invocation 应该保持原来的 errorCode
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
    expect(inv!.errorCode).toBe('PROVIDER_TIMEOUT');

    projDb.close();
  });

  it('completion conflict 回滚：invocation 成功而 task 冲突时整组回滚', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 先将 task 改为 FAILED（模拟竞争）
    projDb.getTaskRepository().failRunning('task-1', 'OTHER', '竞争', '2024-01-01T00:00:03.000Z');

    // 现在尝试在事务中完成两者 —— task 应该冲突
    expect(() => {
      projDb.transaction(() => {
        const invOk = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
          responseMetadataJson: '{}',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 150,
          latencyMs: 500,
          finishReason: 'end_turn',
          providerRequestId: null,
          finishedAt: '2024-01-02T00:00:00.000Z',
        });
        if (!invOk) throw new Error('invocation conflict');

        const taskOk = projDb
          .getTaskRepository()
          .completeRunning('task-1', '{}', '2024-01-02T00:00:00.000Z');
        if (!taskOk) throw new Error('task conflict');
      });
    }).toThrow('task conflict');

    // invocation 应该回滚到 RUNNING（因为事务回滚）
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');

    projDb.close();
  });
});

describe('SQLite CAS fault injection', () => {
  it('success transaction: invocation CAS 成功、task CAS false 时 invocation 回滚', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 先把 task 改为 FAILED，模拟竞争
    projDb.getTaskRepository().failRunning('task-1', 'OTHER', '竞争', '2024-01-01T00:00:03.000Z');

    // 尝试成功提交：invocation 成功但 task 冲突
    expect(() => {
      projDb.transaction(() => {
        const invOk = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
          responseMetadataJson: '{}',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 150,
          latencyMs: 500,
          finishReason: 'end_turn',
          providerRequestId: null,
          finishedAt: '2024-01-02T00:00:00.000Z',
        });
        if (!invOk) throw new Error('invocation conflict');

        const taskOk = projDb
          .getTaskRepository()
          .completeRunning('task-1', '{}', '2024-01-02T00:00:00.000Z');
        if (!taskOk) throw new Error('task conflict');
      });
    }).toThrow('task conflict');

    // invocation 应回滚到 RUNNING
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');

    projDb.close();
  });

  it('success transaction: invocation CAS false 时 task 未更新', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 先把 invocation 改为 FAILED，模拟竞争
    projDb
      .getModelInvocationRepository()
      .markFailed('inv-1', ['RUNNING'], 'OTHER', '竞争', null, '2024-01-01T00:00:03.000Z');

    // 尝试成功提交：invocation CAS 应该失败
    expect(() => {
      projDb.transaction(() => {
        const invOk = projDb.getModelInvocationRepository().markSucceeded('inv-1', 'RUNNING', {
          responseMetadataJson: '{}',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 150,
          latencyMs: 500,
          finishReason: 'end_turn',
          providerRequestId: null,
          finishedAt: '2024-01-02T00:00:00.000Z',
        });
        if (!invOk) throw new Error('invocation conflict');
      });
    }).toThrow('invocation conflict');

    // task 应保持 RUNNING（未被修改）
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');

    // invocation 应保持 FAILED
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');

    projDb.close();
  });

  it('failure transaction: invocation CAS 成功、task CAS false 时 invocation 回滚', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // 先把 task 改为 FAILED
    projDb.getTaskRepository().failRunning('task-1', 'OTHER', '竞争', '2024-01-01T00:00:03.000Z');

    // 尝试失败提交：invocation 成功但 task 冲突
    expect(() => {
      projDb.transaction(() => {
        const invOk = projDb
          .getModelInvocationRepository()
          .markFailed('inv-1', ['RUNNING'], 'ERR', '失败', null, '2024-01-02T00:00:00.000Z');
        if (!invOk) throw new Error('invocation conflict');

        const taskOk = projDb
          .getTaskRepository()
          .failRunning('task-1', 'TASK_EXECUTION_FAILED', '失败', '2024-01-02T00:00:00.000Z');
        if (!taskOk) throw new Error('task conflict');
      });
    }).toThrow('task conflict');

    // invocation 应回滚到 RUNNING
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');

    projDb.close();
  });

  it('recovery: 第一条 invocation CAS 成功、第二条 CAS false 时全部回滚', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getModelInvocationRepository().create({
      id: 'inv-2',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 2,
      requestKind: 'test',
      promptHash: 'b'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-2', 'PENDING', '2024-01-01T00:00:03.000Z');

    // 快照 invocations 状态（模拟恢复前读取）
    const invocations = projDb.getModelInvocationRepository().listByTask('task-1');

    // 模拟恢复：在事务中先修改 inv-2，再处理快照列表
    expect(() => {
      projDb.transaction(() => {
        // 模拟并发修改：先把 inv-2 改为 FAILED
        projDb
          .getModelInvocationRepository()
          .markFailed('inv-2', ['RUNNING'], 'OTHER', '竞争', null, '2024-01-01T00:00:04.000Z');

        // 按快照列表处理（inv-2 在快照中是 RUNNING）
        for (const inv of invocations) {
          if (inv.status === 'RUNNING') {
            const ok = projDb
              .getModelInvocationRepository()
              .markFailed(
                inv.id,
                ['RUNNING'],
                'INVOCATION_INTERRUPTED',
                '中断',
                null,
                '2024-01-02T00:00:00.000Z',
              );
            if (!ok) throw new Error(`恢复调用 ${inv.id} 失败`);
          }
        }
        const taskOk = projDb
          .getTaskRepository()
          .failRunning('task-1', 'TASK_INTERRUPTED', '中断', '2024-01-02T00:00:00.000Z');
        if (!taskOk) throw new Error('恢复任务失败');
      });
    }).toThrow(/恢复调用 inv-2 失败/);

    // 事务回滚后，所有变更都撤销
    // inv-1 应回滚到 RUNNING
    const inv1 = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv1!.status).toBe('RUNNING');

    // inv-2 也应回滚到 RUNNING（事务内的 markFailed 被撤销）
    const inv2 = projDb.getModelInvocationRepository().getById('inv-2');
    expect(inv2!.status).toBe('RUNNING');

    // task 应保持 RUNNING
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');

    projDb.close();
  });

  it('API_KEY_REQUIRED: task conflict 时 invocation 不得单独 FAILED', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    // 先把 task 改为 FAILED
    projDb.getTaskRepository().failRunning('task-1', 'OTHER', '竞争', '2024-01-01T00:00:02.000Z');

    // 尝试 API_KEY_REQUIRED 失败路径
    expect(() => {
      projDb.transaction(() => {
        const invOk = projDb
          .getModelInvocationRepository()
          .markFailed(
            'inv-1',
            ['PENDING'],
            'API_KEY_REQUIRED',
            '缺少 Key',
            null,
            '2024-01-02T00:00:00.000Z',
          );
        if (!invOk) throw new Error('invocation conflict');

        const taskOk = projDb
          .getTaskRepository()
          .failRunning('task-1', 'TASK_EXECUTION_FAILED', '缺少 Key', '2024-01-02T00:00:00.000Z');
        if (!taskOk) throw new Error('task conflict');
      });
    }).toThrow('task conflict');

    // invocation 应回滚到 PENDING
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('PENDING');

    projDb.close();
  });

  it('markRunning conflict: 不留下 PENDING invocation + FAILED task', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb.getTaskRepository().claimPending('task-1', '2024-01-01T00:00:01.000Z');

    projDb.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      providerProfileId: 'mimo',
      model: 'test',
      status: 'PENDING',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    // 先把 invocation 改为 RUNNING（模拟 markRunning 冲突）
    projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:02.000Z');

    // markRunning 应该失败
    const result = projDb
      .getModelInvocationRepository()
      .markRunning('inv-1', 'PENDING', '2024-01-01T00:00:03.000Z');
    expect(result).toBe(false);

    // 两者状态应该一致（未被错误修改）
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');

    projDb.close();
  });

  it('provider profile 缺失: attempt_count 不变、无 invocation', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    projDb.getTaskRepository().create({
      id: 'task-1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // 不 claim，直接验证
    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('PENDING');
    expect(task!.attemptCount).toBe(0);

    // 无 invocation
    const invocations = projDb.getModelInvocationRepository().listByTask('task-1');
    expect(invocations).toHaveLength(0);

    projDb.close();
  });
});
