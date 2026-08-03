/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition V1（两张权威 Graph）
 *
 * 把 Idea-to-Novel 产品流程拆成两张显式、静态、版本化、可验证的产品 Graph：
 *
 * 1. `IdeaToNovelProjectGraphV1`（kind = 'project'）
 *    idea → creationSpec → researchBundle（可为空或用户显式跳过）→ storyBlueprint → PROJECT_READY。
 *    一次 ProjectRun 只负责把项目推进到"蓝图已被用户明确接受"，可以开始创建 ChapterGenerationRun。
 *
 * 2. `ChapterGenerationGraphV1`（kind = 'chapter'）
 *    CHAPTER_PLAN → DRAFT → 三 Critic 并行 → CRITIQUE_JOIN → REWRITE 循环 → CANDIDATE_GATE
 *    → MANUSCRIPT_COMMIT → CHAPTER_READY。
 *    一次 ChapterGenerationRun 只生成一个章节或一个明确生成单元；
 *    "继续生成下一章"由未来 application 层创建新的 ChapterGenerationRun，不得在同一个 run 中重置整张图。
 *
 * 纯 TypeScript —— 不依赖 Electron、SQLite、Node.js 或 Renderer。
 * 不负责随机 ID 或当前时间生成 —— ID 与时间由调用方注入。
 * 不进行模型调用、搜索调用或 Keychain 访问。
 *
 * 本文件只承载：
 * - 闭合枚举（条件、实现类型、预算、人工决策类型）；
 * - 节点与边的定义类型；
 * - 权威的 `IDEA_TO_NOVEL_PROJECT_GRAPH_V1` 与 `CHAPTER_GENERATION_GRAPH_V1` 实例；
 * - Graph 与 Prompt 分离（只引用稳定 prompt ID，不含 prompt 文本）；
 * - 确定性序列化（两张 Graph 分别提供）。
 *
 * 权威规格：docs/product/idea-to-novel-v1.md、docs/development/idea-to-novel-migration-plan.md。
 */

import { codePointCompare } from './creation-contract.js';

// ── 品牌类型 ─────────────────────────────────────────────────────

/** Graph 全局稳定标识 */
export type GraphId = string & { readonly __brand: 'GraphId' };

/** Graph 版本标识（如 'v1'） */
export type GraphVersion = string & { readonly __brand: 'GraphVersion' };

/** 一次 workflow run 的唯一标识 */
export type WorkflowRunId = string & { readonly __brand: 'WorkflowRunId' };

/** Graph 节点稳定标识 */
export type GraphNodeId = string & { readonly __brand: 'GraphNodeId' };

/** Graph 边稳定标识 */
export type GraphEdgeId = string & { readonly __brand: 'GraphEdgeId' };

/** 稳定 prompt 标识 —— 只引用 ID，不嵌入 prompt 文本 */
export type StablePromptId = string & { readonly __brand: 'StablePromptId' };

export function createGraphId(raw: string): GraphId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('GraphId 不能为空');
  }
  return raw as GraphId;
}

export function createGraphVersion(raw: string): GraphVersion {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('GraphVersion 不能为空');
  }
  return raw as GraphVersion;
}

export function createWorkflowRunId(raw: string): WorkflowRunId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('WorkflowRunId 不能为空');
  }
  return raw as WorkflowRunId;
}

export function createGraphNodeId(raw: string): GraphNodeId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('GraphNodeId 不能为空');
  }
  return raw as GraphNodeId;
}

export function createGraphEdgeId(raw: string): GraphEdgeId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('GraphEdgeId 不能为空');
  }
  return raw as GraphEdgeId;
}

const STABLE_PROMPT_ID_PATTERN = /^[a-z][a-z0-9:._-]{1,127}$/;

export function createStablePromptId(raw: string): StablePromptId {
  if (typeof raw !== 'string' || !STABLE_PROMPT_ID_PATTERN.test(raw)) {
    throw new Error('StablePromptId 必须是稳定的小写 ID（不得包含 prompt 文本）');
  }
  return raw as StablePromptId;
}

// ── Graph 标识常量 ──────────────────────────────────────────────

export const IDEA_TO_NOVEL_PROJECT_GRAPH_ID = 'idea-to-novel-project' as GraphId;
export const CHAPTER_GENERATION_GRAPH_ID = 'chapter-generation' as GraphId;
export const GRAPH_VERSION_V1 = 'v1' as GraphVersion;

// ── 条件闭合枚举 ────────────────────────────────────────────────

/** 澄清是否仍需追问 */
export type ClarificationRemaining = 'ask_more' | 'spec_complete';

/** Idea Intake 回答动作（graph 只记录持久化凭证语义，不记录回答正文） */
export type IntakeAction = 'answer' | 'skip' | 'finish';

/** 澄清预算耗尽时的人工升级决策 */
export type IntakeEscalationDecision =
  'continue_with_current_spec' | 'modify_idea' | 'cancel' | 'continue_later';

/** 调研强度三档（无需调研 / 轻量调研 / 深度调研） */
export type ResearchDecision = 'none' | 'light' | 'deep';

/** 调研校验结论 */
export type ResearchVerdict = 'valid' | 'invalid';

/** 调研无效且重试预算耗尽时的人工升级决策 */
export type ResearchEscalationDecision =
  'use_current_research' | 'skip_research' | 'modify_requirements' | 'cancel' | 'continue_later';

/** 蓝图人工门禁决策 */
export type BlueprintGateDecision = 'accept' | 'request_rewrite';

/** 候选稿人工门禁决策 */
export type CandidateGateDecision = 'accept' | 'reject' | 'request_rewrite';

/** 审查结论 */
export type CritiqueVerdict = 'pass' | 'needs_rewrite';

/** 人工升级决策（蓝图 / 候选稿预算耗尽时用户必须显式选择） */
export type EscalationDecision =
  'accept_current' | 'modify_requirements' | 'cancel' | 'continue_later';

/**
 * 运行终止状态。
 *
 * blocked 是终止态（非同一 run 内可恢复）：恢复必须创建新的 workflow run。
 */
export type GraphRunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'blocked';

/** 人工决策类型（人工节点声明；由 transition 从 Graph 读取） */
export type HumanDecisionType =
  'intake_response' | 'blueprint_gate' | 'candidate_gate' | 'escalation';

/** 权威 artifact 种类（闭合集合） */
export type ArtifactKind =
  'idea' | 'creationSpec' | 'researchBundle' | 'storyBlueprint' | 'generationRun' | 'manuscript';

/**
 * 有界循环预算键。
 *
 * 每个键对应一条或多条 loop-back 边，最多重入 `maxIterations` 次；
 * 预算耗尽时必须存在从对应决策节点出发的 `X_budget: exhausted` 出口边。
 */
export type LoopBudgetKey =
  | 'clarification'
  | 'intakeRevision'
  | 'researchRetry'
  | 'blueprintRewrite'
  | 'specRevision'
  | 'rewrite'
  | 'candidateRewrite'
  | 'regenerate';

/** 预算耗尽条件名：`<key>_budget` */
export type LoopBudgetConditionName =
  | 'clarification_budget'
  | 'intake_revision_budget'
  | 'research_retry_budget'
  | 'blueprint_rewrite_budget'
  | 'spec_revision_budget'
  | 'rewrite_budget'
  | 'candidate_rewrite_budget'
  | 'regenerate_budget';

/** 全部条件名（含预算条件） */
export type GraphConditionName =
  | 'clarification_remaining'
  | 'intake_action'
  | 'clarification_budget'
  | 'intake_escalation_decision'
  | 'intake_revision_budget'
  | 'research_decision'
  | 'research_valid'
  | 'research_retry_budget'
  | 'research_escalation_decision'
  | 'blueprint_gate'
  | 'blueprint_rewrite_budget'
  | 'escalation_decision'
  | 'spec_revision_budget'
  | 'critique_verdict'
  | 'rewrite_budget'
  | 'candidate_gate'
  | 'candidate_rewrite_budget'
  | 'regenerate_budget';

/** 每个条件名的闭合取值集合 —— 条件边只允许引用这里的值（as const 保留字面量类型） */
export const GRAPH_CONDITION_OUTCOMES = {
  clarification_remaining: ['ask_more', 'spec_complete'],
  intake_action: ['answer', 'skip', 'finish'],
  clarification_budget: ['available', 'exhausted'],
  intake_escalation_decision: [
    'continue_with_current_spec',
    'modify_idea',
    'cancel',
    'continue_later',
  ],
  intake_revision_budget: ['available', 'exhausted'],
  research_decision: ['none', 'light', 'deep'],
  research_valid: ['valid', 'invalid'],
  research_retry_budget: ['available', 'exhausted'],
  research_escalation_decision: [
    'use_current_research',
    'skip_research',
    'modify_requirements',
    'cancel',
    'continue_later',
  ],
  blueprint_gate: ['accept', 'request_rewrite'],
  blueprint_rewrite_budget: ['available', 'exhausted'],
  escalation_decision: ['accept_current', 'modify_requirements', 'cancel', 'continue_later'],
  spec_revision_budget: ['available', 'exhausted'],
  critique_verdict: ['pass', 'needs_rewrite'],
  rewrite_budget: ['available', 'exhausted'],
  candidate_gate: ['accept', 'reject', 'request_rewrite'],
  candidate_rewrite_budget: ['available', 'exhausted'],
  regenerate_budget: ['available', 'exhausted'],
} as const satisfies Readonly<Record<GraphConditionName, readonly string[]>>;

/** 某条件名对应的闭合取值联合（字面量类型） */
export type GraphConditionOutcomeOf<K extends GraphConditionName> =
  (typeof GRAPH_CONDITION_OUTCOMES)[K][number];

/** 预算条件名 → 预算键 */
export const LOOP_BUDGET_CONDITION_BY_KEY: Readonly<
  Record<LoopBudgetKey, LoopBudgetConditionName>
> = {
  clarification: 'clarification_budget',
  intakeRevision: 'intake_revision_budget',
  researchRetry: 'research_retry_budget',
  blueprintRewrite: 'blueprint_rewrite_budget',
  specRevision: 'spec_revision_budget',
  rewrite: 'rewrite_budget',
  candidateRewrite: 'candidate_rewrite_budget',
  regenerate: 'regenerate_budget',
};

/** 预算条件名集合（用于在 transition 中把预算条件路由到 state.attemptBudget） */
export const BUDGET_CONDITION_NAMES: ReadonlySet<GraphConditionName> = new Set(
  Object.values(LOOP_BUDGET_CONDITION_BY_KEY),
);

const LOOP_BUDGET_KEY_SET: ReadonlySet<string> = new Set(Object.keys(LOOP_BUDGET_CONDITION_BY_KEY));
const GRAPH_CONDITION_NAME_SET: ReadonlySet<string> = new Set(
  Object.keys(GRAPH_CONDITION_OUTCOMES),
);

export function isLoopBudgetKey(value: unknown): value is LoopBudgetKey {
  return typeof value === 'string' && LOOP_BUDGET_KEY_SET.has(value);
}

export function isGraphConditionName(value: unknown): value is GraphConditionName {
  return typeof value === 'string' && GRAPH_CONDITION_NAME_SET.has(value);
}

export function isGraphConditionOutcome(
  condition: GraphConditionName,
  value: unknown,
): value is GraphConditionOutcomeOf<GraphConditionName> {
  if (typeof value !== 'string') return false;
  const outcomes = GRAPH_CONDITION_OUTCOMES[condition];
  if (!Array.isArray(outcomes)) return false;
  return (outcomes as readonly string[]).includes(value);
}

export function budgetKeyForCondition(condition: GraphConditionName): LoopBudgetKey | null {
  const entry = Object.entries(LOOP_BUDGET_CONDITION_BY_KEY).find(([, name]) => name === condition);
  return entry ? (entry[0] as LoopBudgetKey) : null;
}

// ── 稳定 prompt 注册表 ──────────────────────────────────────────

/**
 * V1 使用的稳定 prompt ID 注册表。
 *
 * 只承载稳定 ID，绝不承载 prompt 文本。prompt 文本属于 Level C，
 * 由未来的 Prompt 仓库持有，Graph Definition 不引用。
 */
export const PROMPT_IDS_V1: readonly StablePromptId[] = [
  'prompt:spec-extract-v1',
  'prompt:ask-question-v1',
  'prompt:research-plan-v1',
  'prompt:blueprint-generate-v1',
  'prompt:chapter-plan-v1',
  'prompt:draft-generate-v1',
  'prompt:continuity-critic-v1',
  'prompt:style-critic-v1',
  'prompt:requirement-critic-v1',
  'prompt:rewrite-v1',
].map((id) => createStablePromptId(id));

/** 判断某值是否是注册表中的稳定 prompt ID */
export function isKnownStablePromptId(id: unknown): id is StablePromptId {
  return typeof id === 'string' && PROMPT_IDS_V1.includes(id as StablePromptId);
}

// ── 实现类型闭合枚举 ────────────────────────────────────────────

/**
 * 节点实现类型：描述运行时将如何执行该节点。
 *
 * - IDEA_INPUT / CLARIFY_ANSWER / USER_GATE 是人工交互节点；
 * - 其余为后端执行节点。
 */
export type GraphNodeImplementationKind =
  | 'IDEA_INPUT' // 捕获初始想法（人工输入）
  | 'EXTRACT' // 模型抽取结构化要求
  | 'CLARIFY_ASK' // 模型提出追问问题
  | 'CLARIFY_ANSWER' // 收集用户回答（人工输入）
  | 'DECISION' // 纯决策（调研强度 / 调研校验）
  | 'RESEARCH' // 外部联网调研执行（search + fetch）
  | 'PLAN' // 规划（调研问题计划 / 章节场景计划）
  | 'GENERATE' // 模型生成（蓝图 / 草稿）
  | 'CRITIC' // 模型质量审查
  | 'JOIN' // fan-in 汇合
  | 'REWRITE' // 定点改写
  | 'USER_GATE' // 人工门禁
  | 'COMMIT' // 权威落库（Manuscript commit）
  | 'TERMINAL'; // 终止

/** 需要引用 prompt ID 的模型类实现类型 */
const PROMPT_REQUIRED_KINDS: ReadonlySet<GraphNodeImplementationKind> = new Set([
  'EXTRACT',
  'CLARIFY_ASK',
  'PLAN',
  'GENERATE',
  'CRITIC',
  'REWRITE',
]);

export function isPromptRequiredKind(kind: GraphNodeImplementationKind): boolean {
  return PROMPT_REQUIRED_KINDS.has(kind);
}

/** 人工交互节点实现类型 */
const HUMAN_INTERRUPT_KINDS: ReadonlySet<GraphNodeImplementationKind> = new Set([
  'IDEA_INPUT',
  'CLARIFY_ANSWER',
  'USER_GATE',
]);

export function isHumanInterruptKind(kind: GraphNodeImplementationKind): boolean {
  return HUMAN_INTERRUPT_KINDS.has(kind);
}

export function isTerminalKind(kind: GraphNodeImplementationKind): boolean {
  return kind === 'TERMINAL';
}

const NODE_IMPLEMENTATION_KIND_SET: ReadonlySet<string> = new Set<GraphNodeImplementationKind>([
  'IDEA_INPUT',
  'EXTRACT',
  'CLARIFY_ASK',
  'CLARIFY_ANSWER',
  'DECISION',
  'RESEARCH',
  'PLAN',
  'GENERATE',
  'CRITIC',
  'JOIN',
  'REWRITE',
  'USER_GATE',
  'COMMIT',
  'TERMINAL',
]);

/** 节点实现类型闭合枚举校验（validator 用，防止损坏定义悄悄通过） */
export function isGraphNodeImplementationKind(
  value: unknown,
): value is GraphNodeImplementationKind {
  return typeof value === 'string' && NODE_IMPLEMENTATION_KIND_SET.has(value);
}

/** 边类型闭合枚举校验 */
export function isGraphEdgeKind(value: unknown): value is 'fixed' | 'conditional' {
  return value === 'fixed' || value === 'conditional';
}

/** 边 fan-in 模式闭合枚举校验 */
export function isGraphEdgeMode(value: unknown): value is 'exclusive' | 'join' {
  return value === 'exclusive' || value === 'join';
}

// ── 节点与边定义类型 ────────────────────────────────────────────

/** 边对条件的单个断言：`condition` 必须等于 `expectedOutcome`（闭合枚举） */
export interface EdgeOutcomeRequirement {
  readonly condition: GraphConditionName;
  readonly expectedOutcome: GraphConditionOutcomeOf<GraphConditionName>;
}

/**
 * 有界循环声明。
 *
 * 挂在 loop-back 边上：同一预算键只能出现在一条 loop 边上，
 * 重入次数 `used` 达到 `maxIterations` 后，必须走 `X_budget: exhausted` 出口。
 */
export interface LoopDeclaration {
  readonly budget: LoopBudgetKey;
  readonly maxIterations: number;
}

/**
 * 节点输出契约：节点成功时被允许/要求产出什么。
 *
 * - `requiredOutcomeCondition`：节点必须产出的条件结果（或 null = 不产出条件结果）；
 * - `allowedArtifactKind`：节点允许产出的权威 artifact 种类（或 null = 不产出 artifact）；
 * - `outputRequired`：节点成功时必须产出至少一种输出。
 */
export interface GraphNodeOutputContract {
  readonly requiredOutcomeCondition: GraphConditionName | null;
  readonly allowedArtifactKind: ArtifactKind | null;
  readonly outputRequired: boolean;
}

/**
 * join 聚合策略：JOIN 节点如何从指定来源确定性聚合结果。
 *
 * 只支持 critique_verdict 聚合：恰好 `sources` 指定的全部来源、来源唯一、
 * 每个来源都必须产出 `critique_verdict`；全 pass 才 pass，否则 needs_rewrite。
 */
export interface JoinAggregationPolicy {
  readonly kind: 'critique_verdict';
  readonly sources: ReadonlyArray<GraphNodeId>;
  readonly rule: 'all_pass_or_needs_rewrite';
}

/** 节点定义 */
export interface IdeaToNovelGraphNodeDefinition {
  readonly id: GraphNodeId;
  readonly kind: GraphNodeImplementationKind;
  /** 稳定中文标签（产品语言），非运行数据 */
  readonly label: string;
  /** 模型类节点引用的稳定 prompt ID（不含 prompt 文本） */
  readonly promptId?: StablePromptId;
  /** fan-in join 声明：`requiredIncoming` 必须是进入本节点的 join 边数（>=2） */
  readonly join?: { readonly requiredIncoming: number };
  /** 输出契约（执行语义，参与序列化） */
  readonly output: GraphNodeOutputContract;
  /** 人工决策类型（仅人工节点声明） */
  readonly humanDecisionType?: HumanDecisionType;
  /** 节点成功时重置的预算（执行语义，参与序列化） */
  readonly budgetResetPolicy?: ReadonlyArray<LoopBudgetKey>;
  /** join 聚合策略（仅 JOIN 节点声明） */
  readonly joinAggregationPolicy?: JoinAggregationPolicy;
  /** 终止状态（仅 TERMINAL 节点声明） */
  readonly terminalStatus?: GraphRunTerminalStatus;
}

/** 边定义 */
export interface IdeaToNovelGraphEdgeDefinition {
  readonly id: GraphEdgeId;
  readonly from: GraphNodeId;
  readonly to: GraphNodeId;
  /** fixed = 无条件；conditional = 需 requiredOutcomes 全部成立 */
  readonly kind: 'fixed' | 'conditional';
  /** 条件断言列表（仅 conditional 使用，至少一条） */
  readonly requiredOutcomes?: ReadonlyArray<EdgeOutcomeRequirement>;
  /** fan-in 模式：join = 并发汇入（目标节点必须声明 join）；exclusive = 互斥/顺序进入 */
  readonly mode: 'exclusive' | 'join';
  /** 有界循环声明（仅 loop-back 边使用） */
  readonly loop?: LoopDeclaration;
}

/** 版本化 Graph 定义（共享基础） */
export interface IdeaToNovelGraphDefinitionBase {
  readonly id: GraphId;
  readonly version: GraphVersion;
  /** run 种类：决定状态类型与 required/exact 校验（project / chapter） */
  readonly kind: 'project' | 'chapter';
  readonly entryNodeId: GraphNodeId;
  readonly nodes: ReadonlyArray<IdeaToNovelGraphNodeDefinition>;
  readonly edges: ReadonlyArray<IdeaToNovelGraphEdgeDefinition>;
  /** 本图权威 artifact 槽位（闭合集合，状态校验用） */
  readonly artifactKinds: ReadonlyArray<ArtifactKind>;
  /** 本图权威预算键（闭合集合，状态校验用） */
  readonly budgetKeys: ReadonlyArray<LoopBudgetKey>;
  /** artifact 下游依赖顺序（级联失效用，执行语义，参与序列化） */
  readonly artifactDownstreamOrder: ReadonlyArray<ArtifactKind>;
}

/** 项目级 Graph：idea → creationSpec → researchBundle → storyBlueprint → PROJECT_READY */
export interface IdeaToNovelProjectGraphV1 extends IdeaToNovelGraphDefinitionBase {
  readonly kind: 'project';
}

/** 章节级 Graph：CHAPTER_PLAN → DRAFT → 三 Critic → CRITIQUE_JOIN → REWRITE → CANDIDATE_GATE → MANUSCRIPT_COMMIT → CHAPTER_READY */
export interface ChapterGenerationGraphV1 extends IdeaToNovelGraphDefinitionBase {
  readonly kind: 'chapter';
}

/** 任意一张 Idea-to-Novel Graph V1 */
export type AnyIdeaToNovelGraphV1 = IdeaToNovelProjectGraphV1 | ChapterGenerationGraphV1;

// ── 权威 Graph 实例 ─────────────────────────────────────────────

const NODE_IDS = {
  // Project
  IDEA_CAPTURE: 'IDEA_CAPTURE',
  SPEC_EXTRACT: 'SPEC_EXTRACT',
  ASK_QUESTION: 'ASK_QUESTION',
  COLLECT_ANSWER: 'COLLECT_ANSWER',
  INTAKE_ESCALATION: 'INTAKE_ESCALATION',
  RESEARCH_DECISION: 'RESEARCH_DECISION',
  RESEARCH_PLAN: 'RESEARCH_PLAN',
  RESEARCH_EXECUTE: 'RESEARCH_EXECUTE',
  RESEARCH_VALIDATE: 'RESEARCH_VALIDATE',
  RESEARCH_ESCALATION: 'RESEARCH_ESCALATION',
  BLUEPRINT_GENERATE: 'BLUEPRINT_GENERATE',
  BLUEPRINT_USER_GATE: 'BLUEPRINT_USER_GATE',
  BLUEPRINT_ESCALATION: 'BLUEPRINT_ESCALATION',
  PROJECT_READY: 'PROJECT_READY',
  PROJECT_CANCELLED: 'PROJECT_CANCELLED',
  PROJECT_BLOCKED: 'PROJECT_BLOCKED',
  // Chapter
  CHAPTER_PLAN: 'CHAPTER_PLAN',
  DRAFT: 'DRAFT',
  CONTINUITY_CRITIC: 'CONTINUITY_CRITIC',
  STYLE_CRITIC: 'STYLE_CRITIC',
  REQUIREMENT_CRITIC: 'REQUIREMENT_CRITIC',
  CRITIQUE_JOIN: 'CRITIQUE_JOIN',
  REWRITE: 'REWRITE',
  CANDIDATE_GATE: 'CANDIDATE_GATE',
  CANDIDATE_ESCALATION: 'CANDIDATE_ESCALATION',
  MANUSCRIPT_COMMIT: 'MANUSCRIPT_COMMIT',
  CHAPTER_READY: 'CHAPTER_READY',
  CHAPTER_CANCELLED: 'CHAPTER_CANCELLED',
  CHAPTER_BLOCKED: 'CHAPTER_BLOCKED',
} as const satisfies Record<string, string>;

export const IDEA_CAPTURE = createGraphNodeId(NODE_IDS.IDEA_CAPTURE);
export const SPEC_EXTRACT = createGraphNodeId(NODE_IDS.SPEC_EXTRACT);
export const ASK_QUESTION = createGraphNodeId(NODE_IDS.ASK_QUESTION);
export const COLLECT_ANSWER = createGraphNodeId(NODE_IDS.COLLECT_ANSWER);
export const INTAKE_ESCALATION = createGraphNodeId(NODE_IDS.INTAKE_ESCALATION);
export const RESEARCH_DECISION = createGraphNodeId(NODE_IDS.RESEARCH_DECISION);
export const RESEARCH_PLAN = createGraphNodeId(NODE_IDS.RESEARCH_PLAN);
export const RESEARCH_EXECUTE = createGraphNodeId(NODE_IDS.RESEARCH_EXECUTE);
export const RESEARCH_VALIDATE = createGraphNodeId(NODE_IDS.RESEARCH_VALIDATE);
export const RESEARCH_ESCALATION = createGraphNodeId(NODE_IDS.RESEARCH_ESCALATION);
export const BLUEPRINT_GENERATE = createGraphNodeId(NODE_IDS.BLUEPRINT_GENERATE);
export const BLUEPRINT_USER_GATE = createGraphNodeId(NODE_IDS.BLUEPRINT_USER_GATE);
export const BLUEPRINT_ESCALATION = createGraphNodeId(NODE_IDS.BLUEPRINT_ESCALATION);
export const PROJECT_READY = createGraphNodeId(NODE_IDS.PROJECT_READY);
export const PROJECT_CANCELLED = createGraphNodeId(NODE_IDS.PROJECT_CANCELLED);
export const PROJECT_BLOCKED = createGraphNodeId(NODE_IDS.PROJECT_BLOCKED);
export const CHAPTER_PLAN = createGraphNodeId(NODE_IDS.CHAPTER_PLAN);
export const DRAFT = createGraphNodeId(NODE_IDS.DRAFT);
export const CONTINUITY_CRITIC = createGraphNodeId(NODE_IDS.CONTINUITY_CRITIC);
export const STYLE_CRITIC = createGraphNodeId(NODE_IDS.STYLE_CRITIC);
export const REQUIREMENT_CRITIC = createGraphNodeId(NODE_IDS.REQUIREMENT_CRITIC);
export const CRITIQUE_JOIN = createGraphNodeId(NODE_IDS.CRITIQUE_JOIN);
export const REWRITE = createGraphNodeId(NODE_IDS.REWRITE);
export const CANDIDATE_GATE = createGraphNodeId(NODE_IDS.CANDIDATE_GATE);
export const CANDIDATE_ESCALATION = createGraphNodeId(NODE_IDS.CANDIDATE_ESCALATION);
export const MANUSCRIPT_COMMIT = createGraphNodeId(NODE_IDS.MANUSCRIPT_COMMIT);
export const CHAPTER_READY = createGraphNodeId(NODE_IDS.CHAPTER_READY);
export const CHAPTER_CANCELLED = createGraphNodeId(NODE_IDS.CHAPTER_CANCELLED);
export const CHAPTER_BLOCKED = createGraphNodeId(NODE_IDS.CHAPTER_BLOCKED);

const p = (id: string): StablePromptId => createStablePromptId(id);

const out = (
  requiredOutcomeCondition: GraphConditionName | null,
  allowedArtifactKind: ArtifactKind | null,
): GraphNodeOutputContract => ({
  requiredOutcomeCondition,
  allowedArtifactKind,
  outputRequired: requiredOutcomeCondition !== null || allowedArtifactKind !== null,
});

const noOut = out(null, null);

const cond = <K extends GraphConditionName>(
  condition: K,
  expectedOutcome: GraphConditionOutcomeOf<K>,
): EdgeOutcomeRequirement => ({ condition, expectedOutcome });

// ── Project Graph 节点与边 ───────────────────────────────────────

const PROJECT_NODES: ReadonlyArray<IdeaToNovelGraphNodeDefinition> = [
  {
    id: IDEA_CAPTURE,
    kind: 'IDEA_INPUT',
    label: '想法捕获',
    output: out(null, 'idea'),
    // 重新捕获想法（modify_idea）视为新一轮抽取会话：重置澄清预算
    budgetResetPolicy: ['clarification'],
  },
  {
    id: SPEC_EXTRACT,
    kind: 'EXTRACT',
    label: '创作要求抽取',
    promptId: p('prompt:spec-extract-v1'),
    output: out('clarification_remaining', 'creationSpec'),
  },
  {
    id: ASK_QUESTION,
    kind: 'CLARIFY_ASK',
    label: '追问',
    promptId: p('prompt:ask-question-v1'),
    output: noOut,
  },
  {
    id: COLLECT_ANSWER,
    kind: 'CLARIFY_ANSWER',
    label: '收集回答',
    humanDecisionType: 'intake_response',
    output: out('intake_action', null),
  },
  {
    id: INTAKE_ESCALATION,
    kind: 'USER_GATE',
    label: '澄清预算耗尽人工升级',
    humanDecisionType: 'escalation',
    output: out('intake_escalation_decision', null),
  },
  {
    id: RESEARCH_DECISION,
    kind: 'DECISION',
    label: '调研强度判断',
    output: out('research_decision', null),
  },
  {
    id: RESEARCH_PLAN,
    kind: 'PLAN',
    label: '调研问题规划',
    promptId: p('prompt:research-plan-v1'),
    output: noOut,
  },
  {
    id: RESEARCH_EXECUTE,
    kind: 'RESEARCH',
    label: '调研执行',
    output: out(null, 'researchBundle'),
  },
  {
    id: RESEARCH_VALIDATE,
    kind: 'DECISION',
    label: '调研校验',
    output: out('research_valid', null),
  },
  {
    id: RESEARCH_ESCALATION,
    kind: 'USER_GATE',
    label: '调研无效人工升级',
    humanDecisionType: 'escalation',
    output: out('research_escalation_decision', null),
  },
  {
    id: BLUEPRINT_GENERATE,
    kind: 'GENERATE',
    label: '蓝图生成',
    promptId: p('prompt:blueprint-generate-v1'),
    output: out(null, 'storyBlueprint'),
  },
  {
    id: BLUEPRINT_USER_GATE,
    kind: 'USER_GATE',
    label: '蓝图人工确认',
    humanDecisionType: 'blueprint_gate',
    output: out('blueprint_gate', null),
  },
  {
    id: BLUEPRINT_ESCALATION,
    kind: 'USER_GATE',
    label: '蓝图预算耗尽人工升级',
    humanDecisionType: 'escalation',
    output: out('escalation_decision', null),
  },
  {
    id: PROJECT_READY,
    kind: 'TERMINAL',
    label: '项目就绪',
    output: noOut,
    terminalStatus: 'completed',
  },
  {
    id: PROJECT_CANCELLED,
    kind: 'TERMINAL',
    label: '项目已取消',
    output: noOut,
    terminalStatus: 'cancelled',
  },
  {
    id: PROJECT_BLOCKED,
    kind: 'TERMINAL',
    label: '项目已阻塞',
    output: noOut,
    terminalStatus: 'blocked',
  },
];

const PROJECT_EDGES: ReadonlyArray<IdeaToNovelGraphEdgeDefinition> = [
  // ── Idea Intake ──────────────────────────────────────────────
  {
    id: createGraphEdgeId('idea-capture--spec-extract'),
    from: IDEA_CAPTURE,
    to: SPEC_EXTRACT,
    kind: 'fixed',
    mode: 'exclusive',
  },
  // 澄清已完成 → 进入调研决策
  {
    id: createGraphEdgeId('spec-extract--research-decision'),
    from: SPEC_EXTRACT,
    to: RESEARCH_DECISION,
    kind: 'conditional',
    requiredOutcomes: [cond('clarification_remaining', 'spec_complete')],
    mode: 'exclusive',
  },
  // 澄清未完成 + 预算可用 → 先检查预算，再提出下一个问题
  {
    id: createGraphEdgeId('spec-extract--ask-question'),
    from: SPEC_EXTRACT,
    to: ASK_QUESTION,
    kind: 'conditional',
    requiredOutcomes: [
      cond('clarification_remaining', 'ask_more'),
      cond('clarification_budget', 'available'),
    ],
    mode: 'exclusive',
    loop: { budget: 'clarification', maxIterations: 12 },
  },
  // 澄清未完成 + 预算耗尽 → 不得自动替用户完成访谈，升级人工
  {
    id: createGraphEdgeId('spec-extract--intake-escalation'),
    from: SPEC_EXTRACT,
    to: INTAKE_ESCALATION,
    kind: 'conditional',
    requiredOutcomes: [
      cond('clarification_remaining', 'ask_more'),
      cond('clarification_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('ask-question--collect-answer'),
    from: ASK_QUESTION,
    to: COLLECT_ANSWER,
    kind: 'fixed',
    mode: 'exclusive',
  },
  // 回答路径：最后一次 answer 必须重新经过 SPEC_EXTRACT
  {
    id: createGraphEdgeId('collect-answer--spec-extract-answer'),
    from: COLLECT_ANSWER,
    to: SPEC_EXTRACT,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_action', 'answer')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('collect-answer--spec-extract-skip'),
    from: COLLECT_ANSWER,
    to: SPEC_EXTRACT,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_action', 'skip')],
    mode: 'exclusive',
  },
  // finish：用户主动结束访谈 → 直接进入调研决策
  {
    id: createGraphEdgeId('collect-answer--research-decision-finish'),
    from: COLLECT_ANSWER,
    to: RESEARCH_DECISION,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_action', 'finish')],
    mode: 'exclusive',
  },
  // ── Intake Escalation ────────────────────────────────────────
  {
    id: createGraphEdgeId('intake-escalation--research-decision-continue'),
    from: INTAKE_ESCALATION,
    to: RESEARCH_DECISION,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_escalation_decision', 'continue_with_current_spec')],
    mode: 'exclusive',
  },
  // modify_idea → 返回项目级输入/抽取流程（重新捕获想法），受 intakeRevision 预算约束；
  // IDEA_CAPTURE 成功时重置澄清预算，允许新一轮追问
  {
    id: createGraphEdgeId('intake-escalation--idea-capture-modify'),
    from: INTAKE_ESCALATION,
    to: IDEA_CAPTURE,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_escalation_decision', 'modify_idea')],
    mode: 'exclusive',
    loop: { budget: 'intakeRevision', maxIterations: 3 },
  },
  {
    id: createGraphEdgeId('intake-escalation--project-cancelled'),
    from: INTAKE_ESCALATION,
    to: PROJECT_CANCELLED,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_escalation_decision', 'cancel')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('intake-escalation--project-blocked-later'),
    from: INTAKE_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [cond('intake_escalation_decision', 'continue_later')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('intake-escalation--project-blocked-intake-exhausted'),
    from: INTAKE_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [
      cond('intake_escalation_decision', 'modify_idea'),
      cond('intake_revision_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  // ── Web Research ─────────────────────────────────────────────
  {
    id: createGraphEdgeId('research-decision--blueprint-generate-none'),
    from: RESEARCH_DECISION,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_decision', 'none')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-decision--research-plan-light'),
    from: RESEARCH_DECISION,
    to: RESEARCH_PLAN,
    kind: 'conditional',
    requiredOutcomes: [cond('research_decision', 'light')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-decision--research-plan-deep'),
    from: RESEARCH_DECISION,
    to: RESEARCH_PLAN,
    kind: 'conditional',
    requiredOutcomes: [cond('research_decision', 'deep')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-plan--research-execute'),
    from: RESEARCH_PLAN,
    to: RESEARCH_EXECUTE,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-execute--research-validate'),
    from: RESEARCH_EXECUTE,
    to: RESEARCH_VALIDATE,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-validate--research-execute'),
    from: RESEARCH_VALIDATE,
    to: RESEARCH_EXECUTE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_valid', 'invalid')],
    mode: 'exclusive',
    loop: { budget: 'researchRetry', maxIterations: 2 },
  },
  {
    id: createGraphEdgeId('research-validate--blueprint-generate-valid'),
    from: RESEARCH_VALIDATE,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_valid', 'valid')],
    mode: 'exclusive',
  },
  // invalid + 预算耗尽：不再静默进入蓝图，显式升级人工
  {
    id: createGraphEdgeId('research-validate--research-escalation'),
    from: RESEARCH_VALIDATE,
    to: RESEARCH_ESCALATION,
    kind: 'conditional',
    requiredOutcomes: [
      cond('research_valid', 'invalid'),
      cond('research_retry_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  // ── Research Escalation ──────────────────────────────────────
  {
    id: createGraphEdgeId('research-escalation--blueprint-generate-use'),
    from: RESEARCH_ESCALATION,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_escalation_decision', 'use_current_research')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-escalation--blueprint-generate-skip'),
    from: RESEARCH_ESCALATION,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_escalation_decision', 'skip_research')],
    mode: 'exclusive',
  },
  // modify_requirements → 返回 CreationSpec 相关流程，受 specRevision 预算约束
  {
    id: createGraphEdgeId('research-escalation--spec-extract-modify'),
    from: RESEARCH_ESCALATION,
    to: SPEC_EXTRACT,
    kind: 'conditional',
    requiredOutcomes: [cond('research_escalation_decision', 'modify_requirements')],
    mode: 'exclusive',
    loop: { budget: 'specRevision', maxIterations: 3 },
  },
  {
    id: createGraphEdgeId('research-escalation--project-cancelled'),
    from: RESEARCH_ESCALATION,
    to: PROJECT_CANCELLED,
    kind: 'conditional',
    requiredOutcomes: [cond('research_escalation_decision', 'cancel')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-escalation--project-blocked-later'),
    from: RESEARCH_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [cond('research_escalation_decision', 'continue_later')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('research-escalation--project-blocked-spec-exhausted'),
    from: RESEARCH_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [
      cond('research_escalation_decision', 'modify_requirements'),
      cond('spec_revision_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  // ── Story Blueprint ──────────────────────────────────────────
  {
    id: createGraphEdgeId('blueprint-generate--blueprint-user-gate'),
    from: BLUEPRINT_GENERATE,
    to: BLUEPRINT_USER_GATE,
    kind: 'fixed',
    mode: 'exclusive',
  },
  // 蓝图被用户明确接受 → 项目就绪（可以创建 ChapterGenerationRun）
  {
    id: createGraphEdgeId('blueprint-user-gate--project-ready-accept'),
    from: BLUEPRINT_USER_GATE,
    to: PROJECT_READY,
    kind: 'conditional',
    requiredOutcomes: [cond('blueprint_gate', 'accept')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('blueprint-user-gate--blueprint-generate'),
    from: BLUEPRINT_USER_GATE,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('blueprint_gate', 'request_rewrite')],
    mode: 'exclusive',
    loop: { budget: 'blueprintRewrite', maxIterations: 3 },
  },
  {
    id: createGraphEdgeId('blueprint-user-gate--blueprint-escalation'),
    from: BLUEPRINT_USER_GATE,
    to: BLUEPRINT_ESCALATION,
    kind: 'conditional',
    requiredOutcomes: [
      cond('blueprint_gate', 'request_rewrite'),
      cond('blueprint_rewrite_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  // ── Blueprint Escalation ─────────────────────────────────────
  {
    id: createGraphEdgeId('blueprint-escalation--project-ready-accept'),
    from: BLUEPRINT_ESCALATION,
    to: PROJECT_READY,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'accept_current')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('blueprint-escalation--spec-extract-modify'),
    from: BLUEPRINT_ESCALATION,
    to: SPEC_EXTRACT,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'modify_requirements')],
    mode: 'exclusive',
    loop: { budget: 'specRevision', maxIterations: 3 },
  },
  {
    id: createGraphEdgeId('blueprint-escalation--project-cancelled'),
    from: BLUEPRINT_ESCALATION,
    to: PROJECT_CANCELLED,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'cancel')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('blueprint-escalation--project-blocked-later'),
    from: BLUEPRINT_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'continue_later')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('blueprint-escalation--project-blocked-spec-exhausted'),
    from: BLUEPRINT_ESCALATION,
    to: PROJECT_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [
      cond('escalation_decision', 'modify_requirements'),
      cond('spec_revision_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
];

/** 项目级权威 artifact 槽位 */
export const PROJECT_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'idea',
  'creationSpec',
  'researchBundle',
  'storyBlueprint',
];

/** 项目级权威预算键 */
export const PROJECT_BUDGET_KEYS: readonly LoopBudgetKey[] = [
  'clarification',
  'intakeRevision',
  'researchRetry',
  'blueprintRewrite',
  'specRevision',
];

/** 项目级 artifact 下游依赖顺序（级联失效） */
export const PROJECT_ARTIFACT_DOWNSTREAM_ORDER: readonly ArtifactKind[] = [
  'idea',
  'creationSpec',
  'researchBundle',
  'storyBlueprint',
];

export const IDEA_TO_NOVEL_PROJECT_GRAPH_V1: IdeaToNovelProjectGraphV1 = {
  id: IDEA_TO_NOVEL_PROJECT_GRAPH_ID,
  version: GRAPH_VERSION_V1,
  kind: 'project',
  entryNodeId: IDEA_CAPTURE,
  nodes: PROJECT_NODES,
  edges: PROJECT_EDGES,
  artifactKinds: PROJECT_ARTIFACT_KINDS,
  budgetKeys: PROJECT_BUDGET_KEYS,
  artifactDownstreamOrder: PROJECT_ARTIFACT_DOWNSTREAM_ORDER,
};

// ── Chapter Graph 节点与边 ───────────────────────────────────────

const CHAPTER_NODES: ReadonlyArray<IdeaToNovelGraphNodeDefinition> = [
  {
    id: CHAPTER_PLAN,
    kind: 'PLAN',
    label: '章节规划',
    promptId: p('prompt:chapter-plan-v1'),
    output: noOut,
  },
  {
    id: DRAFT,
    kind: 'GENERATE',
    label: '章节草稿生成',
    promptId: p('prompt:draft-generate-v1'),
    output: out(null, 'generationRun'),
    budgetResetPolicy: ['rewrite', 'candidateRewrite'],
  },
  {
    id: CONTINUITY_CRITIC,
    kind: 'CRITIC',
    label: '连续性审查',
    promptId: p('prompt:continuity-critic-v1'),
    output: out('critique_verdict', null),
  },
  {
    id: STYLE_CRITIC,
    kind: 'CRITIC',
    label: '风格审查',
    promptId: p('prompt:style-critic-v1'),
    output: out('critique_verdict', null),
  },
  {
    id: REQUIREMENT_CRITIC,
    kind: 'CRITIC',
    label: '要求符合审查',
    promptId: p('prompt:requirement-critic-v1'),
    output: out('critique_verdict', null),
  },
  {
    id: CRITIQUE_JOIN,
    kind: 'JOIN',
    label: '审查汇合',
    join: { requiredIncoming: 3 },
    output: out('critique_verdict', null),
    joinAggregationPolicy: {
      kind: 'critique_verdict',
      sources: [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC],
      rule: 'all_pass_or_needs_rewrite',
    },
  },
  {
    id: REWRITE,
    kind: 'REWRITE',
    label: '定点改写',
    promptId: p('prompt:rewrite-v1'),
    output: noOut,
  },
  {
    id: CANDIDATE_GATE,
    kind: 'USER_GATE',
    label: '候选稿人工确认',
    humanDecisionType: 'candidate_gate',
    output: out('candidate_gate', null),
    budgetResetPolicy: ['rewrite'],
  },
  {
    id: CANDIDATE_ESCALATION,
    kind: 'USER_GATE',
    label: '候选稿预算耗尽人工升级',
    humanDecisionType: 'escalation',
    output: out('escalation_decision', null),
  },
  {
    id: MANUSCRIPT_COMMIT,
    kind: 'COMMIT',
    label: '写入稿件',
    output: out(null, 'manuscript'),
  },
  {
    id: CHAPTER_READY,
    kind: 'TERMINAL',
    label: '章节就绪',
    output: noOut,
    terminalStatus: 'completed',
  },
  {
    id: CHAPTER_CANCELLED,
    kind: 'TERMINAL',
    label: '章节已取消',
    output: noOut,
    terminalStatus: 'cancelled',
  },
  {
    id: CHAPTER_BLOCKED,
    kind: 'TERMINAL',
    label: '章节已阻塞',
    output: noOut,
    terminalStatus: 'blocked',
  },
];

const CHAPTER_EDGES: ReadonlyArray<IdeaToNovelGraphEdgeDefinition> = [
  // ── 章节规划 → 草稿 → 三 Critic 并行 ─────────────────────────
  {
    id: createGraphEdgeId('chapter-plan--draft'),
    from: CHAPTER_PLAN,
    to: DRAFT,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('draft--continuity-critic'),
    from: DRAFT,
    to: CONTINUITY_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('draft--style-critic'),
    from: DRAFT,
    to: STYLE_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('draft--requirement-critic'),
    from: DRAFT,
    to: REQUIREMENT_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  // ── 三 Critic 并行 → CRITIQUE_JOIN（fan-in）──────────────────
  {
    id: createGraphEdgeId('continuity-critic--critique-join'),
    from: CONTINUITY_CRITIC,
    to: CRITIQUE_JOIN,
    kind: 'fixed',
    mode: 'join',
  },
  {
    id: createGraphEdgeId('style-critic--critique-join'),
    from: STYLE_CRITIC,
    to: CRITIQUE_JOIN,
    kind: 'fixed',
    mode: 'join',
  },
  {
    id: createGraphEdgeId('requirement-critic--critique-join'),
    from: REQUIREMENT_CRITIC,
    to: CRITIQUE_JOIN,
    kind: 'fixed',
    mode: 'join',
  },
  {
    id: createGraphEdgeId('critique-join--rewrite'),
    from: CRITIQUE_JOIN,
    to: REWRITE,
    kind: 'conditional',
    requiredOutcomes: [cond('critique_verdict', 'needs_rewrite')],
    mode: 'exclusive',
    loop: { budget: 'rewrite', maxIterations: 3 },
  },
  {
    id: createGraphEdgeId('critique-join--candidate-gate-pass'),
    from: CRITIQUE_JOIN,
    to: CANDIDATE_GATE,
    kind: 'conditional',
    requiredOutcomes: [cond('critique_verdict', 'pass')],
    mode: 'exclusive',
  },
  // needs_rewrite + 预算耗尽：不自动接受，交人工门禁
  {
    id: createGraphEdgeId('critique-join--candidate-gate-rewrite-exhausted'),
    from: CRITIQUE_JOIN,
    to: CANDIDATE_GATE,
    kind: 'conditional',
    requiredOutcomes: [
      cond('critique_verdict', 'needs_rewrite'),
      cond('rewrite_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('rewrite--continuity-critic'),
    from: REWRITE,
    to: CONTINUITY_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('rewrite--style-critic'),
    from: REWRITE,
    to: STYLE_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('rewrite--requirement-critic'),
    from: REWRITE,
    to: REQUIREMENT_CRITIC,
    kind: 'fixed',
    mode: 'exclusive',
  },
  // ── Candidate Gate：接受 / 拒绝 / 要求重写 ────────────────────
  {
    id: createGraphEdgeId('candidate-gate--manuscript-commit-accept'),
    from: CANDIDATE_GATE,
    to: MANUSCRIPT_COMMIT,
    kind: 'conditional',
    requiredOutcomes: [cond('candidate_gate', 'accept')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('candidate-gate--draft-reject'),
    from: CANDIDATE_GATE,
    to: DRAFT,
    kind: 'conditional',
    requiredOutcomes: [cond('candidate_gate', 'reject')],
    mode: 'exclusive',
    loop: { budget: 'regenerate', maxIterations: 5 },
  },
  {
    id: createGraphEdgeId('candidate-gate--rewrite-request-rewrite'),
    from: CANDIDATE_GATE,
    to: REWRITE,
    kind: 'conditional',
    requiredOutcomes: [cond('candidate_gate', 'request_rewrite')],
    mode: 'exclusive',
    loop: { budget: 'candidateRewrite', maxIterations: 5 },
  },
  {
    id: createGraphEdgeId('candidate-gate--candidate-escalation-candidate-rewrite-exhausted'),
    from: CANDIDATE_GATE,
    to: CANDIDATE_ESCALATION,
    kind: 'conditional',
    requiredOutcomes: [
      cond('candidate_gate', 'request_rewrite'),
      cond('candidate_rewrite_budget', 'exhausted'),
    ],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('candidate-gate--candidate-escalation-regenerate-exhausted'),
    from: CANDIDATE_GATE,
    to: CANDIDATE_ESCALATION,
    kind: 'conditional',
    requiredOutcomes: [cond('candidate_gate', 'reject'), cond('regenerate_budget', 'exhausted')],
    mode: 'exclusive',
  },
  // ── Candidate Escalation ─────────────────────────────────────
  {
    id: createGraphEdgeId('candidate-escalation--manuscript-commit-accept'),
    from: CANDIDATE_ESCALATION,
    to: MANUSCRIPT_COMMIT,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'accept_current')],
    mode: 'exclusive',
  },
  // 章节 run 只负责一个章节：修改项目级要求不在本 run 能力范围内 → 阻塞（需新 run）
  {
    id: createGraphEdgeId('candidate-escalation--chapter-blocked-modify'),
    from: CANDIDATE_ESCALATION,
    to: CHAPTER_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'modify_requirements')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('candidate-escalation--chapter-cancelled'),
    from: CANDIDATE_ESCALATION,
    to: CHAPTER_CANCELLED,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'cancel')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('candidate-escalation--chapter-blocked-later'),
    from: CANDIDATE_ESCALATION,
    to: CHAPTER_BLOCKED,
    kind: 'conditional',
    requiredOutcomes: [cond('escalation_decision', 'continue_later')],
    mode: 'exclusive',
  },
  // ── Commit → 终止 ─────────────────────────────────────────────
  {
    id: createGraphEdgeId('manuscript-commit--chapter-ready'),
    from: MANUSCRIPT_COMMIT,
    to: CHAPTER_READY,
    kind: 'fixed',
    mode: 'exclusive',
  },
];

/** 章节级权威 artifact 槽位 */
export const CHAPTER_ARTIFACT_KINDS: readonly ArtifactKind[] = ['generationRun', 'manuscript'];

/** 章节级权威预算键 */
export const CHAPTER_BUDGET_KEYS: readonly LoopBudgetKey[] = [
  'rewrite',
  'candidateRewrite',
  'regenerate',
];

/** 章节级 artifact 下游依赖顺序（级联失效） */
export const CHAPTER_ARTIFACT_DOWNSTREAM_ORDER: readonly ArtifactKind[] = [
  'generationRun',
  'manuscript',
];

export const CHAPTER_GENERATION_GRAPH_V1: ChapterGenerationGraphV1 = {
  id: CHAPTER_GENERATION_GRAPH_ID,
  version: GRAPH_VERSION_V1,
  kind: 'chapter',
  entryNodeId: CHAPTER_PLAN,
  nodes: CHAPTER_NODES,
  edges: CHAPTER_EDGES,
  artifactKinds: CHAPTER_ARTIFACT_KINDS,
  budgetKeys: CHAPTER_BUDGET_KEYS,
  artifactDownstreamOrder: CHAPTER_ARTIFACT_DOWNSTREAM_ORDER,
};

// ── 节点产出结果（闭合判别联合）────────────────────────────────

/**
 * 决策节点完成时记录在共享状态中的产出结果。
 *
 * 只允许引用闭合枚举值；预算条件（`X_budget`）不属于节点产出，
 * 由 transition 从 `state.attemptBudget` 求值。
 */
export type GraphNodeOutcome =
  | { readonly condition: 'clarification_remaining'; readonly value: ClarificationRemaining }
  | { readonly condition: 'intake_action'; readonly value: IntakeAction }
  | { readonly condition: 'intake_escalation_decision'; readonly value: IntakeEscalationDecision }
  | { readonly condition: 'research_decision'; readonly value: ResearchDecision }
  | { readonly condition: 'research_valid'; readonly value: ResearchVerdict }
  | {
      readonly condition: 'research_escalation_decision';
      readonly value: ResearchEscalationDecision;
    }
  | { readonly condition: 'blueprint_gate'; readonly value: BlueprintGateDecision }
  | { readonly condition: 'candidate_gate'; readonly value: CandidateGateDecision }
  | { readonly condition: 'critique_verdict'; readonly value: CritiqueVerdict }
  | { readonly condition: 'escalation_decision'; readonly value: EscalationDecision };

// ── 只读辅助 ────────────────────────────────────────────────────

/** 直接后继节点（Renderer 用于展示下一步，而不是用 WorkflowStage 推导） */
export function possibleNextNodes(
  graph: AnyIdeaToNovelGraphV1,
  nodeId: GraphNodeId,
): ReadonlyArray<GraphNodeId> {
  return graph.edges.filter((e) => e.from === nodeId).map((e) => e.to);
}

/** 某预算键在图中声明的最大迭代次数；未声明时返回 null */
export function getLoopBudgetMax(
  graph: AnyIdeaToNovelGraphV1,
  budget: LoopBudgetKey,
): number | null {
  for (const edge of graph.edges) {
    if (edge.loop?.budget === budget) return edge.loop.maxIterations;
  }
  return null;
}

/**
 * 三个 Critic 并行后 join 的聚合结论：全部 pass 才 pass。
 *
 * 要求恰好 3 个合法 critique_verdict 结果；空 / 缺项 / 多项 / 非法 condition 一律抛错。
 */
export function aggregateCritiqueVerdict(
  criticOutcomes: ReadonlyArray<GraphNodeOutcome>,
): CritiqueVerdict {
  if (criticOutcomes.length !== 3) {
    throw new Error(`aggregateCritiqueVerdict 要求恰好 3 个结果，实际 ${criticOutcomes.length}`);
  }
  for (const o of criticOutcomes) {
    if (o.condition !== 'critique_verdict') {
      throw new Error(`aggregateCritiqueVerdict 收到非法 condition: ${o.condition}`);
    }
  }
  const allPass = criticOutcomes.every((o) => o.value === 'pass');
  return allPass ? 'pass' : 'needs_rewrite';
}

// ── 确定性序列化 ────────────────────────────────────────────────

function nfc(s: string): string {
  return s.normalize('NFC');
}

function canonicalRequirement(r: EdgeOutcomeRequirement): string {
  return nfc(`${r.condition}=${r.expectedOutcome}`);
}

/**
 * 把 Graph 定义为稳定 JSON 字符串（两张 Graph 共用同一确定性序列化）。
 *
 * 排序使用仓库统一规则 `codePointCompare`（NFC 规范化 + Unicode code point），
 * 不使用 localeCompare，跨 locale / 输入编码稳定。
 * 节点/边按 id 排序；节点与边的执行语义字段（output / humanDecisionType /
 * budgetResetPolicy / joinAggregationPolicy / terminalStatus / kind /
 * artifactKinds / budgetKeys / artifactDownstreamOrder）全部参与序列化。
 */
export function serializeGraphDefinition(graph: AnyIdeaToNovelGraphV1): string {
  const nodes = [...graph.nodes]
    .map((n) => ({
      id: nfc(n.id),
      kind: n.kind,
      label: nfc(n.label),
      promptId: n.promptId ?? null,
      output: {
        requiredOutcomeCondition: n.output.requiredOutcomeCondition,
        allowedArtifactKind: n.output.allowedArtifactKind,
        outputRequired: n.output.outputRequired,
      },
      humanDecisionType: n.humanDecisionType ?? null,
      budgetResetPolicy: n.budgetResetPolicy
        ? [...n.budgetResetPolicy].sort(codePointCompare)
        : null,
      join: n.join ?? null,
      joinAggregationPolicy: n.joinAggregationPolicy
        ? {
            kind: n.joinAggregationPolicy.kind,
            sources: [...n.joinAggregationPolicy.sources].sort(codePointCompare),
            rule: n.joinAggregationPolicy.rule,
          }
        : null,
      terminalStatus: n.terminalStatus ?? null,
    }))
    .sort((a, b) => codePointCompare(a.id, b.id));
  const edges = [...graph.edges]
    .map((e) => ({
      id: nfc(e.id),
      from: nfc(e.from),
      to: nfc(e.to),
      kind: e.kind,
      requiredOutcomes: (e.requiredOutcomes ?? []).map(canonicalRequirement).sort(codePointCompare),
      mode: e.mode,
      loop: e.loop ?? null,
    }))
    .sort((a, b) => codePointCompare(a.id, b.id));
  const conditions = (Object.keys(GRAPH_CONDITION_OUTCOMES) as GraphConditionName[])
    .sort(codePointCompare)
    .map((name) => ({ name, outcomes: GRAPH_CONDITION_OUTCOMES[name] }));
  const payload = {
    id: nfc(graph.id),
    version: nfc(graph.version),
    kind: graph.kind,
    entryNodeId: nfc(graph.entryNodeId),
    nodes,
    edges,
    conditions,
    artifactKinds: [...graph.artifactKinds],
    budgetKeys: [...graph.budgetKeys],
    artifactDownstreamOrder: [...graph.artifactDownstreamOrder],
  };
  return JSON.stringify(payload);
}

/** Project Graph 的确定性序列化 */
export function serializeIdeaToNovelProjectGraphV1(graph: IdeaToNovelProjectGraphV1): string {
  return serializeGraphDefinition(graph);
}

/** Chapter Graph 的确定性序列化 */
export function serializeChapterGenerationGraphV1(graph: ChapterGenerationGraphV1): string {
  return serializeGraphDefinition(graph);
}
