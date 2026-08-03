/**
 * @ai-novel/domain - Idea-to-Novel Graph Shared State Contract
 *
 * 一次 workflow run 的最小共享状态。
 *
 * 纯 TypeScript —— 不访问时间、UUID、文件系统、数据库或模型；
 * 所有 ID 与时间由调用方注入（`createInitialRunState`）。
 *
 * Artifact 引用必须是闭合判别联合（`ArtifactRef`），
 * 不得使用 `Record<string, unknown>` 或任意 JSON。
 */

import type {
  GraphId,
  GraphNodeId,
  GraphNodeOutcome,
  GraphVersion,
  IdeaToNovelGraphV1,
  LoopBudgetKey,
  WorkflowRunId,
} from './idea-to-novel-graph.js';
import type { ProjectId } from './index.js';

// ── 节点运行状态 ────────────────────────────────────────────────

/** 单节点运行状态 */
export type GraphNodeStatus =
  | 'pending' // 尚未到达
  | 'active' // 正在执行（在 frontier 中）
  | 'waiting_for_human' // 等待人工决策（在 frontier 中）
  | 'succeeded' // 完成
  | 'failed' // 失败
  | 'skipped' // 跳过（保留，V1 不使用）
  | 'cancelled'; // 取消

/** 运行终止状态 */
export type GraphRunTerminalStatus = 'completed' | 'failed' | 'cancelled';

// ── Artifact 引用（闭合判别联合）────────────────────────────────

/** Artifact 类型 —— 权威内容对象的种类 */
export type ArtifactKind =
  | 'idea' // 初始想法
  | 'creationSpec' // 创作要求（CreationSpec）
  | 'researchBundle' // 调研资料包
  | 'storyBlueprint' // 故事蓝图
  | 'generationRun' // 生成记录
  | 'manuscript'; // 稿件

export type IdeaArtifactId = string & { readonly __brand: 'IdeaArtifactId' };
export type CreationSpecArtifactId = string & { readonly __brand: 'CreationSpecArtifactId' };
export type ResearchBundleArtifactId = string & { readonly __brand: 'ResearchBundleArtifactId' };
export type StoryBlueprintArtifactId = string & { readonly __brand: 'StoryBlueprintArtifactId' };
export type GenerationRunArtifactId = string & { readonly __brand: 'GenerationRunArtifactId' };
export type ManuscriptArtifactId = string & { readonly __brand: 'ManuscriptArtifactId' };

function createArtifactId(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('ArtifactId 不能为空');
  }
  return raw;
}

/**
 * Artifact 引用 —— 闭合判别联合。
 *
 * `kind` 与 `artifactId` 的配对由 `artifactRef()` 工厂保证。
 */
export type ArtifactRef =
  | { readonly kind: 'idea'; readonly artifactId: IdeaArtifactId }
  | { readonly kind: 'creationSpec'; readonly artifactId: CreationSpecArtifactId }
  | { readonly kind: 'researchBundle'; readonly artifactId: ResearchBundleArtifactId }
  | { readonly kind: 'storyBlueprint'; readonly artifactId: StoryBlueprintArtifactId }
  | { readonly kind: 'generationRun'; readonly artifactId: GenerationRunArtifactId }
  | { readonly kind: 'manuscript'; readonly artifactId: ManuscriptArtifactId };

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return (
    value === 'idea' ||
    value === 'creationSpec' ||
    value === 'researchBundle' ||
    value === 'storyBlueprint' ||
    value === 'generationRun' ||
    value === 'manuscript'
  );
}

/** 构造 Artifact 引用（工厂保证 kind 与 artifactId 配对） */
export function artifactRef(kind: ArtifactKind, rawId: string): ArtifactRef {
  const id = createArtifactId(rawId);
  switch (kind) {
    case 'idea':
      return { kind, artifactId: id as IdeaArtifactId };
    case 'creationSpec':
      return { kind, artifactId: id as CreationSpecArtifactId };
    case 'researchBundle':
      return { kind, artifactId: id as ResearchBundleArtifactId };
    case 'storyBlueprint':
      return { kind, artifactId: id as StoryBlueprintArtifactId };
    case 'generationRun':
      return { kind, artifactId: id as GenerationRunArtifactId };
    case 'manuscript':
      return { kind, artifactId: id as ManuscriptArtifactId };
  }
}

// ── 人工决策 ────────────────────────────────────────────────────

/**
 * 待处理的人工决策。
 *
 * `decisionType` 是闭合枚举：answer_question（自由文本回答）与两个人工门禁。
 * 门禁的合法取值由对应条件枚举决定，在 `applyHumanDecision` 中校验。
 */
export type PendingHumanDecision =
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'answer_question' }
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'blueprint_gate' }
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'candidate_gate' };

export type HumanDecisionType = PendingHumanDecision['decisionType'];

// ── 共享状态 ────────────────────────────────────────────────────

/**
 * 一次 Idea-to-Novel workflow run 的最小共享状态。
 *
 * 不变量：
 * - `nodeStatuses` 对图中每个节点都有条目；
 * - `activeFrontier` === 状态为 active / waiting_for_human 的节点集合；
 * - `attemptBudget` 对每个 LoopBudgetKey 都有计数。
 */
export interface IdeaToNovelGraphRunState {
  readonly graphId: GraphId;
  readonly graphVersion: GraphVersion;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  /** 每个节点的运行状态（键 = 图中全部节点） */
  readonly nodeStatuses: Readonly<Record<GraphNodeId, GraphNodeStatus>>;
  /** 当前活跃 frontier（active / waiting_for_human 节点） */
  readonly activeFrontier: ReadonlyArray<GraphNodeId>;
  /** 决策节点最近一次产出（键 = 已产出结果的节点） */
  readonly nodeOutcomes: Readonly<Partial<Record<GraphNodeId, GraphNodeOutcome>>>;
  /** 权威 artifact 引用（kind → 当前权威 ref；null = 尚未产生） */
  readonly artifacts: Readonly<Record<ArtifactKind, ArtifactRef | null>>;
  /** 待处理的人工决策；null = 无 */
  readonly pendingHumanDecision: PendingHumanDecision | null;
  /** 有界循环预算已用次数（max 声明在 loop 边上） */
  readonly attemptBudget: Readonly<Record<LoopBudgetKey, number>>;
  /**
   * 已消费的边（其目标已被激活）。用于有界循环回环时防止
   * 循环体外进入循环体的边再次触发。
   */
  readonly consumedEdges: ReadonlyArray<string>;
  /** 因上游 artifact 变化而失效的权威 artifact 引用 */
  readonly invalidatedArtifacts: ReadonlyArray<ArtifactRef>;
  /** 运行终止状态；null = 运行中 */
  readonly terminalStatus: GraphRunTerminalStatus | null;
  /** 运行创建时间（调用方注入，domain 不生成时间） */
  readonly createdAt: string;
}

// ── 初始状态构造 ────────────────────────────────────────────────

export interface InitialRunStateInput {
  readonly graph: IdeaToNovelGraphV1;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  readonly createdAt: string;
}

/**
 * 创建一次 workflow run 的初始状态。
 *
 * - 全部节点 pending；
 * - entry 节点 active 并进入 frontier；
 * - 预算全部为 0；
 * - 无 artifact、无待处理决策、无终止。
 * ID 与时间由调用方注入，本函数不生成。
 */
export function createInitialRunState(input: InitialRunStateInput): IdeaToNovelGraphRunState {
  const { graph, projectId, workflowRunId, createdAt } = input;
  const nodeStatuses = {} as Record<GraphNodeId, GraphNodeStatus>;
  for (const node of graph.nodes) {
    nodeStatuses[node.id] = node.id === graph.entryNodeId ? 'active' : 'pending';
  }
  const attemptBudget = {} as Record<LoopBudgetKey, number>;
  for (const key of LOOP_BUDGET_KEYS) {
    attemptBudget[key] = 0;
  }
  const artifacts = {} as Record<ArtifactKind, ArtifactRef | null>;
  for (const kind of ARTIFACT_KINDS) {
    artifacts[kind] = null;
  }
  return {
    graphId: graph.id,
    graphVersion: graph.version,
    projectId,
    workflowRunId,
    nodeStatuses,
    activeFrontier: [graph.entryNodeId],
    nodeOutcomes: {},
    artifacts,
    pendingHumanDecision: null,
    attemptBudget,
    consumedEdges: [],
    invalidatedArtifacts: [],
    terminalStatus: null,
    createdAt,
  };
}

/** 全部 ArtifactKind（闭合枚举列表） */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'idea',
  'creationSpec',
  'researchBundle',
  'storyBlueprint',
  'generationRun',
  'manuscript',
];

/** 全部 LoopBudgetKey（闭合枚举列表） */
export const LOOP_BUDGET_KEYS: readonly LoopBudgetKey[] = [
  'clarification',
  'researchRetry',
  'blueprintRewrite',
  'rewrite',
  'candidateRewrite',
  'regenerate',
];

/** 节点状态闭合枚举校验 */
export function isValidGraphNodeStatus(value: unknown): value is GraphNodeStatus {
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

/** 终止状态闭合枚举校验 */
export function isValidGraphRunTerminalStatus(value: unknown): value is GraphRunTerminalStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}
