/**
 * NodeRunner（RW-1）。
 *
 * 生产级 runner：扫描 Graph active frontier，为 active 非人工节点创建/恢复持久化 execution，
 * 分发 executor（sync / task-backed），最终只经 NodeSettlementService 完成节点。
 *
 * 硬约束：
 * - 不使用测试专用 runFakeUntilHumanOrTerminal；
 * - executor 不得直接写 graph_runs；
 * - 所有推进最终经 GraphRunService（kernel）的 Domain transition；
 * - 无 execution / 未知 executor / 不可重放 → fail-closed（applyNodeFailure）。
 */

import type {
  AnyIdeaToNovelGraphV1,
  AnyIdeaToNovelRunState,
  GraphRunTerminalStatus,
} from '@ai-novel/domain';
import type { GraphRunDeps } from './graph-run.js';
import { failNode, getRunProgress } from './graph-run.js';
import type { NodeSettlementResult } from './node-execution-types.js';
import {
  INFRA_MAX_ATTEMPTS,
  type ArtifactResolverPort,
  type NodeExecutorDescriptor,
  type NodeExecutionRecord,
  type NodeOutput,
} from './node-execution-types.js';
import { ExecutorRegistry } from './executor-registry.js';
import { settleNodeExecution } from './node-settlement.js';
import type { TaskRepositoryPort } from './types.js';

function isHumanGateKind(kind: string): boolean {
  return kind === 'CLARIFY_ANSWER' || kind === 'USER_GATE';
}

export type NodeDispatchResult =
  | { readonly kind: 'sync'; readonly output: NodeOutput }
  | { readonly kind: 'task'; readonly taskId: string };

/** 真实 executor 的可运行接口（GE-3..6 注册具体实现；RW-1 测试注入 fake） */
export interface NodeExecutorRunner {
  readonly descriptor: NodeExecutorDescriptor;
  run(input: {
    readonly projectId: string;
    readonly graphRunId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly inputHash: string;
  }): Promise<NodeDispatchResult>;
}

export interface NodeRunnerDeps extends GraphRunDeps {
  readonly registry: ExecutorRegistry;
  readonly runners: ReadonlyMap<string, NodeExecutorRunner>;
  readonly artifactResolver: ArtifactResolverPort;
  readonly taskRepo: TaskRepositoryPort;
}

export interface NodeRunnerContext {
  readonly deps: NodeRunnerDeps;
}

function graphFor(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === deps.projectGraph.id) return deps.projectGraph;
  if (graphId === deps.chapterGraph.id) return deps.chapterGraph;
  throw new Error(`未知 graphId: ${graphId}`);
}

/**
 * 推进一个 run：反复 dispatch active 非人工节点，直到人工 Gate / 终态 / 无进展。
 * 返回已 settlement 的结果。
 */
export async function driveRun(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
): Promise<ReadonlyArray<NodeSettlementResult>> {
  const settled: NodeSettlementResult[] = [];
  for (;;) {
    const state = getRunProgress(deps, { projectId, runId });
    if (state.terminalStatus !== null) break;
    if (state.pendingHumanDecision !== null) break;

    const graph = graphFor(deps, state.graphId);
    const next = graph.nodes.find(
      (n) => state.nodeStatuses[n.id] === 'active' && !isHumanGateKind(n.kind),
    );
    if (!next) break;

    const progressed = await dispatchOrReconcile(deps, projectId, runId, next.id, settled);
    // 无进展（如 task-backed 在途、已 settled/superseded 无操作）→ 停止，避免 spin
    if (!progressed) break;
  }
  return settled;
}

/** 为单个 active 节点创建或恢复 execution 并分发；返回是否取得进展 */
async function dispatchOrReconcile(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const existing = deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.getByRunNode(runId, nodeId),
  );
  if (existing) {
    return reconcileExecution(deps, projectId, runId, nodeId, existing, settled);
  }
  return createAndDispatch(deps, projectId, runId, nodeId, settled);
}

async function createAndDispatch(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const state = getRunProgress(deps, { projectId, runId });
  const descriptor = deps.registry.get({
    graphKind: state.graphId === deps.projectGraph.id ? 'project' : 'chapter',
    nodeId,
  });

  if (!descriptor || descriptor.kind === 'human') {
    // 未知 executor / 人工（不应在此）→ fail-closed
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_REGISTERED');
    return true;
  }

  const runner = deps.runners.get(descriptor.executorId);
  if (!runner) {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_FOUND');
    return true;
  }

  const executionId = deps.idGenerator.generate();
  const inputHash = deps.hashPayload(`node-input:${runId}:${nodeId}`);
  const now = deps.clock.now();
  const created = deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.create({
      id: executionId,
      graphRunId: runId,
      graphId: state.graphId,
      graphVersion: state.graphVersion,
      nodeId,
      attempt: 1,
      executorId: descriptor.executorId,
      executorVersion: descriptor.executorVersion,
      recoveryPolicy: descriptor.recoveryPolicy,
      inputHash,
      createdAt: now,
      updatedAt: now,
    }),
  );
  if (!created) {
    // 并发 runner 已创建 → 恢复其 execution
    const concurrent = deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.getByRunNode(runId, nodeId),
    );
    if (concurrent) return reconcileExecution(deps, projectId, runId, nodeId, concurrent, settled);
    return true;
  }

  return dispatchExecution(
    deps,
    projectId,
    runId,
    nodeId,
    executionId,
    descriptor,
    runner,
    1,
    inputHash,
    settled,
  );
}

/** 分发已创建的 execution（sync 立即 settle；task-backed 创建任务并标记 running）；返回是否取得进展 */
async function dispatchExecution(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  executionId: string,
  descriptor: NodeExecutorDescriptor,
  runner: NodeExecutorRunner,
  attempt: number,
  inputHash: string,
  settled: NodeSettlementResult[],
): Promise<boolean> {
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
        attempt,
        inputHash,
      });
      if (dispatch.kind !== 'sync') {
        throw new Error('sync executor 未返回 NodeOutput');
      }
      output = dispatch.output;
    } catch {
      deps.tx.runInTransaction((repos) =>
        repos.nodeExecutionRepo.markFailed(executionId, ['pending', 'running'], 'EXECUTOR_ERROR'),
      );
      await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
      return true;
    }
    const result = settleNodeExecution(deps, {
      projectId,
      runId,
      nodeId,
      executionId,
      outcome: output?.outcome,
      artifact: output?.artifact,
    });
    settled.push(result);
    return true;
  }

  // task-backed：创建任务并链接 execution
  let taskId: string;
  try {
    const dispatch = await runner.run({ projectId, graphRunId: runId, nodeId, attempt, inputHash });
    if (dispatch.kind !== 'task') {
      throw new Error('task-backed executor 未返回 taskId');
    }
    taskId = dispatch.taskId;
  } catch {
    deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.markFailed(executionId, ['pending'], 'EXECUTOR_ERROR'),
    );
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_ERROR');
    return true;
  }
  deps.tx.runInTransaction((repos) =>
    repos.nodeExecutionRepo.markRunning(executionId, ['pending'], taskId),
  );
  return true;
}

/** 恢复已有 execution（按 status + recoveryPolicy reconcile）；返回是否取得进展 */
async function reconcileExecution(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  switch (exec.status) {
    case 'settled':
    case 'superseded':
      return false;
    case 'failed':
      await failClosedNode(
        deps,
        projectId,
        runId,
        nodeId,
        exec.errorCode ?? 'NODE_EXECUTION_FAILED',
      );
      return true;
    case 'pending': {
      return reDispatchPending(deps, projectId, runId, nodeId, exec, settled);
    }
    case 'running': {
      return reconcileRunning(deps, projectId, runId, nodeId, exec, settled);
    }
  }
}

async function reDispatchPending(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  exec: NodeExecutionRecord,
  settled: NodeSettlementResult[],
): Promise<boolean> {
  const descriptor = deps.registry.get({
    graphKind: exec.graphId === deps.projectGraph.id ? 'project' : 'chapter',
    nodeId,
  });
  if (!descriptor || descriptor.kind === 'human') {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_REGISTERED');
    return true;
  }
  const runner = deps.runners.get(descriptor.executorId);
  if (!runner) {
    await failClosedNode(deps, projectId, runId, nodeId, 'EXECUTOR_NOT_FOUND');
    return true;
  }
  return dispatchExecution(
    deps,
    projectId,
    runId,
    nodeId,
    exec.id,
    descriptor,
    runner,
    exec.attempt,
    exec.inputHash,
    settled,
  );
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
      const result = settleNodeExecution(deps, { projectId, runId, nodeId, executionId: exec.id });
      settled.push(result);
      return true;
    }
    if (task.status === 'FAILED') {
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
    // RUNNING / PENDING：任务在途或待调度 → 保持（无进展，driveRun 停止）
    return false;
  }

  // sync 在途（重启中断）：replayable 且未超限 → 受控重试；否则 fail-closed
  const descriptor = deps.registry.get({
    graphKind: exec.graphId === deps.projectGraph.id ? 'project' : 'chapter',
    nodeId,
  });
  if (descriptor?.recoveryPolicy === 'replayable' && exec.attempt < INFRA_MAX_ATTEMPTS) {
    deps.tx.runInTransaction((repos) =>
      repos.nodeExecutionRepo.retry(exec.id, ['running'], deps.clock.now()),
    );
    return reDispatchPending(deps, projectId, runId, nodeId, exec, settled);
  }
  await failClosedNode(deps, projectId, runId, nodeId, 'NODE_INTERRUPTED');
  return true;
}

/** fail-closed：把节点标记失败（仅经 kernel failNode Domain transition，best-effort） */
async function failClosedNode(
  deps: NodeRunnerDeps,
  projectId: string,
  runId: string,
  nodeId: string,
  errorCode: string,
): Promise<void> {
  // 先记录 execution 失败（如存在）
  deps.tx.runInTransaction((repos) => {
    const existing = repos.nodeExecutionRepo.getByRunNode(runId, nodeId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      repos.nodeExecutionRepo.markFailed(existing.id, ['pending', 'running'], errorCode);
    }
  });
  // 稳定幂等键；run 已终态时忽略（best-effort fail-closed）
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
