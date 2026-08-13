/**
 * 章节生成四类模型任务执行器（GE-6 / B9，设计见 docs/development/b9-chapter-wiring-design.md）。
 *
 * 覆盖 ChapterGenerationGraphV1 的四个模型节点：
 * - CHAPTER_PLAN（`prompt:chapter-plan-v1`）→ ChapterScenePlan（内部 artifact，图契约 noOut）；
 * - DRAFT（`prompt:draft-generate-v1`）→ 候选修订（source=DRAFT，同时是 generationRun artifact）；
 * - CONTINUITY / STYLE / REQUIREMENT_CRITIC（`prompt:*-critic-v1`）→ 审查结论
 *   （outcome `critique_verdict`，无 artifact）；三者共用任务类型 CHAPTER_CRITIQUE，
 *   角色由**权威 execution.nodeId** 派生（不信任调用方 payload，D-B9-3）；
 * - REWRITE（`prompt:rewrite-v1`）→ 候选修订（source=REWRITE，图契约 noOut，不产生新 artifact）。
 *
 * 骨架照 blueprint-generate.ts：payload 解析 → claim 前配置校验（保持 PENDING 语义）→
 * claimPending → 权威 execution 反查 → 上下文装配 → 模型调用 → 严格解析 → 最终事务
 * （领域行落库 + execution-bound envelope + invocation/task 终态，全有或全无）→ 补偿。
 * 四个执行器共用同一 `runChapterModelTask` 骨架，只在 prompt / 解析 / 持久化三处分叉——
 * 复制四份 250 行骨架必然漂移（TD-019 的教训）。
 *
 * D-B9-2：上下文（蓝图、目标章节、创作要求、现有候选与审查意见）一律从**权威存储**按
 * `execution.graphRunId` 反查——chapter run 的 binding（creationSpecVersionId /
 * storyBlueprintId / blueprintChapterId / researchBundleId）存在 graph_runs 行里，
 * 由 `createChapterRun` 写入且此后不可变。payload 只承载 prompt 变异提示（改写轮次等），
 * 不承载任何身份字段，避免"调用方手拼 context"。
 */

import type {
  ChapterCandidateRepositoryPort,
  ChapterCritiqueRepositoryPort,
  ChapterScenePlanRepositoryPort,
  CreationContractVersionRepositoryPort,
  GraphRunRepositoryPort,
  ModelInvocationData,
  NodeExecutionRepositoryPort,
  StoryBlueprintRepositoryPort,
  TaskData,
} from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import {
  createChapterCandidate,
  createChapterCritique,
  createChapterScenePlan,
  validateCreationContractSections,
  CONTINUITY_CRITIC,
  REQUIREMENT_CRITIC,
  STYLE_CRITIC,
  type BlueprintChapter,
  type ChapterCandidate,
  type ChapterCritique,
  type ChapterCritiqueIssue,
  type ChapterScene,
  type ChapterScenePlan,
  type CritiqueVerdict,
  type StoryBlueprint,
  type TaskType,
} from '@ai-novel/domain';
import { sha256Hex, TaskExecutionError, type TaskEngineDeps } from './index.js';
import { compensateFinalization } from './chapter-generation.js';

// ── deps / 结果类型 ───────────────────────────────────────────────

export interface ChapterNodeExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  /** D-B9-2：按 execution.graphRunId 反查 chapter run binding（权威身份） */
  readonly graphRunRepo: GraphRunRepositoryPort;
  readonly blueprintRepo: StoryBlueprintRepositoryPort;
  readonly specVersionRepo: CreationContractVersionRepositoryPort;
  readonly scenePlanRepo: ChapterScenePlanRepositoryPort;
  readonly candidateRepo: ChapterCandidateRepositoryPort;
  readonly critiqueRepo: ChapterCritiqueRepositoryPort;
}

/** 最终事务内持久化的产物摘要（决定 envelope 与 task.result） */
export interface ChapterPersistResult {
  readonly artifactKind: 'generationRun' | null;
  readonly artifactId: string | null;
  readonly artifactVersion: number | null;
  readonly contentJson: string;
  readonly outcome: { readonly condition: string; readonly value: string } | null;
  readonly resultJson: string;
}

export interface ChapterNodeExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly persisted: ChapterPersistResult | null;
}

// ── 解析边界常量 ──────────────────────────────────────────────────

const MIN_SCENES = 1;
const MAX_SCENES = 12;
const MAX_BEATS = 12;
const MAX_SHORT_FIELD_LENGTH = 300;
const MAX_SCENE_SUMMARY_LENGTH = 1000;
/** 正文下限：低于此长度只可能是占位/截断，不是一章可用正文 */
const MIN_CONTENT_LENGTH = 200;
const MAX_CONTENT_LENGTH = 40000;
const MAX_TITLE_LENGTH = 200;
const MAX_ISSUES = 20;
const MAX_ISSUE_FIELD_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 2000;

/**
 * 正文类任务的输出上限。网关默认 4096 会截断一章中文正文（2500~4000 字按 ~1.5
 * token/字算就撞顶，截断输出必然解析失败）。取 8192 而不是更高，是因为 D6 要覆盖的
 * OpenAI 兼容端点里有 max_tokens 硬上限 8192 的实现（如 DeepSeek chat），超限会被
 * 直接 400 拒绝——宁可让极长章节撞一次解析失败，也不要让整类 provider 用不了。
 */
const PROSE_MAX_TOKENS = 8192;

// ── 系统提示词 ────────────────────────────────────────────────────

/**
 * 中文正文的共同写作纪律。质量基线（roadmap §17）里最差的两项是 AI 味 2.67 与语言
 * 自然度 3.33，这段纪律是针对该基线的直接干预，DRAFT 与 REWRITE 共用。
 */
const PROSE_DISCIPLINE = [
  '写作纪律（中文网文正文）：',
  '- 用具体的动作、对白、可感知的细节推进，不用抽象总结代替场景；',
  '- 不写"他感到一阵莫名的悸动"这类直陈情绪的句子，情绪由动作与对白外显；',
  '- 比喻克制：一个场景至多一个新鲜比喻，禁止连续排比式比喻堆叠；',
  '- 禁止空泛套话（"仿佛整个世界都安静了""命运的齿轮开始转动""空气仿佛凝固"）；',
  '- 对白要有区分度：不同人物的用词习惯、句长、语气必须能被读者分辨；',
  '- 不做上帝视角的主题升华与读者说教，不在结尾强行点题；',
  '- 段落长短交错，避免每段都是三句式的机械节奏。',
].join('\n');

export const CHAPTER_PLAN_SYSTEM_PROMPT = [
  '你是中文小说的章节场景规划助手。输入是故事蓝图、本章目标与创作要求。',
  '你的职责：把本章目标拆解为有先后因果的场景序列，每个场景给出梗概与关键节拍。',
  '规划必须服务于本章目标，不得越界写到后续章节的内容，也不得重复已完成章节已经交代过的信息。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"title":"...","scenes":[{"summary":"...","beats":["...","..."]}]}',
  `字段边界：scenes ${MIN_SCENES}..${MAX_SCENES} 个；每个场景 beats 0..${MAX_BEATS} 条；`,
  'title 是本章标题（可沿用蓝图给定标题或在其基础上细化）。所有字符串字段禁止为空。',
].join('\n');

export const CHAPTER_DRAFT_SYSTEM_PROMPT = [
  '你是中文小说正文写作助手。输入是故事蓝图、本章目标、场景计划与创作要求。',
  '你的职责：按场景计划写出这一章的完整正文。',
  '正文必须覆盖场景计划的全部场景，按计划顺序推进，不得跳过场景，也不得写入计划之外的情节。',
  'regenerateAttempt 大于 0 时说明用户否决了上一版草稿，本次必须换一种写法（不同的切入',
  '场景、叙述视角或节奏安排），不得只做措辞层面的微调。',
  PROSE_DISCIPLINE,
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"title":"...","content":"..."}',
  `字段边界：content 为本章完整正文（${MIN_CONTENT_LENGTH}..${MAX_CONTENT_LENGTH} 字符，`,
  '段落之间用换行分隔，不要写章节号或"第X章"以外的元信息）。字符串字段禁止为空。',
].join('\n');

const CRITIC_SYSTEM_PROMPT_HEAD = [
  '你是中文小说的质量审查助手。输入是故事蓝图、本章目标、场景计划与候选正文。',
  '你只审查下面指定的一个维度，不越界评价其它维度。',
];

const CRITIC_SYSTEM_PROMPT_TAIL = [
  '判定标准：只有当问题严重到必须改写才判 needs_rewrite；纯粹的偏好差异判 pass。',
  '判 needs_rewrite 时必须给出至少一条可定位、可执行的问题（excerpt 取自候选正文原文）。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"verdict":"pass"|"needs_rewrite","summary":"...",' +
    '"issues":[{"severity":"minor"|"major","excerpt":"...","problem":"...","suggestion":"..."}]}',
  `字段边界：issues 0..${MAX_ISSUES} 条；excerpt 可为空字符串（表示全篇性问题）；`,
  'summary、problem、suggestion 禁止为空。',
];

const CRITIC_DIMENSIONS: Readonly<Record<string, { role: string; focus: ReadonlyArray<string> }>> =
  {
    [CONTINUITY_CRITIC]: {
      role: 'continuity',
      focus: [
        '审查维度：连续性。检查本章与蓝图设定、人物设定、已确立的事实是否自洽；',
        '人物是否做出与其设定/动机相悖的行为；时间线、地点、道具、称谓是否前后一致；',
        '是否出现蓝图中不存在的重大设定而未作交代。',
      ],
    },
    [STYLE_CRITIC]: {
      role: 'style',
      focus: [
        '审查维度：语言与风格。检查是否有 AI 腔（空泛抒情、机械排比、滥用比喻、',
        '直陈情绪、每段同样节奏）；对白是否有人物区分度；是否有语病、重复用词、',
        '视角混乱；叙述与创作要求声明的语气/风格是否一致。',
      ],
    },
    [REQUIREMENT_CRITIC]: {
      role: 'requirement',
      focus: [
        '审查维度：要求符合度。检查本章是否达成蓝图给定的本章目标；是否覆盖场景计划的',
        '全部场景且未擅自新增计划外情节；是否违反创作要求中的题材、受众、篇幅、禁忌等约束。',
      ],
    },
  };

export function criticSystemPrompt(criticNodeId: string): string {
  const dimension = CRITIC_DIMENSIONS[criticNodeId];
  if (!dimension) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `未知 Critic 节点: ${criticNodeId}`);
  }
  return [...CRITIC_SYSTEM_PROMPT_HEAD, ...dimension.focus, ...CRITIC_SYSTEM_PROMPT_TAIL].join(
    '\n',
  );
}

export const CHAPTER_REWRITE_SYSTEM_PROMPT = [
  '你是中文小说正文改写助手。输入是故事蓝图、本章目标、场景计划、当前候选正文，',
  '以及需要修复的问题清单。',
  '你的职责：在保留候选正文可用部分的前提下，逐条修复问题清单，输出完整的新版正文。',
  '硬约束：必须输出完整正文（不是差异、不是片段、不是修改说明）；不得借改写之机改变',
  '本章目标或引入场景计划之外的情节；未被问题清单点到的段落应尽量保持原样。',
  PROSE_DISCIPLINE,
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"title":"...","content":"..."}',
  `字段边界：content 为本章完整正文（${MIN_CONTENT_LENGTH}..${MAX_CONTENT_LENGTH} 字符）。`,
  '字符串字段禁止为空。',
].join('\n');

// ── 严格解析 ──────────────────────────────────────────────────────

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${what}不是合法 JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${what}不是对象`);
  }
  return parsed as Record<string, unknown>;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  what: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${what}含多余字段: ${key}`);
    }
  }
}

function assertSchemaVersion(obj: Record<string, unknown>, what: string): void {
  if (obj.schemaVersion !== 1) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${what} schemaVersion 必须为 1`);
  }
}

function requireString(value: unknown, field: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string') {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `${field} 长度不足（至少 ${minLength} 字符）`,
    );
  }
  if (trimmed.length > maxLength) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `${field} 超过长度上限 ${maxLength}`);
  }
  return trimmed;
}

export interface ParsedChapterPlan {
  readonly title: string;
  readonly scenes: ReadonlyArray<ChapterScene>;
}

export function parseChapterPlanV1(text: string): ParsedChapterPlan {
  const obj = parseJsonObject(text, '章节场景计划');
  assertExactKeys(obj, ['schemaVersion', 'title', 'scenes'], '章节场景计划');
  assertSchemaVersion(obj, '章节场景计划');
  const title = requireString(obj.title, '章节场景计划 title', MAX_TITLE_LENGTH);
  if (
    !Array.isArray(obj.scenes) ||
    obj.scenes.length < MIN_SCENES ||
    obj.scenes.length > MAX_SCENES
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `章节场景计划 scenes 数量必须在 ${MIN_SCENES}..${MAX_SCENES}`,
    );
  }
  const scenes: ChapterScene[] = obj.scenes.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `场景 ${index} 不是对象`);
    }
    const scene = raw as Record<string, unknown>;
    assertExactKeys(scene, ['summary', 'beats'], `场景 ${index}`);
    const summary = requireString(scene.summary, `场景 ${index} summary`, MAX_SCENE_SUMMARY_LENGTH);
    if (!Array.isArray(scene.beats) || scene.beats.length > MAX_BEATS) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `场景 ${index} beats 非法`);
    }
    const beats = scene.beats.map((beat, beatIndex) =>
      requireString(beat, `场景 ${index} beats[${beatIndex}]`, MAX_SHORT_FIELD_LENGTH),
    );
    return { summary, beats };
  });
  return { title, scenes };
}

export interface ParsedChapterProse {
  readonly title: string;
  readonly content: string;
}

/** DRAFT 与 REWRITE 共用同一输出形状（都是"完整正文"） */
export function parseChapterProseV1(text: string, what: string): ParsedChapterProse {
  const obj = parseJsonObject(text, what);
  assertExactKeys(obj, ['schemaVersion', 'title', 'content'], what);
  assertSchemaVersion(obj, what);
  const title = requireString(obj.title, `${what} title`, MAX_TITLE_LENGTH);
  const content = requireString(
    obj.content,
    `${what} content`,
    MAX_CONTENT_LENGTH,
    MIN_CONTENT_LENGTH,
  );
  return { title, content };
}

export interface ParsedChapterCritique {
  readonly verdict: CritiqueVerdict;
  readonly summary: string;
  readonly issues: ReadonlyArray<ChapterCritiqueIssue>;
}

export function parseChapterCritiqueV1(text: string): ParsedChapterCritique {
  const obj = parseJsonObject(text, '章节审查结论');
  assertExactKeys(obj, ['schemaVersion', 'verdict', 'summary', 'issues'], '章节审查结论');
  assertSchemaVersion(obj, '章节审查结论');
  if (obj.verdict !== 'pass' && obj.verdict !== 'needs_rewrite') {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `章节审查结论 verdict 非法: ${String(obj.verdict)}`,
    );
  }
  const verdict = obj.verdict as CritiqueVerdict;
  const summary = requireString(obj.summary, '章节审查结论 summary', MAX_SUMMARY_LENGTH);
  if (!Array.isArray(obj.issues) || obj.issues.length > MAX_ISSUES) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节审查结论 issues 非法');
  }
  const issues: ChapterCritiqueIssue[] = obj.issues.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `审查问题 ${index} 不是对象`);
    }
    const issue = raw as Record<string, unknown>;
    assertExactKeys(issue, ['severity', 'excerpt', 'problem', 'suggestion'], `审查问题 ${index}`);
    if (issue.severity !== 'minor' && issue.severity !== 'major') {
      throw new TaskExecutionError(
        'MODEL_RESPONSE_INVALID',
        `审查问题 ${index} severity 非法: ${String(issue.severity)}`,
      );
    }
    if (typeof issue.excerpt !== 'string' || issue.excerpt.length > MAX_ISSUE_FIELD_LENGTH) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `审查问题 ${index} excerpt 非法`);
    }
    return {
      severity: issue.severity,
      excerpt: issue.excerpt.trim(),
      problem: requireString(issue.problem, `审查问题 ${index} problem`, MAX_ISSUE_FIELD_LENGTH),
      suggestion: requireString(
        issue.suggestion,
        `审查问题 ${index} suggestion`,
        MAX_ISSUE_FIELD_LENGTH,
      ),
    };
  });
  // needs_rewrite 而无任何问题 = 改写节点拿不到可执行输入，等于让改写空转一轮预算。
  if (verdict === 'needs_rewrite' && issues.length === 0) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      '章节审查结论判 needs_rewrite 时必须给出至少一条问题',
    );
  }
  return { verdict, summary, issues };
}

// ── payload ───────────────────────────────────────────────────────

/** D-B9-2：payload 只承载 prompt 变异提示，不含任何身份字段 */
export interface ChapterTaskPayload {
  /** 图预算 `rewrite` 计数（Critic 判 needs_rewrite 的改写轮次） */
  readonly rewriteAttempt: number;
  /** 图预算 `candidateRewrite` 计数（用户在候选 Gate 请求改写的轮次） */
  readonly candidateRewriteAttempt: number;
  /** 图预算 `regenerate` 计数（用户否决候选后重新起草的轮次） */
  readonly regenerateAttempt: number;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function parseChapterTaskPayload(payloadJson: string): ChapterTaskPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '章节任务 payload 不是合法 JSON');
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return {
    rewriteAttempt: nonNegativeInt(obj.rewriteAttempt),
    candidateRewriteAttempt: nonNegativeInt(obj.candidateRewriteAttempt),
    regenerateAttempt: nonNegativeInt(obj.regenerateAttempt),
  };
}

// ── 上下文装配 ────────────────────────────────────────────────────

export interface ChapterTaskContext {
  readonly projectId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly payload: ChapterTaskPayload;
  readonly blueprint: StoryBlueprint;
  readonly chapter: BlueprintChapter;
  /** 目标章节在蓝图章节序列中的序号（自 1 起；供"前情提要"与"本章位置"） */
  readonly chapterNumber: number;
  /** 蓝图中排在目标章节之前的章节目标（本 run 只写一章，前情以蓝图目标为准） */
  readonly precedingChapters: ReadonlyArray<BlueprintChapter>;
  readonly creationSpec: unknown;
  readonly scenePlan: ChapterScenePlan | null;
  readonly candidate: ChapterCandidate | null;
  readonly critiques: ReadonlyArray<ChapterCritique>;
}

interface ChapterRunBinding {
  readonly creationSpecVersionId: string;
  readonly storyBlueprintId: string;
  readonly blueprintChapterId: string;
}

function readBinding(
  deps: ChapterNodeExecutionDeps,
  graphRunId: string,
  projectId: string,
): ChapterRunBinding {
  const record = deps.graphRunRepo.getById(graphRunId);
  if (!record) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', `章节 run ${graphRunId} 不存在`);
  }
  if (record.kind !== 'chapter') {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', `run ${graphRunId} 不是章节 run`);
  }
  if (record.state.projectId !== projectId) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '章节 run 与任务 project 不匹配');
  }
  const state = record.state as unknown as {
    creationSpecVersionId?: unknown;
    storyBlueprintId?: unknown;
    blueprintChapterId?: unknown;
  };
  if (
    typeof state.creationSpecVersionId !== 'string' ||
    typeof state.storyBlueprintId !== 'string' ||
    typeof state.blueprintChapterId !== 'string'
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '章节 run 缺少 binding');
  }
  return {
    creationSpecVersionId: state.creationSpecVersionId,
    storyBlueprintId: state.storyBlueprintId,
    blueprintChapterId: state.blueprintChapterId,
  };
}

function loadContext(
  deps: ChapterNodeExecutionDeps,
  input: {
    readonly projectId: string;
    readonly graphRunId: string;
    readonly nodeId: string;
    readonly payload: ChapterTaskPayload;
  },
): ChapterTaskContext {
  const binding = readBinding(deps, input.graphRunId, input.projectId);
  const found = deps.blueprintRepo.getById(input.projectId, binding.storyBlueprintId);
  if (!found) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '章节 run 绑定的故事蓝图不存在');
  }
  const blueprint = found.blueprint;
  const chapterIndex = blueprint.chapters.findIndex((c) => c.id === binding.blueprintChapterId);
  if (chapterIndex < 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '故事蓝图中找不到本 run 绑定的章节');
  }
  const specVersion = deps.specVersionRepo.getById(input.projectId, binding.creationSpecVersionId);
  if (!specVersion) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '章节 run 绑定的创作要求版本不存在');
  }
  let creationSpec: unknown;
  try {
    creationSpec = validateCreationContractSections(JSON.parse(specVersion.sectionsJson));
  } catch {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', 'creationSpec sections 损坏');
  }
  const candidate = deps.candidateRepo.getLatestByRun(input.projectId, input.graphRunId);
  const critiques = candidate
    ? deps.critiqueRepo.listByCandidateRevision(
        input.projectId,
        input.graphRunId,
        candidate.revisionNo,
      )
    : [];
  return {
    projectId: input.projectId,
    graphRunId: input.graphRunId,
    nodeId: input.nodeId,
    payload: input.payload,
    blueprint,
    chapter: blueprint.chapters[chapterIndex]!,
    chapterNumber: chapterIndex + 1,
    precedingChapters: blueprint.chapters.slice(0, chapterIndex),
    creationSpec,
    scenePlan: deps.scenePlanRepo.getLatestByRun(input.projectId, input.graphRunId),
    candidate,
    critiques,
  };
}

// ── prompt 构造（确定性序列化）────────────────────────────────────

function blueprintContextPayload(ctx: ChapterTaskContext): Record<string, unknown> {
  return {
    premise: ctx.blueprint.premise,
    world: ctx.blueprint.world,
    conflict: ctx.blueprint.conflict,
    characters: ctx.blueprint.characters,
    relationships: ctx.blueprint.relationships,
    plotlines: ctx.blueprint.plotlines,
    // 结局方向对单章写作是"不得提前泄底"的约束信息，仍需给出，由 prompt 说明用途
    ending: ctx.blueprint.ending,
  };
}

function chapterContextPayload(ctx: ChapterTaskContext): Record<string, unknown> {
  return {
    chapterNumber: ctx.chapterNumber,
    totalChapters: ctx.blueprint.chapters.length,
    title: ctx.chapter.title,
    goal: ctx.chapter.goal,
    precedingChapterGoals: ctx.precedingChapters.map((c) => ({ title: c.title, goal: c.goal })),
  };
}

export function buildChapterPlanPrompt(ctx: ChapterTaskContext): string {
  return JSON.stringify(
    {
      blueprint: blueprintContextPayload(ctx),
      chapter: chapterContextPayload(ctx),
      creationSpec: ctx.creationSpec,
      note: '结局方向仅用于把握伏笔与走向，本章不得提前写出结局。',
    },
    null,
    2,
  );
}

export function buildChapterDraftPrompt(ctx: ChapterTaskContext): string {
  return JSON.stringify(
    {
      blueprint: blueprintContextPayload(ctx),
      chapter: chapterContextPayload(ctx),
      creationSpec: ctx.creationSpec,
      scenePlan: ctx.scenePlan
        ? { title: ctx.scenePlan.title, scenes: ctx.scenePlan.scenes }
        : null,
      regenerateAttempt: ctx.payload.regenerateAttempt,
      note: '结局方向仅用于把握伏笔与走向，本章不得提前写出结局。',
    },
    null,
    2,
  );
}

export function buildChapterCritiquePrompt(ctx: ChapterTaskContext): string {
  if (!ctx.candidate) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '审查任务缺少候选正文');
  }
  return JSON.stringify(
    {
      blueprint: blueprintContextPayload(ctx),
      chapter: chapterContextPayload(ctx),
      creationSpec: ctx.creationSpec,
      scenePlan: ctx.scenePlan
        ? { title: ctx.scenePlan.title, scenes: ctx.scenePlan.scenes }
        : null,
      candidate: { title: ctx.candidate.title, content: ctx.candidate.content },
      rewriteAttempt: ctx.payload.rewriteAttempt,
    },
    null,
    2,
  );
}

export function buildChapterRewritePrompt(ctx: ChapterTaskContext): string {
  if (!ctx.candidate) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '改写任务缺少候选正文');
  }
  // D-B9-6：用户在候选 Gate 点"请求改写"时无法附意见（图的 candidate_gate 决策 DTO 无
  // feedback 字段，与 TD-029-1 蓝图侧同病）——此处如实告知模型"本轮改写由用户发起但
  // 未附具体意见"，不得伪造一条用户意见。承载 feedback 属 B10 UI 批次。
  const userRequestedRewrite = ctx.payload.candidateRewriteAttempt > 0;
  return JSON.stringify(
    {
      blueprint: blueprintContextPayload(ctx),
      chapter: chapterContextPayload(ctx),
      creationSpec: ctx.creationSpec,
      scenePlan: ctx.scenePlan
        ? { title: ctx.scenePlan.title, scenes: ctx.scenePlan.scenes }
        : null,
      candidate: { title: ctx.candidate.title, content: ctx.candidate.content },
      critiques: ctx.critiques.map((c) => ({
        dimension: CRITIC_DIMENSIONS[c.criticNodeId]?.role ?? c.criticNodeId,
        verdict: c.verdict,
        summary: c.summary,
        issues: c.issues,
      })),
      rewriteAttempt: ctx.payload.rewriteAttempt,
      userRequestedRewrite,
      userFeedback: null,
      note: userRequestedRewrite
        ? '本轮改写由用户在候选确认环节发起，用户未附具体意见；请按问题清单与创作要求提升整体质量。'
        : '本轮改写由质量审查发起，请逐条修复问题清单。',
    },
    null,
    2,
  );
}

// ── 共享执行骨架 ──────────────────────────────────────────────────

interface ChapterTaskSpec<P> {
  readonly taskType: TaskType;
  readonly requestKind: string;
  readonly maxTokens?: number;
  systemPrompt(ctx: ChapterTaskContext): string;
  buildPrompt(ctx: ChapterTaskContext): string;
  parse(text: string): P;
  /** 在最终事务内执行：持久化领域行，返回 envelope / task.result 所需摘要 */
  persist(ctx: ChapterTaskContext, parsed: P, now: string): ChapterPersistResult;
}

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

function failedResult(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
  invocationId: string | null,
): ChapterNodeExecutionResult {
  return {
    task: deps.taskRepo.getById(taskId)!,
    invocation: invocationId ? deps.invocationRepo.getById(invocationId) : null,
    persisted: null,
  };
}

/** claim 之后的确定性失败：invocation（若已建）+ task 同事务标记 FAILED */
function failAfterClaim(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
  invocationId: string | null,
  code: string,
  message: string,
  latencyMs: number | null,
): void {
  deps.transaction(() => {
    if (invocationId) {
      requireCas(
        deps.invocationRepo.markFailed(invocationId, ['RUNNING'], code, message, latencyMs),
        '无法标记调用失败',
      );
    }
    // task 错误码统一为 TASK_EXECUTION_FAILED（与 blueprint/research/spec-extract 一致）：
    // 具体成因记在 invocation 的错误码上；node-runner 只用 task 错误码判断
    // "是不是基础设施中断"，业务性失败一律非 infra retryable。
    requireCas(
      deps.taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
      '无法标记任务失败',
    );
  });
}

async function runChapterModelTask<P>(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
  spec: ChapterTaskSpec<P>,
): Promise<ChapterNodeExecutionResult> {
  const { taskRepo, invocationRepo, secretStore, providerRepo, idGenerator, invokeModel } = deps;

  const task = taskRepo.getById(taskId);
  if (!task) throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.taskType !== spec.taskType) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  const payload = parseChapterTaskPayload(task.payloadJson);

  // ── claim 前配置校验（缺配置不增 attempt，任务保持 PENDING 等用户配置后重驱动）──
  let profile;
  try {
    profile = resolveProviderForTask({ providerRepo }, task.taskType);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new TaskExecutionError('PROVIDER_NOT_CONFIGURED', '模型提供商未配置');
    }
    throw err;
  }
  if (!isProviderProtocol(profile.providerType)) {
    throw new TaskExecutionError('PROVIDER_NOT_CONFIGURED', '模型提供商协议不合法');
  }
  const protocol: ProviderProtocol = profile.providerType;

  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    throw new TaskExecutionError('API_KEY_READ_FAILED', '无法读取 API Key');
  }
  if (!apiKey) throw new TaskExecutionError('API_KEY_REQUIRED', '请先配置 API Key');

  if (!deps.nodeExecutionResultStore) {
    throw new TaskExecutionError(
      'TASK_EXECUTION_FAILED',
      'task-backed 执行缺少 nodeExecutionResultStore（无法持久化产物）',
    );
  }
  const nodeExecutionResultStore = deps.nodeExecutionResultStore;

  if (!taskRepo.claimPending(taskId)) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
  }

  // ── 权威 execution context（从 DB 反查，不信任调用方手拼 context）──
  const execution = deps.nodeExecutionRepo.getByTaskId(taskId);
  if (!execution) {
    deps.transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_NOT_BOUND', '任务未绑定 node execution'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }

  // ── 上下文装配（全部从权威存储反查）──
  let ctx: ChapterTaskContext;
  let systemPrompt: string;
  let prompt: string;
  try {
    ctx = loadContext(deps, {
      projectId: task.projectId,
      graphRunId: execution.graphRunId,
      nodeId: execution.nodeId,
      payload,
    });
    systemPrompt = spec.systemPrompt(ctx);
    prompt = spec.buildPrompt(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : '章节任务上下文装配失败';
    failAfterClaim(deps, taskId, null, 'TASK_EXECUTION_FAILED', message, null);
    return failedResult(deps, taskId, null);
  }

  const updatedTask = taskRepo.getById(taskId)!;
  const invocationId = idGenerator.generate();
  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: spec.requestKind,
    promptHash: sha256Hex(prompt),
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      nodeId: execution.nodeId,
      rewriteAttempt: payload.rewriteAttempt,
      candidateRewriteAttempt: payload.candidateRewriteAttempt,
      regenerateAttempt: payload.regenerateAttempt,
    }),
  });
  deps.transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  const result = await invokeModel({
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey,
    prompt,
    systemPrompt,
    protocol,
    ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : '模型调用异常';
    failAfterClaim(deps, taskId, invocationId, 'PROVIDER_CONNECTION_FAILED', message, null);
    return { failed: true as const };
  });
  if ('failed' in result) return failedResult(deps, taskId, invocationId);

  if (result.errorCode) {
    failAfterClaim(
      deps,
      taskId,
      invocationId,
      result.errorCode,
      result.errorMessage ?? '模型调用失败',
      result.latencyMs,
    );
    return failedResult(deps, taskId, invocationId);
  }

  let parsed: P;
  try {
    parsed = spec.parse(result.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : '模型输出解析失败';
    failAfterClaim(deps, taskId, invocationId, 'MODEL_RESPONSE_INVALID', message, result.latencyMs);
    return failedResult(deps, taskId, invocationId);
  }

  const now = deps.clock.now();

  // ── 最终事务：领域行落库 + execution-bound envelope + invocation/task 终态 ──
  let persisted!: ChapterPersistResult;
  try {
    deps.transaction(() => {
      persisted = spec.persist(ctx, parsed, now);
      nodeExecutionResultStore.saveOrVerifySame({
        executionId: execution.id,
        projectId: task.projectId,
        graphRunId: execution.graphRunId,
        nodeId: execution.nodeId,
        taskId,
        activationNo: execution.activationNo,
        attemptNo: execution.attemptNo,
        executorId: execution.executorId,
        executorVersion: execution.executorVersion,
        inputHash: execution.inputHash,
        artifactKind: persisted.artifactKind,
        artifactId: persisted.artifactId,
        artifactVersion: persisted.artifactVersion,
        contentJson: persisted.contentJson,
        outcome: persisted.outcome,
        createdAt: now,
      });
      requireCas(
        invocationRepo.markSucceeded(invocationId, 'RUNNING', {
          responseMetadataJson: JSON.stringify({
            finishReason: result.finishReason ?? null,
            providerRequestId: result.providerRequestId ?? null,
          }),
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          cacheReadTokens: result.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
          totalTokens: result.usage?.totalTokens ?? null,
          latencyMs: result.latencyMs ?? null,
          finishReason: result.finishReason ?? null,
          providerRequestId: result.providerRequestId ?? null,
        }),
        '无法标记调用成功',
      );
      requireCas(taskRepo.completeRunning(taskId, persisted.resultJson), '无法标记任务完成');
    });
  } catch (err) {
    compensateFinalization(deps, taskId, invocationId, '任务最终提交失败，已补偿标记失败');
    throw err;
  }

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    persisted,
  };
}

// ── 四个执行器 ────────────────────────────────────────────────────

/** CHAPTER_PLAN：产出场景计划（内部 artifact；图契约 noOut，envelope 无 artifact 无 outcome） */
export async function executeChapterPlan(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
): Promise<ChapterNodeExecutionResult> {
  return runChapterModelTask<ParsedChapterPlan>(deps, taskId, {
    taskType: 'CHAPTER_PLAN',
    requestKind: 'chapter_plan',
    systemPrompt: () => CHAPTER_PLAN_SYSTEM_PROMPT,
    buildPrompt: buildChapterPlanPrompt,
    parse: parseChapterPlanV1,
    persist: (ctx, parsed, now) => {
      const plan = createChapterScenePlan({
        id: deps.idGenerator.generate(),
        projectId: ctx.projectId,
        graphRunId: ctx.graphRunId,
        blueprintChapterId: ctx.chapter.id,
        title: parsed.title,
        scenes: parsed.scenes,
        createdAt: now,
      });
      deps.scenePlanRepo.save(plan);
      return {
        artifactKind: null,
        artifactId: null,
        artifactVersion: null,
        contentJson: JSON.stringify({ kind: 'chapterScenePlan', plan }),
        outcome: null,
        resultJson: JSON.stringify({ scenePlanId: plan.id, sceneCount: plan.scenes.length }),
      };
    },
  });
}

/**
 * DRAFT：产出候选修订（source=DRAFT），同时是 Graph `generationRun` artifact。
 * artifactVersion 取该修订号——同 run 内单调递增，regenerate 循环的每一版都有不同版本号。
 */
export async function executeChapterDraftNode(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
): Promise<ChapterNodeExecutionResult> {
  return runChapterModelTask<ParsedChapterProse>(deps, taskId, {
    taskType: 'CHAPTER_DRAFT',
    requestKind: 'chapter_draft',
    maxTokens: PROSE_MAX_TOKENS,
    systemPrompt: () => CHAPTER_DRAFT_SYSTEM_PROMPT,
    buildPrompt: buildChapterDraftPrompt,
    parse: (text) => parseChapterProseV1(text, '章节草稿'),
    persist: (ctx, parsed, now) => {
      const revisionNo = deps.candidateRepo.getMaxRevisionNo(ctx.projectId, ctx.graphRunId) + 1;
      const artifactId = deps.idGenerator.generate();
      const candidate = createChapterCandidate({
        id: artifactId,
        projectId: ctx.projectId,
        graphRunId: ctx.graphRunId,
        revisionNo,
        source: 'DRAFT',
        artifactId,
        title: parsed.title,
        content: parsed.content,
        createdAt: now,
      });
      deps.candidateRepo.save(candidate);
      return {
        artifactKind: 'generationRun',
        artifactId,
        artifactVersion: revisionNo,
        contentJson: JSON.stringify({ kind: 'generationRun', candidate }),
        outcome: null,
        resultJson: JSON.stringify({
          candidateId: candidate.id,
          revisionNo,
          contentLength: candidate.content.length,
        }),
      };
    },
  });
}

/**
 * 三个 Critic 共用：角色由权威 `execution.nodeId` 派生（D-B9-3）。
 * 产出 outcome `critique_verdict`，无 artifact（图契约 out('critique_verdict', null)）。
 */
export async function executeChapterCritique(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
): Promise<ChapterNodeExecutionResult> {
  return runChapterModelTask<ParsedChapterCritique>(deps, taskId, {
    taskType: 'CHAPTER_CRITIQUE',
    requestKind: 'chapter_critique',
    systemPrompt: (ctx) => criticSystemPrompt(ctx.nodeId),
    buildPrompt: buildChapterCritiquePrompt,
    parse: parseChapterCritiqueV1,
    persist: (ctx, parsed, now) => {
      if (!ctx.candidate) {
        throw new TaskExecutionError('TASK_EXECUTION_FAILED', '审查任务缺少候选正文');
      }
      const critique = createChapterCritique({
        id: deps.idGenerator.generate(),
        projectId: ctx.projectId,
        graphRunId: ctx.graphRunId,
        candidateRevisionNo: ctx.candidate.revisionNo,
        criticNodeId: ctx.nodeId,
        verdict: parsed.verdict,
        summary: parsed.summary,
        issues: parsed.issues,
        createdAt: now,
      });
      deps.critiqueRepo.save(critique);
      return {
        artifactKind: null,
        artifactId: null,
        artifactVersion: null,
        contentJson: JSON.stringify({ kind: 'chapterCritique', critique }),
        outcome: { condition: 'critique_verdict', value: parsed.verdict },
        resultJson: JSON.stringify({
          critiqueId: critique.id,
          verdict: critique.verdict,
          issueCount: critique.issues.length,
        }),
      };
    },
  });
}

/** REWRITE：产出候选修订（source=REWRITE）；图契约 noOut —— 不产生新 artifact、无 outcome */
export async function executeChapterRewrite(
  deps: ChapterNodeExecutionDeps,
  taskId: string,
): Promise<ChapterNodeExecutionResult> {
  return runChapterModelTask<ParsedChapterProse>(deps, taskId, {
    taskType: 'CHAPTER_REWRITE',
    requestKind: 'chapter_rewrite',
    maxTokens: PROSE_MAX_TOKENS,
    systemPrompt: () => CHAPTER_REWRITE_SYSTEM_PROMPT,
    buildPrompt: buildChapterRewritePrompt,
    parse: (text) => parseChapterProseV1(text, '章节改写稿'),
    persist: (ctx, parsed, now) => {
      const revisionNo = deps.candidateRepo.getMaxRevisionNo(ctx.projectId, ctx.graphRunId) + 1;
      const candidate = createChapterCandidate({
        id: deps.idGenerator.generate(),
        projectId: ctx.projectId,
        graphRunId: ctx.graphRunId,
        revisionNo,
        source: 'REWRITE',
        artifactId: null,
        title: parsed.title,
        content: parsed.content,
        createdAt: now,
      });
      deps.candidateRepo.save(candidate);
      return {
        artifactKind: null,
        artifactId: null,
        artifactVersion: null,
        contentJson: JSON.stringify({ kind: 'chapterRewrite', candidate }),
        outcome: null,
        resultJson: JSON.stringify({
          candidateId: candidate.id,
          revisionNo,
          contentLength: candidate.content.length,
        }),
      };
    },
  });
}

/** 供 worker dispatch 使用的 Critic 节点集合（与图定义一致） */
export const CRITIC_NODE_IDS: ReadonlyArray<string> = [
  CONTINUITY_CRITIC,
  STYLE_CRITIC,
  REQUIREMENT_CRITIC,
];
