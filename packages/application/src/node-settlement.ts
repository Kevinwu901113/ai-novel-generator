/**
 * NodeSettlementService（RW-1）。
 *
 * 唯一允许非人工节点完成的方式。所有数据库变化（artifact 解析校验、Domain transition、
 * CAS 保存 Graph、标记 execution settled、写幂等 command 记录）处于同一 BEGIN IMMEDIATE 事务。
 *
 * 重复 settlement 返回原结果，绝不重复推进 Graph：
 * - execution.status === 'settled' → 直接返回 deduped；
 * - commandLog 同 idempotencyKey 已存在 → applyTransitionInTransaction 返回现态 deduped。
 */

import type {
  AnyIdeaToNovelRunState,
  ApplyNodeSuccessOptions,
  ArtifactKind,
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
import type {
  ArtifactPayload,
  ArtifactResolverPort,
  NodeSettlementResult,
} from './node-execution-types.js';
import { AppError } from './errors.js';

export class NodeSettlementError extends AppError {
  constructor(
    code:
      | 'NODE_EXECUTION_NOT_FOUND'
      | 'NODE_EXECUTION_STATE_CONFLICT'
      | 'NODE_SETTLEMENT_ARTIFACT_INVALID'
      | 'NODE_SETTLEMENT_ARTIFACT_MISSING',
    message: string,
  ) {
    super(code, message);
    this.name = 'NodeSettlementError';
  }
}

export interface NodeSettlementDeps extends GraphRunDeps {
  readonly artifactResolver: ArtifactResolverPort;
}

export interface SettleNodeExecutionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly outcome?: { readonly condition: string; readonly value: string };
  /** sync executor 直接提议的 artifact 载荷；task-backed 从 generation_artifacts 读取 */
  readonly artifact?: ArtifactPayload;
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
    if (execution.status === 'settled') {
      // 重复 settlement：返回原结果，不重复推进
      const current = repos.graphRunRepo.getById(input.runId);
      return {
        executionId: input.executionId,
        runId: input.runId,
        nodeId: input.nodeId,
        settled: false,
        terminalStatus: current ? terminalStatusOf(current.state) : null,
      };
    }
    if (execution.status !== 'running' && execution.status !== 'pending') {
      throw new NodeSettlementError(
        'NODE_EXECUTION_STATE_CONFLICT',
        `execution ${input.executionId} 状态 ${execution.status} 不可 settlement`,
      );
    }

    // ── 解析并校验真实 artifact（严格边界，禁止任意字符串 ArtifactRef）──
    let receipt = null;
    let proposed: ArtifactPayload | undefined = input.artifact;
    if (execution.taskId !== null && proposed === undefined) {
      // task-backed：从 generation_artifacts 读取权威持久化产物
      const persisted = repos.generationArtifactStore.getLatestByRunNode(input.runId, input.nodeId);
      if (!persisted) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_MISSING',
          `task ${execution.taskId} 无已持久化产物，无法 settlement`,
        );
      }
      proposed = {
        kind: kindFromContent(persisted.contentJson),
        artifactId: persisted.id,
        producerNodeId: input.nodeId,
        version: persisted.version,
      };
      // task-backed 产物必须声明合法 ArtifactKind（存在性/归属由 resolver 校验）
      if (!isArtifactKind(proposed.kind)) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_INVALID',
          `产物 kind 非法: ${String(proposed.kind)}`,
        );
      }
    }
    if (proposed !== undefined) {
      receipt = deps.artifactResolver.resolve({
        projectId: input.projectId,
        graphRunId: input.runId,
        graphVersion: execution.graphVersion,
        nodeId: input.nodeId,
        proposed,
      });
    }

    // ── 校验 outcome 形状 ──
    let outcome: { readonly condition: string; readonly value: string } | undefined;
    if (input.outcome !== undefined) {
      if (!isGraphConditionName(input.outcome.condition)) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_INVALID',
          `未知条件: ${input.outcome.condition}`,
        );
      }
      if (!isGraphConditionOutcome(input.outcome.condition, input.outcome.value)) {
        throw new NodeSettlementError(
          'NODE_SETTLEMENT_ARTIFACT_INVALID',
          `非法 outcome: ${input.outcome.condition}=${input.outcome.value}`,
        );
      }
      outcome = { condition: input.outcome.condition, value: input.outcome.value };
    }

    const artifactRefForTransition = receipt
      ? artifactRef(receipt.kind, receipt.artifactId)
      : undefined;

    const idempotencyKey = `settle:${input.executionId}`;
    const opts: ApplyNodeSuccessOptions = {
      ...(outcome !== undefined
        ? { outcome: { condition: outcome.condition, value: outcome.value } as GraphNodeOutcome }
        : {}),
      ...(artifactRefForTransition !== undefined ? { artifactRef: artifactRefForTransition } : {}),
    };
    const result: GraphRunTransitionResult = applyTransitionInTransaction(
      deps,
      repos,
      input.runId,
      'nodeSettlement',
      idempotencyKey,
      {
        command: 'nodeSettlement',
        runId: input.runId,
        nodeId: input.nodeId,
        executionId: input.executionId,
      },
      (graph, state) => {
        const nodeId = createGraphNodeId(input.nodeId);
        const next = applyNodeSuccessTransition(graph, state, nodeId, opts);
        return parkHumanNodes(graph, next);
      },
    );

    // ── 标记 execution settled（与 Graph CAS 同一事务）──
    if (result.deduped === false) {
      const ok = repos.nodeExecutionRepo.markSettled(
        input.executionId,
        ['running', 'pending'],
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
      executionId: input.executionId,
      runId: input.runId,
      nodeId: input.nodeId,
      settled: result.deduped === false,
      terminalStatus: result.run.terminalStatus,
    };
  });
}

/** 从持久化产物 content_json 推导 artifact kind（task-backed settlement） */
function kindFromContent(contentJson: string): ArtifactKind {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'kind' in (parsed as Record<string, unknown>)
    ) {
      const kind = (parsed as Record<string, unknown>).kind;
      if (isArtifactKind(kind)) return kind;
    }
  } catch {
    // fall through
  }
  throw new NodeSettlementError('NODE_SETTLEMENT_ARTIFACT_INVALID', '产物缺少合法 kind');
}
