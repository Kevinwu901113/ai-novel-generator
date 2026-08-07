/**
 * NodeSettlementService（RW-1-R5）。
 *
 * 唯一允许非人工节点完成的方式。所有数据库变化（execution 身份/结果/stale 校验、Domain
 * transition、CAS 保存 Graph、标记 execution settled、写幂等 command 记录）处于同一
 * BEGIN IMMEDIATE 事务。
 *
 * 硬约束（RW-1-R5）：
 * - run/node/task 从 execution 反推，不允许调用方自由组合；
 * - 只允许 running（已 settled → 重复 settlement 返回原结果）；
 * - task-backed 必须验证 task SUCCEEDED + ownership；结果按 executionId 读取（durable
 *   envelope 含真实 artifactId）；validateEnvelope 校验 projectId/taskId/activationNo；
 * - inputHash 重算（按 Graph 节点 input 契约 + activationNo），stale 拒绝；
 * - artifact 经 transaction-scoped resolver 校验（查询真实 repository）；
 * - artifact invalid / stale / task 未成功 = 确定性失败（failExecutionAndNodeInTransaction
 *   同一事务内标记 execution failed + applyNodeFailure）；Graph CAS conflict = 可重试
 *   （调用方不得误标 failed）。
 */

import type {
  AnyIdeaToNovelGraphV1,
  AnyIdeaToNovelRunState,
  ApplyNodeSuccessOptions,
  GraphNodeOutcome,
  GraphRunTerminalStatus,
} from '@ai-novel/domain';
import {
  artifactRef,
  applyNodeFailure as applyNodeFailureTransition,
  applyNodeSuccess as applyNodeSuccessTransition,
  createGraphNodeId,
  isArtifactKind,
  isGraphConditionName,
  isGraphConditionOutcome,
} from '@ai-novel/domain';
import type { GraphRunDeps, GraphRunTransitionResult } from './graph-run.js';
import { applyTransitionInTransaction, parkHumanNodes } from './graph-run.js';
import type { GraphRunTransactionRepositories } from './graph-run-types.js';
import type { ExecutorRegistry } from './executor-registry.js';
import { computeNodeInputSnapshot, inputHashOf } from './node-input.js';
import type {
  ArtifactPayload,
  ArtifactResolverPort,
  NodeExecutionResultEnvelope,
  NodeOutput,
  NodeSettlementResult,
} from './node-execution-types.js';
import { AppError } from './errors.js';

export type NodeSettlementErrorCode =
  | 'NODE_EXECUTION_NOT_FOUND'
  | 'NODE_EXECUTION_STATE_CONFLICT'
  | 'NODE_EXECUTION_IDENTITY_MISMATCH'
  | 'NODE_EXECUTOR_UNAVAILABLE'
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

/** 由 run 状态解析权威图（project / chapter） */
function graphForState(deps: GraphRunDeps, state: AnyIdeaToNovelRunState): AnyIdeaToNovelGraphV1 {
  return state.graphId === deps.projectGraph.id ? deps.projectGraph : deps.chapterGraph;
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
    if (!descriptor) {
      // TD-020：registry 缺该节点 executor 是能力缺口，不是结果非法。
      // 已完成任务的 durable 结果必须保留，等有该能力的 worker 再结算，
      // 不得借 identity 校验把 run 打成终态 failed。
      throw new NodeSettlementError(
        'NODE_EXECUTOR_UNAVAILABLE',
        'registry 缺该节点 executor，结果保留待可结算 worker',
      );
    }
    if (
      descriptor.executorId !== execution.executorId ||
      descriptor.executorVersion !== execution.executorVersion
    ) {
      throw new NodeSettlementError('NODE_EXECUTION_IDENTITY_MISMATCH', 'executor identity 不匹配');
    }

    // ── stale 校验：按 Graph 节点 input 契约 + activationNo 重算当前输入哈希 ──
    const graph = graphForState(deps, run.state);
    const currentInputHash = inputHashOf(
      deps.hashPayload,
      computeNodeInputSnapshot(graph, run.state, execution.nodeId, execution.activationNo),
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
      // （Blocker 3：task 读经 repos.taskRepo，同一事务内保证一致性）
      const task = repos.taskRepo.getById(execution.taskId);
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
      validateEnvelope(envelope, execution, input.projectId);
      outcome = envelope.outcome ?? undefined;
      if (envelope.artifactKind !== null) {
        // Blocker 9：三元组 all-present（validateEnvelope 已保证），不默认补 version
        proposed = {
          kind: envelope.artifactKind,
          artifactId: envelope.artifactId!,
          producerNodeId: execution.nodeId,
          version: envelope.artifactVersion!,
        };
      }
    } else if (input.output !== undefined) {
      outcome = input.output.outcome;
      proposed = input.output.artifact;
    }

    // ── artifact 归属登记 + 校验（同一事务）──
    //
    // 顺序即语义（B2-RW Blocker 1）：**先 upsert provenance，再 resolve**。
    // provenance 表的主键 (artifact_kind, artifact_id) 是 artifact 归属的原子闸门：
    // - 该 artifact 尚无归属 → 本 execution 登记为唯一产出者；
    // - 已归属其它 execution/run/node/version → upsert 抛错 → 整事务回滚（拒绝引用他人产物）。
    // 随后 resolver 从**已持久化的 provenance 行**（而非调用方字段）复核归属，并校验底层
    // 权威存储的存在性与 version。若反过来先 resolve，要求 provenance 行预先存在，则由于
    // 全仓库只有此处写 provenance，除 generationRun 外任何 artifact 都永远无法 settlement。
    //
    // generationRun 的权威 provenance 即 execution-bound envelope（含 execution_id + artifact_id
    // 唯一索引），不占用 provenance 表。
    let receipt = null;
    if (proposed !== undefined) {
      if (proposed.kind !== 'generationRun') {
        repos.artifactProvenanceRepo.upsert({
          artifactKind: proposed.kind,
          artifactId: proposed.artifactId,
          version: proposed.version,
          projectId: input.projectId,
          graphRunId: execution.graphRunId,
          nodeId: execution.nodeId,
          executionId: execution.id,
          createdAt: deps.clock.now(),
        });
      }
      receipt = deps.artifactResolver.resolve(repos, {
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

/**
 * 原子失败（RW-1-R5）：execution 标记 failed + Domain applyNodeFailure + Graph CAS +
 * 幂等 command 记录，全部同一 BEGIN IMMEDIATE 事务。
 *
 * 幂等键使用 executionId（`fail:${executionId}`）；Graph 层失败（如 run 已终态）时
 * 整事务回滚 —— execution 不会被"半失败"。
 * 禁止调用方在外部 blanket catch 吞掉真实错误。
 */
export function failExecutionAndNodeInTransaction(
  deps: NodeSettlementDeps,
  repos: GraphRunTransactionRepositories,
  input: { readonly projectId: string; readonly executionId: string; readonly errorCode: string },
): GraphRunTransitionResult {
  const execution = repos.nodeExecutionRepo.getById(input.executionId);
  if (!execution) {
    throw new NodeSettlementError(
      'NODE_EXECUTION_NOT_FOUND',
      `execution ${input.executionId} 不存在`,
    );
  }
  const run = repos.graphRunRepo.getById(execution.graphRunId);
  if (!run || run.state.projectId !== input.projectId) {
    throw new NodeSettlementError('NODE_EXECUTION_IDENTITY_MISMATCH', 'project ownership 不匹配');
  }
  const marked = repos.nodeExecutionRepo.markFailed(
    execution.id,
    ['pending', 'running'],
    input.errorCode,
  );
  if (!marked) {
    throw new NodeSettlementError(
      'NODE_EXECUTION_STATE_CONFLICT',
      `execution ${execution.id} 状态不可标记 failed（仅 pending/running）`,
    );
  }
  return applyTransitionInTransaction(
    deps,
    repos,
    execution.graphRunId,
    'failNode',
    `fail:${execution.id}`,
    {
      command: 'failNode',
      runId: execution.graphRunId,
      nodeId: execution.nodeId,
      executionId: execution.id,
      errorCode: input.errorCode,
    },
    (graph, state) => applyNodeFailureTransition(graph, state, createGraphNodeId(execution.nodeId)),
  );
}

/** 校验 durable result envelope 与 execution 的一致性（含 projectId/taskId/activationNo） */
function validateEnvelope(
  envelope: NodeExecutionResultEnvelope,
  execution: {
    readonly id: string;
    readonly graphRunId: string;
    readonly nodeId: string;
    readonly activationNo: number;
    readonly attemptNo: number;
    readonly executorId: string;
    readonly executorVersion: string;
    readonly inputHash: string;
    readonly taskId: string | null;
  },
  projectId: string,
): void {
  if (
    envelope.executionId !== execution.id ||
    envelope.projectId !== projectId ||
    envelope.graphRunId !== execution.graphRunId ||
    envelope.nodeId !== execution.nodeId ||
    envelope.activationNo !== execution.activationNo ||
    envelope.attemptNo !== execution.attemptNo ||
    envelope.executorId !== execution.executorId ||
    envelope.executorVersion !== execution.executorVersion ||
    envelope.inputHash !== execution.inputHash ||
    envelope.taskId !== execution.taskId
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
  // Blocker 9：artifact 三元组 all-null / all-present 不变量（kind↔id↔version 一致）
  const kindPresent = envelope.artifactKind !== null;
  if (
    kindPresent !== (envelope.artifactId !== null) ||
    kindPresent !== (envelope.artifactVersion !== null)
  ) {
    throw new NodeSettlementError(
      'NODE_SETTLEMENT_ARTIFACT_INVALID',
      'envelope artifact 三元组不完整（必须 all-null 或 all-present）',
    );
  }
}
