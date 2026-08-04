/**
 * TaskRepositoryPort 的 SQLite 适配（RW-1-R5, Blocker 3）。
 *
 * 把 database 包内建的 `TaskRepository`（数据库接口）适配为 application 的
 * `TaskRepositoryPort`，使 Graph 事务（`GraphRunTransactionRepositories.taskRepo`）
 * 能保证 execution、task 创建与绑定处于同一 BEGIN IMMEDIATE 事务。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TaskRepositoryPort, CreateTaskInput, TaskData } from '@ai-novel/application';
import type { TaskStatus } from '@ai-novel/domain';
import { TaskRepositoryImpl } from './project-database.js';
import type { TaskRow } from './types.js';

export class TaskRepositoryPortAdapter implements TaskRepositoryPort {
  private readonly repo: TaskRepositoryImpl;

  constructor(
    db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.repo = new TaskRepositoryImpl(db);
  }

  create(data: CreateTaskInput): void {
    this.repo.create({
      id: data.id,
      projectId: data.projectId,
      taskType: data.taskType,
      status: 'PENDING',
      inputVersionJson: data.inputVersionJson,
      payloadJson: data.payloadJson,
      dedupeKey: data.dedupeKey ?? null,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
  }

  getById(id: string): TaskData | null {
    const row = this.repo.getById(id);
    return row ? this.toTask(row) : null;
  }

  listByProject(projectId: string, limit?: number): ReadonlyArray<TaskData> {
    return this.repo.listByProject(projectId, limit).map(this.toTask);
  }

  listByStatus(status: TaskStatus): ReadonlyArray<TaskData> {
    return this.repo.listByStatus(status).map(this.toTask);
  }

  claimPending(id: string): boolean {
    return this.repo.claimPending(id, this.now());
  }

  completeRunning(id: string, resultJson: string): boolean {
    return this.repo.completeRunning(id, resultJson, this.now());
  }

  failRunning(id: string, errorCode: string, errorMessage: string): boolean {
    return this.repo.failRunning(id, errorCode, errorMessage, this.now());
  }

  failPending(id: string, errorCode: string, errorMessage: string): boolean {
    return this.repo.failPending(id, errorCode, errorMessage, this.now());
  }

  markStale(id: string, expectedStatuses: ReadonlyArray<TaskStatus>): boolean {
    return this.repo.markStale(id, expectedStatuses, this.now());
  }

  resetToPending(id: string, expectedStatus: TaskStatus): boolean {
    return this.repo.resetToPending(id, expectedStatus, this.now());
  }

  listRunning(): ReadonlyArray<TaskData> {
    return this.repo.listRunning().map(this.toTask);
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
