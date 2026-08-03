/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition V1
 *
 * 把 Idea-to-Novel 产品主流程定义为一棵显式、静态、版本化、可验证的产品 Graph。
 *
 * 纯 TypeScript —— 不依赖 Electron、SQLite、Node.js 或 Renderer。
 * 不负责随机 ID 或当前时间生成 —— ID 与时间由调用方注入。
 * 不进行模型调用、搜索调用或 Keychain 访问。
 *
 * 本文件只承载：
 * - 闭合枚举（条件、实现类型、预算、人工决策类型）；
 * - 节点与边的定义类型；
 * - 权威的 `IDEA_TO_NOVEL_GRAPH_V1` 实例；
 * - Graph 与 Prompt 分离（只引用稳定 prompt ID，不含 prompt 文本）；
 * - 确定性序列化。
 *
 * 权威规格：docs/product/idea-to-novel-v1.md、docs/development/idea-to-novel-migration-plan.md。
 */

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

export const IDEA_TO_NOVEL_GRAPH_ID = 'idea-to-novel' as GraphId;
export const IDEA_TO_NOVEL_GRAPH_VERSION_V1 = 'v1' as GraphVersion;

// ── 条件闭合枚举 ────────────────────────────────────────────────

/** 澄清是否仍需追问 */
export type ClarificationRemaining = 'ask_more' | 'spec_complete';

/** 调研强度三档（无需调研 / 轻量调研 / 深度调研） */
export type ResearchDecision = 'none' | 'light' | 'deep';

/** 调研校验结论 */
export type ResearchVerdict = 'valid' | 'invalid';

/** 蓝图人工门禁决策 */
export type BlueprintGateDecision = 'accept' | 'request_rewrite';

/** 候选稿人工门禁决策 */
export type CandidateGateDecision = 'accept' | 'reject' | 'request_rewrite';

/** 审查结论 */
export type CritiqueVerdict = 'pass' | 'needs_rewrite';

/**
 * 有界循环预算键。
 *
 * 每个键对应一条 loop-back 边，最多重入 `maxIterations` 次；
 * 预算耗尽时必须存在 `X_budget: exhausted` 的出口边。
 */
export type LoopBudgetKey =
  | 'clarification'
  | 'researchRetry'
  | 'blueprintRewrite'
  | 'rewrite'
  | 'candidateRewrite'
  | 'regenerate';

/** 预算耗尽条件名：`<key>_budget` */
export type LoopBudgetConditionName =
  | 'clarification_budget'
  | 'research_retry_budget'
  | 'blueprint_rewrite_budget'
  | 'rewrite_budget'
  | 'candidate_rewrite_budget'
  | 'regenerate_budget';

/** 全部条件名（含预算条件） */
export type GraphConditionName =
  | 'clarification_remaining'
  | 'clarification_budget'
  | 'research_decision'
  | 'research_valid'
  | 'research_retry_budget'
  | 'blueprint_gate'
  | 'blueprint_rewrite_budget'
  | 'critique_verdict'
  | 'rewrite_budget'
  | 'candidate_gate'
  | 'candidate_rewrite_budget'
  | 'regenerate_budget';

/** 每个条件名的闭合取值集合 —— 条件边只允许引用这里的值（as const 保留字面量类型） */
export const GRAPH_CONDITION_OUTCOMES = {
  clarification_remaining: ['ask_more', 'spec_complete'],
  clarification_budget: ['available', 'exhausted'],
  research_decision: ['none', 'light', 'deep'],
  research_valid: ['valid', 'invalid'],
  research_retry_budget: ['available', 'exhausted'],
  blueprint_gate: ['accept', 'request_rewrite'],
  blueprint_rewrite_budget: ['available', 'exhausted'],
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
  researchRetry: 'research_retry_budget',
  blueprintRewrite: 'blueprint_rewrite_budget',
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

/** 版本化 Graph 定义 */
export interface IdeaToNovelGraphV1 {
  readonly id: GraphId;
  readonly version: GraphVersion;
  readonly entryNodeId: GraphNodeId;
  readonly nodes: ReadonlyArray<IdeaToNovelGraphNodeDefinition>;
  readonly edges: ReadonlyArray<IdeaToNovelGraphEdgeDefinition>;
}

// ── 权威 Graph 实例 ─────────────────────────────────────────────

const NODE_IDS = {
  IDEA_CAPTURE: 'IDEA_CAPTURE',
  SPEC_EXTRACT: 'SPEC_EXTRACT',
  ASK_QUESTION: 'ASK_QUESTION',
  COLLECT_ANSWER: 'COLLECT_ANSWER',
  RESEARCH_DECISION: 'RESEARCH_DECISION',
  RESEARCH_PLAN: 'RESEARCH_PLAN',
  RESEARCH_EXECUTE: 'RESEARCH_EXECUTE',
  RESEARCH_VALIDATE: 'RESEARCH_VALIDATE',
  BLUEPRINT_GENERATE: 'BLUEPRINT_GENERATE',
  BLUEPRINT_USER_GATE: 'BLUEPRINT_USER_GATE',
  CHAPTER_PLAN: 'CHAPTER_PLAN',
  DRAFT: 'DRAFT',
  CONTINUITY_CRITIC: 'CONTINUITY_CRITIC',
  STYLE_CRITIC: 'STYLE_CRITIC',
  REQUIREMENT_CRITIC: 'REQUIREMENT_CRITIC',
  CRITIQUE_JOIN: 'CRITIQUE_JOIN',
  REWRITE: 'REWRITE',
  CANDIDATE_GATE: 'CANDIDATE_GATE',
  MANUSCRIPT_COMMIT: 'MANUSCRIPT_COMMIT',
  EXPORT_READY: 'EXPORT_READY',
} as const satisfies Record<string, string>;

export const IDEA_CAPTURE = createGraphNodeId(NODE_IDS.IDEA_CAPTURE);
export const SPEC_EXTRACT = createGraphNodeId(NODE_IDS.SPEC_EXTRACT);
export const ASK_QUESTION = createGraphNodeId(NODE_IDS.ASK_QUESTION);
export const COLLECT_ANSWER = createGraphNodeId(NODE_IDS.COLLECT_ANSWER);
export const RESEARCH_DECISION = createGraphNodeId(NODE_IDS.RESEARCH_DECISION);
export const RESEARCH_PLAN = createGraphNodeId(NODE_IDS.RESEARCH_PLAN);
export const RESEARCH_EXECUTE = createGraphNodeId(NODE_IDS.RESEARCH_EXECUTE);
export const RESEARCH_VALIDATE = createGraphNodeId(NODE_IDS.RESEARCH_VALIDATE);
export const BLUEPRINT_GENERATE = createGraphNodeId(NODE_IDS.BLUEPRINT_GENERATE);
export const BLUEPRINT_USER_GATE = createGraphNodeId(NODE_IDS.BLUEPRINT_USER_GATE);
export const CHAPTER_PLAN = createGraphNodeId(NODE_IDS.CHAPTER_PLAN);
export const DRAFT = createGraphNodeId(NODE_IDS.DRAFT);
export const CONTINUITY_CRITIC = createGraphNodeId(NODE_IDS.CONTINUITY_CRITIC);
export const STYLE_CRITIC = createGraphNodeId(NODE_IDS.STYLE_CRITIC);
export const REQUIREMENT_CRITIC = createGraphNodeId(NODE_IDS.REQUIREMENT_CRITIC);
export const CRITIQUE_JOIN = createGraphNodeId(NODE_IDS.CRITIQUE_JOIN);
export const REWRITE = createGraphNodeId(NODE_IDS.REWRITE);
export const CANDIDATE_GATE = createGraphNodeId(NODE_IDS.CANDIDATE_GATE);
export const MANUSCRIPT_COMMIT = createGraphNodeId(NODE_IDS.MANUSCRIPT_COMMIT);
export const EXPORT_READY = createGraphNodeId(NODE_IDS.EXPORT_READY);

const p = (id: string): StablePromptId => createStablePromptId(id);

const NODES: ReadonlyArray<IdeaToNovelGraphNodeDefinition> = [
  {
    id: IDEA_CAPTURE,
    kind: 'IDEA_INPUT',
    label: '想法捕获',
  },
  {
    id: SPEC_EXTRACT,
    kind: 'EXTRACT',
    label: '创作要求抽取',
    promptId: p('prompt:spec-extract-v1'),
  },
  {
    id: ASK_QUESTION,
    kind: 'CLARIFY_ASK',
    label: '追问',
    promptId: p('prompt:ask-question-v1'),
  },
  {
    id: COLLECT_ANSWER,
    kind: 'CLARIFY_ANSWER',
    label: '收集回答',
  },
  {
    id: RESEARCH_DECISION,
    kind: 'DECISION',
    label: '调研强度判断',
  },
  {
    id: RESEARCH_PLAN,
    kind: 'PLAN',
    label: '调研问题规划',
    promptId: p('prompt:research-plan-v1'),
  },
  {
    id: RESEARCH_EXECUTE,
    kind: 'RESEARCH',
    label: '调研执行',
  },
  {
    id: RESEARCH_VALIDATE,
    kind: 'DECISION',
    label: '调研校验',
  },
  {
    id: BLUEPRINT_GENERATE,
    kind: 'GENERATE',
    label: '蓝图生成',
    promptId: p('prompt:blueprint-generate-v1'),
  },
  {
    id: BLUEPRINT_USER_GATE,
    kind: 'USER_GATE',
    label: '蓝图人工确认',
  },
  {
    id: CHAPTER_PLAN,
    kind: 'PLAN',
    label: '章节规划',
    promptId: p('prompt:chapter-plan-v1'),
  },
  {
    id: DRAFT,
    kind: 'GENERATE',
    label: '章节草稿生成',
    promptId: p('prompt:draft-generate-v1'),
  },
  {
    id: CONTINUITY_CRITIC,
    kind: 'CRITIC',
    label: '连续性审查',
    promptId: p('prompt:continuity-critic-v1'),
  },
  {
    id: STYLE_CRITIC,
    kind: 'CRITIC',
    label: '风格审查',
    promptId: p('prompt:style-critic-v1'),
  },
  {
    id: REQUIREMENT_CRITIC,
    kind: 'CRITIC',
    label: '要求符合审查',
    promptId: p('prompt:requirement-critic-v1'),
  },
  {
    id: CRITIQUE_JOIN,
    kind: 'JOIN',
    label: '审查汇合',
    join: { requiredIncoming: 3 },
  },
  {
    id: REWRITE,
    kind: 'REWRITE',
    label: '定点改写',
    promptId: p('prompt:rewrite-v1'),
  },
  {
    id: CANDIDATE_GATE,
    kind: 'USER_GATE',
    label: '候选稿人工确认',
  },
  {
    id: MANUSCRIPT_COMMIT,
    kind: 'COMMIT',
    label: '写入稿件',
  },
  {
    id: EXPORT_READY,
    kind: 'TERMINAL',
    label: '可导出',
  },
];

const cond = <K extends GraphConditionName>(
  condition: K,
  expectedOutcome: GraphConditionOutcomeOf<K>,
): EdgeOutcomeRequirement => ({ condition, expectedOutcome });

const EDGES: ReadonlyArray<IdeaToNovelGraphEdgeDefinition> = [
  // ── Idea Intake ──────────────────────────────────────────────
  {
    id: createGraphEdgeId('idea-capture--spec-extract'),
    from: IDEA_CAPTURE,
    to: SPEC_EXTRACT,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('spec-extract--ask-question'),
    from: SPEC_EXTRACT,
    to: ASK_QUESTION,
    kind: 'conditional',
    requiredOutcomes: [cond('clarification_remaining', 'ask_more')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('ask-question--collect-answer'),
    from: ASK_QUESTION,
    to: COLLECT_ANSWER,
    kind: 'fixed',
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('collect-answer--spec-extract'),
    from: COLLECT_ANSWER,
    to: SPEC_EXTRACT,
    kind: 'fixed',
    mode: 'exclusive',
    loop: { budget: 'clarification', maxIterations: 12 },
  },
  {
    id: createGraphEdgeId('spec-extract--research-decision'),
    from: SPEC_EXTRACT,
    to: RESEARCH_DECISION,
    kind: 'conditional',
    requiredOutcomes: [cond('clarification_remaining', 'spec_complete')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('collect-answer--research-decision-budget-exhausted'),
    from: COLLECT_ANSWER,
    to: RESEARCH_DECISION,
    kind: 'conditional',
    requiredOutcomes: [cond('clarification_budget', 'exhausted')],
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
  {
    id: createGraphEdgeId('research-validate--blueprint-generate-budget-exhausted'),
    from: RESEARCH_VALIDATE,
    to: BLUEPRINT_GENERATE,
    kind: 'conditional',
    requiredOutcomes: [cond('research_retry_budget', 'exhausted')],
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
  {
    id: createGraphEdgeId('blueprint-user-gate--chapter-plan-accept'),
    from: BLUEPRINT_USER_GATE,
    to: CHAPTER_PLAN,
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
    id: createGraphEdgeId('blueprint-user-gate--chapter-plan-budget-exhausted'),
    from: BLUEPRINT_USER_GATE,
    to: CHAPTER_PLAN,
    kind: 'conditional',
    requiredOutcomes: [cond('blueprint_rewrite_budget', 'exhausted')],
    mode: 'exclusive',
  },
  // ── Generation：Draft + 三 Critic 并行 + join ─────────────────
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
  {
    id: createGraphEdgeId('critique-join--candidate-gate-budget-exhausted'),
    from: CRITIQUE_JOIN,
    to: CANDIDATE_GATE,
    kind: 'conditional',
    requiredOutcomes: [cond('rewrite_budget', 'exhausted')],
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
    id: createGraphEdgeId('candidate-gate--manuscript-commit-candidate-rewrite-exhausted'),
    from: CANDIDATE_GATE,
    to: MANUSCRIPT_COMMIT,
    kind: 'conditional',
    requiredOutcomes: [cond('candidate_rewrite_budget', 'exhausted')],
    mode: 'exclusive',
  },
  {
    id: createGraphEdgeId('candidate-gate--manuscript-commit-regenerate-exhausted'),
    from: CANDIDATE_GATE,
    to: MANUSCRIPT_COMMIT,
    kind: 'conditional',
    requiredOutcomes: [cond('regenerate_budget', 'exhausted')],
    mode: 'exclusive',
  },
  // ── Commit → 终止 ─────────────────────────────────────────────
  {
    id: createGraphEdgeId('manuscript-commit--export-ready'),
    from: MANUSCRIPT_COMMIT,
    to: EXPORT_READY,
    kind: 'fixed',
    mode: 'exclusive',
  },
];

export const IDEA_TO_NOVEL_GRAPH_V1: IdeaToNovelGraphV1 = {
  id: IDEA_TO_NOVEL_GRAPH_ID,
  version: IDEA_TO_NOVEL_GRAPH_VERSION_V1,
  entryNodeId: IDEA_CAPTURE,
  nodes: NODES,
  edges: EDGES,
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
  | { readonly condition: 'research_decision'; readonly value: ResearchDecision }
  | { readonly condition: 'research_valid'; readonly value: ResearchVerdict }
  | { readonly condition: 'blueprint_gate'; readonly value: BlueprintGateDecision }
  | { readonly condition: 'candidate_gate'; readonly value: CandidateGateDecision }
  | { readonly condition: 'critique_verdict'; readonly value: CritiqueVerdict };

// ── 只读辅助 ────────────────────────────────────────────────────

/** 直接后继节点（Renderer 用于展示下一步，而不是用 WorkflowStage 推导） */
export function possibleNextNodes(
  graph: IdeaToNovelGraphV1,
  nodeId: GraphNodeId,
): ReadonlyArray<GraphNodeId> {
  return graph.edges.filter((e) => e.from === nodeId).map((e) => e.to);
}

/** 某预算键在图中声明的最大迭代次数；未声明时返回 null */
export function getLoopBudgetMax(graph: IdeaToNovelGraphV1, budget: LoopBudgetKey): number | null {
  for (const edge of graph.edges) {
    if (edge.loop?.budget === budget) return edge.loop.maxIterations;
  }
  return null;
}

/** 三个 Critic 并行后 join 的聚合结论：全部 pass 才 pass */
export function aggregateCritiqueVerdict(
  criticOutcomes: ReadonlyArray<GraphNodeOutcome>,
): CritiqueVerdict {
  const allPass = criticOutcomes.every(
    (o) => o.condition === 'critique_verdict' && o.value === 'pass',
  );
  return allPass ? 'pass' : 'needs_rewrite';
}

// ── 确定性序列化 ────────────────────────────────────────────────

function canonicalRequirement(r: EdgeOutcomeRequirement): string {
  return `${r.condition}=${r.expectedOutcome}`;
}

/**
 * 把 Graph 定义为稳定 JSON 字符串。
 *
 * - 节点/边按 id 排序；
 * - 字段顺序固定；
 * - 条件注册表按条件名排序。
 * 对结构相同但键序不同的输入产生相同输出（确定性）。
 */
export function serializeIdeaToNovelGraphV1(graph: IdeaToNovelGraphV1): string {
  const nodes = [...graph.nodes]
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      promptId: n.promptId ?? null,
      join: n.join ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...graph.edges]
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      requiredOutcomes: (e.requiredOutcomes ?? []).map(canonicalRequirement).sort(),
      mode: e.mode,
      loop: e.loop ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const conditions = (Object.keys(GRAPH_CONDITION_OUTCOMES) as GraphConditionName[])
    .sort()
    .map((name) => ({ name, outcomes: GRAPH_CONDITION_OUTCOMES[name] }));
  const payload = {
    id: graph.id,
    version: graph.version,
    entryNodeId: graph.entryNodeId,
    nodes,
    edges,
    conditions,
  };
  return JSON.stringify(payload);
}
