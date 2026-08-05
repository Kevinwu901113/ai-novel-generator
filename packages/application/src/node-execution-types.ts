/**
 * Durable Node Execution & Settlement 类型（RW-1-R5）。
 *
 * 建立所有真实节点（GE-3..GE-6）共同依赖的执行与 settlement 契约：
 * - 每次真实尝试 = 不可变新 execution row（activation_no + attempt_no；attempt 仅在
 *   activation 内递增；新 activation → activation_no+1 且 attempt_no=1）；
 * - unique(graph_run_id, node_id, activation_no, attempt_no) 防重复创建；
 *   partial unique (graph_run_id, node_id) WHERE in-flight 作为并发 claim 原子门；
 * - task_id 非空唯一（系统按 executionId 生成 dedupeKey，executor 不得自定义）；
 * - input_snapshot_json / input_hash 持久化（canonical input contract 声明输入子集，
 *   settlement 重算并拒绝 stale；infra retry 复用真实 persisted inputHash）；
 * - claimed_by / lease_expires_at：sync execution lease，未过期不得被其他 runner retry；
 * - executor API 拆分：SyncNodeExecutor.execute（真实执行）与
 *   TaskBackedNodeExecutor.prepareTask（同步、纯函数、无副作用，须在真实 execution 身份
 *   生成后调用）；任务 worker 经 getByTaskId 从 DB 取得权威 execution context；
 * - execution-bound durable result envelope（execution_id 唯一；含真实 artifactId）；
 * - ArtifactResolverPort 事务内严格边界（存在性/归属/version 校验，查询真实 repository）。
 */

import type { ArtifactKind, GraphNodeId, GraphRunTerminalStatus } from '@ai-novel/domain';
import type { GraphRunKind, GraphRunTransactionRepositories } from './graph-run-types.js';
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

/**
 * executor 可运行的权威执行上下文（在真实 executionId / activationNo / attemptNo /
 * inputHash 生成后注入；不再有空 visitId/inputHash 调用）。
 */
export interface NodeExecutionInputContext {
  readonly projectId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly activationNo: number;
  readonly attemptNo: number;
  /** canonical input snapshot（按节点 input contract 声明子集构造） */
  readonly inputSnapshot: unknown;
  readonly inputHash: string;
}

/** sync executor：真实执行，产出 NodeOutput（settlement 前不持久化） */
export interface SyncNodeExecutor {
  readonly descriptor: NodeExecutorDescriptor;
  execute(ctx: NodeExecutionInputContext): NodeOutput;
}

/**
 * task-backed executor：prepareTask 必须同步、纯函数、无副作用。
 * 只返回任务规格（不创建 task）；task 由 runner 在 claim 事务内按 executionId 创建并绑定。
 */
export interface TaskBackedNodeExecutor {
  readonly descriptor: NodeExecutorDescriptor;
  prepareTask(ctx: NodeExecutionInputContext): NodeTaskSpec;
}

/** 可运行 executor（sync 或 task-backed） */
export type NodeExecutorRunner = SyncNodeExecutor | TaskBackedNodeExecutor;

// ── Node Execution 记录 ───────────────────────────────────────────

export type NodeExecutionStatus = 'pending' | 'running' | 'settled' | 'failed' | 'superseded';

export interface NodeExecutionRecord {
  readonly id: string;
  readonly graphRunId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly nodeId: string;
  readonly activationNo: number;
  readonly attemptNo: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly recoveryPolicy: NodeRecoveryPolicy;
  /** canonical input snapshot（持久化；infra retry 复用） */
  readonly inputSnapshotJson: string | null;
  readonly inputHash: string;
  readonly taskId: string | null;
  /** 声称该 execution 的 runner 身份 */
  readonly claimedBy: string | null;
  /** sync execution lease 过期时间（task-backed 为 null，由任务生命周期管理） */
  readonly leaseExpiresAt: string | null;
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
  readonly activationNo: number;
  readonly attemptNo: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly recoveryPolicy: NodeRecoveryPolicy;
  /** canonical input snapshot 的 canonical serialization */
  readonly inputSnapshotJson: string;
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
  /** 任务 worker 经 taskId 取得权威 execution context（唯一反向查找） */
  getByTaskId(taskId: string): NodeExecutionRecord | null;
  /** 某 run+node 的最新 execution（历史或 in-flight，按 activation_no DESC, attempt_no DESC） */
  getLatestByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null;
  /** 某 run+node 的 in-flight execution（pending/running；partial unique 保证至多一个） */
  getInFlightByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null;
  listActiveByRun(graphRunId: string): ReadonlyArray<NodeExecutionRecord>;
  /**
   * CAS：pending → running；绑定 taskId / claimedBy / leaseExpiresAt。
   * sync execution 由 runner 设置 lease；task-backed 仅绑定 taskId（lease 为 null）。
   */
  markRunning(
    id: string,
    expectedStatuses: ReadonlyArray<NodeExecutionStatus>,
    opts: {
      readonly taskId: string | null;
      readonly claimedBy: string | null;
      readonly leaseExpiresAt: string | null;
    },
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

// ── TaskSpec（无副作用；事务内创建 task；executor 不控制 dedupeKey）──

/** task-backed executor 返回的无副作用任务规格（不预先创建 task） */
export interface NodeTaskSpec {
  readonly taskType: TaskType;
  readonly payloadJson: string;
  /** 不再含 executor-controlled dedupeKey：系统按 executionId 生成 */
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
  readonly activationNo: number;
  readonly attemptNo: number;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly inputHash: string;
  readonly artifactKind: ArtifactKind | null;
  /** 真实 artifactId（指向 research_bundles / story_blueprints / generation artifact 的真实 ID） */
  readonly artifactId: string | null;
  readonly artifactVersion: number | null;
  /** 完整权威内容（task 成功前持久化） */
  readonly contentJson: string | null;
  readonly outcome: StrictNodeOutcome | null;
  readonly createdAt: string;
}

export interface NodeExecutionResultStorePort {
  /** 在 task 成功事务内保存（execution_id 唯一） */
  save(envelope: NodeExecutionResultEnvelope): void;
  /**
   * 幂等保存：同 executionId 内容一致 → no-op；内容不一致 → 抛错；不存在 → 插入。
   * task finalization 崩溃重试时保证不覆盖权威结果。
   */
  saveOrVerifySame(envelope: NodeExecutionResultEnvelope): void;
  getByExecutionId(executionId: string): NodeExecutionResultEnvelope | null;
  /** 按 Graph ArtifactRef 的真实 artifactId 解析 generation artifact 内容（Blocker 5） */
  getByArtifactId(artifactId: string): NodeExecutionResultEnvelope | null;
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
 * execution→artifact 溯源（Blocker 5）。
 *
 * 每个产出 artifact 的 execution（含 sync）在 settlement 同事务持久化 provenance；
 * resolver 从持久化 provenance（而非调用方字段）校验 kind/id/version/project/run/node/execution。
 * generationRun 的权威 provenance 即 execution-bound envelope（含 execution_id + artifact_id）。
 */
export interface ArtifactProvenanceRecord {
  readonly artifactKind: ArtifactKind;
  readonly artifactId: string;
  readonly version: number;
  readonly projectId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly createdAt: string;
}

export interface ArtifactProvenanceRepoPort {
  /** 幂等：同 (kind,id) 同 execution 同 version → no-op；异 execution/version → 抛错 */
  upsert(record: ArtifactProvenanceRecord): void;
  getByArtifact(artifactKind: ArtifactKind, artifactId: string): ArtifactProvenanceRecord | null;
}

export interface ArtifactResolveInput {
  readonly projectId: string;
  readonly graphRunId: string;
  readonly graphVersion: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly proposed: ArtifactPayload;
}

/**
 * Artifact 校验端口：settlement 的唯一 artifact 入口。
 * 事务内查询真实 repository，校验存在性 / kind / project / run / version / producer node /
 * execution 归属；不通过则抛错（fail-closed），绝不接受未验证的 ArtifactRef。
 */
export interface ArtifactResolverPort {
  resolve(
    repos: GraphRunTransactionRepositories,
    input: ArtifactResolveInput,
  ): PersistedArtifactReceipt;
}

// ── Settlement 结果 ───────────────────────────────────────────────

export interface NodeSettlementResult {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly settled: boolean; // false = 重复 settlement（返回原结果）
  readonly terminalStatus: GraphRunTerminalStatus | null;
}

// ── 基础设施上限 / 租约 ───────────────────────────────────────────

/** 基础设施重试上限（与 Graph 业务 loop budget 分开） */
export const INFRA_MAX_ATTEMPTS = 2;

/** 仅明确的基础设施错误码可 infra retry（不包含业务性失败） */
export const INFRA_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'TASK_INTERRUPTED',
  'NODE_INTERRUPTED',
  'LEGACY_INTERRUPTED',
]);

/** sync execution lease 时长（未过期不得被其他 runner retry） */
export const SYNC_LEASE_MS = 5 * 60 * 1000;
