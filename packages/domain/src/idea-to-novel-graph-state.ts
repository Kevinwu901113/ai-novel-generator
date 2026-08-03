/**
 * @ai-novel/domain - Idea-to-Novel Graph Run State Contract（Project / Chapter 两种明确类型）
 *
 * 两张权威 Graph 使用两种明确的 run state 类型，不再使用无法区分 run 种类的模糊 state：
 *
 * - `IdeaToNovelProjectRunState`：Project Graph 的状态，不含 chapter-only 必需字段；
 * - `ChapterGenerationRunState`：Chapter Graph 的状态，必须绑定 `blueprintChapterId`
 *   及项目级输入引用（creationSpecVersionId / researchBundleId / storyBlueprintId）。
 *
 * 纯 TypeScript —— 不访问时间、UUID、文件系统、数据库或模型；
 * 所有 ID 与时间由调用方注入（`createProjectInitialRunState` / `createChapterInitialRunState`）。
 *
 * Artifact 引用必须是闭合判别联合（`ArtifactRef`），
 * 不得使用 `Record<string, unknown>` 或任意 JSON。
 */

import type {
  AnyIdeaToNovelGraphV1,
  ArtifactKind,
  ChapterArtifactKind,
  ChapterBudgetKey,
  ChapterGenerationGraphV1,
  GraphId,
  GraphNodeId,
  GraphNodeOutcome,
  GraphRunTerminalStatus,
  GraphVersion,
  IdeaToNovelProjectGraphV1,
  LoopBudgetKey,
  ProjectArtifactKind,
  ProjectBudgetKey,
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

// Artifact 引用（闭合判别联合）────────────────────────────────

export type IdeaArtifactId = string & { readonly __brand: 'IdeaArtifactId' };
export type CreationSpecArtifactId = string & { readonly __brand: 'CreationSpecArtifactId' };
export type ResearchBundleArtifactId = string & { readonly __brand: 'ResearchBundleArtifactId' };
export type StoryBlueprintArtifactId = string & { readonly __brand: 'StoryBlueprintArtifactId' };
export type GenerationRunArtifactId = string & { readonly __brand: 'GenerationRunArtifactId' };
export type ManuscriptArtifactId = string & { readonly __brand: 'ManuscriptArtifactId' };

/** 创作要求版本标识（Chapter run 输入引用） */
export type CreationSpecVersionId = string & { readonly __brand: 'CreationSpecVersionId' };

/** 蓝图章节标识（Chapter run 输入引用） */
export type BlueprintChapterId = string & { readonly __brand: 'BlueprintChapterId' };

function createChapterBindingId(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Chapter 绑定引用不能为空');
  }
  return raw;
}

/** 构造创作要求版本标识（运行时注入，domain 不生成） */
export function createCreationSpecVersionId(raw: string): CreationSpecVersionId {
  return createChapterBindingId(raw) as CreationSpecVersionId;
}

/** 构造蓝图章节标识（运行时注入，domain 不生成） */
export function createBlueprintChapterId(raw: string): BlueprintChapterId {
  return createChapterBindingId(raw) as BlueprintChapterId;
}

/** 构造调研资料包标识（运行时注入，domain 不生成） */
export function createResearchBundleArtifactId(raw: string): ResearchBundleArtifactId {
  return createChapterBindingId(raw) as ResearchBundleArtifactId;
}

/** 构造故事蓝图标识（运行时注入，domain 不生成） */
export function createStoryBlueprintArtifactId(raw: string): StoryBlueprintArtifactId {
  return createChapterBindingId(raw) as StoryBlueprintArtifactId;
}

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
 * `decisionType` 是闭合枚举：intake_response（Idea Intake 回答）、
 * blueprint_gate / candidate_gate 两个人工门禁、escalation（人工升级）。
 * 门禁/升级的合法取值由对应条件枚举决定，在 `applyHumanDecision` 中校验。
 */
export type PendingHumanDecision =
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'intake_response' }
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'blueprint_gate' }
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'candidate_gate' }
  | { readonly nodeId: GraphNodeId; readonly decisionType: 'escalation' };

// ── 共享状态基础 ────────────────────────────────────────────────

/**
 * 两种 run state 共享的基础字段。
 *
 * 不变量：
 * - `nodeStatuses` 对图中每个节点都有条目；
 * - `activeFrontier` === 状态为 active / waiting_for_human 的节点集合；
 * - `attemptBudget` 对本图声明的每个预算键都有计数。
 */
export interface IdeaToNovelGraphRunStateBase<
  A extends ArtifactKind = ArtifactKind,
  B extends LoopBudgetKey = LoopBudgetKey,
> {
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
  /** 权威 artifact 引用（kind → 当前权威 ref；null = 尚未产生；键 = 本图 artifact 槽位） */
  readonly artifacts: Readonly<Record<A, ArtifactRef | null>>;
  /** 待处理的人工决策；null = 无 */
  readonly pendingHumanDecision: PendingHumanDecision | null;
  /** 有界循环预算已用次数（键 = 本图预算键；max 声明在 loop 边上） */
  readonly attemptBudget: Readonly<Record<B, number>>;
  /**
   * 已消费的边（其目标已被激活）。用于有界循环回环时防止
   * 循环体外进入循环体的边再次触发。
   */
  readonly consumedEdges: ReadonlyArray<string>;
  /** 因上游 artifact 变化而失效的权威 artifact 引用（kind 限于本图合法槽位） */
  readonly invalidatedArtifacts: ReadonlyArray<ArtifactRef>;
  /** 运行终止状态；null = 运行中 */
  readonly terminalStatus: GraphRunTerminalStatus | null;
  /** 运行创建时间（调用方注入，domain 不生成时间） */
  readonly createdAt: string;
}

/**
 * Project Graph run 状态（不包含 chapter-only 必需字段）。
 *
 * artifact / budget 槽位真正拆开：只含 Project Graph 的 4 个 artifact 槽位与 5 个预算键。
 */
export interface IdeaToNovelProjectRunState extends IdeaToNovelGraphRunStateBase<
  ProjectArtifactKind,
  ProjectBudgetKey
> {
  readonly graphId: GraphId;
  readonly graphVersion: GraphVersion;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  readonly artifacts: Readonly<Record<ProjectArtifactKind, ArtifactRef | null>>;
  readonly attemptBudget: Readonly<Record<ProjectBudgetKey, number>>;
}

/**
 * Chapter Graph run 状态。
 *
 * 必须绑定 `blueprintChapterId` 与项目级输入引用；
 * 这些引用在 run 创建时由 application 从 Project run 的权威状态注入。
 *
 * artifact / budget 槽位真正拆开：只含 Chapter Graph 的 2 个 artifact 槽位与 3 个预算键。
 */
export interface ChapterGenerationRunState extends IdeaToNovelGraphRunStateBase<
  ChapterArtifactKind,
  ChapterBudgetKey
> {
  readonly graphId: GraphId;
  readonly graphVersion: GraphVersion;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  readonly creationSpecVersionId: CreationSpecVersionId;
  readonly researchBundleId: ResearchBundleArtifactId | null;
  readonly storyBlueprintId: StoryBlueprintArtifactId;
  readonly blueprintChapterId: BlueprintChapterId;
  readonly artifacts: Readonly<Record<ChapterArtifactKind, ArtifactRef | null>>;
  readonly attemptBudget: Readonly<Record<ChapterBudgetKey, number>>;
}

/** 任意一种 run state */
export type AnyIdeaToNovelRunState = IdeaToNovelProjectRunState | ChapterGenerationRunState;

// ── 初始状态构造 ────────────────────────────────────────────────

/** Project run 初始状态输入 */
export interface ProjectInitialRunStateInput {
  readonly graph: IdeaToNovelProjectGraphV1;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  readonly createdAt: string;
}

/** Chapter run 初始状态输入 */
export interface ChapterInitialRunStateInput {
  readonly graph: ChapterGenerationGraphV1;
  readonly projectId: ProjectId;
  readonly workflowRunId: WorkflowRunId;
  readonly creationSpecVersionId: CreationSpecVersionId;
  readonly researchBundleId: ResearchBundleArtifactId | null;
  readonly storyBlueprintId: StoryBlueprintArtifactId;
  readonly blueprintChapterId: BlueprintChapterId;
  readonly createdAt: string;
}

function buildBaseState<A extends ArtifactKind, B extends LoopBudgetKey>(
  graph: AnyIdeaToNovelGraphV1,
  createdAt: string,
): Omit<IdeaToNovelGraphRunStateBase<A, B>, 'projectId' | 'workflowRunId'> {
  const nodeStatuses = {} as Record<GraphNodeId, GraphNodeStatus>;
  for (const node of graph.nodes) {
    nodeStatuses[node.id] = node.id === graph.entryNodeId ? 'active' : 'pending';
  }
  const attemptBudget = {} as Record<B, number>;
  for (const key of graph.budgetKeys) {
    attemptBudget[key as B] = 0;
  }
  const artifacts = {} as Record<A, ArtifactRef | null>;
  for (const kind of graph.artifactKinds) {
    artifacts[kind as A] = null;
  }
  return {
    graphId: graph.id,
    graphVersion: graph.version,
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

/**
 * 创建一次 Project run 的初始状态。
 *
 * - 全部节点 pending；entry 节点 active 并进入 frontier；
 * - 预算与 artifact 槽位按 Project Graph 声明初始化；
 * - 无 artifact、无待处理决策、无终止。
 * ID 与时间由调用方注入，本函数不生成。
 */
export function createProjectInitialRunState(
  input: ProjectInitialRunStateInput,
): IdeaToNovelProjectRunState {
  const { graph, projectId, workflowRunId, createdAt } = input;
  return {
    ...buildBaseState<ProjectArtifactKind, ProjectBudgetKey>(graph, createdAt),
    projectId,
    workflowRunId,
  };
}

/**
 * 创建一次 Chapter run 的初始状态。
 *
 * - 全部节点 pending；entry 节点 active 并进入 frontier；
 * - 预算与 artifact 槽位按 Chapter Graph 声明初始化；
 * - 绑定 blueprintChapterId 与项目级输入引用（run 创建时由调用方注入）；
 * - 无 artifact、无待处理决策、无终止。
 * ID 与时间由调用方注入，本函数不生成。
 */
export function createChapterInitialRunState(
  input: ChapterInitialRunStateInput,
): ChapterGenerationRunState {
  const {
    graph,
    projectId,
    workflowRunId,
    creationSpecVersionId,
    researchBundleId,
    storyBlueprintId,
    blueprintChapterId,
    createdAt,
  } = input;
  return {
    ...buildBaseState<ChapterArtifactKind, ChapterBudgetKey>(graph, createdAt),
    projectId,
    workflowRunId,
    creationSpecVersionId,
    researchBundleId,
    storyBlueprintId,
    blueprintChapterId,
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
  'intakeRevision',
  'researchRetry',
  'blueprintRewrite',
  'specRevision',
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
  return (
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'blocked'
  );
}
