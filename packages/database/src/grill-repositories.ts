/**
 * Grill-me 仓库实现。
 *
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  GrillSessionRepository,
  GrillSessionRow,
  CreateGrillSessionData,
  DbGrillSessionStatus,
  GrillQuestionRepository,
  GrillQuestionRow,
  CreateGrillQuestionData,
  DbGrillQuestionStatus,
  GrillAnswerRepository,
  GrillAnswerRow,
  CreateGrillAnswerData,
  GrillProposalRepository,
  GrillProposalRow,
  CreateGrillProposalData,
  DbGrillProposalStatus,
  GrillQuestionPlanProposalRepository,
  GrillQuestionPlanProposalRow,
  CreateGrillQuestionPlanProposalData,
  DbGrillQuestionPlanProposalStatus,
} from './types.js';

// ── 烧烤会话仓库实现 ──────────────────────────────────────────────

export class GrillSessionRepositoryImpl implements GrillSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateGrillSessionData): void {
    this.db
      .prepare(
        `INSERT INTO grill_sessions (id, project_id, status, version, goal, created_at, updated_at)
         VALUES (?, ?, 'DRAFT', 1, ?, ?, ?)`,
      )
      .run(data.id, data.projectId, data.goal, data.createdAt, data.updatedAt);
  }

  getById(id: string): GrillSessionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, status, version, goal, created_at, updated_at,
                started_at, completed_at, abandoned_at
         FROM grill_sessions WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByProject(projectId: string): ReadonlyArray<GrillSessionRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, status, version, goal, created_at, updated_at,
                started_at, completed_at, abandoned_at
         FROM grill_sessions WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  transitionStatus(
    id: string,
    expectedVersion: number,
    newStatus: DbGrillSessionStatus,
    now: string,
  ): boolean {
    let timestampClause: string;
    switch (newStatus) {
      case 'ACTIVE':
        timestampClause = 'started_at = COALESCE(started_at, ?)';
        break;
      case 'COMPLETED':
        timestampClause = 'completed_at = ?';
        break;
      case 'ABANDONED':
        timestampClause = 'abandoned_at = ?';
        break;
      default:
        timestampClause = 'started_at = started_at';
        break;
    }

    const needsTimestamp =
      newStatus === 'ACTIVE' || newStatus === 'COMPLETED' || newStatus === 'ABANDONED';

    const sql = needsTimestamp
      ? `UPDATE grill_sessions SET status = ?, version = version + 1, updated_at = ?, ${timestampClause}
         WHERE id = ? AND version = ?`
      : `UPDATE grill_sessions SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`;

    const result = needsTimestamp
      ? this.db.prepare(sql).run(newStatus, now, now, id, expectedVersion)
      : this.db.prepare(sql).run(newStatus, now, id, expectedVersion);

    return result.changes === 1;
  }

  bumpVersion(id: string, expectedVersion: number, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE grill_sessions SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(now, id, expectedVersion);
    return result.changes === 1;
  }

  private toRow(row: Record<string, unknown>): GrillSessionRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      status: row.status as DbGrillSessionStatus,
      version: row.version as number,
      goal: row.goal as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      startedAt: (row.started_at as string) ?? null,
      completedAt: (row.completed_at as string) ?? null,
      abandonedAt: (row.abandoned_at as string) ?? null,
    };
  }
}

// ── 烧烤问题仓库实现 ──────────────────────────────────────────────

export class GrillQuestionRepositoryImpl implements GrillQuestionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateGrillQuestionData): void {
    this.db
      .prepare(
        `INSERT INTO grill_questions
           (id, session_id, sequence, topic, text, rationale, status, depends_on_question_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?)`,
      )
      .run(
        data.id,
        data.sessionId,
        data.sequence,
        data.topic,
        data.text,
        data.rationale,
        data.dependsOnQuestionIds,
        data.createdAt,
      );
  }

  getById(id: string): GrillQuestionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, sequence, topic, text, rationale, status,
                depends_on_question_ids, created_at, asked_at, answered_at, skipped_at, superseded_at
         FROM grill_questions WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listBySession(sessionId: string): ReadonlyArray<GrillQuestionRow> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, sequence, topic, text, rationale, status,
                depends_on_question_ids, created_at, asked_at, answered_at, skipped_at, superseded_at
         FROM grill_questions WHERE session_id = ? ORDER BY sequence`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  transitionStatus(
    id: string,
    expectedStatus: DbGrillQuestionStatus,
    newStatus: DbGrillQuestionStatus,
    now: string,
  ): boolean {
    let timestampColumn: string;
    switch (newStatus) {
      case 'ASKED':
        timestampColumn = 'asked_at';
        break;
      case 'ANSWERED':
        timestampColumn = 'answered_at';
        break;
      case 'SKIPPED':
        timestampColumn = 'skipped_at';
        break;
      case 'SUPERSEDED':
        timestampColumn = 'superseded_at';
        break;
      default:
        return false;
    }

    const result = this.db
      .prepare(
        `UPDATE grill_questions SET status = ?, ${timestampColumn} = ?
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, now, id, expectedStatus);
    return result.changes === 1;
  }

  getMaxSequence(sessionId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM grill_questions WHERE session_id = ?',
      )
      .get(sessionId) as { max_seq: number };
    return row.max_seq;
  }

  private toRow(row: Record<string, unknown>): GrillQuestionRow {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      sequence: row.sequence as number,
      topic: row.topic as string,
      text: row.text as string,
      rationale: row.rationale as string,
      status: row.status as DbGrillQuestionStatus,
      dependsOnQuestionIds: row.depends_on_question_ids as string,
      createdAt: row.created_at as string,
      askedAt: (row.asked_at as string) ?? null,
      answeredAt: (row.answered_at as string) ?? null,
      skippedAt: (row.skipped_at as string) ?? null,
      supersededAt: (row.superseded_at as string) ?? null,
    };
  }
}

// ── 烧烤回答仓库实现 ──────────────────────────────────────────────

export class GrillAnswerRepositoryImpl implements GrillAnswerRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateGrillAnswerData): void {
    this.db
      .prepare(
        `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.sessionId,
        data.questionId,
        data.revision,
        data.source,
        data.text,
        data.createdAt,
      );
  }

  getById(id: string): GrillAnswerRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, question_id, revision, source, text, created_at, superseded_at
         FROM grill_answers WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  getCurrentByQuestion(questionId: string): GrillAnswerRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, question_id, revision, source, text, created_at, superseded_at
         FROM grill_answers WHERE question_id = ? AND superseded_at IS NULL`,
      )
      .get(questionId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByQuestion(questionId: string): ReadonlyArray<GrillAnswerRow> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, question_id, revision, source, text, created_at, superseded_at
         FROM grill_answers WHERE question_id = ? ORDER BY revision`,
      )
      .all(questionId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  listCurrentBySession(sessionId: string): ReadonlyArray<GrillAnswerRow> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, question_id, revision, source, text, created_at, superseded_at
         FROM grill_answers WHERE session_id = ? AND superseded_at IS NULL ORDER BY created_at`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  supersedeCurrent(questionId: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE grill_answers SET superseded_at = ?
         WHERE question_id = ? AND superseded_at IS NULL`,
      )
      .run(now, questionId);
    return result.changes >= 1;
  }

  private toRow(row: Record<string, unknown>): GrillAnswerRow {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      questionId: row.question_id as string,
      revision: row.revision as number,
      source: row.source as 'USER' | 'IMPORTED',
      text: row.text as string,
      createdAt: row.created_at as string,
      supersededAt: (row.superseded_at as string) ?? null,
    };
  }
}

// ── 推理提案仓库实现 ──────────────────────────────────────────────

export class GrillProposalRepositoryImpl implements GrillProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateGrillProposalData): void {
    this.db
      .prepare(
        `INSERT INTO grill_inference_proposals
           (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, rationale, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?)`,
      )
      .run(
        data.id,
        data.sessionId,
        data.basedOnAnswerIds,
        data.key,
        data.proposedValueJson,
        data.confidence,
        data.rationale,
        data.createdAt,
      );
  }

  getById(id: string): GrillProposalRow | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, based_on_answer_ids, key, proposed_value_json,
                confidence, rationale, status, created_at, reviewed_at
         FROM grill_inference_proposals WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listBySession(sessionId: string): ReadonlyArray<GrillProposalRow> {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, based_on_answer_ids, key, proposed_value_json,
                confidence, rationale, status, created_at, reviewed_at
         FROM grill_inference_proposals WHERE session_id = ? ORDER BY created_at`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  transitionStatus(
    id: string,
    expectedStatus: DbGrillProposalStatus,
    newStatus: DbGrillProposalStatus,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE grill_inference_proposals SET status = ?, reviewed_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, now, id, expectedStatus);
    return result.changes === 1;
  }

  private toRow(row: Record<string, unknown>): GrillProposalRow {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      basedOnAnswerIds: row.based_on_answer_ids as string,
      key: row.key as string,
      proposedValueJson: row.proposed_value_json as string,
      confidence: row.confidence as number,
      rationale: row.rationale as string,
      status: row.status as DbGrillProposalStatus,
      createdAt: row.created_at as string,
      reviewedAt: (row.reviewed_at as string) ?? null,
    };
  }
}

// ── 烧烤问题规划提案仓库实现 ──────────────────────────────────────

export class GrillQuestionPlanProposalRepositoryImpl implements GrillQuestionPlanProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateGrillQuestionPlanProposalData): void {
    this.db
      .prepare(
        `INSERT INTO grill_question_plan_proposals
           (id, project_id, session_id, task_id, invocation_id,
            base_session_version, schema_version, questions_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.sessionId,
        data.taskId,
        data.invocationId,
        data.baseSessionVersion,
        data.schemaVersion,
        data.questionsJson,
        data.createdAt,
      );
  }

  getById(id: string): GrillQuestionPlanProposalRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, session_id, task_id, invocation_id,
                base_session_version, schema_version, questions_json,
                status, created_at, reviewed_at
         FROM grill_question_plan_proposals WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listBySession(sessionId: string): ReadonlyArray<GrillQuestionPlanProposalRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, session_id, task_id, invocation_id,
                base_session_version, schema_version, questions_json,
                status, created_at, reviewed_at
         FROM grill_question_plan_proposals WHERE session_id = ? ORDER BY created_at`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  transitionStatus(
    id: string,
    expectedStatus: DbGrillQuestionPlanProposalStatus,
    newStatus: DbGrillQuestionPlanProposalStatus,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE grill_question_plan_proposals SET status = ?, reviewed_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(newStatus, now, id, expectedStatus);
    return result.changes === 1;
  }

  private toRow(row: Record<string, unknown>): GrillQuestionPlanProposalRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      sessionId: row.session_id as string,
      taskId: row.task_id as string,
      invocationId: row.invocation_id as string,
      baseSessionVersion: row.base_session_version as number,
      schemaVersion: row.schema_version as number,
      questionsJson: row.questions_json as string,
      status: row.status as DbGrillQuestionPlanProposalStatus,
      createdAt: row.created_at as string,
      reviewedAt: (row.reviewed_at as string) ?? null,
    };
  }
}
