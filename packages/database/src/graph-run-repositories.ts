/**
 * Graph Run 持久化仓库（GE-1）。
 *
 * - GraphRunRepositoryImpl：统一 graph_runs 表（kind 判别），state_json 存完整校验后的 domain run 状态；
 *   expected_version 独立列作 CAS 守卫。
 * - GraphRunCommandLogRepositoryImpl：graph_run_commands 幂等日志（PK 冲突 = 并发重复）。
 * - IdeaIntakeAnswerPortImpl：权威 grill_answers 写入（answer receipt 契约的写入目标）。
 *
 * 所有写方法必须在 GraphRunTransactionPortImpl 的 BEGIN IMMEDIATE 事务内调用。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AnyIdeaToNovelRunState, ChapterGenerationRunState } from '@ai-novel/domain';
import {
  CHAPTER_GENERATION_GRAPH_ID,
  isValidGraphNodeStatus,
  isValidGraphRunTerminalStatus,
} from '@ai-novel/domain';
import type {
  GraphRunCommandRecord,
  GraphRunCommandLogPort,
  GraphRunRepositoryPort,
  GraphRunStateRecord,
  IdeaIntakeAnswerPort,
} from '@ai-novel/application';

/** graph_runs 行 */
interface DbGraphRunRow {
  id: string;
  project_id: string;
  kind: 'project' | 'chapter';
  graph_id: string;
  graph_version: string;
  terminal_status: string | null;
  state_json: string;
  expected_version: number;
  creation_spec_version_id: string | null;
  research_bundle_id: string | null;
  story_blueprint_id: string | null;
  blueprint_chapter_id: string | null;
  created_at: string;
  updated_at: string;
}

function kindOfState(state: AnyIdeaToNovelRunState): 'project' | 'chapter' {
  return state.graphId === CHAPTER_GENERATION_GRAPH_ID ? 'chapter' : 'project';
}

/** 校验并解码 state_json（防损坏 JSON / 非法图身份） */
function decodeState(row: DbGraphRunRow): AnyIdeaToNovelRunState {
  const parsed: unknown = JSON.parse(row.state_json);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`graph_runs ${row.id} state_json 损坏`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.graphId !== 'string' || typeof obj.workflowRunId !== 'string') {
    throw new Error(`graph_runs ${row.id} state_json 缺少身份字段`);
  }
  if (typeof obj.nodeStatuses !== 'object' || obj.nodeStatuses === null) {
    throw new Error(`graph_runs ${row.id} state_json 缺少 nodeStatuses`);
  }
  for (const [nodeId, status] of Object.entries(obj.nodeStatuses as Record<string, unknown>)) {
    if (!isValidGraphNodeStatus(status)) {
      throw new Error(`graph_runs ${row.id} 节点 ${nodeId} 状态非法`);
    }
  }
  if (obj.terminalStatus !== null) {
    if (!isValidGraphRunTerminalStatus(obj.terminalStatus)) {
      throw new Error(`graph_runs ${row.id} terminalStatus 非法`);
    }
  }
  return obj as unknown as AnyIdeaToNovelRunState;
}

export class GraphRunRepositoryImpl implements GraphRunRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(state: AnyIdeaToNovelRunState, updatedAt: string): void {
    const kind = kindOfState(state);
    const isChapter = state.graphId === CHAPTER_GENERATION_GRAPH_ID;
    const chapter = isChapter ? (state as ChapterGenerationRunState) : null;
    const binding = isChapter
      ? {
          creationSpecVersionId: chapter!.creationSpecVersionId,
          researchBundleId: chapter!.researchBundleId,
          storyBlueprintId: chapter!.storyBlueprintId,
          blueprintChapterId: chapter!.blueprintChapterId,
        }
      : {
          creationSpecVersionId: null,
          researchBundleId: null,
          storyBlueprintId: null,
          blueprintChapterId: null,
        };
    this.db
      .prepare(
        `INSERT INTO graph_runs (
           id, project_id, kind, graph_id, graph_version, terminal_status,
           state_json, expected_version,
           creation_spec_version_id, research_bundle_id, story_blueprint_id, blueprint_chapter_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.workflowRunId,
        state.projectId,
        kind,
        state.graphId,
        state.graphVersion,
        state.terminalStatus,
        JSON.stringify(state),
        binding.creationSpecVersionId,
        binding.researchBundleId,
        binding.storyBlueprintId,
        binding.blueprintChapterId,
        state.createdAt,
        updatedAt,
      );
  }

  getById(runId: string): GraphRunStateRecord | null {
    const row = this.db.prepare('SELECT * FROM graph_runs WHERE id = ?').get(runId) as
      DbGraphRunRow | undefined;
    if (!row) return null;
    return {
      kind: row.kind,
      state: decodeState(row),
      expectedVersion: row.expected_version,
    };
  }

  listByProject(projectId: string): ReadonlyArray<GraphRunStateRecord> {
    const rows = this.db
      .prepare('SELECT * FROM graph_runs WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as ReadonlyArray<DbGraphRunRow>;
    return rows.map((row) => ({
      kind: row.kind,
      state: decodeState(row),
      expectedVersion: row.expected_version,
    }));
  }

  listNonTerminal(): ReadonlyArray<GraphRunStateRecord> {
    const rows = this.db
      .prepare('SELECT * FROM graph_runs WHERE terminal_status IS NULL ORDER BY created_at ASC')
      .all() as unknown as ReadonlyArray<DbGraphRunRow>;
    return rows.map((row) => ({
      kind: row.kind,
      state: decodeState(row),
      expectedVersion: row.expected_version,
    }));
  }

  saveWithCas(
    runId: string,
    expectedVersion: number,
    next: AnyIdeaToNovelRunState,
    updatedAt: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE graph_runs
            SET state_json = ?, terminal_status = ?,
                expected_version = expected_version + 1, updated_at = ?
          WHERE id = ? AND expected_version = ?`,
      )
      .run(JSON.stringify(next), next.terminalStatus, updatedAt, runId, expectedVersion);
    return result.changes === 1;
  }
}

export class GraphRunCommandLogRepositoryImpl implements GraphRunCommandLogPort {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): GraphRunCommandRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, command_type, payload_hash, applied_expected_version, applied_at
           FROM graph_run_commands WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          run_id: string;
          command_type: string;
          payload_hash: string;
          applied_expected_version: number;
          applied_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      commandType: row.command_type,
      payloadHash: row.payload_hash,
      appliedExpectedVersion: row.applied_expected_version,
      appliedAt: row.applied_at,
    };
  }

  insert(record: GraphRunCommandRecord): boolean {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO graph_run_commands (
             id, run_id, command_type, payload_hash, applied_expected_version, applied_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.runId,
          record.commandType,
          record.payloadHash,
          record.appliedExpectedVersion,
          record.appliedAt,
        );
      return result.changes === 1;
    } catch {
      // 主键冲突 = 并发重复命令
      return false;
    }
  }
}

/** 权威 answer 存储写入（grill_answers），revision 按 question 递增 */
export class IdeaIntakeAnswerPortImpl implements IdeaIntakeAnswerPort {
  constructor(private readonly db: DatabaseSync) {}

  insertAnswer(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly questionId: string;
    readonly text: string;
    readonly createdAt: string;
  }): void {
    const revision = this.db
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
           FROM grill_answers WHERE question_id = ?`,
      )
      .get(input.questionId) as { next_revision: number };
    this.db
      .prepare(
        `INSERT INTO grill_answers (
           id, session_id, question_id, revision, source, text, created_at
         ) VALUES (?, ?, ?, ?, 'USER', ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.questionId,
        revision.next_revision,
        input.text,
        input.createdAt,
      );
  }
}
