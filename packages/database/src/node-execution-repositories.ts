/**
 * Durable Node Execution & Result 持久化（RW-1-R5）。
 *
 * - NodeExecutionRepositoryImpl：node_executions；每次真实尝试 = 不可变新 row
 *   （activation_no + attempt_no，attempt 仅在 activation 内递增）；unique
 *   (graph_run_id, node_id, activation_no, attempt_no) 防重复创建；partial unique
 *   (graph_run_id, node_id) WHERE in-flight 作为并发 claim 原子门；task_id 非空唯一；
 *   create 只把明确的 UNIQUE 冲突（in-flight partial unique）解释为并发，其它 SQLite
 *   错误抛出。getByTaskId 供任务 worker 反查权威 execution context。
 * - NodeExecutionResultStoreImpl：node_execution_results（execution_id 唯一 envelope；
 *   saveOrVerifySame 幂等：同内容 no-op，异内容抛错）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateNodeExecutionInput,
  NodeExecutionRecord,
  NodeExecutionRepositoryPort,
  NodeExecutionResultEnvelope,
  NodeExecutionResultStorePort,
  NodeExecutionStatus,
  NodeRecoveryPolicy,
} from '@ai-novel/application';

// SQLITE_CONSTRAINT_UNIQUE
const SQLITE_CONSTRAINT = 19;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

function sqliteErrorCode(err: unknown): number | null {
  if (err !== null && typeof err === 'object' && 'errcode' in err) {
    const code = (err as { errcode?: unknown }).errcode;
    if (typeof code === 'number') return code;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  if (code === SQLITE_CONSTRAINT_UNIQUE) return true;
  if (code === SQLITE_CONSTRAINT) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('UNIQUE constraint failed');
  }
  return false;
}

interface DbNodeExecutionRow {
  id: string;
  graph_run_id: string;
  graph_id: string;
  graph_version: string;
  node_id: string;
  activation_no: number;
  attempt_no: number;
  executor_id: string;
  executor_version: string;
  recovery_policy: NodeRecoveryPolicy;
  input_snapshot_json: string | null;
  input_hash: string;
  task_id: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
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
    activationNo: row.activation_no,
    attemptNo: row.attempt_no,
    executorId: row.executor_id,
    executorVersion: row.executor_version,
    recoveryPolicy: row.recovery_policy,
    inputSnapshotJson: row.input_snapshot_json,
    inputHash: row.input_hash,
    taskId: row.task_id,
    claimedBy: row.claimed_by,
    leaseExpiresAt: row.lease_expires_at,
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
             id, graph_run_id, graph_id, graph_version, node_id, activation_no, attempt_no,
             executor_id, executor_version, recovery_policy,
             input_snapshot_json, input_hash,
             task_id, claimed_by, lease_expires_at,
             status, artifact_receipt_json, error_code, created_at, updated_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                     'pending', NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          input.id,
          input.graphRunId,
          input.graphId,
          input.graphVersion,
          input.nodeId,
          input.activationNo,
          input.attemptNo,
          input.executorId,
          input.executorVersion,
          input.recoveryPolicy,
          input.inputSnapshotJson,
          input.inputHash,
          input.createdAt,
          input.updatedAt,
        );
      return result.changes === 1;
    } catch (err) {
      // 仅明确 UNIQUE 冲突（同 run+node 已有 in-flight）视为并发；其它错误必须抛出
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  getById(id: string): NodeExecutionRecord | null {
    const row = this.db.prepare('SELECT * FROM node_executions WHERE id = ?').get(id) as
      DbNodeExecutionRow | undefined;
    return row ? decodeExecution(row) : null;
  }

  getByTaskId(taskId: string): NodeExecutionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM node_executions WHERE task_id = ? LIMIT 1')
      .get(taskId) as DbNodeExecutionRow | undefined;
    return row ? decodeExecution(row) : null;
  }

  getLatestByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM node_executions WHERE graph_run_id = ? AND node_id = ? ORDER BY activation_no DESC, attempt_no DESC LIMIT 1',
      )
      .get(graphRunId, nodeId) as DbNodeExecutionRow | undefined;
    return row ? decodeExecution(row) : null;
  }

  getInFlightByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM node_executions WHERE graph_run_id = ? AND node_id = ? AND status IN ('pending','running') ORDER BY activation_no DESC, attempt_no DESC LIMIT 1",
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
    opts: {
      readonly taskId: string | null;
      readonly claimedBy: string | null;
      readonly leaseExpiresAt: string | null;
    },
  ): boolean {
    const placeholders = expectedStatuses.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE node_executions SET status = 'running', task_id = ?, claimed_by = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        opts.taskId,
        opts.claimedBy,
        opts.leaseExpiresAt,
        new Date().toISOString(),
        id,
        ...expectedStatuses,
      );
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

interface DbResultRow {
  execution_id: string;
  project_id: string;
  graph_run_id: string;
  node_id: string;
  task_id: string | null;
  activation_no: number;
  attempt_no: number;
  executor_id: string;
  executor_version: string;
  input_hash: string;
  artifact_kind: string | null;
  artifact_id: string | null;
  artifact_version: number | null;
  content_json: string | null;
  outcome_json: string | null;
  created_at: string;
}

function decodeResult(row: DbResultRow): NodeExecutionResultEnvelope {
  return {
    executionId: row.execution_id,
    projectId: row.project_id,
    graphRunId: row.graph_run_id,
    nodeId: row.node_id,
    taskId: row.task_id,
    activationNo: row.activation_no,
    attemptNo: row.attempt_no,
    executorId: row.executor_id,
    executorVersion: row.executor_version,
    inputHash: row.input_hash,
    artifactKind: (row.artifact_kind ?? null) as NodeExecutionResultEnvelope['artifactKind'],
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    contentJson: row.content_json,
    outcome: row.outcome_json
      ? (JSON.parse(row.outcome_json) as NodeExecutionResultEnvelope['outcome'])
      : null,
    createdAt: row.created_at,
  };
}

/** 逐字段比对两条 envelope（幂等 saveOrVerifySame 的一致性判定） */
function envelopesEqual(a: NodeExecutionResultEnvelope, b: NodeExecutionResultEnvelope): boolean {
  return (
    a.executionId === b.executionId &&
    a.projectId === b.projectId &&
    a.graphRunId === b.graphRunId &&
    a.nodeId === b.nodeId &&
    a.taskId === b.taskId &&
    a.activationNo === b.activationNo &&
    a.attemptNo === b.attemptNo &&
    a.executorId === b.executorId &&
    a.executorVersion === b.executorVersion &&
    a.inputHash === b.inputHash &&
    a.artifactKind === b.artifactKind &&
    a.artifactId === b.artifactId &&
    a.artifactVersion === b.artifactVersion &&
    a.contentJson === b.contentJson &&
    JSON.stringify(a.outcome) === JSON.stringify(b.outcome) &&
    a.createdAt === b.createdAt
  );
}

export class NodeExecutionResultStoreImpl implements NodeExecutionResultStorePort {
  constructor(private readonly db: DatabaseSync) {}

  save(envelope: NodeExecutionResultEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO node_execution_results (
           execution_id, project_id, graph_run_id, node_id, task_id, activation_no, attempt_no,
           executor_id, executor_version, input_hash,
           artifact_kind, artifact_id, artifact_version, content_json, outcome_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.executionId,
        envelope.projectId,
        envelope.graphRunId,
        envelope.nodeId,
        envelope.taskId,
        envelope.activationNo,
        envelope.attemptNo,
        envelope.executorId,
        envelope.executorVersion,
        envelope.inputHash,
        envelope.artifactKind,
        envelope.artifactId,
        envelope.artifactVersion,
        envelope.contentJson,
        envelope.outcome ? JSON.stringify(envelope.outcome) : null,
        envelope.createdAt,
      );
  }

  saveOrVerifySame(envelope: NodeExecutionResultEnvelope): void {
    const existing = this.getByExecutionId(envelope.executionId);
    if (existing === null) {
      this.save(envelope);
      return;
    }
    if (!envelopesEqual(existing, envelope)) {
      throw new Error(`execution ${envelope.executionId} 已有不同内容的权威 result，拒绝覆盖`);
    }
    // 同内容 → 幂等 no-op
  }

  getByExecutionId(executionId: string): NodeExecutionResultEnvelope | null {
    const row = this.db
      .prepare('SELECT * FROM node_execution_results WHERE execution_id = ?')
      .get(executionId) as DbResultRow | undefined;
    return row ? decodeResult(row) : null;
  }
}
