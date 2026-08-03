/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约（DTO + 运行时校验）
 *
 * 只包含类型定义和验证函数，供 Main / Preload / Renderer / Worker 共享。
 * 不含业务逻辑 —— 逻辑在 @ai-novel/domain 的 pure transition / validator 中。
 *
 * 本模块是纯自包含：不导入任何包，校验器为手写（与仓库惯例一致）。
 */

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

// ── 节点运行状态 ─────────────────────────────────────────────────

export type GraphNodeStatusPublicData =
  'pending' | 'active' | 'waiting_for_human' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export function isValidGraphNodeStatusPublicData(
  value: unknown,
): value is GraphNodeStatusPublicData {
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

// ── 运行终止状态 ─────────────────────────────────────────────────

export type GraphRunTerminalStatusPublicData = 'completed' | 'failed' | 'cancelled';

export function isValidGraphRunTerminalStatusPublicData(
  value: unknown,
): value is GraphRunTerminalStatusPublicData {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

// ── Artifact 引用（闭合判别联合）─────────────────────────────────

export type GraphArtifactKindPublicData =
  'idea' | 'creationSpec' | 'researchBundle' | 'storyBlueprint' | 'generationRun' | 'manuscript';

export function isValidGraphArtifactKindPublicData(
  value: unknown,
): value is GraphArtifactKindPublicData {
  return (
    value === 'idea' ||
    value === 'creationSpec' ||
    value === 'researchBundle' ||
    value === 'storyBlueprint' ||
    value === 'generationRun' ||
    value === 'manuscript'
  );
}

/** Artifact 引用 —— 闭合判别联合，拒绝任意 JSON */
export type GraphArtifactRefPublicData =
  | { readonly kind: 'idea'; readonly artifactId: string }
  | { readonly kind: 'creationSpec'; readonly artifactId: string }
  | { readonly kind: 'researchBundle'; readonly artifactId: string }
  | { readonly kind: 'storyBlueprint'; readonly artifactId: string }
  | { readonly kind: 'generationRun'; readonly artifactId: string }
  | { readonly kind: 'manuscript'; readonly artifactId: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isArtifactRefShape(value: unknown): value is {
  readonly kind: string;
  readonly artifactId: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { readonly kind?: unknown; readonly artifactId?: unknown };
  return isNonEmptyString(obj.kind) && 'artifactId' in obj;
}

export function isValidGraphArtifactRefPublicData(
  value: unknown,
): value is GraphArtifactRefPublicData {
  if (!isArtifactRefShape(value)) return false;
  if (!isValidGraphArtifactKindPublicData(value.kind)) return false;
  return isNonEmptyString(value.artifactId);
}

// ── 有界循环预算键 ───────────────────────────────────────────────

export type GraphLoopBudgetKeyPublicData =
  | 'clarification'
  | 'researchRetry'
  | 'blueprintRewrite'
  | 'rewrite'
  | 'candidateRewrite'
  | 'regenerate';

export function isValidGraphLoopBudgetKeyPublicData(
  value: unknown,
): value is GraphLoopBudgetKeyPublicData {
  return (
    value === 'clarification' ||
    value === 'researchRetry' ||
    value === 'blueprintRewrite' ||
    value === 'rewrite' ||
    value === 'candidateRewrite' ||
    value === 'regenerate'
  );
}

// ── 待处理人工决策（闭合判别联合）────────────────────────────────

export type GraphPendingHumanDecisionPublicData =
  | { readonly nodeId: string; readonly decisionType: 'answer_question' }
  | { readonly nodeId: string; readonly decisionType: 'blueprint_gate' }
  | { readonly nodeId: string; readonly decisionType: 'candidate_gate' };

export function isValidGraphPendingHumanDecisionPublicData(
  value: unknown,
): value is GraphPendingHumanDecisionPublicData {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { readonly nodeId?: unknown; readonly decisionType?: unknown };
  if (!isNonEmptyString(obj.nodeId)) return false;
  if (obj.decisionType === 'answer_question') return true;
  if (obj.decisionType === 'blueprint_gate') return true;
  return obj.decisionType === 'candidate_gate';
}

// ── Graph Run 共享状态（跨进程）──────────────────────────────────

/**
 * 一次 Idea-to-Novel workflow run 的跨进程共享状态。
 *
 * 对应 @ai-novel/domain 的 `IdeaToNovelGraphRunState` 的 public 投影。
 * 不含节点产出（Level C）、已消费边（运行时簿记）与 createdAt（运行创建时间）。
 */
export interface GraphRunStatePublicData {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly projectId: string;
  readonly workflowRunId: string;
  readonly nodeStatuses: Readonly<Record<string, GraphNodeStatusPublicData>>;
  readonly activeFrontier: ReadonlyArray<string>;
  readonly artifacts: Readonly<
    Record<GraphArtifactKindPublicData, GraphArtifactRefPublicData | null>
  >;
  readonly pendingHumanDecision: GraphPendingHumanDecisionPublicData | null;
  readonly attemptBudget: Readonly<Record<GraphLoopBudgetKeyPublicData, number>>;
  readonly invalidatedArtifacts: ReadonlyArray<GraphArtifactRefPublicData>;
  readonly terminalStatus: GraphRunTerminalStatusPublicData | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isValidGraphRunStatePublicData(value: unknown): value is GraphRunStatePublicData {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.graphId)) return false;
  if (!isNonEmptyString(value.graphVersion)) return false;
  if (!isNonEmptyString(value.projectId)) return false;
  if (!isNonEmptyString(value.workflowRunId)) return false;

  if (!isRecord(value.nodeStatuses)) return false;
  for (const status of Object.values(value.nodeStatuses)) {
    if (!isValidGraphNodeStatusPublicData(status)) return false;
  }

  if (!Array.isArray(value.activeFrontier)) return false;
  for (const id of value.activeFrontier) {
    if (!isNonEmptyString(id)) return false;
  }

  if (!isRecord(value.artifacts)) return false;
  const artifactKinds = [
    'idea',
    'creationSpec',
    'researchBundle',
    'storyBlueprint',
    'generationRun',
    'manuscript',
  ];
  for (const kind of artifactKinds) {
    if (!(kind in value.artifacts)) return false;
    const ref = value.artifacts[kind];
    if (ref !== null && !isValidGraphArtifactRefPublicData(ref)) return false;
    if (ref !== null) {
      const refObj = ref as { readonly kind?: unknown };
      if (refObj.kind !== kind) return false;
    }
  }

  if (value.pendingHumanDecision !== null) {
    if (!isValidGraphPendingHumanDecisionPublicData(value.pendingHumanDecision)) return false;
  }

  if (!isRecord(value.attemptBudget)) return false;
  const budgetKeys = [
    'clarification',
    'researchRetry',
    'blueprintRewrite',
    'rewrite',
    'candidateRewrite',
    'regenerate',
  ];
  for (const key of budgetKeys) {
    if (!(key in value.attemptBudget)) return false;
    const n = value.attemptBudget[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return false;
  }

  if (!Array.isArray(value.invalidatedArtifacts)) return false;
  for (const ref of value.invalidatedArtifacts) {
    if (!isValidGraphArtifactRefPublicData(ref)) return false;
  }

  if (value.terminalStatus !== null) {
    if (!isValidGraphRunTerminalStatusPublicData(value.terminalStatus)) return false;
  }

  return true;
}
