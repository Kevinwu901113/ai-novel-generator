/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约（DTO + 运行时校验）
 *
 * 只包含类型定义和验证函数，供 Main / Preload / Renderer / Worker 共享。
 * 不含业务逻辑 —— 逻辑在 @ai-novel/domain 的 pure transition / validator 中。
 *
 * 本模块是纯自包含：不导入任何包，校验器为手写（与仓库惯例一致）。
 * 不复制 Domain 的完整 Graph 执行器，不实现伪严格 graph-aware validator，
 * 不依赖 domain 包，不暴露内部 transition 函数。
 *
 * 暴露范围（Renderer / runtime 真正需要的稳定公共类型）：
 * - Project / Chapter Graph identity DTO 与 run kind；
 * - WorkflowStage 投影；
 * - 当前节点 / possible next nodes 公共投影；
 * - 人工决策公共 input DTO（含 Idea Intake 凭证制语义）；
 * - 终止状态 DTO。
 *
 * 说明：共享状态（RunState）的权威校验在 @ai-novel/domain 的
 * `validateGraphRunState`（graph-aware，required + exact / fail-closed）。
 * contracts 不暴露 graph-aware 状态 validator —— 避免伪严格边界。
 */

// ── Graph identity / run kind ────────────────────────────────────

/** run 种类（project / chapter） */
export type GraphRunKind = 'project' | 'chapter';

export function isValidGraphRunKind(value: unknown): value is GraphRunKind {
  return value === 'project' || value === 'chapter';
}

/** 某张 Graph 的稳定身份（跨进程传递用字符串字段，branded 类型只存在于 domain） */
export interface GraphIdentityDto {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly kind: GraphRunKind;
}

// ── plain-object + required/exact 校验基础 ───────────────────────

/**
 * 仅接受 Object.prototype 或 null prototype 的普通对象；
 * 自定义原型 / 数组 / null / 原始类型拒绝。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 公共 ID 长度上限（与 Domain `AnswerReceiptId` 的 128 上限一致） */
const MAX_PUBLIC_ID_LENGTH = 128;

/**
 * 统一的 bounded trimmed ID helper。
 *
 * 应用于所有跨进程公共 ID（graphId / graphVersion / nodeId / possibleNextNodes /
 * HumanDecisionInputDto.nodeId / answerId）：必须是字符串、非空、trimmed（无首尾
 * 空白）、长度 ≤ `MAX_PUBLIC_ID_LENGTH`。answerId 的规则与 Domain `AnswerReceiptId`
 * （`isAnswerReceiptId`）完全一致 —— 非空 + trimmed + ≤128。
 */
function isBoundedTrimmedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= MAX_PUBLIC_ID_LENGTH
  );
}

/**
 * required + exact 结构校验：普通对象、必需键齐全、无额外键。
 * 不使用 `value as Record<string, unknown>` 绕过 —— 由 isPlainObject 安全收窄。
 */
function hasRequiredExactKeys(
  value: unknown,
  required: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== required.length) return false;
  for (const key of required) {
    if (!hasOwn(value, key)) return false;
  }
  return true;
}

export function isValidGraphIdentityDto(value: unknown): value is GraphIdentityDto {
  if (!hasRequiredExactKeys(value, ['graphId', 'graphVersion', 'kind'])) return false;
  return (
    isBoundedTrimmedId(value.graphId) &&
    isBoundedTrimmedId(value.graphVersion) &&
    isValidGraphRunKind(value.kind)
  );
}

// ── UI 阶段（派生映射）───────────────────────────────────────────

/** 节点 → UI 阶段的派生枚举（不是图，不能用于推导下一节点） */
export type WorkflowStage =
  'idea' | 'clarify' | 'research' | 'blueprint' | 'generate' | 'manuscript' | 'done';

export function isValidWorkflowStage(value: unknown): value is WorkflowStage {
  return (
    value === 'idea' ||
    value === 'clarify' ||
    value === 'research' ||
    value === 'blueprint' ||
    value === 'generate' ||
    value === 'manuscript' ||
    value === 'done'
  );
}

// ── 当前节点 / possible next nodes 公共投影 ─────────────────────

/** 节点运行状态（与 domain 的 GraphNodeStatus 一致的稳定公共枚举） */
export type GraphNodeStatusDto =
  'pending' | 'active' | 'waiting_for_human' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export function isValidGraphNodeStatusDto(value: unknown): value is GraphNodeStatusDto {
  return (
    value === 'pending' ||
    value === 'active' ||
    value === 'waiting_for_human' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'cancelled'
  );
}

/** 单个节点的进度投影（Renderer 展示用） */
export interface GraphNodeProjectionDto {
  readonly nodeId: string;
  readonly stage: WorkflowStage;
  readonly status: GraphNodeStatusDto;
}

export function isValidGraphNodeProjectionDto(value: unknown): value is GraphNodeProjectionDto {
  if (!hasRequiredExactKeys(value, ['nodeId', 'stage', 'status'])) return false;
  return (
    isBoundedTrimmedId(value.nodeId) &&
    isValidWorkflowStage(value.stage) &&
    isValidGraphNodeStatusDto(value.status)
  );
}

/** 进度投影：当前活跃节点 + possible next nodes（Renderer 不自己推导下一节点） */
export interface GraphProgressProjectionDto {
  readonly activeNodes: ReadonlyArray<GraphNodeProjectionDto>;
  readonly possibleNextNodes: ReadonlyArray<string>;
}

export function isValidGraphProgressProjectionDto(
  value: unknown,
): value is GraphProgressProjectionDto {
  if (!hasRequiredExactKeys(value, ['activeNodes', 'possibleNextNodes'])) return false;
  if (!Array.isArray(value.activeNodes)) return false;
  if (!Array.isArray(value.possibleNextNodes)) return false;
  // activeNodes：每个投影合法，且 nodeId 不重复
  const activeIds = new Set<string>();
  for (const node of value.activeNodes) {
    if (!isValidGraphNodeProjectionDto(node)) return false;
    if (activeIds.has(node.nodeId)) return false; // 重复 active node 拒绝
    activeIds.add(node.nodeId);
  }
  // possibleNextNodes：每个都是 trimmed bounded ID，且不重复
  const nextIds = new Set<string>();
  for (const id of value.possibleNextNodes) {
    if (!isBoundedTrimmedId(id)) return false;
    if (nextIds.has(id)) return false; // 重复 possible next node 拒绝
    nextIds.add(id);
  }
  return true;
}

// ── 人工决策公共 input DTO ───────────────────────────────────────

/**
 * Idea Intake 回答决策（凭证制，graph 不保存回答正文）。
 *
 * - answer：必须带非空、trimmed 的 `answerId`；Runtime 先把回答写入
 *   现有 Grill/Idea Intake 权威存储取得 answerId，再推进 Graph transition。
 * - skip：跳过当前问题；不需要 answerId。
 * - finish：主动结束访谈；不需要 answerId。
 */
export type IntakeHumanDecisionDto =
  | {
      readonly nodeId: string;
      readonly decisionType: 'intake_response';
      readonly action: 'answer';
      readonly answerId: string;
    }
  | {
      readonly nodeId: string;
      readonly decisionType: 'intake_response';
      readonly action: 'skip';
    }
  | {
      readonly nodeId: string;
      readonly decisionType: 'intake_response';
      readonly action: 'finish';
    };

/** 人工升级决策取值（含各升级节点的闭合枚举） */
export type EscalationDecisionOutcomeDto =
  | 'accept_current'
  | 'modify_requirements'
  | 'cancel'
  | 'continue_later'
  | 'continue_with_current_spec'
  | 'modify_idea'
  | 'use_current_research'
  | 'skip_research';

/** 人工决策公共 input DTO（闭合判别联合） */
export type HumanDecisionInputDto =
  | IntakeHumanDecisionDto
  | {
      readonly nodeId: string;
      readonly decisionType: 'blueprint_gate';
      readonly outcome: 'accept' | 'request_rewrite';
    }
  | {
      readonly nodeId: string;
      readonly decisionType: 'candidate_gate';
      readonly outcome: 'accept' | 'reject' | 'request_rewrite';
    }
  | {
      readonly nodeId: string;
      readonly decisionType: 'escalation';
      readonly outcome: EscalationDecisionOutcomeDto;
    };

function isIntakeHumanDecisionDto(value: Record<string, unknown>): value is IntakeHumanDecisionDto {
  if (value.decisionType !== 'intake_response') return false;
  if (!isBoundedTrimmedId(value.nodeId)) return false;
  if (value.action === 'answer') {
    // answer 必须带合法 answerId（receipt：非空、trimmed、≤128），且无额外键；
    // 规则与 Domain `AnswerReceiptId` 完全一致
    return (
      hasRequiredExactKeys(value, ['nodeId', 'decisionType', 'action', 'answerId']) &&
      isBoundedTrimmedId(value.answerId)
    );
  }
  if (value.action === 'skip' || value.action === 'finish') {
    return hasRequiredExactKeys(value, ['nodeId', 'decisionType', 'action']);
  }
  return false;
}

const ESCALATION_OUTCOMES: ReadonlySet<string> = new Set<EscalationDecisionOutcomeDto>([
  'accept_current',
  'modify_requirements',
  'cancel',
  'continue_later',
  'continue_with_current_spec',
  'modify_idea',
  'use_current_research',
  'skip_research',
]);

/** 人工决策公共 input DTO 校验（手写，plain-object + required/exact，fail-closed） */
export function isValidHumanDecisionInputDto(value: unknown): value is HumanDecisionInputDto {
  if (!isPlainObject(value)) return false;
  if (isIntakeHumanDecisionDto(value)) return true;
  if (!isBoundedTrimmedId(value.nodeId)) return false;
  if (value.decisionType === 'blueprint_gate') {
    return (
      hasRequiredExactKeys(value, ['nodeId', 'decisionType', 'outcome']) &&
      (value.outcome === 'accept' || value.outcome === 'request_rewrite')
    );
  }
  if (value.decisionType === 'candidate_gate') {
    return (
      hasRequiredExactKeys(value, ['nodeId', 'decisionType', 'outcome']) &&
      (value.outcome === 'accept' ||
        value.outcome === 'reject' ||
        value.outcome === 'request_rewrite')
    );
  }
  if (value.decisionType === 'escalation') {
    return (
      hasRequiredExactKeys(value, ['nodeId', 'decisionType', 'outcome']) &&
      typeof value.outcome === 'string' &&
      ESCALATION_OUTCOMES.has(value.outcome)
    );
  }
  return false;
}

// ── 终止状态 DTO ────────────────────────────────────────────────

/** 运行终止状态（blocked 是终止态：恢复必须创建新 run） */
export type RunTerminalStatusDto = 'completed' | 'failed' | 'cancelled' | 'blocked';

export function isValidRunTerminalStatusDto(value: unknown): value is RunTerminalStatusDto {
  return (
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'blocked'
  );
}

/** 运行终止状态 DTO */
export interface RunTerminalStateDto {
  readonly terminalStatus: RunTerminalStatusDto | null;
}

export function isValidRunTerminalStateDto(value: unknown): value is RunTerminalStateDto {
  if (!hasRequiredExactKeys(value, ['terminalStatus'])) return false;
  return value.terminalStatus === null || isValidRunTerminalStatusDto(value.terminalStatus);
}
