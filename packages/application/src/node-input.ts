/**
 * Node input snapshot / inputHash（RW-1-R5, canonical input contract）。
 *
 * input snapshot 完全由 Graph 节点声明的 `input` 契约驱动（artifact / outcome / budget /
 * binding 依赖子集），并包含 activationNo（同节点新 activation 视为不同输入）。
 * 用于拒绝 stale result：上游 artifact / 决策 outcome / 预算 / 绑定变化后，旧结果不得 settlement。
 *
 * 关键性质：
 * - 未声明的 state 变化（如无关 fan-out 兄弟节点结算）不改变本节点 input snapshot
 *   （契约即隔离边界）；
 * - 不使用全局 run expectedVersion 做 stale 判断（fan-out 中其它 Critic settlement 会
 *   合法改变 run version）；
 * - infra retry（同 activation）复用持久化 inputHash，不重算。
 */

import type { AnyIdeaToNovelGraphV1, AnyIdeaToNovelRunState } from '@ai-novel/domain';
import type { ChapterGenerationRunState } from '@ai-novel/domain';
import { canonicalJson } from './canonical-json.js';

/** 由 Graph 节点 input 契约 + run 状态构造节点输入的确定性快照 */
export function computeNodeInputSnapshot(
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
  nodeId: string,
  activationNo: number,
): unknown {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new Error(`computeNodeInputSnapshot: 节点 ${nodeId} 不在图 ${graph.id} 内`);
  }
  const contract = node.input;
  const base: Record<string, unknown> = {
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    nodeId,
    activationNo,
  };
  if (contract.requiresArtifacts.length > 0) {
    const artifacts: Record<string, unknown> = {};
    for (const kind of contract.requiresArtifacts) {
      artifacts[kind] = state.artifacts[kind as never] ?? null;
    }
    base.artifacts = artifacts;
  }
  if (contract.requiresOutcomes.length > 0) {
    const outcomes: Record<string, unknown> = {};
    for (const depNodeId of contract.requiresOutcomes) {
      outcomes[depNodeId] = state.nodeOutcomes[depNodeId] ?? null;
    }
    base.outcomes = outcomes;
  }
  if (contract.requiresBudgetKeys.length > 0) {
    const budget: Record<string, unknown> = {};
    for (const key of contract.requiresBudgetKeys) {
      budget[key] = state.attemptBudget[key as never] ?? 0;
    }
    base.budget = budget;
  }
  if (contract.requiresBindings) {
    const chapter = state as ChapterGenerationRunState;
    base.bindings = {
      creationSpecVersionId: chapter.creationSpecVersionId,
      researchBundleId: chapter.researchBundleId,
      storyBlueprintId: chapter.storyBlueprintId,
      blueprintChapterId: chapter.blueprintChapterId,
    };
  }
  return base;
}

/** 仓库 canonical serialization（与 input_snapshot_json 持久化一致） */
export function serializeInputSnapshot(snapshot: unknown): string {
  return canonicalJson(snapshot);
}

/** 由 snapshot 计算 inputHash（与 execution.inputHash 一致） */
export function inputHashOf(hashPayload: (payload: string) => string, snapshot: unknown): string {
  return hashPayload(canonicalJson(snapshot));
}
