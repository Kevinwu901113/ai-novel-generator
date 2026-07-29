/**
 * 任务去重数据库测试。
 *
 * 验证 migration v4：
 * - tasks.task_type CHECK 支持 GRILL_QUESTION_PLAN；
 * - dedupe_key partial unique index 保证同一 key 至多一个 PENDING/RUNNING 任务；
 * - 任务终结后释放 dedupe_key，可重新创建。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';

let tempDir: string;
let db: ProjectDatabase;

const NOW = '2024-06-15T12:00:00.000Z';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'task-dedupe-test-'));
  db = new ProjectDatabase(join(tempDir, 'project.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function createPlanTask(id: string, dedupeKey: string): void {
  db.getTaskRepository().create({
    id,
    projectId: 'proj-1',
    taskType: 'GRILL_QUESTION_PLAN',
    status: 'PENDING',
    inputVersionJson: '{}',
    payloadJson: '{}',
    dedupeKey,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('tasks dedupe_key 与 GRILL_QUESTION_PLAN', () => {
  it('接受 GRILL_QUESTION_PLAN 任务类型（CHECK 已放宽）', () => {
    expect(() => createPlanTask('t1', 'grill_question_plan:sess-1:1')).not.toThrow();
    const task = db.getTaskRepository().getById('t1');
    expect(task?.taskType).toBe('GRILL_QUESTION_PLAN');
    expect(task?.dedupeKey).toBe('grill_question_plan:sess-1:1');
  });

  it('33. 同一 dedupe_key 的第二个 PENDING 任务被数据库拒绝', () => {
    createPlanTask('t1', 'grill_question_plan:sess-1:1');
    expect(() => createPlanTask('t2', 'grill_question_plan:sess-1:1')).toThrow();
  });

  it('RUNNING 状态同样占用 dedupe_key', () => {
    createPlanTask('t1', 'grill_question_plan:sess-1:1');
    db.getTaskRepository().claimPending('t1', NOW); // PENDING -> RUNNING
    expect(() => createPlanTask('t2', 'grill_question_plan:sess-1:1')).toThrow();
  });

  it('任务终结后释放 dedupe_key，可重新创建', () => {
    createPlanTask('t1', 'grill_question_plan:sess-1:1');
    db.getTaskRepository().claimPending('t1', NOW);
    db.getTaskRepository().completeRunning('t1', '{}', NOW); // RUNNING -> SUCCEEDED
    expect(() => createPlanTask('t2', 'grill_question_plan:sess-1:1')).not.toThrow();
  });

  it('STALE 后释放 dedupe_key', () => {
    createPlanTask('t1', 'grill_question_plan:sess-1:1');
    db.getTaskRepository().claimPending('t1', NOW);
    db.getTaskRepository().markStale('t1', ['RUNNING'], NOW);
    expect(() => createPlanTask('t2', 'grill_question_plan:sess-1:1')).not.toThrow();
  });

  it('不同 dedupe_key 互不影响', () => {
    createPlanTask('t1', 'grill_question_plan:sess-1:1');
    expect(() => createPlanTask('t2', 'grill_question_plan:sess-1:2')).not.toThrow();
    expect(() => createPlanTask('t3', 'grill_question_plan:sess-2:1')).not.toThrow();
  });

  it('无 dedupe_key 的任务不受去重约束', () => {
    db.getTaskRepository().create({
      id: 'm1',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getTaskRepository().create({
      id: 'm2',
      projectId: 'proj-1',
      taskType: 'MODEL_INVOCATION_TEST',
      status: 'PENDING',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(db.getTaskRepository().getById('m2')).not.toBeNull();
  });
});
