/**
 * Durable Node Execution & Settlement 类型（RW-1）。
 *
 * 建立所有真实节点（GE-3..GE-6）共同依赖的执行与 settlement 契约：
 * - NodeExecutorDescriptor / ExecutorRegistry：按 graph kind + nodeId 查找 executor；
 * - NodeExecutionRecord：每次真实节点执行的持久化记录（唯一约束防重复创建）；
 * - PersistedArtifactReceipt / ArtifactResolverPort：严格 artifact 边界
 *   （禁止 production executor 传任意字符串 ArtifactRef；存在性与归属由 settlement 校验）；
 * - GenerationArtifactStore：task 成功前持久化完整解析输出的权威存储。
 */

import type { ArtifactKind, GraphNodeId, GraphRunTerminalStatus } from '@ai-novel/domain';
import type { GraphRunKind } from './graph-run-types.js';

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
  readonly attempt: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly recoveryPolicy: NodeRecoveryPolicy;
  readonly inputHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NodeExecutionRepositoryPort {
  /** 插入；唯一约束 (graph_run_id, node_id, attempt) 冲突返回 false */
  create(input: CreateNodeExecutionInput): boolean;
  getById(id: string): NodeExecutionRecord | null;
  getByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null;
  /** 恢复扫描：某 run 的未完成执行（pending / running） */
  listActiveByRun(graphRunId: string): ReadonlyArray<NodeExecutionRecord>;
  /** CAS：pending → running；可绑定 taskId */
  markRunning(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    taskId: string | null,
  ): boolean;
  /** CAS：running/pending → settled；写入 receipt + settledAt */
  markSettled(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    receiptJson: string | null,
    settledAt: string,
  ): boolean;
  /** CAS：→ failed（errorCode） */
  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    errorCode: string,
  ): boolean;
  /** CAS 受控重试：→ pending + attempt++（受基础设施重试上限约束） */
  retry(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    updatedAt: string,
  ): boolean;
  /** CAS：→ superseded（同节点新 attempt 取代旧记录） */
  markSuperseded(id: string, expectedStatuses: ReadonlyArray<NodeExecutionStatus>): boolean;
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
    readonly proposed: ArtifactPayload;
  }): PersistedArtifactReceipt;
}

// ── Generation Artifact Store（task 成功前持久化）─────────────────

export interface GenerationArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly producerExecutorId: string;
  readonly contentJson: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface GenerationArtifactStorePort {
  /** 在 task 成功事务内持久化完整解析输出 */
  save(record: GenerationArtifactRecord): void;
  getById(id: string): GenerationArtifactRecord | null;
  /** 按 run+node 取最新（供 settlement 读取持久化结果） */
  getLatestByRunNode(graphRunId: string, nodeId: string): GenerationArtifactRecord | null;
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
