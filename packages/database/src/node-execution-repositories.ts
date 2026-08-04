/**
 * Durable Node Execution & Generation Artifact 持久化（RW-1）。
 *
 * - NodeExecutionRepositoryImpl：node_executions（唯一约束 (graph_run_id, node_id, attempt)）；
 * - GenerationArtifactStoreImpl：generation_artifacts（task 成功前持久化的权威产物）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateNodeExecutionInput,
  GenerationArtifactRecord,
  GenerationArtifactStorePort,
  NodeExecutionRecord,
  NodeExecutionRepositoryPort,
  NodeExecutionStatus,
  NodeRecoveryPolicy,
} from '@ai-novel/application';

interface DbNodeExecutionRow {
  id: string;
  graph_run_id: string;
  graph_id: string;
  graph_version: string;
  node_id: string;
  attempt: number;
  executor_id: string;
  executor_version: string;
  recovery_policy: NodeRecoveryPolicy;
  input_hash: string;
  task_id: string | null;
  status: NodeExecutionStatus;
  artifact_receipt_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

function decodeExecution(row: DbNodeExecutionRow): NodeExecutionRecord {
  return {
    id: row.id,
    graphRunId: row.graph_run_id,
    graphId: row.graph_id,
    graphVersion: row.graph_version,
    nodeId: row.node_id,
    attempt: row.attempt,
    executorId: row.executor_id,
    executorVersion: row.executor_version,
    recoveryPolicy: row.recovery_policy,
    inputHash: row.input_hash,
    taskId: row.task_id,
    status: row.status,
    artifactReceiptJson: row.artifact_receipt_json,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

export class NodeExecutionRepositoryImpl implements NodeExecutionRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateNodeExecutionInput): boolean {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO node_executions (
             id, graph_run_id, graph_id, graph_version, node_id, attempt,
             executor_id, executor_version, recovery_policy, input_hash,
             task_id, status, artifact_receipt_json, error_code, created_at, updated_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          input.id,
          input.graphRunId,
          input.graphId,
          input.graphVersion,
          input.nodeId,
          input.attempt,
          input.executorId,
          input.executorVersion,
          input.recoveryPolicy,
          input.inputHash,
          null,
          input.createdAt,
          input.updatedAt,
        );
      return result.changes === 1;
    } catch {
      // 唯一约束 (graph_run_id, node_id, attempt) 冲突 → 并发重复创建
      return false;
    }
  }

  getById(id: string): NodeExecutionRecord | null {
    const row = this.db.prepare('SELECT * FROM node_executions WHERE id = ?').get(id) as
      DbNodeExecutionRow | undefined;
    return row ? decodeExecution(row) : null;
  }

  getByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM node_executions WHERE graph_run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1',
      )
      .get(graphRunId, nodeId) as DbNodeExecutionRow | undefined;
    return row ? decodeExecution(row) : null;
  }

  listActiveByRun(graphRunId: string): ReadonlyArray<NodeExecutionRecord> {
    const rows = this.db
      .prepare(
        "SELECT * FROM node_executions WHERE graph_run_id = ? AND status IN ('pending','running') ORDER BY created_at ASC",
      )
      .all(graphRunId) as unknown as ReadonlyArray<DbNodeExecutionRow>;
    return rows.map(decodeExecution);
  }

  markRunning(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    taskId: string | null,
  ): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'running', task_id = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(taskId, new Date().toISOString(), id, ...expectedStatuses);
    return result.changes === 1;
  }

  markSettled(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    receiptJson: string | null,
    settledAt: string,
  ): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'settled', artifact_receipt_json = ?, settled_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(receiptJson, settledAt, settledAt, id, ...expectedStatuses);
    return result.changes === 1;
  }

  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    errorCode: string,
  ): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'failed', error_code = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(errorCode, new Date().toISOString(), id, ...expectedStatuses);
    return result.changes === 1;
  }

  retry(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    updatedAt: string,
  ): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'pending', attempt = attempt + 1, error_code = NULL, task_id = NULL, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(updatedAt, id, ...expectedStatuses);
    return result.changes === 1;
  }

  markSuperseded(id: string, expectedStatuses: ReadonlyArray<NodeExecutionStatus>): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'superseded', updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(new Date().toISOString(), id, ...expectedStatuses);
    return result.changes === 1;
  }
}

interface DbGenerationArtifactRow {
  id: string;
  project_id: string;
  graph_run_id: string;
  node_id: string;
  producer_executor_id: string;
  content_json: string;
  version: number;
  created_at: string;
}

function decodeArtifact(row: DbGenerationArtifactRow): GenerationArtifactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    graphRunId: row.graph_run_id,
    nodeId: row.node_id,
    producerExecutorId: row.producer_executor_id,
    contentJson: row.content_json,
    version: row.version,
    createdAt: row.created_at,
  };
}

export class GenerationArtifactStoreImpl implements GenerationArtifactStorePort {
  constructor(private readonly db: DatabaseSync) {}

  save(record: GenerationArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO generation_artifacts (
           id, project_id, graph_run_id, node_id, producer_executor_id, content_json, version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.graphRunId,
        record.nodeId,
        record.producerExecutorId,
        record.contentJson,
        record.version,
        record.createdAt,
      );
  }

  getById(id: string): GenerationArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM generation_artifacts WHERE id = ?').get(id) as
      DbGenerationArtifactRow | undefined;
    return row ? decodeArtifact(row) : null;
  }

  getLatestByRunNode(graphRunId: string, nodeId: string): GenerationArtifactRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM generation_artifacts WHERE graph_run_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(graphRunId, nodeId) as DbGenerationArtifactRow | undefined;
    return row ? decodeArtifact(row) : null;
  }
}
