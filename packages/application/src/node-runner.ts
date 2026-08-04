/**
 * NodeRunner（RW-1-R5）。
 *
 * 生产级 runner：扫描 Graph active frontier（**全量** dispatch，支持 fan-out 并行），
 * 为 active 非人工节点创建/恢复持久化 execution，最终只经 NodeSettlementService 完成节点。
 *
 * 硬约束（RW-1-R5）：
 * - 不使用测试专用 runFakeUntilHumanOrTerminal；executor 不得直接写 graph_runs；
 * - 每次真实尝试 = 不可变新 execution row（activation_no + attempt_no；attempt 仅在
 *   activation 内递增；新 activation → activation_no+1 且 attempt_no=1）；
 * - **initial execution 与 infra retry 复用同一原子 claim path**（claimExecution）；
 *   task-backed retry 必须创建/绑定/调度新 task（dedupeKey=exec:executionId）；
 *   sync retry 复用真实 persisted inputHash/inputSnapshot；
 * - prepareTask 在真实 executionId/activationNo/attemptNo/inputHash 生成后同步调用
 *   （纯函数、无副作用），绝不预先用空 visitId/inputHash 调用；
 * - 仅明确基础设施错误码（TASK_INTERRUPTED / NODE_INTERRUPTED）可 infra retry；
 *   sync execution 有 lease（claimed_by + lease_expires_at），未过期不得被其他 runner retry；
 * - 失败走原子路径 failExecutionAndNodeInTransaction（execution failed + applyNodeFailure
 *   + Graph CAS + command log 同一事务）；禁止 blanket catch failNode；
 * - settlement 错误分类：确定性失败 → 原子失败；Graph CAS conflict → 可重试不误标 failed。
 */

import type {
  AnyIdeaToNovelGraphV1,
  AnyIdeaToNovelRunState,
  GraphRunTerminalStatus,
} from '@ai-novel/domain';
import type { GraphRunDeps } from './graph-run.js';
import { failNodeInTransaction, getRunProgress } from './graph-run.js';
import {
  GraphRunStateConflictError,
  GraphRunValidationError,
  GraphRunVersionConflictError,
} from './graph-run-errors.js';
import { computeNodeInputSnapshot, inputHashOf, serializeInputSnapshot } from './node-input.js';
import {
  failExecutionAndNodeInTransaction,
  settleNodeExecution,
  NodeSettlementError,
} from './node-settlement.js';
import {
  INFRA_MAX_ATTEMPTS,
  INFRA_RETRYABLE_CODES,
  SYNC_LEASE_MS,
  type NodeExecutionInputContext,
  type NodeExecutionRecord,
  type NodeExecutorDescriptor,
  type NodeExecutorRunner,
  type NodeOutput,
  type NodeSettlementResult,
  type NodeTaskSpec,
  type SyncNodeExecutor,
  type TaskBackedNodeExecutor,
} from './node-execution-types.js';
import type { GraphRunTransactionRepositories } from './graph-run-types.js';
import type { NodeSettlementDeps } from './node-settlement.js';

/** NodeRunner 依赖（NodeSettlementDeps + runner 侧接线） */
export interface NodeRunnerDeps extends NodeSettlementDeps {
  readonly runners: ReadonlyMap<string, NodeExecutorRunner>;
  /** 声称 execution 的 runner 身份（claimed_by / lease） */
  readonly runnerId: string;
  /** 提交后调度 task-backed 任务（Worker 接线；RW-1 测试可为 no-op） */
  readonly scheduleTask?: (taskId: string) => void;
}

function isHumanGateKind(kind: string): boolean {
  return kind === 'CLARIFY_ANSWER' || kind === 'USER_GATE';
}

export type NodeDispatchResult =
  | { readonly kind: 'sync'; readonly output: NodeOutput }
  | { readonly kind: 'task'; readonly spec: NodeTaskSpec };

function graphFor(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === deps.projectGraph.id) return deps.projectGraph;
  if (graphId === deps.chapterGraph.id) return deps.chapterGraph;
  throw new Error(`未知 graphId: ${graphId}`);
}

function descriptorFor(
  deps: NodeRunnerDeps,
  state: AnyIdeaToNovelRunState,
  nodeId: string,
): NodeExecutorDescriptor | null {
  return deps.registry.get({
    graphKind: state.graphId === deps.projectGraph.id ? 'project' : 'chapter',
    nodeId,
  });
}

function runnerFor(deps: NodeRunnerDeps, descriptor: NodeExecutorDescriptor): NodeExecutorRunner {
  const runner = deps.runners.get(descriptor.executorId);
  if (!runner) {
    throw new Error(`executor ${descriptor.executorId} 未注册 runner`);
  }
  return runner;
}

// ── infra retry 判定 ─────────────────────────────────────────────

/** 可计 infra retry 次数（同 activation 内 attempt < 上限） */
function canInfraRetryCount(exec: NodeExecutionRecord): boolean {
  return exec.recoveryPolicy === 'replayable' && exec.attemptNo < INFRA_MAX_ATTEMPTS;
}

/** 明确基础设施错误码（业务性失败不可 retry） */
function isInfraInterrupted(errorCode: string | null): boolean {
  return errorCode !== null && INFRA_RETRYABLE_CODES.has(errorCode);
}

function isLeaseExpired(deps: GraphRunDeps, exec: NodeExecutionRecord): boolean {
  if (exec.leaseExpiresAt === null) return true;
  return Date.parse(exec.leaseExpiresAt) <= Date.parse(deps.clock.now());
}

function leaseExpiry(deps: GraphRunDeps): string {
  return new Date(Date.parse(deps.clock.now()) + SYNC_LEASE_MS).toISOString();
}

function isRetryableConflict(err: unknown): boolean {
  return err instanceof GraphRunVersionConflictError;
}

function errorCodeOf(err: unknown): string {
  return err instanceof NodeSettlementError ? err.code : 'NODE_EXECUTION_FAILED';
}

// ── 统一 claim（initial + infra retry 共用同一原子路径）────────────

interface ClaimSuccess {
  readonly status: 'claimed';
  readonly executionId: string;
  readonly activationNo: number;
  readonly attemptNo: number;
  readonly inputHash: string;
  readonly inputSnapshot: unknown;
  readonly taskId?: string;
}

type ClaimResult =
  ClaimSuccess | { readonly status: 'not_active' } | { readonly status: 'concurrent' };

/**
 * 在已打开事务内原子 claim：
 * - re-read run（node 仍 active）→ 判定 activation/attempt → 创建 execution row；
 * - previousOverride（infra retry）→ supersede 旧 execution，同 activation attempt+1，
 *   复用真实 persisted inputHash/inputSnapshot；
 * - 无 previousOverride 且 latest failed + infra retryable → 同 activation 续 attempt；
 * - 否则新 activation（activation_no+1, attempt_no=1）并计算新 input snapshot；
 * - task-backed：真实身份生成后同步调用 prepareTask（纯函数）→ 创建 task
 *   （dedupeKey=`exec:${executionId}`）→ 绑定 taskId + markRunning；
 * - sync：markRunning（claimed_by + lease）。
 */
function claimExecution(
  deps: NodeRunnerDeps,
  repos: GraphRunTransactionRepositories,
  ctx: {
    readonly projectId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly descriptor: NodeExecutorDescriptor;
    readonly runner: NodeExecutorRunner;
    readonly previousOverride?: NodeExecutionRecord;
  },
): ClaimResult {
  const { projectId, runId, nodeId, descriptor, runner, previousOverride } = ctx;
  const fresh = repos.graphRunRepo.getById(runId);
  if (!fresh || fresh.state.nodeStatuses[nodeId as never] !== 'active') {
    return { status: 'not_active' };
  }
  const latest = repos.nodeExecutionRepo.getLatestByRunNode(runId, nodeId);

  let previous: NodeExecutionRecord | null = null;
  let activationNo: number;
  let attemptNo: number;
  if (previousOverride) {
    previous = previousOverride;
    activationNo = previous.activationNo;
    attemptNo = previous.attemptNo + 1;
    // 旧 in-flight 必须 supersede（并发安全；同 activation 下一 attempt）
    if (previous.status === 'pending' || previous.status === 'running') {
      const superseded = repos.nodeExecutionRepo.markSuperseded(previous.id, [
        'pending',
        'running',
      ]);
      if (!superseded) return { status: 'concurrent' };
    }
  } else if (
    latest !== null &&
    latest.status === 'failed' &&
    canInfraRetryCount(latest) &&
    isInfraInterrupted(latest.errorCode)
  ) {
    previous = latest;
    activationNo = latest.activationNo;
    attemptNo = latest.attemptNo + 1;
  } else {
    activationNo = (latest?.activationNo ?? 0) + 1;
    attemptNo = 1;
  }

  const executionId = deps.idGenerator.generate();
  // sync / task infra retry 复用真实 persisted input；新 activation 计算 input snapshot
  let inputSnapshotJson: string;
  let inputHash: string;
  if (previous !== null && previous.inputSnapshotJson !== null) {
    inputSnapshotJson = previous.inputSnapshotJson;
    inputHash = previous.inputHash;
  } else {
    const graph = graphFor(deps, fresh.state.graphId);
    const snapshot = computeNodeInputSnapshot(graph, fresh.state, nodeId, activationNo);
    inputSnapshotJson = serializeInputSnapshot(snapshot);
    inputHash = inputHashOf(deps.hashPayload, snapshot);
  }
  const now = deps.clock.now();

  const created = repos.nodeExecutionRepo.create({
    id: executionId,
    graphRunId: runId,
    graphId: fresh.state.graphId,
    graphVersion: fresh.state.graphVersion,
    nodeId,
    activationNo,
    attemptNo,
    executorId: descriptor.executorId,
    executorVersion: descriptor.executorVersion,
    recoveryPolicy: descriptor.recoveryPolicy,
    inputSnapshotJson,
    inputHash,
    createdAt: now,
    updatedAt: now,
  });
  if (!created) return { status: 'concurrent' };

  const execCtx: NodeExecutionInputContext = {
    projectId,
    graphRunId: runId,
    nodeId,
    executionId,
    activationNo,
    attemptNo,
    inputSnapshot: JSON.parse(inputSnapshotJson),
    inputHash,
  };

  if (descriptor.kind === 'task_backed') {
    // prepareTask 必须在真实身份生成后同步调用（纯函数、无副作用）
    let taskSpec: NodeTaskSpec;
    try {
      taskSpec = (runner as TaskBackedNodeExecutor).prepareTask(execCtx);
    } catch (err) {
      // prepareTask 失败 → 事务回滚（无 execution 残留）；上层 fail-closed
      throw new Error(`prepareTask 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const taskId = deps.idGenerator.generate();
    // Blocker 3：task 创建必须与 execution 同事务（repos.taskRepo）
    repos.taskRepo.create({
      id: taskId,
      projectId,
      taskType: taskSpec.taskType,
      inputVersionJson: '{}',
      payloadJson: taskSpec.payloadJson,
      dedupeKey: `exec:${executionId}`,
    });
    const running = repos.nodeExecutionRepo.markRunning(executionId, ['pending'], {
      taskId,
      claimedBy: deps.runnerId,
      leaseExpiresAt: null,
    });
    // 不变量：刚插入的 execution 必须能标记 running；否则整个事务回滚（不允许残留 pending+task）
    if (!running) {
      throw new Error(
        `claim 不变量破坏：execution ${executionId} 刚插入后 markRunning 失败（状态非 pending）`,
      );
    }
    return {
      status: 'claimed',
      executionId,
      activationNo,
      attemptNo,
      inputHash,
      inputSnapshot: execCtx.inputSnapshot,
      taskId,
    };
  }

  const running = repos.nodeExecutionRepo.markRunning(executionId, ['pending'], {
    taskId: null,
    claimedBy: deps.runnerId,
    leaseExpiresAt: leaseExpiry(deps),
  });
  if (!running) {
    throw new Error(
      `claim 不变量破坏：execution ${executionId} 刚插入后 markRunning 失败（状态非 pending）`,
    );
  }
  return {
    status: 'claimed',
    executionId,
    activationNo,
    attemptNo,
    inputHash,
    inputSnapshot: execCtx.inputSnapshot,
  };
}

// ── 顶层推进 ──────────────────────────────────────────────────────

/** 单次 driveRun 的可变状态（settlement 结果 + 本轮已重新调度的 PENDING task） */
interface DriveState {
  readonly settled: NodeSettlementResult[];
  readonly rescheduled: Set<string>;
}

export async function driveRun(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
): Promise<ReadonlyArray<NodeSettlementResult>> {
  const drive: DriveState = { settled: [], rescheduled: new Set() };
  for (let round = 0; round < 200; round += 1) {
    const state = getRunProgress(deps, { projectId, runId });
    if (state.terminalStatus !== null) break;
    if (state.pendingHumanDecision !== null) break;

    const graph = graphFor(deps, state.graphId);
    const frontier = graph.nodes.filter(
      (n) => state.nodeStatuses[n.id] === 'active' && !isHumanGateKind(n.kind),
    );
    if (frontier.length === 0) break;

    let anyProgress = false;
    for (const node of frontier) {
      const progressed = await dispatchNode(deps, projectId, runId, node.id, drive);
      if (progressed) anyProgress = true;
    }
    if (!anyProgress) break;
  }
  return drive.settled;
}

/** 为单个 active 节点恢复或创建 execution 并分发；返回是否取得进展 */
async function dispatchNode(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  drive: DriveState,
): Promise<boolean> {
  const inFlight = deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.getInFlightByRunNode(runId, nodeId),
  );
  if (inFlight) {
    if (inFlight.status === 'pending') {
      return reDispatchPending(deps, projectId, runId, nodeId, inFlight, drive);
    }
    // running
    if (inFlight.taskId !== null) {
      return reconcileTaskBackedRunning(deps, projectId, runId, nodeId, inFlight, drive);
    }
    // sync running：依据 lease
    if (isLeaseExpired(deps, inFlight)) {
      return claimAndDispatch(deps, projectId, runId, nodeId, drive, inFlight);
    }
    return false; // lease 未过期：其他 runner 活跃 → 保持
  }
  return claimAndDispatch(deps, projectId, runId, nodeId, drive, undefined);
}

/** 统一 claim + dispatch（initial 或 infra retry） */
async function claimAndDispatch(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  drive: DriveState,
  previousOverride?: NodeExecutionRecord,
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, state, nodeId);
  if (!descriptor || descriptor.kind === 'human') {
    return failClosedNode(deps, projectId, runId, nodeId, undefined, 'EXECUTOR_NOT_REGISTERED');
  }
  let runner: NodeExecutorRunner;
  try {
    runner = runnerFor(deps, descriptor);
  } catch {
    return failClosedNode(deps, projectId, runId, nodeId, undefined, 'EXECUTOR_NOT_FOUND');
  }

  let claim: ClaimResult;
  try {
    claim = deps.tx.runInTransaction((repos) =>
      claimExecution(deps, repos, {
        projectId,
        runId,
        nodeId,
        descriptor,
        runner,
        previousOverride,
      }),
    );
  } catch {
    // claim 事务失败（prepareTask / task 创建失败）→ fail-closed（无 execution 残留）
    return failClosedNode(deps, projectId, runId, nodeId, undefined, 'EXECUTOR_ERROR');
  }
  if (claim.status === 'not_active') return true;
  if (claim.status === 'concurrent') {
    const inFlight = deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.getInFlightByRunNode(runId, nodeId),
    );
    if (inFlight) return dispatchNode(deps, projectId, runId, nodeId, drive);
    return true;
  }
  return dispatchClaimed(deps, projectId, runId, nodeId, claim, descriptor, drive);
}

async function dispatchClaimed(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  claim: ClaimSuccess,
  descriptor: NodeExecutorDescriptor,
  drive: DriveState,
): Promise<boolean> {
  if (descriptor.kind === 'sync') {
    return runSyncAndSettle(deps, projectId, runId, nodeId, claim, drive);
  }
  if (claim.taskId !== undefined) deps.scheduleTask?.(claim.taskId);
  return true;
}

async function runSyncAndSettle(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  claim: {
    readonly executionId: string;
    readonly activationNo: number;
    readonly attemptNo: number;
    readonly inputHash: string;
    readonly inputSnapshot: unknown;
  },
  drive: DriveState,
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, state, nodeId);
  if (!descriptor || descriptor.kind !== 'sync') {
    return failClosedNode(deps, projectId, runId, nodeId, claim.executionId, 'EXECUTOR_NOT_FOUND');
  }
  const runner = deps.runners.get(descriptor.executorId) as SyncNodeExecutor | undefined;
  if (!runner) {
    return failClosedNode(deps, projectId, runId, nodeId, claim.executionId, 'EXECUTOR_NOT_FOUND');
  }
  const ctx: NodeExecutionInputContext = {
    projectId,
    graphRunId: runId,
    nodeId,
    executionId: claim.executionId,
    activationNo: claim.activationNo,
    attemptNo: claim.attemptNo,
    inputSnapshot: claim.inputSnapshot,
    inputHash: claim.inputHash,
  };
  let output: NodeOutput;
  try {
    output = runner.execute(ctx);
  } catch {
    return failClosedNode(deps, projectId, runId, nodeId, claim.executionId, 'EXECUTOR_ERROR');
  }
  return settleWithClassification(deps, projectId, runId, nodeId, claim.executionId, output, drive);
}

// ── pending / running 恢复 ─────────────────────────────────────────

async function reDispatchPending(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  drive: DriveState,
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, state, nodeId);
  if (!descriptor || descriptor.kind === 'human') {
    return failClosedNode(deps, projectId, runId, nodeId, exec.id, 'EXECUTOR_NOT_FOUND');
  }
  if (descriptor.kind === 'sync') {
    const running = deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.markRunning(exec.id, ['pending'], {
        taskId: null,
        claimedBy: deps.runnerId,
        leaseExpiresAt: leaseExpiry(deps),
      }),
    );
    if (!running) return true; // 并发
    return runSyncAndSettle(
      deps,
      projectId,
      runId,
      nodeId,
      {
        executionId: exec.id,
        activationNo: exec.activationNo,
        attemptNo: exec.attemptNo,
        inputHash: exec.inputHash,
        inputSnapshot: exec.inputSnapshotJson ? JSON.parse(exec.inputSnapshotJson) : undefined,
      },
      drive,
    );
  }
  // task-backed pending：已有 taskId → 幂等重新调度（每 driveRun 至多一次）；无 taskId → fail-closed
  if (exec.taskId !== null) {
    if (!drive.rescheduled.has(exec.taskId)) {
      drive.rescheduled.add(exec.taskId);
      deps.scheduleTask?.(exec.taskId);
      return true;
    }
    return false;
  }
  return failClosedNode(deps, projectId, runId, nodeId, exec.id, 'TASK_NOT_BOUND');
}

async function reconcileTaskBackedRunning(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  drive: DriveState,
): Promise<boolean> {
  // Blocker 3：task 读经 repos.taskRepo（与 execution 同一事务保证一致性）
  const task = deps.tx.runInTransaction((repos) => repos.taskRepo.getById(exec.taskId!));
  if (!task) {
    return failClosedNode(deps, projectId, runId, nodeId, exec.id, 'TASK_NOT_FOUND');
  }
  if (task.status === 'SUCCEEDED') {
    return settleWithClassification(deps, projectId, runId, nodeId, exec.id, undefined, drive);
  }
  if (task.status === 'FAILED') {
    // 仅明确基础设施错误可 infra retry（统一 claim path 创建/绑定/调度新 task）
    if (canInfraRetryCount(exec) && isInfraInterrupted(task.errorCode)) {
      return claimAndDispatch(deps, projectId, runId, nodeId, drive, exec);
    }
    return failClosedNode(
      deps,
      projectId,
      runId,
      nodeId,
      exec.id,
      task.errorCode ?? 'TASK_EXECUTION_FAILED',
    );
  }
  if (task.status === 'PENDING') {
    // 幂等重新调度（每 driveRun 至多一次；worker 侧 schedule 幂等）
    if (!drive.rescheduled.has(task.id)) {
      drive.rescheduled.add(task.id);
      deps.scheduleTask?.(task.id);
      return true;
    }
    return false;
  }
  // RUNNING：任务在途 → 保持（不误 fail、不 spin）
  return false;
}

// ── settlement + 错误分类 ─────────────────────────────────────────

async function settleWithClassification(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  executionId: string,
  output: NodeOutput | undefined,
  drive: DriveState,
): Promise<boolean> {
  try {
    const result = settleNodeExecution(deps, { projectId, executionId, output });
    drive.settled.push(result);
    return true;
  } catch (err) {
    if (isRetryableConflict(err)) {
      // Graph CAS/version 冲突：可重试，execution 保持 running，不误标 failed
      return true;
    }
    // 确定性失败（artifact invalid/stale/task 未成功 等）→ 原子失败
    return failClosedNode(deps, projectId, runId, nodeId, executionId, errorCodeOf(err));
  }
}

// ── 原子失败 ──────────────────────────────────────────────────────

/**
 * fail-closed：
 * - 有 execution → failExecutionAndNodeInTransaction（execution failed + applyNodeFailure
 *   + CAS + command log 同一事务）；仅预期冲突（run 已终态 / 节点非 active）回退为单独
 *   标记 execution failed；其它错误必须向上抛（禁止 blanket catch）。
 * - 无 execution（未知 executor）→ 仅 fail node（幂等键按 run+node）。
 */
async function failClosedNode(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  executionId: string | undefined,
  errorCode: string,
): Promise<boolean> {
  if (executionId !== undefined) {
    try {
      deps.tx.runInTransaction((repos) =>
        failExecutionAndNodeInTransaction(deps, repos, { projectId, executionId, errorCode }),
      );
      return true;
    } catch (err) {
      // Blocker 6：只允许在"run 已终态或节点 provably 不再 active"时做 audit-only 标记；
      // identity / validation / 其它错误必须上抛（禁止 split-brain：execution failed + node active）。
      const runRecord = deps.tx.runInTransaction((repos) => repos.graphRunRepo.getById(runId));
      const runTerminal = runRecord !== null && runRecord.state.terminalStatus !== null;
      const nodeInactive =
        runRecord !== null && runRecord.state.nodeStatuses[nodeId as never] !== 'active';
      if (runTerminal || nodeInactive) {
        try {
          deps.tx.runInTransaction((repos) =>
            repos.nodeExecutionRepo.markFailed(executionId, ['pending', 'running'], errorCode),
          );
        } catch {
          /* 忽略并发 CAS */
        }
        return true;
      }
      throw err;
    }
  }
  const key = `fail-closed:${runId}:${nodeId}`;
  try {
    deps.tx.runInTransaction((repos) => failNodeInTransaction(deps, repos, runId, key, nodeId));
  } catch (err) {
    if (err instanceof GraphRunStateConflictError || err instanceof GraphRunValidationError) {
      // 无 execution 的 fail-closed：run 已终态 / 节点非 active 视为已处理
      return true;
    }
    throw err;
  }
  return true;
}

/** 读取 run 终态（供 runner 判断） */
export function runTerminalStatusOf(state: AnyIdeaToNovelRunState): GraphRunTerminalStatus | null {
  return state.terminalStatus;
}
