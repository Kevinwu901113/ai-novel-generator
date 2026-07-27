/**
 * 项目数据库（project.sqlite）实现。
 *
 * 管理单个小说项目的元数据。
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import { DatabaseSync } from 'node:sqlite';
import { SQLiteMigrator } from './migrator.js';
import {
  GrillSessionRepositoryImpl,
  GrillQuestionRepositoryImpl,
  GrillAnswerRepositoryImpl,
  GrillProposalRepositoryImpl,
} from './grill-repositories.js';
import type {
  ProjectDatabaseManager,
  ProjectMetadataRepository,
  ProjectMetadataRow,
  CreateProjectMetadataData,
  TaskRepository,
  TaskRow,
  CreateTaskData,
  DbTaskType,
  DbTaskStatus,
  ModelInvocationRepository,
  ModelInvocationRow,
  CreateInvocationData,
  DbInvocationStatus,
  InvocationStats,
  GrillSessionRepository,
  GrillQuestionRepository,
  GrillAnswerRepository,
  GrillProposalRepository,
  Migration,
} from './types.js';

// ── 迁移定义 ──────────────────────────────────────────────────────

const PROJECT_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_metadata (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initial_idea TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idea',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_version_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        stale_at TEXT,
        cancelled_at TEXT,
        CHECK (task_type IN ('PROVIDER_CONNECTION_TEST', 'MODEL_INVOCATION_TEST')),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(input_version_json)),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(project_id, created_at);

      CREATE TABLE IF NOT EXISTS model_invocations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        request_kind TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        request_metadata_json TEXT NOT NULL,
        response_metadata_json TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        finish_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        provider_request_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        CHECK (attempt_number >= 1),
        CHECK (length(prompt_hash) = 64),
        CHECK (json_valid(request_metadata_json)),
        CHECK (response_metadata_json IS NULL OR json_valid(response_metadata_json)),
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
        CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        CHECK (total_tokens IS NULL OR total_tokens >= 0),
        CHECK (latency_ms IS NULL OR latency_ms >= 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_invocations_task_attempt ON model_invocations(task_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_invocations_project_created ON model_invocations(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_invocations_status ON model_invocations(status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_task_attempt_unique
        ON model_invocations(task_id, attempt_number);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE grill_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        version INTEGER NOT NULL DEFAULT 1,
        goal TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        abandoned_at TEXT,
        CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED')),
        CHECK (version >= 1)
      ) STRICT;

      CREATE TABLE grill_questions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        topic TEXT NOT NULL,
        text TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PLANNED',
        depends_on_question_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        asked_at TEXT,
        answered_at TEXT,
        skipped_at TEXT,
        superseded_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        CHECK (status IN ('PLANNED', 'ASKED', 'ANSWERED', 'SKIPPED', 'SUPERSEDED')),
        CHECK (sequence >= 1),
        CHECK (json_valid(depends_on_question_ids))
      ) STRICT;

      CREATE UNIQUE INDEX idx_grill_questions_session_sequence
        ON grill_questions(session_id, sequence);

      CREATE TABLE grill_answers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'USER',
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        FOREIGN KEY (question_id) REFERENCES grill_questions(id),
        CHECK (source IN ('USER', 'IMPORTED')),
        CHECK (revision >= 1)
      ) STRICT;

      CREATE UNIQUE INDEX idx_grill_answers_question_revision
        ON grill_answers(question_id, revision);

      CREATE TABLE grill_inference_proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        based_on_answer_ids TEXT NOT NULL DEFAULT '[]',
        key TEXT NOT NULL,
        proposed_value_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PROPOSED',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
        CHECK (confidence >= 0 AND confidence <= 1),
        CHECK (json_valid(based_on_answer_ids)),
        CHECK (json_valid(proposed_value_json))
      ) STRICT;

      CREATE INDEX idx_grill_sessions_project ON grill_sessions(project_id);
      CREATE INDEX idx_grill_questions_session ON grill_questions(session_id);
      CREATE INDEX idx_grill_answers_session ON grill_answers(session_id);
      CREATE INDEX idx_grill_proposals_session ON grill_inference_proposals(session_id);
    `,
  },
];

// ── 项目元数据仓库实现 ────────────────────────────────────────────

class ProjectMetadataRepositoryImpl implements ProjectMetadataRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateProjectMetadataData): void {
    this.db
      .prepare(
        `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(data.id, data.name, data.initialIdea, data.status, data.createdAt, data.updatedAt);
  }

  get(): ProjectMetadataRow | null {
    const row = this.db
      .prepare(
        'SELECT id, name, initial_idea, status, created_at, updated_at FROM project_metadata LIMIT 1',
      )
      .get() as
      | {
          id: string;
          name: string;
          initial_idea: string;
          status: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      initialIdea: row.initial_idea,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  update(data: Partial<Omit<ProjectMetadataRow, 'id'>>): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];

    if (data.name !== undefined) {
      sets.push('name = ?');
      values.push(data.name);
    }
    if (data.initialIdea !== undefined) {
      sets.push('initial_idea = ?');
      values.push(data.initialIdea);
    }
    if (data.status !== undefined) {
      sets.push('status = ?');
      values.push(data.status);
    }
    if (data.createdAt !== undefined) {
      sets.push('created_at = ?');
      values.push(data.createdAt);
    }
    if (data.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      values.push(data.updatedAt);
    }

    if (sets.length === 0) return;

    this.db.prepare(`UPDATE project_metadata SET ${sets.join(', ')}`).run(...values);
  }
}

// ── 任务仓库实现 ──────────────────────────────────────────────────

class TaskRepositoryImpl implements TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateTaskData): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, task_type, status, input_version_json, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.taskType,
        data.status,
        data.inputVersionJson,
        data.payloadJson,
        data.createdAt,
        data.updatedAt,
      );
  }

  getById(id: string): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByProject(projectId: string, limit = 100): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  listByStatus(status: string): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE status = ? ORDER BY created_at`,
      )
      .all(status) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  claimPending(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET
           status = 'RUNNING',
           attempt_count = attempt_count + 1,
           started_at = ?,
           updated_at = ?,
           finished_at = NULL,
           error_code = NULL,
           error_message = NULL
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }

  completeRunning(id: string, resultJson: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'SUCCEEDED', result_json = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(resultJson, now, now, id);
    return result.changes === 1;
  }

  failRunning(id: string, errorCode: string, errorMessage: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(errorCode, errorMessage, now, now, id);
    return result.changes === 1;
  }

  markStale(id: string, expectedStatuses: ReadonlyArray<DbTaskStatus>, now: string): boolean {
    if (expectedStatuses.length === 0) return false;
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'STALE', updated_at = ?, stale_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(now, now, id, ...expectedStatuses);
    return result.changes === 1;
  }

  resetToPending(id: string, expectedStatus: DbTaskStatus, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(now, id, expectedStatus);
    return result.changes === 1;
  }

  listRunning(): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE status = 'RUNNING'`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: Record<string, unknown>): TaskRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskType: row.task_type as DbTaskType,
      status: row.status as DbTaskStatus,
      inputVersionJson: row.input_version_json as string,
      payloadJson: row.payload_json as string,
      resultJson: (row.result_json as string) ?? null,
      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      attemptCount: row.attempt_count as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
      staleAt: (row.stale_at as string) ?? null,
      cancelledAt: (row.cancelled_at as string) ?? null,
    };
  }
}

// ── 模型调用仓库实现 ──────────────────────────────────────────────

class ModelInvocationRepositoryImpl implements ModelInvocationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateInvocationData): void {
    this.db
      .prepare(
        `INSERT INTO model_invocations
           (id, project_id, task_id, provider_profile_id, model, status,
            attempt_number, request_kind, prompt_hash, request_metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.taskId,
        data.providerProfileId,
        data.model,
        data.status,
        data.attemptNumber,
        data.requestKind,
        data.promptHash,
        data.requestMetadataJson,
        data.createdAt,
      );
  }

  getById(id: string): ModelInvocationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByTask(taskId: string): ReadonlyArray<ModelInvocationRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE task_id = ? ORDER BY attempt_number`,
      )
      .all(taskId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  markRunning(id: string, expectedStatus: 'PENDING', now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE model_invocations SET status = 'RUNNING', started_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(now, id, expectedStatus);
    return result.changes === 1;
  }

  markSucceeded(
    id: string,
    expectedStatus: 'RUNNING',
    result: {
      responseMetadataJson: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      totalTokens: number | null;
      latencyMs: number | null;
      finishReason: string | null;
      providerRequestId: string | null;
      finishedAt: string;
    },
  ): boolean {
    const updateResult = this.db
      .prepare(
        `UPDATE model_invocations SET
           status = 'SUCCEEDED',
           response_metadata_json = ?,
           input_tokens = ?,
           output_tokens = ?,
           cache_read_tokens = ?,
           cache_write_tokens = ?,
           total_tokens = ?,
           latency_ms = ?,
           finish_reason = ?,
           provider_request_id = ?,
           finished_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        result.responseMetadataJson,
        result.inputTokens,
        result.outputTokens,
        result.cacheReadTokens,
        result.cacheWriteTokens,
        result.totalTokens,
        result.latencyMs,
        result.finishReason,
        result.providerRequestId,
        result.finishedAt,
        id,
        expectedStatus,
      );
    return updateResult.changes === 1;
  }

  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<DbInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
    finishedAt: string,
  ): boolean {
    if (expectedStatuses.length === 0) return false;
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE model_invocations SET
           status = 'FAILED', error_code = ?, error_message = ?,
           latency_ms = ?, finished_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(errorCode, errorMessage, latencyMs, finishedAt, id, ...expectedStatuses);
    return result.changes === 1;
  }

  getStatsByProject(projectId: string): InvocationStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as invocation_count,
           COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0) as succeeded_count,
           COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) as failed_count,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0) as total_input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0) as total_output_tokens,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) as total_tokens,
           COALESCE(SUM(COALESCE(latency_ms, 0)), 0) as total_latency_ms
         FROM model_invocations WHERE project_id = ?`,
      )
      .get(projectId) as Record<string, number>;

    return {
      invocationCount: row.invocation_count,
      succeededCount: row.succeeded_count,
      failedCount: row.failed_count,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalTokens: row.total_tokens,
      totalLatencyMs: row.total_latency_ms,
    };
  }

  listRunning(): ReadonlyArray<ModelInvocationRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE status = 'RUNNING'`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: Record<string, unknown>): ModelInvocationRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      providerProfileId: row.provider_profile_id as string,
      model: row.model as string,
      status: row.status as DbInvocationStatus,
      attemptNumber: row.attempt_number as number,
      requestKind: row.request_kind as string,
      promptHash: row.prompt_hash as string,
      requestMetadataJson: row.request_metadata_json as string,
      responseMetadataJson: (row.response_metadata_json as string) ?? null,
      inputTokens: (row.input_tokens as number) ?? null,
      outputTokens: (row.output_tokens as number) ?? null,
      cacheReadTokens: (row.cache_read_tokens as number) ?? null,
      cacheWriteTokens: (row.cache_write_tokens as number) ?? null,
      totalTokens: (row.total_tokens as number) ?? null,
      latencyMs: (row.latency_ms as number) ?? null,
      finishReason: (row.finish_reason as string) ?? null,
      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      providerRequestId: (row.provider_request_id as string) ?? null,
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
    };
  }
}

// ── 项目数据库管理器 ──────────────────────────────────────────────

export class ProjectDatabase implements ProjectDatabaseManager {
  private readonly db: DatabaseSync;
  private readonly metadataRepo: ProjectMetadataRepositoryImpl;
  private readonly taskRepo: TaskRepositoryImpl;
  private readonly invocationRepo: ModelInvocationRepositoryImpl;
  private readonly grillSessionRepo: GrillSessionRepositoryImpl;
  private readonly grillQuestionRepo: GrillQuestionRepositoryImpl;
  private readonly grillAnswerRepo: GrillAnswerRepositoryImpl;
  private readonly grillProposalRepo: GrillProposalRepositoryImpl;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);

    // 配置 SQLite
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // 运行迁移
    const migrator = new SQLiteMigrator(this.db);
    migrator.migrate(0, PROJECT_MIGRATIONS);

    this.metadataRepo = new ProjectMetadataRepositoryImpl(this.db);
    this.taskRepo = new TaskRepositoryImpl(this.db);
    this.invocationRepo = new ModelInvocationRepositoryImpl(this.db);
    this.grillSessionRepo = new GrillSessionRepositoryImpl(this.db);
    this.grillQuestionRepo = new GrillQuestionRepositoryImpl(this.db);
    this.grillAnswerRepo = new GrillAnswerRepositoryImpl(this.db);
    this.grillProposalRepo = new GrillProposalRepositoryImpl(this.db);
  }

  getProjectMetadataRepository(): ProjectMetadataRepository {
    return this.metadataRepo;
  }

  getTaskRepository(): TaskRepository {
    return this.taskRepo;
  }

  getModelInvocationRepository(): ModelInvocationRepository {
    return this.invocationRepo;
  }

  getGrillSessionRepository(): GrillSessionRepository {
    return this.grillSessionRepo;
  }

  getGrillQuestionRepository(): GrillQuestionRepository {
    return this.grillQuestionRepo;
  }

  getGrillAnswerRepository(): GrillAnswerRepository {
    return this.grillAnswerRepo;
  }

  getGrillProposalRepository(): GrillProposalRepository {
    return this.grillProposalRepo;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 验证项目数据库版本兼容性（不创建连接）。
 *
 * 打开项目时先检查版本，版本不兼容时给出明确错误。
 */
export function checkProjectDatabaseVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrator = new SQLiteMigrator(db);
    const currentVersion = migrator.getCurrentVersion();
    const maxSupported = Math.max(...PROJECT_MIGRATIONS.map((m) => m.version), 0);
    if (currentVersion > maxSupported) {
      throw new Error(
        `项目数据库版本 ${currentVersion} 高于应用支持的最高版本 ${maxSupported}，无法打开。请升级应用。`,
      );
    }
  } finally {
    db.close();
  }
}
