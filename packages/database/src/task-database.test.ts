/**
 * 任务和模型调用数据库测试。
 *
 * 验证迁移、CHECK 约束、索引、FK、仓库 CRUD。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

    // 验证 tasks 表存在
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

    // 创建合法任务
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
        taskType: 'INVALID_TYPE',
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
        status: 'INVALID_STATUS',
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

    // 先创建一个任务
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
        attemptNumber: 0, // 非法：必须 >= 1
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
        promptHash: 'short', // 非法：必须 64 字符
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

    // 创建合法调用
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

    // 尝试设置负数 token（通过直接 SQL）
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

    // 相同 task_id + attempt_number 应该失败
    expect(() => {
      projDb.getModelInvocationRepository().create({
        id: 'inv-2',
        projectId: 'proj-1',
        taskId: 'task-1',
        providerProfileId: 'mimo',
        model: 'test',
        status: 'PENDING',
        attemptNumber: 1, // 重复
        requestKind: 'test',
        promptHash: 'b'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
    }).toThrow();

    // 不同 attempt_number 应该成功
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

  function createTask(id: string, status = 'PENDING') {
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

  it('CAS transition 成功', () => {
    createTask('task-1', 'PENDING');
    const result = projDb
      .getTaskRepository()
      .transition('task-1', 'PENDING', 'RUNNING', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(true);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING');
  });

  it('CAS transition 失败（状态不匹配）', () => {
    createTask('task-1', 'RUNNING');
    const result = projDb
      .getTaskRepository()
      .transition('task-1', 'PENDING', 'RUNNING', '2024-01-02T00:00:00.000Z');
    expect(result).toBe(false);

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('RUNNING'); // 状态不变
  });

  it('双重 claim 只有一个成功', () => {
    createTask('task-1', 'PENDING');
    const result1 = projDb
      .getTaskRepository()
      .transition('task-1', 'PENDING', 'RUNNING', '2024-01-02T00:00:00.000Z');
    const result2 = projDb
      .getTaskRepository()
      .transition('task-1', 'PENDING', 'RUNNING', '2024-01-02T00:00:00.000Z');
    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });

  it('updateResult 原子提交', () => {
    createTask('task-1', 'RUNNING');
    projDb
      .getTaskRepository()
      .updateResult(
        'task-1',
        '{"accepted":true}',
        '2024-01-02T00:00:00.000Z',
        '2024-01-02T00:00:00.000Z',
      );

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('SUCCEEDED');
    expect(task!.resultJson).toBe('{"accepted":true}');
    expect(task!.finishedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('updateFailure 原子提交', () => {
    createTask('task-1', 'RUNNING');
    projDb
      .getTaskRepository()
      .updateFailure(
        'task-1',
        'TASK_EXECUTION_FAILED',
        '失败',
        '2024-01-02T00:00:00.000Z',
        '2024-01-02T00:00:00.000Z',
      );

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('FAILED');
    expect(task!.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(task!.errorMessage).toBe('失败');
  });

  it('incrementAttempt', () => {
    createTask('task-1', 'PENDING');
    projDb
      .getTaskRepository()
      .incrementAttempt('task-1', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.attemptCount).toBe(1);
    expect(task!.status).toBe('RUNNING');
  });

  it('markStale', () => {
    createTask('task-1', 'PENDING');
    projDb
      .getTaskRepository()
      .markStale('task-1', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z');

    const task = projDb.getTaskRepository().getById('task-1');
    expect(task!.status).toBe('STALE');
    expect(task!.staleAt).toBe('2024-01-02T00:00:00.000Z');
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

    // 创建一个任务
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

  it('markRunning', () => {
    createInvocation('inv-1');
    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('RUNNING');
    expect(inv!.startedAt).toBe('2024-01-02T00:00:00.000Z');
  });

  it('markSucceeded', () => {
    createInvocation('inv-1');
    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
    projDb.getModelInvocationRepository().markSucceeded('inv-1', {
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

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('SUCCEEDED');
    expect(inv!.inputTokens).toBe(100);
    expect(inv!.outputTokens).toBe(50);
    expect(inv!.totalTokens).toBe(150);
    expect(inv!.latencyMs).toBe(500);
    expect(inv!.finishReason).toBe('end_turn');
    expect(inv!.providerRequestId).toBe('msg-001');
  });

  it('markFailed', () => {
    createInvocation('inv-1');
    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
    projDb
      .getModelInvocationRepository()
      .markFailed('inv-1', 'PROVIDER_TIMEOUT', '超时', 20000, '2024-01-02T00:00:20.000Z');

    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('FAILED');
    expect(inv!.errorCode).toBe('PROVIDER_TIMEOUT');
    expect(inv!.errorMessage).toBe('超时');
    expect(inv!.latencyMs).toBe(20000);
  });

  it('getStatsByProject', () => {
    createInvocation('inv-1', 1);
    createInvocation('inv-2', 2);

    // inv-1 成功
    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
    projDb.getModelInvocationRepository().markSucceeded('inv-1', {
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

    // inv-2 失败
    projDb.getModelInvocationRepository().markRunning('inv-2', '2024-01-02T00:00:02.000Z');
    projDb
      .getModelInvocationRepository()
      .markFailed('inv-2', 'PROVIDER_TIMEOUT', '超时', 1000, '2024-01-02T00:00:03.000Z');

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

    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
    projDb.getModelInvocationRepository().markSucceeded('inv-1', {
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

    // 验证数据库中仍然是 null
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.inputTokens).toBeNull();
    expect(inv!.outputTokens).toBeNull();
  });

  it('listRunning', () => {
    createInvocation('inv-1', 1);
    createInvocation('inv-2', 2);

    projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');

    const running = projDb.getModelInvocationRepository().listRunning();
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('inv-1');
  });

  it('transaction 原子提交', () => {
    createInvocation('inv-1', 1);

    projDb.transaction(() => {
      projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
      projDb.getModelInvocationRepository().markSucceeded('inv-1', {
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
        projDb.getModelInvocationRepository().markRunning('inv-1', '2024-01-02T00:00:00.000Z');
        throw new Error('故意失败');
      });
    }).toThrow('故意失败');

    // 状态应该回滚到 PENDING
    const inv = projDb.getModelInvocationRepository().getById('inv-1');
    expect(inv!.status).toBe('PENDING');
  });
});
