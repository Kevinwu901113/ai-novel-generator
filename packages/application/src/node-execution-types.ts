/**
 * Durable Node Execution & Settlement 类型（RW-1 Rework）。
 *
 * 建立所有真实节点（GE-3..GE-6）共同依赖的执行与 settlement 契约：
 * - 每次真实尝试 = 不可变新 execution row（attempt 单调递增，旧 row 保留 superseded/failed）；
 * - visit_id 区分新 activation 与同 activation infra retry；
 * - partial unique (graph_run_id, node_id) WHERE in-flight 作为并发 claim 原子门；
 * - execution-bound durable result envelope（execution_id 唯一）；
 * - ArtifactResolverPort 严格边界（存在性/归属/version 校验）。
 */

import type { ArtifactKind, GraphNodeId, GraphRunTerminalStatus } from '@ai-novel/domain';
import type { GraphRunKind } from './graph-run-types.js';
import type { TaskType } from '@ai-novel/domain';

// ── Executor ──────────────────────────────────────────────────────

export type NodeExecutorKind = 'sync' | 'task_backed' | 'human';

/** 恢复策略：与 Graph 业务 loop budget 分离的基础设施级策略 */
export type NodeRecoveryPolicy = 'replayable' | 'settle_if_result' | 'fail_closed';

/** executor 元数据（registry 条目） */
export interface NodeExecutorDescriptor {
  readonly executorId: string;
  readonly executorVersion: string;
  readonly graphKind: GraphRunKind;
  readonly nodeId: GraphNodeId;
  readonly kind: NodeExecutorKind;
  readonly recoveryPolicy: NodeRecoveryPolicy;
}

/** executor 查找键 */
export interface ExecutorKey {
  readonly graphKind: GraphRunKind;
  readonly nodeId: string;
}

// ── Node Execution 记录 ───────────────────────────────────────────

export type NodeExecutionStatus = 'pending' | 'running' | 'settled' | 'failed' | 'superseded';

export interface NodeExecutionRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly nodeId: string;
  readonly visitId: string;
  readonly attempt: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly recoveryPolicy: NodeRecoveryPolicy;
  readonly inputHash: string;
  readonly taskId: string | null;
  readonly status: NodeExecutionStatus;
  readonly artifactReceiptJson: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

export interface CreateNodeExecutionInput {
  readonly id: string;
  readonly graphRunId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly nodeId: string;
  readonly visitId: string;
  readonly attempt: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly recoveryPolicy: NodeRecoveryPolicy;
  readonly inputHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NodeExecutionRepositoryPort {
  /**
   * 插入；仅当违反 partial unique（同 run+node 已有 in-flight execution）时返回 false。
   * 其它 SQLite 错误必须抛出（禁止 catch 吞掉所有错误）。
   */
  create(input: CreateNodeExecutionInput): boolean;
  getById(id: string): NodeExecutionRecord | null;
  /** 某 run+node 的最新 execution（历史或 in-flight，按 attempt 降序） */
  getLatestByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null;
  /** 某 run+node 的 in-flight execution（pending/running；partial unique 保证至多一个） */
  getInFlightByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null;
  listActiveByRun(graphRunId: string): ReadonlyArray<NodeExecutionRecord>;
  /** CAS：pending → running；绑定 taskId */
  markRunning(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    taskId: string | null,
  ): boolean;
  markSettled(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    receiptJson: string | null,
    settledAt: string,
  ): boolean;
  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    errorCode: string,
  ): boolean;
  markSuperseded(id: string, expectedStatuses: ReadonlyArray<NodeExecutionStatus>): boolean;
}

// ── TaskSpec（无副作用；事务内创建 task）──────────────────────────

/** task-backed executor 返回的无副作用任务规格（不预先创建 task） */
export interface NodeTaskSpec {
  readonly taskType: TaskType;
  readonly payloadJson: string;
  readonly dedupeKey: string;
}

// ── Durable Result Envelope（execution-bound）─────────────────────

/** 严格 outcome（由 executor 产出并经校验） */
export interface StrictNodeOutcome {
  readonly condition: string;
  readonly value: string;
}

/** execution-bound 权威 durable result（execution_id 唯一） */
export interface NodeExecutionResultEnvelope {
  readonly executionId: string;
  readonly projectId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly taskId: string | null;
  readonly attempt: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly inputHash: string;
  readonly artifactKind: ArtifactKind | null;
  readonly artifactVersion: number | null;
  /** 完整权威内容（task 成功前持久化） */
  readonly contentJson: string | null;
  readonly outcome: StrictNodeOutcome | null;
  readonly createdAt: string;
}

export interface NodeExecutionResultStorePort {
  /** 在 task 成功事务内保存（execution_id 唯一） */
  save(envelope: NodeExecutionResultEnvelope): void;
  getByExecutionId(executionId: string): NodeExecutionResultEnvelope | null;
}

// ── Artifact 边界 ─────────────────────────────────────────────────

/** 由 executor 提议的 artifact 载荷（必须引用真实持久化对象，禁止任意字符串） */
export interface ArtifactPayload {
  readonly kind: ArtifactKind;
  readonly artifactId: string;
  readonly producerNodeId: string;
  readonly version: number;
}

/** 通过校验后的持久化 artifact receipt */
export interface PersistedArtifactReceipt {
  readonly kind: ArtifactKind;
  readonly artifactId: string;
  readonly producerNodeId: string;
  readonly projectId: string;
  readonly graphRunId: string;
  readonly graphVersion: string;
  readonly version: number;
}

/** executor 的节点输出 */
export interface NodeOutput {
  readonly outcome?: { readonly condition: string; readonly value: string };
  readonly artifact?: ArtifactPayload;
}

/**
 * Artifact 校验端口：settlement 的唯一 artifact 入口。
 * 校验存在性 / kind / project / run / version / producer node；
 * 不通过则抛错（fail-closed），绝不接受未验证的 ArtifactRef。
 */
export interface ArtifactResolverPort {
  resolve(input: {
    readonly projectId: string;
    readonly graphRunId: string;
    readonly graphVersion: string;
    readonly nodeId: string;
    readonly executionId: string;
    readonly proposed: ArtifactPayload;
  }): PersistedArtifactReceipt;
}

// ── Settlement 结果 ───────────────────────────────────────────────

export interface NodeSettlementResult {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly settled: boolean; // false = 重复 settlement（返回原结果）
  readonly terminalStatus: GraphRunTerminalStatus | null;
}

// ── 基础设施重试上限（与 Graph 业务 loop budget 分开）─────────────

export const INFRA_MAX_ATTEMPTS = 2;
