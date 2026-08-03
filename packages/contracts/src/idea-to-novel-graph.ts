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

export function isValidGraphIdentityDto(value: unknown): value is GraphIdentityDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.graphId === 'string' &&
    obj.graphId.trim().length > 0 &&
    typeof obj.graphVersion === 'string' &&
    obj.graphVersion.trim().length > 0 &&
    isValidGraphRunKind(obj.kind)
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.nodeId === 'string' &&
    obj.nodeId.trim().length > 0 &&
    isValidWorkflowStage(obj.stage) &&
    isValidGraphNodeStatusDto(obj.status)
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.activeNodes)) return false;
  if (!Array.isArray(obj.possibleNextNodes)) return false;
  for (const node of obj.activeNodes) {
    if (!isValidGraphNodeProjectionDto(node)) return false;
  }
  for (const id of obj.possibleNextNodes) {
    if (typeof id !== 'string' || id.trim().length === 0) return false;
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
  if (typeof value.nodeId !== 'string' || value.nodeId.trim().length === 0) return false;
  if (value.action === 'answer') {
    return (
      typeof value.answerId === 'string' &&
      value.answerId.trim().length > 0 &&
      value.answerId === value.answerId.trim()
    );
  }
  return value.action === 'skip' || value.action === 'finish';
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

/** 人工决策公共 input DTO 校验（手写，fail-closed） */
export function isValidHumanDecisionInputDto(value: unknown): value is HumanDecisionInputDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.nodeId !== 'string' || obj.nodeId.trim().length === 0) return false;
  if (isIntakeHumanDecisionDto(obj)) return true;
  if (obj.decisionType === 'blueprint_gate') {
    return obj.outcome === 'accept' || obj.outcome === 'request_rewrite';
  }
  if (obj.decisionType === 'candidate_gate') {
    return (
      obj.outcome === 'accept' || obj.outcome === 'reject' || obj.outcome === 'request_rewrite'
    );
  }
  if (obj.decisionType === 'escalation') {
    return typeof obj.outcome === 'string' && ESCALATION_OUTCOMES.has(obj.outcome);
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.terminalStatus === null) return true;
  return isValidRunTerminalStatusDto(obj.terminalStatus);
}
