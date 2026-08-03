/**
 * @ai-novel/domain - Graph-aware Run State Validation（unknown 输入边界）
 *
 * 权威的共享状态校验：把任意输入与权威 Graph 对照校验，绝不抛异常、绝不部分接受。
 *
 * contracts 包不再暴露伪严格的 `GraphRunStatePublicData` validator；
 * 本模块是唯一权威的 graph-aware 状态校验边界，`assertValidTransitionState` 复用本模块。
 *
 * 检查（fail-closed）：
 * - 输入必须是 Object.prototype / null prototype 的普通对象；
 * - 顶层键 required + exact（无缺失、无多余、无自定义原型 / 继承键）；
 * - graphId/version 等于权威 Graph；所有 ID trim 非空；
 * - nodeStatuses 恰好覆盖全部 Graph 节点，无未知节点，状态闭合；
 * - activeFrontier 无重复，且与 active/waiting_for_human status 双向一致；
 * - pending decision 双向一致：waiting_for_human 节点必须恰好对应一个 pending decision；
 * - terminal run frontier 必须为空；completed/cancelled/blocked 时对应终止节点必须 succeeded；
 * - attemptBudget 恰好覆盖全部预算键，计数合法；
 * - artifacts 恰好覆盖闭合集合，ref 嵌套 exact keys，kind 匹配；
 * - invalidatedArtifacts 无重复；
 * - consumedEdges 均为已知边 ID、无重复；
 * - nodeOutcomes：节点已知且 succeeded、condition 与节点输出契约一致、value 属于闭合枚举；
 * - createdAt 非空。
 *
 * 纯函数 —— 不访问时间、UUID、文件系统、数据库或模型。
 */

import {
  isGraphConditionName,
  isGraphConditionOutcome,
  type GraphNodeId,
  type IdeaToNovelGraphV1,
} from './idea-to-novel-graph.js';
import {
  ARTIFACT_KINDS,
  LOOP_BUDGET_KEYS,
  isArtifactKind,
  isValidGraphNodeStatus,
  isValidGraphRunTerminalStatus,
} from './idea-to-novel-graph-state.js';

/** 状态校验错误码（闭合枚举） */
export type GraphStateValidationErrorCode =
  | 'STATE_NOT_OBJECT'
  | 'STATE_CUSTOM_PROTOTYPE'
  | 'STATE_GRAPH_ID_MISMATCH'
  | 'STATE_EXTRA_KEY'
  | 'STATE_MISSING_KEY'
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
  | 'STATE_ARTIFACT_REF_KEYS'
  | 'STATE_INVALIDATED_DUPLICATE'
  | 'STATE_CONSUMED_UNKNOWN'
  | 'STATE_CONSUMED_DUPLICATE'
  | 'STATE_OUTCOME_NODE_UNKNOWN'
  | 'STATE_OUTCOME_NODE_NOT_SUCCEEDED'
  | 'STATE_OUTCOME_CONDITION_MISMATCH'
  | 'STATE_OUTCOME_VALUE_INVALID'
  | 'STATE_OUTCOME_KEYS'
  | 'STATE_PENDING_KEYS'
  | 'STATE_EMPTY_ID'
  | 'STATE_CREATED_AT_INVALID';

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
const ARTIFACT_REF_KEYS = new Set(['kind', 'artifactId']);
const OUTCOME_KEYS = new Set(['condition', 'value']);
const PENDING_KEYS = new Set(['nodeId', 'decisionType']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkExactKeys(
  errors: GraphStateValidationError[],
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: GraphStateValidationErrorCode,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(se(code, `${where} 含未知键: ${key}`));
  }
}

/**
 * 校验任意输入与权威 Graph 的一致性，返回错误列表（空数组 = 有效）。
 * fail-closed：任意输入都至少返回一条错误或空数组，绝不抛异常。
 */
export function validateGraphRunState(
  graph: IdeaToNovelGraphV1,
  state: unknown,
): ReadonlyArray<GraphStateValidationError> {
  const errors: GraphStateValidationError[] = [];
  if (!isRecord(state)) return [se('STATE_NOT_OBJECT', 'state 不是对象')];
  if (!isPlainObject(state)) return [se('STATE_CUSTOM_PROTOTYPE', 'state 含自定义原型')];

  for (const key of Object.keys(state)) {
    if (!STATE_KEYS.has(key)) errors.push(se('STATE_EXTRA_KEY', `state 含未知键: ${key}`));
  }
  for (const key of STATE_KEYS) {
    if (!(key in state)) errors.push(se('STATE_MISSING_KEY', `state 缺少必需键: ${key}`));
  }

  const graphId = state.graphId as unknown;
  const graphVersion = state.graphVersion as unknown;
  if (graphId !== graph.id || graphVersion !== graph.version) {
    errors.push(se('STATE_GRAPH_ID_MISMATCH', 'state.graphId/version 与权威 Graph 不一致'));
  }
  if (!isTrimmedNonEmpty(state.projectId)) errors.push(se('STATE_EMPTY_ID', 'projectId 为空'));
  if (!isTrimmedNonEmpty(state.workflowRunId))
    errors.push(se('STATE_EMPTY_ID', 'workflowRunId 为空'));
  if (!isTrimmedNonEmpty(state.createdAt)) {
    errors.push(se('STATE_CREATED_AT_INVALID', 'createdAt 非法'));
  }

  const knownIds = new Set<GraphNodeId>(graph.nodes.map((n) => n.id));
  const knownEdgeIds = new Set<string>(graph.edges.map((e) => e.id));

  // nodeStatuses
  const nodeStatuses = state.nodeStatuses as unknown;
  if (!isPlainObject(nodeStatuses)) {
    errors.push(se('STATE_NODE_KEY_SET_INCOMPLETE', 'nodeStatuses 不是普通对象'));
  } else {
    checkExactKeys(
      errors,
      nodeStatuses,
      new Set(graph.nodes.map((n) => n.id as string)),
      'STATE_NODE_KEY_SET_UNKNOWN',
      'nodeStatuses',
    );
    for (const node of graph.nodes) {
      if (!(node.id in nodeStatuses)) {
        errors.push(
          se('STATE_NODE_KEY_SET_INCOMPLETE', `nodeStatuses 缺少节点 ${node.id}`, node.id),
        );
      }
    }
    for (const [id, status] of Object.entries(nodeStatuses)) {
      if (!knownIds.has(id as GraphNodeId)) {
        errors.push(se('STATE_NODE_KEY_SET_UNKNOWN', `nodeStatuses 含未知节点 ${id}`));
      }
      if (!isValidGraphNodeStatus(status)) {
        errors.push(se('STATE_NODE_STATUS_INVALID', `节点 ${id} 状态非法`));
      }
    }
  }

  // activeFrontier
  const activeFrontier = state.activeFrontier as unknown;
  if (!Array.isArray(activeFrontier)) {
    errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', 'activeFrontier 必须是数组'));
  } else {
    const frontierSet = new Set<string>(activeFrontier as string[]);
    if (frontierSet.size !== activeFrontier.length) {
      errors.push(se('STATE_FRONTIER_DUPLICATE', 'activeFrontier 不允许重复'));
    }
    for (const id of activeFrontier) {
      if (!isTrimmedNonEmpty(id)) errors.push(se('STATE_EMPTY_ID', 'frontier 含空 ID'));
    }
    const waitingOrActive = graph.nodes.filter((n) => {
      const s = (nodeStatuses as Record<string, unknown>)[n.id];
      return s === 'active' || s === 'waiting_for_human';
    });
    if (waitingOrActive.length !== frontierSet.size) {
      errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', 'frontier 与 active/waiting 状态不一致'));
    }
    for (const n of waitingOrActive) {
      if (!frontierSet.has(n.id)) {
        errors.push(
          se('STATE_FRONTIER_STATUS_MISMATCH', `frontier 缺少 active 节点 ${n.id}`, n.id),
        );
      }
    }
  }

  // pending decision 双向一致：waiting_for_human 必须恰好对应一个 pending decision
  const pending = state.pendingHumanDecision as unknown;
  if (pending !== null) {
    if (!isPlainObject(pending)) {
      errors.push(se('STATE_PENDING_KEYS', 'pendingHumanDecision 不是普通对象'));
    } else {
      checkExactKeys(errors, pending, PENDING_KEYS, 'STATE_PENDING_KEYS', 'pendingHumanDecision');
      const nodeId = pending.nodeId as unknown;
      if (!knownIds.has(nodeId as GraphNodeId)) {
        errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点未知'));
      } else {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if ((nodeStatuses as Record<string, unknown>)[nodeId as string] !== 'waiting_for_human') {
          errors.push(
            se(
              'STATE_PENDING_DECISION_INCONSISTENT',
              'pending decision 节点状态应为 waiting_for_human',
            ),
          );
        }
        if (!(activeFrontier as unknown[]).includes(nodeId)) {
          errors.push(
            se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点应在 frontier'),
          );
        }
        if (node && node.humanDecisionType !== pending.decisionType) {
          errors.push(
            se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 类型与节点不一致'),
          );
        }
      }
    }
  }
  if (isPlainObject(nodeStatuses)) {
    const waitingNodes = graph.nodes.filter((n) => nodeStatuses[n.id] === 'waiting_for_human');
    for (const n of waitingNodes) {
      if (pending === null || !isPlainObject(pending) || pending.nodeId !== n.id) {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            `waiting_for_human 节点 ${n.id} 缺少对应 pending decision`,
            n.id,
          ),
        );
      }
    }
    if (pending !== null && isPlainObject(pending) && isTrimmedNonEmpty(pending.nodeId)) {
      const pendingNodeId = pending.nodeId as string;
      if (!waitingNodes.some((n) => n.id === pendingNodeId)) {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            'pending decision 节点不在 waiting_for_human 集合中',
          ),
        );
      }
    }
  }

  // terminal 一致性
  const terminalStatus = state.terminalStatus as unknown;
  if (terminalStatus !== null) {
    if (!isValidGraphRunTerminalStatus(terminalStatus)) {
      errors.push(se('STATE_TERMINAL_NODE_NOT_SUCCEEDED', 'terminalStatus 非法'));
    }
    if (Array.isArray(activeFrontier) && activeFrontier.length > 0) {
      errors.push(se('STATE_TERMINAL_FRONTIER_NOT_EMPTY', 'terminal run 的 frontier 必须为空'));
    }
    if (terminalStatus !== 'failed') {
      const terminalNode = graph.nodes.find(
        (n) => n.kind === 'TERMINAL' && n.terminalStatus === terminalStatus,
      );
      if (
        terminalNode &&
        isPlainObject(nodeStatuses) &&
        nodeStatuses[terminalNode.id] !== 'succeeded'
      ) {
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

  // attemptBudget
  const attemptBudget = state.attemptBudget as unknown;
  if (!isPlainObject(attemptBudget)) {
    errors.push(se('STATE_BUDGET_KEY_SET_INCOMPLETE', 'attemptBudget 不是普通对象'));
  } else {
    checkExactKeys(
      errors,
      attemptBudget,
      new Set(LOOP_BUDGET_KEYS),
      'STATE_BUDGET_KEY_SET_UNKNOWN',
      'attemptBudget',
    );
    for (const key of LOOP_BUDGET_KEYS) {
      if (!(key in attemptBudget)) {
        errors.push(se('STATE_BUDGET_KEY_SET_INCOMPLETE', `attemptBudget 缺少预算 ${key}`));
      }
    }
    for (const [key, value] of Object.entries(attemptBudget)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        errors.push(se('STATE_BUDGET_COUNT_INVALID', `预算 ${key} 计数非法`));
      }
    }
  }

  // artifacts
  const artifacts = state.artifacts as unknown;
  if (!isPlainObject(artifacts)) {
    errors.push(se('STATE_ARTIFACT_SLOT_INCOMPLETE', 'artifacts 不是普通对象'));
  } else {
    checkExactKeys(
      errors,
      artifacts,
      new Set(ARTIFACT_KINDS),
      'STATE_ARTIFACT_KIND_UNKNOWN',
      'artifacts',
    );
    for (const kind of ARTIFACT_KINDS) {
      if (!(kind in artifacts)) {
        errors.push(se('STATE_ARTIFACT_SLOT_INCOMPLETE', `artifacts 缺少槽位 ${kind}`));
      }
    }
    for (const [kind, ref] of Object.entries(artifacts)) {
      if (!isArtifactKind(kind)) {
        errors.push(se('STATE_ARTIFACT_KIND_UNKNOWN', `artifacts 含未知 kind ${kind}`));
      }
      if (ref === null) continue;
      if (!isPlainObject(ref)) {
        errors.push(se('STATE_ARTIFACT_REF_MISMATCH', `artifacts.${kind} 引用不是对象`));
        continue;
      }
      checkExactKeys(
        errors,
        ref,
        ARTIFACT_REF_KEYS,
        'STATE_ARTIFACT_REF_KEYS',
        `artifacts.${kind}`,
      );
      if (ref.kind !== kind) {
        errors.push(se('STATE_ARTIFACT_REF_MISMATCH', `artifacts.${kind} 引用 kind 不匹配`));
      }
      if (!isTrimmedNonEmpty(ref.artifactId)) {
        errors.push(se('STATE_EMPTY_ID', `artifacts.${kind} 引用 ID 为空`));
      }
    }
  }

  // invalidatedArtifacts 无重复
  const invalidatedArtifacts = state.invalidatedArtifacts as unknown;
  if (!Array.isArray(invalidatedArtifacts)) {
    errors.push(se('STATE_INVALIDATED_DUPLICATE', 'invalidatedArtifacts 必须是数组'));
  } else {
    const seenRefs = new Set<string>();
    for (const ref of invalidatedArtifacts) {
      if (!isPlainObject(ref)) {
        errors.push(se('STATE_ARTIFACT_REF_MISMATCH', 'invalidated artifact 不是对象'));
        continue;
      }
      checkExactKeys(
        errors,
        ref,
        ARTIFACT_REF_KEYS,
        'STATE_ARTIFACT_REF_KEYS',
        'invalidatedArtifacts',
      );
      if (!isTrimmedNonEmpty(ref.kind) || !isTrimmedNonEmpty(ref.artifactId)) {
        errors.push(se('STATE_EMPTY_ID', 'invalidated artifact ID 为空'));
        continue;
      }
      const key = `${ref.kind}:${ref.artifactId}`;
      if (seenRefs.has(key)) {
        errors.push(se('STATE_INVALIDATED_DUPLICATE', `invalidated artifact 重复: ${key}`));
      }
      seenRefs.add(key);
    }
  }

  // consumedEdges：均为已知边 ID、无重复
  const consumedEdges = state.consumedEdges as unknown;
  if (!Array.isArray(consumedEdges)) {
    errors.push(se('STATE_CONSUMED_UNKNOWN', 'consumedEdges 必须是数组'));
  } else {
    const seenEdges = new Set<string>();
    for (const id of consumedEdges) {
      if (!isTrimmedNonEmpty(id)) {
        errors.push(se('STATE_EMPTY_ID', 'consumedEdges 含空 ID'));
        continue;
      }
      if (!knownEdgeIds.has(id)) {
        errors.push(se('STATE_CONSUMED_UNKNOWN', `consumedEdges 含未知边 ${id}`));
      }
      if (seenEdges.has(id)) {
        errors.push(se('STATE_CONSUMED_DUPLICATE', `consumedEdges 含重复边 ${id}`));
      }
      seenEdges.add(id);
    }
  }

  // nodeOutcomes：节点已知且 succeeded、condition 与契约一致、value 属于闭合枚举
  const nodeOutcomes = state.nodeOutcomes as unknown;
  if (!isPlainObject(nodeOutcomes)) {
    errors.push(se('STATE_OUTCOME_KEYS', 'nodeOutcomes 不是普通对象'));
  } else {
    checkExactKeys(
      errors,
      nodeOutcomes,
      new Set(graph.nodes.map((n) => n.id as string)),
      'STATE_OUTCOME_NODE_UNKNOWN',
      'nodeOutcomes',
    );
    for (const [nodeId, outcome] of Object.entries(nodeOutcomes)) {
      if (!knownIds.has(nodeId as GraphNodeId)) {
        errors.push(se('STATE_OUTCOME_NODE_UNKNOWN', `nodeOutcomes 含未知节点 ${nodeId}`));
        continue;
      }
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (isPlainObject(nodeStatuses) && nodeStatuses[nodeId] !== 'succeeded') {
        errors.push(
          se(
            'STATE_OUTCOME_NODE_NOT_SUCCEEDED',
            `节点 ${nodeId} 有 outcome 但未 succeeded`,
            nodeId as GraphNodeId,
          ),
        );
      }
      if (!isPlainObject(outcome)) {
        errors.push(se('STATE_OUTCOME_KEYS', `节点 ${nodeId} 的 outcome 不是对象`));
        continue;
      }
      checkExactKeys(errors, outcome, OUTCOME_KEYS, 'STATE_OUTCOME_KEYS', `节点 ${nodeId} outcome`);
      const condition = outcome.condition as unknown;
      if (!isGraphConditionName(condition)) {
        errors.push(
          se('STATE_OUTCOME_CONDITION_MISMATCH', `节点 ${nodeId} 的 outcome condition 非法`),
        );
        continue;
      }
      const expected = node ? node.output.requiredOutcomeCondition : null;
      if (expected !== condition) {
        errors.push(
          se(
            'STATE_OUTCOME_CONDITION_MISMATCH',
            `节点 ${nodeId} 的 outcome condition ${String(condition)} 与输出契约 ${String(expected)} 不一致`,
            nodeId as GraphNodeId,
          ),
        );
      }
      if (!isGraphConditionOutcome(condition as never, outcome.value)) {
        errors.push(se('STATE_OUTCOME_VALUE_INVALID', `节点 ${nodeId} 的 outcome value 非法`));
      }
    }
  }

  return errors;
}

/** 状态是否有效（错误列表为空） */
export function isValidGraphRunState(graph: IdeaToNovelGraphV1, state: unknown): boolean {
  return validateGraphRunState(graph, state).length === 0;
}
