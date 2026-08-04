/**
 * NodeRunner（RW-1 Rework）。
 *
 * 生产级 runner：扫描 Graph active frontier（**全量** dispatch，支持 fan-out 并行），
 * 为 active 非人工节点创建/恢复持久化 execution，最终只经 NodeSettlementService 完成节点。
 *
 * 硬约束：
 * - 不使用测试专用 runFakeUntilHumanOrTerminal；
 * - executor 不得直接写 graph_runs；
 * - 所有推进最终经 kernel Domain transition；
 * - 每次真实尝试 = 不可变新 execution row（visit_id + attempt 单调递增，旧 row superseded）；
 * - claim/task 创建/绑定在单个 BEGIN IMMEDIATE 内（原子，task-backed 先取无副作用 TaskSpec）；
 * - 无 execution / 未知 executor / 不可重放 → fail-closed；
 * - settlement 错误分类：确定性失败 → execution failed + applyNodeFailure；CAS conflict → 可重试不误标 failed。
 */

import type {
  AnyIdeaToNovelGraphV1,
  AnyIdeaToNovelRunState,
  GraphRunTerminalStatus,
} from '@ai-novel/domain';
import type { GraphRunDeps } from './graph-run.js';
import { failNode, getRunProgress } from './graph-run.js';
import { GraphRunVersionConflictError } from './graph-run-errors.js';
import { computeNodeInputSnapshot } from './node-input.js';
import { settleNodeExecution, NodeSettlementError } from './node-settlement.js';
import type { NodeSettlementResult } from './node-execution-types.js';
import {
  INFRA_MAX_ATTEMPTS,
  type ArtifactResolverPort,
  type NodeExecutorDescriptor,
  type NodeExecutionRecord,
  type NodeOutput,
  type NodeTaskSpec,
} from './node-execution-types.js';
import { ExecutorRegistry } from './executor-registry.js';
import type { TaskRepositoryPort } from './types.js';

function isHumanGateKind(kind: string): boolean {
  return kind === 'CLARIFY_ANSWER' || kind === 'USER_GATE';
}

/** 基础设施可重试错误（同 activation 受控 retry） */
const INFRA_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'TASK_INTERRUPTED',
  'EXECUTOR_ERROR',
  'NODE_INTERRUPTED',
]);

export type NodeDispatchResult =
  | { readonly kind: 'sync'; readonly output: NodeOutput }
  | { readonly kind: 'task'; readonly spec: NodeTaskSpec };

/** 真实 executor 的可运行接口（GE-3..6 注册具体实现；RW-1 测试注入 fake） */
export interface NodeExecutorRunner {
  readonly descriptor: NodeExecutorDescriptor;
  run(input: {
    readonly projectId: string;
    readonly graphRunId: string;
    readonly nodeId: string;
    readonly visitId: string;
    readonly attempt: number;
    readonly inputHash: string;
  }): Promise<NodeDispatchResult>;
}

export interface NodeRunnerDeps extends GraphRunDeps {
  readonly registry: ExecutorRegistry;
  readonly runners: ReadonlyMap<string, NodeExecutorRunner>;
  readonly artifactResolver: ArtifactResolverPort;
  readonly taskRepo: TaskRepositoryPort;
  /** 提交后调度 task-backed 任务（Worker 接线；RW-1 测试可为 no-op） */
  readonly scheduleTask?: (taskId: string) => void;
}

function graphFor(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === deps.projectGraph.id) return deps.projectGraph;
  if (graphId === deps.chapterGraph.id) return deps.chapterGraph;
  throw new Error(`未知 graphId: ${graphId}`);
}

/** 判定基础设施重试（同 activation 新 attempt） */
function shouldInfraRetry(exec: NodeExecutionRecord): boolean {
  return (
    exec.recoveryPolicy === 'replayable' &&
    exec.attempt < INFRA_MAX_ATTEMPTS &&
    (exec.errorCode === null || INFRA_RETRYABLE_CODES.has(exec.errorCode))
  );
}

function isRetryableConflict(err: unknown): boolean {
  return err instanceof GraphRunVersionConflictError;
}

function errorCodeOf(err: unknown): string {
  if (err instanceof NodeSettlementError) return err.code;
  if (err instanceof Error) return 'NODE_EXECUTION_FAILED';
  return 'NODE_EXECUTION_FAILED';
}

/**
 * 推进一个 run：每轮对 active frontier 做**全量**快照并逐个 claim/dispatch（fan-out 并行），
 * 只有完整一轮均无进展才停止。返回已 settlement 的结果。
 */
export async function driveRun(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
): Promise<ReadonlyArray<NodeSettlementResult>> {
  const settled: NodeSettlementResult[] = [];
  // 防御：基础设施轮数上限（防止无界业务循环导致的死循环；业务循环由 Graph budget 约束）
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
      const progressed = await dispatchNode(deps, projectId, runId, node.id, settled);
      if (progressed) anyProgress = true;
    }
    if (!anyProgress) break;
  }
  return settled;
}

/** 为单个 active 节点恢复或创建 execution 并分发；返回是否取得进展 */
async function dispatchNode(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const inFlight = deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.getInFlightByRunNode(runId, nodeId),
  );
  if (inFlight) {
    return reconcileExecution(deps, projectId, runId, nodeId, inFlight, settled);
  }
  return createAndDispatch(deps, projectId, runId, nodeId, settled);
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

async function createAndDispatch(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, state, nodeId);
  if (!descriptor || descriptor.kind === 'human') {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_REGISTERED');
    return true;
  }
  const runner = deps.runners.get(descriptor.executorId);
  if (!runner) {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_FOUND');
    return true;
  }

  // task-backed：先取无副作用 TaskSpec（不创建 task）
  let taskSpec: NodeTaskSpec | undefined;
  if (descriptor.kind === 'task_backed') {
    try {
      const dispatch = await runner.run({
        projectId,
        graphRunId: runId,
        nodeId,
        visitId: '',
        attempt: 1,
        inputHash: '',
      });
      if (dispatch.kind !== 'task') throw new Error('task-backed executor 未返回 TaskSpec');
      taskSpec = dispatch.spec;
    } catch {
      await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
      return true;
    }
  }

  // 原子 claim：单事务内重读 run（node 仍 active）→ 决定 visit/attempt → 创建 execution →
  // （task-backed）创建 task + 绑定 taskId + markRunning；（sync）markRunning。
  const claim = deps.tx.runInTransaction((repos) => {
    const fresh = repos.graphRunRepo.getById(runId);
    if (!fresh || fresh.state.nodeStatuses[nodeId as never] !== 'active') {
      return { status: 'not_active' as const };
    }
    const latest = repos.nodeExecutionRepo.getLatestByRunNode(runId, nodeId);
    const isRetry = latest !== null && latest.status === 'failed' && shouldInfraRetry(latest);
    const visitId = isRetry ? latest!.visitId : deps.idGenerator.generate();
    const attempt = isRetry ? latest!.attempt + 1 : 1;
    const executionId = deps.idGenerator.generate();
    const inputHash = deps.hashPayload(
      JSON.stringify(computeNodeInputSnapshot(fresh.state, nodeId)),
    );
    const now = deps.clock.now();

    const created = repos.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: runId,
      graphId: fresh.state.graphId,
      graphVersion: fresh.state.graphVersion,
      nodeId,
      visitId,
      attempt,
      executorId: descriptor.executorId,
      executorVersion: descriptor.executorVersion,
      recoveryPolicy: descriptor.recoveryPolicy,
      inputHash,
      createdAt: now,
      updatedAt: now,
    });
    if (!created) return { status: 'concurrent' as const };

    if (descriptor.kind === 'task_backed' && taskSpec) {
      const taskId = deps.idGenerator.generate();
      deps.taskRepo.create({
        id: taskId,
        projectId,
        taskType: taskSpec.taskType,
        inputVersionJson: '{}',
        payloadJson: taskSpec.payloadJson,
        dedupeKey: taskSpec.dedupeKey,
      });
      repos.nodeExecutionRepo.markRunning(executionId, ['pending'], taskId);
      return { status: 'claimed' as const, executionId, taskId, visitId, attempt, inputHash };
    }
    const running = repos.nodeExecutionRepo.markRunning(executionId, ['pending'], null);
    if (!running) return { status: 'concurrent' as const };
    return { status: 'claimed' as const, executionId, visitId, attempt, inputHash };
  });

  if (claim.status === 'not_active') return true; // 节点已移走，下一轮重新评估
  if (claim.status === 'concurrent') {
    const inFlight = deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.getInFlightByRunNode(runId, nodeId),
    );
    if (inFlight) return reconcileExecution(deps, projectId, runId, nodeId, inFlight, settled);
    return true;
  }

  // 已 claim：sync → 运行 executor + settle；task-backed → 提交后调度
  if (descriptor.kind === 'sync') {
    let output: NodeOutput;
    try {
      const dispatch = await runner.run({
        projectId,
        graphRunId: runId,
        nodeId,
        visitId: claim.visitId,
        attempt: claim.attempt,
        inputHash: claim.inputHash,
      });
      if (dispatch.kind !== 'sync') throw new Error('sync executor 未返回 NodeOutput');
      output = dispatch.output;
    } catch {
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(
          claim.executionId,
          ['pending', 'running'],
          'EXECUTOR_ERROR',
        ),
      );
      await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
      return true;
    }
    return settleWithClassification(
      deps,
      projectId,
      runId,
      nodeId,
      claim.executionId,
      output,
      settled,
    );
  }

  if (claim.taskId !== undefined) deps.scheduleTask?.(claim.taskId);
  return true;
}

/** settlement + 错误分类：确定性失败 → execution failed + failClosed；CAS conflict → 可重试不误标 */
async function settleWithClassification(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  executionId: string,
  output: NodeOutput | undefined,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  try {
    const result = settleNodeExecution(deps, { projectId, executionId, output });
    settled.push(result);
    return true;
  } catch (err) {
    if (isRetryableConflict(err)) {
      // Graph CAS/version 冲突：可重试，execution 保持 running，不误标 failed
      return true;
    }
    // 确定性失败（artifact invalid/stale/task 未成功 等）
    deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.markFailed(executionId, ['running'], errorCodeOf(err)),
    );
    await failClosedNode(deps, projectId, runId, nodeId, errorCodeOf(err));
    return true;
  }
}

/** 恢复已有 execution（in-flight：pending/running） */
async function reconcileExecution(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  if (exec.status === 'pending') {
    return reDispatchExecution(deps, projectId, runId, nodeId, exec, settled);
  }
  if (exec.status === 'running') {
    return reconcileRunning(deps, projectId, runId, nodeId, exec, settled);
  }
  return false;
}

async function reDispatchExecution(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, state, nodeId);
  const runner = descriptor ? deps.runners.get(descriptor.executorId) : undefined;
  if (!descriptor || descriptor.kind === 'human' || !runner) {
    deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.markFailed(exec.id, ['pending'], 'EXECUTOR_NOT_FOUND'),
    );
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_FOUND');
    return true;
  }
  if (descriptor.kind === 'sync') {
    let output: NodeOutput;
    try {
      const dispatch = await runner.run({
        projectId,
        graphRunId: runId,
        nodeId,
        visitId: exec.visitId,
        attempt: exec.attempt,
        inputHash: exec.inputHash,
      });
      if (dispatch.kind !== 'sync') throw new Error('sync executor 未返回 NodeOutput');
      output = dispatch.output;
    } catch {
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(exec.id, ['pending', 'running'], 'EXECUTOR_ERROR'),
      );
      await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
      return true;
    }
    return settleWithClassification(deps, projectId, runId, nodeId, exec.id, output, settled);
  }
  // task-backed pending：无 taskId 或 task PENDING → 按已有 taskId 保持/重调度
  return true;
}

async function reconcileRunning(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  if (exec.taskId !== null) {
    const task = deps.taskRepo.getById(exec.taskId);
    if (!task) {
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(exec.id, ['running'], 'TASK_NOT_FOUND'),
      );
      await failClosedNode(deps, projectId, runId, nodeId, 'TASK_NOT_FOUND');
      return true;
    }
    if (task.status === 'SUCCEEDED') {
      return settleWithClassification(deps, projectId, runId, nodeId, exec.id, undefined, settled);
    }
    if (task.status === 'FAILED') {
      if (shouldInfraRetry(exec)) {
        return spawnRetryExecution(deps, projectId, runId, nodeId, exec, settled);
      }
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(
          exec.id,
          ['running'],
          task.errorCode ?? 'TASK_EXECUTION_FAILED',
        ),
      );
      await failClosedNode(
        deps,
        projectId,
        runId,
        nodeId,
        task.errorCode ?? 'TASK_EXECUTION_FAILED',
      );
      return true;
    }
    // RUNNING / PENDING：任务在途 → 保持（无进展）
    return false;
  }

  // sync 在途（重启中断）：replayable 且未超限 → 同 activation 新 attempt；否则 fail-closed
  if (shouldInfraRetry(exec)) {
    return spawnRetryExecution(deps, projectId, runId, nodeId, exec, settled);
  }
  deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.markFailed(exec.id, ['running'], 'NODE_INTERRUPTED'),
  );
  await failClosedNode(deps, projectId, runId, nodeId, 'NODE_INTERRUPTED');
  return true;
}

/** 同 activation 基础设施重试：创建新 execution row（同 visit，attempt+1），旧 row superseded */
async function spawnRetryExecution(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  previous: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const executionId = deps.idGenerator.generate();
  const claim = deps.tx.runInTransaction((repos) => {
    const fresh = repos.graphRunRepo.getById(runId);
    if (!fresh || fresh.state.nodeStatuses[nodeId as never] !== 'active') return false;
    if (!repos.nodeExecutionRepo.markSuperseded(previous.id, ['pending', 'running'])) return false;
    const inputHash = deps.hashPayload(
      JSON.stringify(computeNodeInputSnapshot(fresh.state, nodeId)),
    );
    const now = deps.clock.now();
    return repos.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: runId,
      graphId: fresh.state.graphId,
      graphVersion: fresh.state.graphVersion,
      nodeId,
      visitId: previous.visitId,
      attempt: previous.attempt + 1,
      executorId: previous.executorId,
      executorVersion: previous.executorVersion,
      recoveryPolicy: previous.recoveryPolicy,
      inputHash,
      createdAt: now,
      updatedAt: now,
    });
  });
  if (!claim) return false;
  const fresh = getRunProgress(deps, { projectId, runId });
  const descriptor = descriptorFor(deps, fresh, nodeId);
  const runner = descriptor ? deps.runners.get(descriptor.executorId) : undefined;
  if (!descriptor || !runner || descriptor.kind === 'human') {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_FOUND');
    return true;
  }
  if (descriptor.kind === 'sync') {
    deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.markRunning(executionId, ['pending'], null),
    );
    let output: NodeOutput;
    try {
      const dispatch = await runner.run({
        projectId,
        graphRunId: runId,
        nodeId,
        visitId: previous.visitId,
        attempt: previous.attempt + 1,
        inputHash: '',
      });
      if (dispatch.kind !== 'sync') throw new Error('sync executor 未返回 NodeOutput');
      output = dispatch.output;
    } catch {
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(executionId, ['pending', 'running'], 'EXECUTOR_ERROR'),
      );
      await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
      return true;
    }
    return settleWithClassification(deps, projectId, runId, nodeId, executionId, output, settled);
  }
  return true;
}

/** fail-closed：先标记 in-flight execution failed，再经 kernel failNode 失败节点（best-effort） */
async function failClosedNode(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  errorCode: string,
): Promise<void> {
  deps.tx.runInTransaction((repos) => {
    const inFlight = repos.nodeExecutionRepo.getInFlightByRunNode(runId, nodeId);
    if (inFlight)
      repos.nodeExecutionRepo.markFailed(inFlight.id, ['pending', 'running'], errorCode);
  });
  try {
    failNode(deps, {
      projectId,
      runId,
      nodeId,
      idempotencyKey: `fail-closed:${runId}:${nodeId}`,
    });
  } catch {
    // run 已终止或节点已非 active：忽略
  }
}

/** 读取 run 终态（供 runner 判断） */
export function runTerminalStatusOf(state: AnyIdeaToNovelRunState): GraphRunTerminalStatus | null {
  return state.terminalStatus;
}
