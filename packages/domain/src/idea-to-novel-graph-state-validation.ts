/**
 * @ai-novel/domain - Graph-aware Run State Validation（unknown 输入边界，fail-closed）
 *
 * 权威的共享状态校验：把任意输入与权威 Graph 对照校验，绝不抛异常、绝不部分接受。
 *
 * contracts 包不再暴露伪严格的 `GraphRunStatePublicData` validator；
 * 本模块是唯一权威的 graph-aware 状态校验边界，`assertValidTransitionState` 复用本模块。
 *
 * fail-closed 边界规则：
 * - 输入必须是 Object.prototype / null prototype 的普通对象；
 * - 顶层键按 Graph 种类（project / chapter）执行 required + exact（无缺失、无多余）；
 * - 每个嵌套结构先独立做 shape narrowing（`parse*` 辅助），得到类型安全的局部变量；
 * - shape 无效时，不继续执行依赖该结构的交叉语义检查；
 * - 不使用 `as Record<string, unknown>` / `as unknown[]` 绕过已经失败的 shape 判断；
 * - 交叉校验只使用已经安全解析的局部变量；
 * - 任意 unknown 输入都返回至少一条闭合错误码或空数组，绝不抛异常。
 *
 * 检查（fail-closed）：
 * - graphId/version 等于权威 Graph；所有 ID trim 非空；
 * - nodeStatuses 恰好覆盖全部 Graph 节点，无未知节点，状态闭合；
 * - activeFrontier 无重复、均为已知节点，且与 active/waiting_for_human status 双向一致；
 * - pending decision 双向一致：waiting_for_human 节点必须恰好对应一个 pending decision；
 * - terminal run frontier 必须为空；completed/cancelled/blocked 时对应终止节点必须 succeeded；
 * - attemptBudget 恰好覆盖本图声明的预算键，计数合法；
 * - artifacts 恰好覆盖本图声明的 artifact 槽位，ref 嵌套 exact keys，kind 匹配；
 * - invalidatedArtifacts 无重复；
 * - consumedEdges 均为已知边 ID、无重复；
 * - nodeOutcomes：节点已知且 succeeded、condition 与节点输出契约一致、value 属于闭合枚举；
 * - Chapter state 必须绑定 creationSpecVersionId / researchBundleId / storyBlueprintId / blueprintChapterId。
 *
 * 纯函数 —— 不访问时间、UUID、文件系统、数据库或模型。
 */

import {
  isGraphConditionName,
  isGraphConditionOutcome,
  type GraphNodeId,
  type AnyIdeaToNovelGraphV1,
} from './idea-to-novel-graph.js';
import {
  isValidGraphNodeStatus,
  isValidGraphRunTerminalStatus,
  type GraphNodeStatus,
} from './idea-to-novel-graph-state.js';

/** 状态校验错误码（闭合枚举） */
export type GraphStateValidationErrorCode =
  | 'STATE_NOT_OBJECT'
  | 'STATE_CUSTOM_PROTOTYPE'
  | 'STATE_UNKNOWN_GRAPH_KIND'
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

// ── 每类 Graph 的必需顶层键（required + exact）──────────────────

const BASE_STATE_KEYS: ReadonlyArray<string> = [
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
];

const PROJECT_STATE_KEYS: ReadonlySet<string> = new Set(BASE_STATE_KEYS);

const CHAPTER_STATE_KEYS: ReadonlySet<string> = new Set([
  ...BASE_STATE_KEYS,
  'creationSpecVersionId',
  'researchBundleId',
  'storyBlueprintId',
  'blueprintChapterId',
]);

const ARTIFACT_REF_KEYS = new Set(['kind', 'artifactId']);
const OUTCOME_KEYS = new Set(['condition', 'value']);
const PENDING_KEYS = new Set(['nodeId', 'decisionType']);
const VALID_PENDING_DECISION_TYPES = new Set([
  'intake_response',
  'blueprint_gate',
  'candidate_gate',
  'escalation',
]);

// ── 基础守卫 ────────────────────────────────────────────────────

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

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
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

// ── 嵌套结构解析（shape narrowing，shape 无效时停止该结构的交叉检查）──

type ParsedOk<T> = { readonly ok: true; readonly value: T };
type ParsedErr = { readonly ok: false; readonly errors: ReadonlyArray<GraphStateValidationError> };
type Parsed<T> = ParsedOk<T> | ParsedErr;

function parsedOk<T>(value: T): ParsedOk<T> {
  return { ok: true, value };
}

function parsedErr(errors: ReadonlyArray<GraphStateValidationError>): ParsedErr {
  return { ok: false, errors };
}

/** nodeStatuses：普通对象 + 恰好覆盖全部 Graph 节点 + 状态闭合 */
function parseNodeStatuses(
  graph: AnyIdeaToNovelGraphV1,
  raw: unknown,
): Parsed<ReadonlyMap<string, GraphNodeStatus>> {
  if (!isPlainObject(raw)) {
    return parsedErr([se('STATE_NODE_KEY_SET_INCOMPLETE', 'nodeStatuses 不是普通对象')]);
  }
  const errors: GraphStateValidationError[] = [];
  const knownIds = new Set<string>(graph.nodes.map((n) => n.id));
  checkExactKeys(errors, raw, knownIds, 'STATE_NODE_KEY_SET_UNKNOWN', 'nodeStatuses');
  for (const node of graph.nodes) {
    if (!hasOwn(raw, node.id)) {
      errors.push(se('STATE_NODE_KEY_SET_INCOMPLETE', `nodeStatuses 缺少节点 ${node.id}`, node.id));
    }
  }
  const parsed = new Map<string, GraphNodeStatus>();
  for (const [id, status] of Object.entries(raw)) {
    if (!knownIds.has(id)) continue;
    if (!isValidGraphNodeStatus(status)) {
      errors.push(se('STATE_NODE_STATUS_INVALID', `节点 ${id} 状态非法`));
      continue;
    }
    parsed.set(id, status);
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

/** activeFrontier：数组 + 元素为已知节点 + trim 非空 + 无重复 */
function parseFrontier(raw: unknown, knownIds: ReadonlySet<string>): Parsed<ReadonlySet<string>> {
  if (!Array.isArray(raw)) {
    return parsedErr([se('STATE_FRONTIER_STATUS_MISMATCH', 'activeFrontier 必须是数组')]);
  }
  const errors: GraphStateValidationError[] = [];
  const parsed = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors.push(se('STATE_EMPTY_ID', 'frontier 含空 ID'));
      continue;
    }
    if (!knownIds.has(id)) {
      errors.push(se('STATE_NODE_KEY_SET_UNKNOWN', `frontier 含未知节点 ${id}`));
      continue;
    }
    if (parsed.has(id)) {
      errors.push(se('STATE_FRONTIER_DUPLICATE', 'activeFrontier 不允许重复'));
      continue;
    }
    parsed.add(id);
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

/** pendingHumanDecision：null 或普通对象 + 已知节点 + 合法 decisionType */
function parsePending(
  raw: unknown,
  knownIds: ReadonlySet<string>,
): Parsed<{ readonly nodeId: string; readonly decisionType: string } | null> {
  if (raw === null) return parsedOk(null);
  if (!isPlainObject(raw)) {
    return parsedErr([se('STATE_PENDING_KEYS', 'pendingHumanDecision 不是普通对象')]);
  }
  const errors: GraphStateValidationError[] = [];
  checkExactKeys(errors, raw, PENDING_KEYS, 'STATE_PENDING_KEYS', 'pendingHumanDecision');
  const nodeId = raw.nodeId;
  const decisionType = raw.decisionType;
  if (typeof nodeId !== 'string' || typeof decisionType !== 'string') {
    if (typeof nodeId !== 'string' || !knownIds.has(nodeId)) {
      errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点未知'));
    }
    if (typeof decisionType !== 'string' || !VALID_PENDING_DECISION_TYPES.has(decisionType)) {
      errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 类型非法'));
    }
    return parsedErr(errors);
  }
  if (!knownIds.has(nodeId)) {
    errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点未知'));
  }
  if (!VALID_PENDING_DECISION_TYPES.has(decisionType)) {
    errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 类型非法'));
  }
  if (errors.length > 0) return parsedErr(errors);
  return parsedOk({ nodeId, decisionType });
}

/** attemptBudget：普通对象 + 恰好覆盖本图预算键 + 计数合法 */
function parseAttemptBudget(
  raw: unknown,
  budgetKeys: ReadonlyArray<string>,
): Parsed<ReadonlyMap<string, number>> {
  if (!isPlainObject(raw)) {
    return parsedErr([se('STATE_BUDGET_KEY_SET_INCOMPLETE', 'attemptBudget 不是普通对象')]);
  }
  const errors: GraphStateValidationError[] = [];
  const allowed = new Set<string>(budgetKeys);
  checkExactKeys(errors, raw, allowed, 'STATE_BUDGET_KEY_SET_UNKNOWN', 'attemptBudget');
  for (const key of budgetKeys) {
    if (!hasOwn(raw, key)) {
      errors.push(se('STATE_BUDGET_KEY_SET_INCOMPLETE', `attemptBudget 缺少预算 ${key}`));
    }
  }
  const parsed = new Map<string, number>();
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      errors.push(se('STATE_BUDGET_COUNT_INVALID', `预算 ${key} 计数非法`));
      continue;
    }
    parsed.set(key, value);
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

type ParsedArtifactRef = { readonly kind: string; readonly artifactId: string };

/** artifacts：普通对象 + 恰好覆盖本图 artifact 槽位 + ref 嵌套 exact keys */
function parseArtifacts(
  raw: unknown,
  artifactKinds: ReadonlyArray<string>,
): Parsed<ReadonlyMap<string, ParsedArtifactRef | null>> {
  if (!isPlainObject(raw)) {
    return parsedErr([se('STATE_ARTIFACT_SLOT_INCOMPLETE', 'artifacts 不是普通对象')]);
  }
  const errors: GraphStateValidationError[] = [];
  const allowed = new Set<string>(artifactKinds);
  checkExactKeys(errors, raw, allowed, 'STATE_ARTIFACT_KIND_UNKNOWN', 'artifacts');
  for (const kind of artifactKinds) {
    if (!hasOwn(raw, kind)) {
      errors.push(se('STATE_ARTIFACT_SLOT_INCOMPLETE', `artifacts 缺少槽位 ${kind}`));
    }
  }
  const parsed = new Map<string, ParsedArtifactRef | null>();
  for (const [kind, ref] of Object.entries(raw)) {
    if (!allowed.has(kind)) continue;
    if (ref === null) {
      parsed.set(kind, null);
      continue;
    }
    if (!isPlainObject(ref)) {
      errors.push(se('STATE_ARTIFACT_REF_MISMATCH', `artifacts.${kind} 引用不是对象`));
      continue;
    }
    checkExactKeys(errors, ref, ARTIFACT_REF_KEYS, 'STATE_ARTIFACT_REF_KEYS', `artifacts.${kind}`);
    const refKind = ref.kind;
    const artifactId = ref.artifactId;
    if (refKind !== kind) {
      errors.push(se('STATE_ARTIFACT_REF_MISMATCH', `artifacts.${kind} 引用 kind 不匹配`));
    }
    if (!isTrimmedNonEmpty(artifactId)) {
      errors.push(se('STATE_EMPTY_ID', `artifacts.${kind} 引用 ID 为空`));
      continue;
    }
    parsed.set(kind, { kind, artifactId });
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

/** invalidatedArtifacts：数组 + 合法 ref + 无重复 */
function parseInvalidatedArtifacts(raw: unknown): Parsed<ReadonlyArray<ParsedArtifactRef>> {
  if (!Array.isArray(raw)) {
    return parsedErr([se('STATE_INVALIDATED_DUPLICATE', 'invalidatedArtifacts 必须是数组')]);
  }
  const errors: GraphStateValidationError[] = [];
  const parsed: ParsedArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of raw) {
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
    const kind = ref.kind;
    const artifactId = ref.artifactId;
    if (!isTrimmedNonEmpty(kind) || !isTrimmedNonEmpty(artifactId)) {
      errors.push(se('STATE_EMPTY_ID', 'invalidated artifact ID 为空'));
      continue;
    }
    const key = `${kind}:${artifactId}`;
    if (seen.has(key)) {
      errors.push(se('STATE_INVALIDATED_DUPLICATE', `invalidated artifact 重复: ${key}`));
    }
    seen.add(key);
    parsed.push({ kind, artifactId });
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

/** consumedEdges：数组 + 已知边 ID + 无重复 */
function parseConsumedEdges(
  raw: unknown,
  knownEdgeIds: ReadonlySet<string>,
): Parsed<ReadonlySet<string>> {
  if (!Array.isArray(raw)) {
    return parsedErr([se('STATE_CONSUMED_UNKNOWN', 'consumedEdges 必须是数组')]);
  }
  const errors: GraphStateValidationError[] = [];
  const parsed = new Set<string>();
  for (const id of raw) {
    if (!isTrimmedNonEmpty(id)) {
      errors.push(se('STATE_EMPTY_ID', 'consumedEdges 含空 ID'));
      continue;
    }
    if (!knownEdgeIds.has(id)) {
      errors.push(se('STATE_CONSUMED_UNKNOWN', `consumedEdges 含未知边 ${id}`));
      continue;
    }
    if (parsed.has(id)) {
      errors.push(se('STATE_CONSUMED_DUPLICATE', `consumedEdges 含重复边 ${id}`));
      continue;
    }
    parsed.add(id);
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

type ParsedOutcome = {
  readonly nodeId: string;
  readonly condition: string;
  readonly value: unknown;
};

/** nodeOutcomes：普通对象 + 节点已知 + condition 与契约一致 + value 闭合 */
function parseNodeOutcomes(
  graph: AnyIdeaToNovelGraphV1,
  raw: unknown,
): Parsed<ReadonlyMap<string, ParsedOutcome>> {
  if (!isPlainObject(raw)) {
    return parsedErr([se('STATE_OUTCOME_KEYS', 'nodeOutcomes 不是普通对象')]);
  }
  const errors: GraphStateValidationError[] = [];
  const knownIds = new Set<string>(graph.nodes.map((n) => n.id));
  checkExactKeys(errors, raw, knownIds, 'STATE_OUTCOME_NODE_UNKNOWN', 'nodeOutcomes');
  const parsed = new Map<string, ParsedOutcome>();
  for (const [nodeId, outcome] of Object.entries(raw)) {
    if (!knownIds.has(nodeId)) continue;
    if (!isPlainObject(outcome)) {
      errors.push(se('STATE_OUTCOME_KEYS', `节点 ${nodeId} 的 outcome 不是对象`));
      continue;
    }
    checkExactKeys(errors, outcome, OUTCOME_KEYS, 'STATE_OUTCOME_KEYS', `节点 ${nodeId} outcome`);
    const condition = outcome.condition;
    const value = outcome.value;
    if (!isGraphConditionName(condition)) {
      errors.push(
        se('STATE_OUTCOME_CONDITION_MISMATCH', `节点 ${nodeId} 的 outcome condition 非法`),
      );
      continue;
    }
    const node = graph.nodes.find((n) => n.id === nodeId);
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
    if (!isGraphConditionOutcome(condition, value)) {
      errors.push(se('STATE_OUTCOME_VALUE_INVALID', `节点 ${nodeId} 的 outcome value 非法`));
      continue;
    }
    parsed.set(nodeId, { nodeId, condition, value });
  }
  return errors.length > 0 ? parsedErr(errors) : parsedOk(parsed);
}

// ── 权威入口 ────────────────────────────────────────────────────

/**
 * 校验任意输入与权威 Graph 的一致性，返回错误列表（空数组 = 有效）。
 * fail-closed：任意输入都至少返回一条错误或空数组，绝不抛异常。
 */
export function validateGraphRunState(
  graph: AnyIdeaToNovelGraphV1,
  state: unknown,
): ReadonlyArray<GraphStateValidationError> {
  const errors: GraphStateValidationError[] = [];
  if (!isRecord(state)) return [se('STATE_NOT_OBJECT', 'state 不是对象')];
  if (!isPlainObject(state)) return [se('STATE_CUSTOM_PROTOTYPE', 'state 含自定义原型')];

  // 顶层键：按 Graph 种类执行 required + exact
  let keySet: ReadonlySet<string>;
  if (graph.kind === 'project') keySet = PROJECT_STATE_KEYS;
  else if (graph.kind === 'chapter') keySet = CHAPTER_STATE_KEYS;
  else return [se('STATE_UNKNOWN_GRAPH_KIND', 'graph 的 kind 未知')];
  checkExactKeys(errors, state, keySet, 'STATE_EXTRA_KEY', 'state');
  for (const key of keySet) {
    if (!hasOwn(state, key)) errors.push(se('STATE_MISSING_KEY', `state 缺少必需键: ${key}`));
  }

  // 标识与 ID
  const graphId = state.graphId;
  const graphVersion = state.graphVersion;
  if (graphId !== graph.id || graphVersion !== graph.version) {
    errors.push(se('STATE_GRAPH_ID_MISMATCH', 'state.graphId/version 与权威 Graph 不一致'));
  }
  if (!isTrimmedNonEmpty(state.projectId)) errors.push(se('STATE_EMPTY_ID', 'projectId 为空'));
  if (!isTrimmedNonEmpty(state.workflowRunId))
    errors.push(se('STATE_EMPTY_ID', 'workflowRunId 为空'));
  if (graph.kind === 'chapter') {
    if (!isTrimmedNonEmpty(state.creationSpecVersionId)) {
      errors.push(se('STATE_EMPTY_ID', 'creationSpecVersionId 为空'));
    }
    if (!isTrimmedNonEmpty(state.storyBlueprintId)) {
      errors.push(se('STATE_EMPTY_ID', 'storyBlueprintId 为空'));
    }
    if (!isTrimmedNonEmpty(state.blueprintChapterId)) {
      errors.push(se('STATE_EMPTY_ID', 'blueprintChapterId 为空'));
    }
    if (state.researchBundleId !== null && !isTrimmedNonEmpty(state.researchBundleId)) {
      errors.push(se('STATE_EMPTY_ID', 'researchBundleId 为空'));
    }
  }
  if (!isTrimmedNonEmpty(state.createdAt)) {
    errors.push(se('STATE_CREATED_AT_INVALID', 'createdAt 非法'));
  }

  const knownIds = new Set<string>(graph.nodes.map((n) => n.id));
  const knownEdgeIds = new Set<string>(graph.edges.map((e) => e.id));

  // 嵌套结构独立 shape narrowing
  const nodeStatuses = parseNodeStatuses(graph, state.nodeStatuses);
  if (!nodeStatuses.ok) errors.push(...nodeStatuses.errors);

  const frontier = parseFrontier(state.activeFrontier, knownIds);
  if (!frontier.ok) errors.push(...frontier.errors);

  const pending = parsePending(state.pendingHumanDecision, knownIds);
  if (!pending.ok) errors.push(...pending.errors);

  const attemptBudget = parseAttemptBudget(state.attemptBudget, graph.budgetKeys);
  if (!attemptBudget.ok) errors.push(...attemptBudget.errors);

  const artifacts = parseArtifacts(state.artifacts, graph.artifactKinds);
  if (!artifacts.ok) errors.push(...artifacts.errors);

  const invalidated = parseInvalidatedArtifacts(state.invalidatedArtifacts);
  if (!invalidated.ok) errors.push(...invalidated.errors);

  const consumedEdges = parseConsumedEdges(state.consumedEdges, knownEdgeIds);
  if (!consumedEdges.ok) errors.push(...consumedEdges.errors);

  const nodeOutcomes = parseNodeOutcomes(graph, state.nodeOutcomes);
  if (!nodeOutcomes.ok) {
    errors.push(...nodeOutcomes.errors);
  } else if (nodeStatuses.ok) {
    // outcome 节点必须 succeeded（仅当 nodeStatuses 有效时执行交叉校验）
    for (const [, entry] of nodeOutcomes.value) {
      if (nodeStatuses.value.get(entry.nodeId) !== 'succeeded') {
        errors.push(
          se(
            'STATE_OUTCOME_NODE_NOT_SUCCEEDED',
            `节点 ${entry.nodeId} 有 outcome 但未 succeeded`,
            entry.nodeId as GraphNodeId,
          ),
        );
      }
    }
  }

  // 交叉校验：仅使用已经安全解析的局部变量
  if (nodeStatuses.ok && frontier.ok) {
    const waitingOrActive = graph.nodes.filter((n) => {
      const s = nodeStatuses.value.get(n.id);
      return s === 'active' || s === 'waiting_for_human';
    });
    if (waitingOrActive.length !== frontier.value.size) {
      errors.push(se('STATE_FRONTIER_STATUS_MISMATCH', 'frontier 与 active/waiting 状态不一致'));
    }
    for (const n of waitingOrActive) {
      if (!frontier.value.has(n.id)) {
        errors.push(
          se('STATE_FRONTIER_STATUS_MISMATCH', `frontier 缺少 active 节点 ${n.id}`, n.id),
        );
      }
    }
  }

  // pending decision 双向一致（仅当 nodeStatuses / frontier / pending 均有效）
  if (nodeStatuses.ok && frontier.ok && pending.ok) {
    const pd = pending.value;
    if (pd !== null) {
      const node = graph.nodes.find((n) => n.id === pd.nodeId);
      if (nodeStatuses.value.get(pd.nodeId) !== 'waiting_for_human') {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            'pending decision 节点状态应为 waiting_for_human',
          ),
        );
      }
      if (!frontier.value.has(pd.nodeId)) {
        errors.push(
          se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 节点应在 frontier'),
        );
      }
      if (node && node.humanDecisionType !== pd.decisionType) {
        errors.push(se('STATE_PENDING_DECISION_INCONSISTENT', 'pending decision 类型与节点不一致'));
      }
    }
    const waitingNodes = graph.nodes.filter(
      (n) => nodeStatuses.value.get(n.id) === 'waiting_for_human',
    );
    for (const n of waitingNodes) {
      if (pd === null || pd.nodeId !== n.id) {
        errors.push(
          se(
            'STATE_PENDING_DECISION_INCONSISTENT',
            `waiting_for_human 节点 ${n.id} 缺少对应 pending decision`,
            n.id,
          ),
        );
      }
    }
    if (pd !== null && !waitingNodes.some((n) => n.id === pd.nodeId)) {
      errors.push(
        se(
          'STATE_PENDING_DECISION_INCONSISTENT',
          'pending decision 节点不在 waiting_for_human 集合中',
        ),
      );
    }
  }

  // terminal 一致性
  const terminalStatus = state.terminalStatus;
  if (terminalStatus !== null) {
    if (!isValidGraphRunTerminalStatus(terminalStatus)) {
      errors.push(se('STATE_TERMINAL_NODE_NOT_SUCCEEDED', 'terminalStatus 非法'));
    }
    if (frontier.ok && frontier.value.size > 0) {
      errors.push(se('STATE_TERMINAL_FRONTIER_NOT_EMPTY', 'terminal run 的 frontier 必须为空'));
    }
    if (typeof terminalStatus === 'string' && terminalStatus !== 'failed' && nodeStatuses.ok) {
      const terminalNode = graph.nodes.find(
        (n) => n.kind === 'TERMINAL' && n.terminalStatus === terminalStatus,
      );
      if (terminalNode && nodeStatuses.value.get(terminalNode.id) !== 'succeeded') {
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

  return errors;
}

/** 状态是否有效（错误列表为空） */
export function isValidGraphRunState(graph: AnyIdeaToNovelGraphV1, state: unknown): boolean {
  return validateGraphRunState(graph, state).length === 0;
}
