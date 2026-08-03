/**
 * @ai-novel/domain - Graph-aware Run State Validation
 *
 * 权威的共享状态校验：把 `IdeaToNovelGraphRunState` 与权威 Graph 对照校验。
 *
 * contracts 包不再暴露伪严格的 `GraphRunStatePublicData` validator；
 * 本模块是唯一权威的 graph-aware 状态校验边界。
 *
 * 检查：
 * - graphId/version 等于权威 Graph；
 * - nodeStatuses 恰好覆盖全部 Graph 节点，无未知节点；
 * - activeFrontier 无重复，且与 active/waiting_for_human status 双向一致；
 * - pending decision 的节点 / 类型 / 状态一致；
 * - terminal run 的 frontier 必须为空；completed 时对应终止节点必须 succeeded；
 * - attemptBudget 恰好覆盖全部预算键；artifacts 恰好覆盖闭合集合；
 * - invalidatedArtifacts 无重复；所有 ID trim 非空；
 * - 拒绝额外 top-level 与嵌套键。
 *
 * 纯函数 —— 不访问时间、UUID、文件系统、数据库或模型。
 */

import type { ArtifactKind, GraphNodeId, IdeaToNovelGraphV1 } from './idea-to-novel-graph.js';
import {
  ARTIFACT_KINDS,
  LOOP_BUDGET_KEYS,
  isArtifactKind,
  isValidGraphNodeStatus,
  isValidGraphRunTerminalStatus,
  type IdeaToNovelGraphRunState,
} from './idea-to-novel-graph-state.js';

/** 状态校验错误码（闭合枚举） */
export type GraphStateValidationErrorCode =
  | 'STATE_NOT_OBJECT'
  | 'STATE_GRAPH_ID_MISMATCH'
  | 'STATE_EXTRA_KEY'
  | 'STATE_NODE_KEY_SET_INCOMPLETE'
  | 'STATE_NODE_KEY_SET_UNKNOWN'
  | 'STATE_NODE_STATUS_INVALID'
  | 'STATE_FRONTIER_DUPLICATE'
  | 'STATE_FRONTIER_STATUS_MISMATCH'
  | 'STATE_PENDING_DECISION_INCONSISTENT'
  | 'STATE_TERMINAL_FRONTIER_NOT_EMPTY'
  | 'STATE_TERMINAL_NODE_NOT_SUCCEEDED'
  | 'STATE_BUDGET_KEY_SET_INCOMPLETE'
  | 'STATE_BUDGET_KEY_SET_UNKNOWN'
  | 'STATE_BUDGET_COUNT_INVALID'
  | 'STATE_ARTIFACT_SLOT_INCOMPLETE'
  | 'STATE_ARTIFACT_KIND_UNKNOWN'
  | 'STATE_ARTIFACT_REF_MISMATCH'
  | 'STATE_INVALIDATED_DUPLICATE'
  | 'STATE_OUTCOME_INVALID'
  | 'STATE_EMPTY_ID';

/** 单条状态校验错误 */
export interface GraphStateValidationError {
  readonly code: GraphStateValidationErrorCode;
  readonly message: string;
  readonly nodeId?: GraphNodeId;
}

function se(
  code: GraphStateValidationErrorCode,
  message: string,
  nodeId?: GraphNodeId,
): GraphStateValidationError {
  return { code, message, ...(nodeId ? { nodeId } : {}) };
}

const STATE_KEYS = new Set([
  'graphId',
  'graphVersion',
  'projectId',
  'workflowRunId',
  'nodeStatuses',
  'activeFrontier',
  'nodeOutcomes',
  'artifacts',
  'pendingHumanDecision',
  'attemptBudget',
  'consumedEdges',
  'invalidatedArtifacts',
  'terminalStatus',
  'createdAt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验运行状态与权威 Graph 的一致性，返回错误列表（空数组 = 有效）。
 * fail-closed：非法 state 返回至少一条错误，绝不抛异常。
 */
export function validateGraphRunState(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
): ReadonlyArray<GraphStateValidationError> {
  if (!isRecord(state)) return [se('STATE_NOT_OBJECT', 'state 不是对象')];
  const errors: GraphStateValidationError[] = [];

  for (const key of Object.keys(state)) {
    if (!STATE_KEYS.has(key)) errors.push(se('STATE_EXTRA_KEY', `state 含未知键: ${key}`));
  }

  if (state.graphId !== graph.id || state.graphVersion !== graph.version) {
    errors.push(se('STATE_GRAPH_ID_MISMATCH', 'state.graphId/version 与权威 Graph 不一致'));
  }
  if (!isTrimmedNonEmpty(state.projectId)) errors.push(se('STATE_EMPTY_ID', 'projectId 为空'));
  if (!isTrimmedNonEmpty(state.workflowRunId))
    errors.push(se('STATE_EMPTY_ID', 'workflowRunId 为空'));

  const knownIds = new Set<GraphNodeId>(graph.nodes.map((n) => n.id));
  if (!isRecord(state.nodeStatuses)) {
    errors.push(se('STATE_NODE_KEY_SET_INCOMPLETE', 'nodeStatuses 不是对象'));
  } else {
    for (const node of graph.nodes) {
      if (!(node.id in state.nodeStatuses)) {
        errors.push(
          se('STATE_NODE_KEY_SET_INCOMPLETE', `nodeStatuses 缺少节点 ${node.id}`, node.id),
        );
      }
    }
    for (const id of Object.keys(state.nodeStatuses)) {
      if (!knownIds.has(id as GraphNodeId)) {
        errors.push(se('STATE_NODE_KEY_SET_UNKNOWN', `nodeStatuses 含未知节点 ${id}`));
      }
      if (!isValidGraphNodeStatus(state.nodeStatuses[id as GraphNodeId])) {
        errors.push(se('STATE_NODE_STATUS_INVALID', `节点 ${id} 状态非法`));
      }
    }
  }

  // activeFrontier 无重复 + 与 active/waiting_for_human 双向一致
  if (!Array.isArray(state.activeFrontier)) {
    errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', 'activeFrontier 必须是数组'));
  } else {
    const frontierSet = new Set<GraphNodeId>(state.activeFrontier);
    if (frontierSet.size !== state.activeFrontier.length) {
      errors.push(se('STATE_FRONTIER_DUPLICATE', 'activeFrontier 不允许重复'));
    }
    for (const id of state.activeFrontier) {
      if (!isTrimmedNonEmpty(id)) errors.push(se('STATE_EMPTY_ID', 'frontier 含空 ID'));
    }
    const expectedFrontier = graph.nodes
      .filter((n) => {
        const s = state.nodeStatuses[n.id];
        return s === 'active' || s === 'waiting_for_human';
      })
      .map((n) => n.id);
    if (expectedFrontier.length !== frontierSet.size) {
      errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', 'frontier 与 active/waiting 状态不一致'));
    }
    for (const id of expectedFrontier) {
      if (!frontierSet.has(id)) {
        errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', `frontier 缺少 active 节点 ${id}`, id));
      }
    }
  }

  // pending decision 一致性
  if (state.pendingHumanDecision !== null) {
    const pd = state.pendingHumanDecision;
    if (!knownIds.has(pd.nodeId)) {
      errors.push(
        se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点未知', pd.nodeId),
      );
    } else {
      const node = graph.nodes.find((n) => n.id === pd.nodeId);
      if (state.nodeStatuses[pd.nodeId] !== 'waiting_for_human') {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            'pending decision 节点状态应为 waiting_for_human',
            pd.nodeId,
          ),
        );
      }
      if (!state.activeFrontier.includes(pd.nodeId)) {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            'pending decision 节点应在 frontier',
            pd.nodeId,
          ),
        );
      }
      if (node && node.humanDecisionType !== pd.decisionType) {
        errors.push(
          se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 类型与节点不一致', pd.nodeId),
        );
      }
    }
  }

  // terminal 一致性
  if (state.terminalStatus !== null) {
    if (!isValidGraphRunTerminalStatus(state.terminalStatus)) {
      errors.push(se('STATE_TERMINAL_NODE_NOT_SUCCEEDED', 'terminalStatus 非法'));
    }
    if (state.activeFrontier.length > 0) {
      errors.push(se('STATE_TERMINAL_FRONTIER_NOT_EMPTY', 'terminal run 的 frontier 必须为空'));
    }
    if (state.terminalStatus !== 'failed') {
      // completed / cancelled / blocked 必须对应终止节点 succeeded
      const terminalNode = graph.nodes.find(
        (n) => n.kind === 'TERMINAL' && n.terminalStatus === state.terminalStatus,
      );
      if (terminalNode && state.nodeStatuses[terminalNode.id] !== 'succeeded') {
        errors.push(
          se(
            'STATE_TERMINAL_NODE_NOT_SUCCEEDED',
            `终止节点 ${terminalNode.id} 应为 succeeded`,
            terminalNode.id,
          ),
        );
      }
    }
  }

  // attemptBudget key set 完整
  if (!isRecord(state.attemptBudget)) {
    errors.push(se('STATE_BUDGET_KEY_SET_INCOMPLETE', 'attemptBudget 不是对象'));
  } else {
    for (const key of LOOP_BUDGET_KEYS) {
      if (!(key in state.attemptBudget)) {
        errors.push(se('STATE_BUDGET_KEY_SET_INCOMPLETE', `attemptBudget 缺少预算 ${key}`));
      }
    }
    for (const key of Object.keys(state.attemptBudget)) {
      if (!LOOP_BUDGET_KEYS.includes(key as never)) {
        errors.push(se('STATE_BUDGET_KEY_SET_UNKNOWN', `attemptBudget 含未知预算 ${key}`));
      }
      const n = state.attemptBudget[key as never];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
        errors.push(se('STATE_BUDGET_COUNT_INVALID', `预算 ${key} 计数非法`));
      }
    }
  }

  // artifacts 槽位完整
  if (!isRecord(state.artifacts)) {
    errors.push(se('STATE_ARTIFACT_SLOT_INCOMPLETE', 'artifacts 不是对象'));
  } else {
    for (const kind of ARTIFACT_KINDS) {
      if (!(kind in state.artifacts)) {
        errors.push(se('STATE_ARTIFACT_SLOT_INCOMPLETE', `artifacts 缺少槽位 ${kind}`));
      }
    }
    for (const key of Object.keys(state.artifacts)) {
      if (!isArtifactKind(key)) {
        errors.push(se('STATE_ARTIFACT_KIND_UNKNOWN', `artifacts 含未知 kind ${key}`));
      }
      const ref = state.artifacts[key as ArtifactKind];
      if (ref !== null) {
        if (ref.kind !== key) {
          errors.push(se('STATE_ARTIFACT_REF_MISMATCH', `artifacts.${key} 引用 kind 不匹配`));
        }
        if (!isTrimmedNonEmpty(ref.artifactId)) {
          errors.push(se('STATE_EMPTY_ID', `artifacts.${key} 引用 ID 为空`));
        }
      }
    }
  }

  // invalidatedArtifacts 无重复
  if (!Array.isArray(state.invalidatedArtifacts)) {
    errors.push(se('STATE_INVALIDATED_DUPLICATE', 'invalidatedArtifacts 必须是数组'));
  } else {
    const seenRefs = new Set<string>();
    for (const ref of state.invalidatedArtifacts) {
      const key = `${ref.kind}:${ref.artifactId}`;
      if (seenRefs.has(key)) {
        errors.push(se('STATE_INVALIDATED_DUPLICATE', `invalidated artifact 重复: ${key}`));
      }
      seenRefs.add(key);
      if (!isTrimmedNonEmpty(ref.artifactId))
        errors.push(se('STATE_EMPTY_ID', 'invalidated artifact ID 为空'));
    }
  }

  // nodeOutcomes 合法
  if (!isRecord(state.nodeOutcomes)) {
    errors.push(se('STATE_OUTCOME_INVALID', 'nodeOutcomes 不是对象'));
  } else {
    for (const [nodeId, outcome] of Object.entries(state.nodeOutcomes)) {
      if (!knownIds.has(nodeId as GraphNodeId)) {
        errors.push(se('STATE_OUTCOME_INVALID', `nodeOutcomes 含未知节点 ${nodeId}`));
        continue;
      }
      const o = outcome as { condition?: unknown; value?: unknown };
      if (!o || typeof o.condition !== 'string' || o.condition.length === 0) {
        errors.push(se('STATE_OUTCOME_INVALID', `节点 ${nodeId} 的 outcome 非法`));
      }
    }
  }

  return errors;
}

/** 状态是否有效（错误列表为空） */
export function isValidGraphRunState(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
): boolean {
  return validateGraphRunState(graph, state).length === 0;
}
