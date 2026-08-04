/**
 * NodeSettlementService（RW-1 Rework）。
 *
 * 唯一允许非人工节点完成的方式。所有数据库变化（execution 身份/结果/stale 校验、Domain
 * transition、CAS 保存 Graph、标记 execution settled、写幂等 command 记录）处于同一
 * BEGIN IMMEDIATE 事务。
 *
 * 硬约束（Blocker 4/5/6/8）：
 * - run/node/task 从 execution 反推，不允许调用方自由组合；
 * - 只允许 running（已 settled → 重复 settlement 返回原结果）；
 * - task-backed 必须验证 task SUCCEEDED + ownership；结果按 executionId 读取；
 * - inputHash 重校验（stale 拒绝）；
 * - artifact invalid / stale / task 未成功 = 确定性失败（调用方标记 execution failed +
 *   applyNodeFailure）；Graph CAS conflict = 可重试（调用方不得误标 failed）。
 */

import type {
  AnyIdeaToNovelRunState,
  ApplyNodeSuccessOptions,
  GraphNodeOutcome,
  GraphRunTerminalStatus,
} from '@ai-novel/domain';
import {
  artifactRef,
  applyNodeSuccess as applyNodeSuccessTransition,
  createGraphNodeId,
  isArtifactKind,
  isGraphConditionName,
  isGraphConditionOutcome,
} from '@ai-novel/domain';
import type { GraphRunDeps } from './graph-run.js';
import { applyTransitionInTransaction, parkHumanNodes } from './graph-run.js';
import type { GraphRunTransitionResult } from './graph-run.js';
import type { ExecutorRegistry } from './executor-registry.js';
import { computeNodeInputSnapshot } from './node-input.js';
import type {
  ArtifactPayload,
  ArtifactResolverPort,
  NodeExecutionResultEnvelope,
  NodeOutput,
  NodeSettlementResult,
} from './node-execution-types.js';
import type { TaskRepositoryPort } from './types.js';
import { AppError } from './errors.js';

export type NodeSettlementErrorCode =
  | 'NODE_EXECUTION_NOT_FOUND'
  | 'NODE_EXECUTION_STATE_CONFLICT'
  | 'NODE_EXECUTION_IDENTITY_MISMATCH'
  | 'NODE_SETTLEMENT_ARTIFACT_MISSING'
  | 'NODE_SETTLEMENT_ARTIFACT_INVALID'
  | 'NODE_SETTLEMENT_STALE_INPUT'
  | 'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED';

export class NodeSettlementError extends AppError {
  constructor(code: NodeSettlementErrorCode, message: string) {
    super(code, message);
    this.name = 'NodeSettlementError';
  }
}

export interface NodeSettlementDeps extends GraphRunDeps {
  readonly artifactResolver: ArtifactResolverPort;
  readonly registry: ExecutorRegistry;
  readonly taskRepo: TaskRepositoryPort;
}

export interface SettleNodeExecutionInput {
  readonly projectId: string;
  readonly executionId: string;
  /** sync executor 直接产出（task-backed 从 durable result envelope 读取） */
  readonly output?: NodeOutput;
}

function terminalStatusOf(run: AnyIdeaToNovelRunState): GraphRunTerminalStatus | null {
  return run.terminalStatus;
}

export function settleNodeExecution(
  deps: NodeSettlementDeps,
  input: SettleNodeExecutionInput,
): NodeSettlementResult {
  return deps.tx.runInTransaction((repos) => {
    const execution = repos.nodeExecutionRepo.getById(input.executionId);
    if (!execution) {
      throw new NodeSettlementError(
        'NODE_EXECUTION_NOT_FOUND',
        `execution ${input.executionId} 不存在`,
      );
    }

    // 重复 settlement：返回原结果（不检查输入身份，因为原结果已提交）
    if (execution.status === 'settled') {
      const current = repos.graphRunRepo.getById(execution.graphRunId);
      return {
        executionId: input.executionId,
        runId: execution.graphRunId,
        nodeId: execution.nodeId,
        settled: false,
        terminalStatus: current ? terminalStatusOf(current.state) : null,
      };
    }
    if (execution.status !== 'running') {
      throw new NodeSettlementError(
        'NODE_EXECUTION_STATE_CONFLICT',
        `execution ${input.executionId} 状态 ${execution.status} 不可 settlement（仅 running）`,
      );
    }

    // ── 身份校验（从 execution 反推 run/node，不允许调用方自由组合）──
    const run = repos.graphRunRepo.getById(execution.graphRunId);
    if (!run) {
      throw new NodeSettlementError(
        'NODE_EXECUTION_IDENTITY_MISMATCH',
        `run ${execution.graphRunId} 不存在`,
      );
    }
    if (run.state.projectId !== input.projectId) {
      throw new NodeSettlementError('NODE_EXECUTION_IDENTITY_MISMATCH', 'project ownership 不匹配');
    }
    if (
      run.state.graphId !== execution.graphId ||
      run.state.graphVersion !== execution.graphVersion
    ) {
      throw new NodeSettlementError('NODE_EXECUTION_IDENTITY_MISMATCH', 'graph identity 不匹配');
    }
    const graphKind = run.state.graphId === deps.projectGraph.id ? 'project' : 'chapter';
    const descriptor = deps.registry.get({ graphKind, nodeId: execution.nodeId });
    if (
      !descriptor ||
      descriptor.executorId !== execution.executorId ||
      descriptor.executorVersion !== execution.executorVersion
    ) {
      throw new NodeSettlementError('NODE_EXECUTION_IDENTITY_MISMATCH', 'executor identity 不匹配');
    }

    // ── stale 校验：当前节点输入快照必须仍与 execution.inputHash 一致 ──
    const currentInputHash = deps.hashPayload(
      JSON.stringify(computeNodeInputSnapshot(run.state, execution.nodeId)),
    );
    if (currentInputHash !== execution.inputHash) {
      throw new NodeSettlementError(
        'NODE_SETTLEMENT_STALE_INPUT',
        '节点输入已变更，拒绝 stale 结果',
      );
    }

    // ── 解析结果（task-backed 从 durable envelope；sync 用调用方 output）──
    let outcome: { condition: string; value: string } | undefined;
    let proposed: ArtifactPayload | undefined;
    if (execution.taskId !== null) {
      // task-backed：验证 task SUCCEEDED + ownership + 结果按 executionId 读取
      const task = deps.taskRepo.getById(execution.taskId);
      if (!task) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED',
          `task ${execution.taskId} 不存在`,
        );
      }
      if (task.projectId !== input.projectId) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED',
          'task ownership 不匹配',
        );
      }
      if (task.status !== 'SUCCEEDED') {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED',
          `task ${execution.taskId} 状态 ${task.status}`,
        );
      }
      const envelope = repos.nodeExecutionResultStore.getByExecutionId(execution.id);
      if (!envelope) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_MISSING',
          `execution ${execution.id} 无 durable result`,
        );
      }
      validateEnvelope(envelope, execution);
      outcome = envelope.outcome ?? undefined;
      if (envelope.artifactKind !== null) {
        proposed = {
          kind: envelope.artifactKind,
          artifactId: execution.id,
          producerNodeId: execution.nodeId,
          version: envelope.artifactVersion ?? 1,
        };
      }
    } else if (input.output !== undefined) {
      outcome = input.output.outcome;
      proposed = input.output.artifact;
    }

    // ── artifact 校验（严格边界）──
    let receipt = null;
    if (proposed !== undefined) {
      receipt = deps.artifactResolver.resolve({
        projectId: input.projectId,
        graphRunId: execution.graphRunId,
        graphVersion: execution.graphVersion,
        nodeId: execution.nodeId,
        executionId: execution.id,
        proposed,
      });
    }

    // ── outcome 形状校验 ──
    if (outcome !== undefined) {
      if (
        !isGraphConditionName(outcome.condition) ||
        !isGraphConditionOutcome(outcome.condition, outcome.value)
      ) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_INVALID',
          `非法 outcome: ${outcome.condition}=${outcome.value}`,
        );
      }
    }

    const artifactRefForTransition = receipt
      ? artifactRef(receipt.kind, receipt.artifactId)
      : undefined;
    const opts: ApplyNodeSuccessOptions = {
      ...(outcome !== undefined
        ? { outcome: { condition: outcome.condition, value: outcome.value } as GraphNodeOutcome }
        : {}),
      ...(artifactRefForTransition !== undefined ? { artifactRef: artifactRefForTransition } : {}),
    };

    const idempotencyKey = `settle:${execution.id}`;
    const result: GraphRunTransitionResult = applyTransitionInTransaction(
      deps,
      repos,
      execution.graphRunId,
      'nodeSettlement',
      idempotencyKey,
      {
        command: 'nodeSettlement',
        runId: execution.graphRunId,
        nodeId: execution.nodeId,
        executionId: execution.id,
      },
      (graph, state) => {
        const nodeId = createGraphNodeId(execution.nodeId);
        const next = applyNodeSuccessTransition(graph, state, nodeId, opts);
        return parkHumanNodes(graph, next);
      },
    );

    if (result.deduped === false) {
      const ok = repos.nodeExecutionRepo.markSettled(
        execution.id,
        ['running'],
        receipt ? JSON.stringify(receipt) : null,
        deps.clock.now(),
      );
      if (!ok) {
        throw new NodeSettlementError(
          'NODE_EXECUTION_STATE_CONFLICT',
          '标记 execution settled 失败',
        );
      }
    }

    return {
      executionId: execution.id,
      runId: execution.graphRunId,
      nodeId: execution.nodeId,
      settled: result.deduped === false,
      terminalStatus: result.run.terminalStatus,
    };
  });
}

/** 校验 durable result envelope 与 execution 的一致性 */
function validateEnvelope(
  envelope: NodeExecutionResultEnvelope,
  execution: {
    readonly id: string;
    readonly graphRunId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly executorId: string;
    readonly executorVersion: string;
    readonly inputHash: string;
  },
): void {
  if (
    envelope.executionId !== execution.id ||
    envelope.graphRunId !== execution.graphRunId ||
    envelope.nodeId !== execution.nodeId ||
    envelope.attempt !== execution.attempt ||
    envelope.executorId !== execution.executorId ||
    envelope.executorVersion !== execution.executorVersion ||
    envelope.inputHash !== execution.inputHash
  ) {
    throw new NodeSettlementError(
      'NODE_EXECUTION_IDENTITY_MISMATCH',
      'durable result 与 execution 不匹配',
    );
  }
  if (envelope.artifactKind !== null && !isArtifactKind(envelope.artifactKind)) {
    throw new NodeSettlementError(
      'NODE_SETTLEMENT_ARTIFACT_INVALID',
      `artifact kind 非法: ${String(envelope.artifactKind)}`,
    );
  }
}
