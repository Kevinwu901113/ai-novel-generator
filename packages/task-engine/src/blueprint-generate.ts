/**
 * BLUEPRINT_GENERATE 任务执行器（GE-5 / B7，设计见 docs/development/b7-blueprint-wiring-design.md）。
 *
 * 骨架照 research-run.ts：payload 严格解析 → claim 前配置校验（照 spec-extract.ts，
 * provider + API key，无 search key）→ claimPending → 权威 execution 反查 → 上下文装配
 * → 模型调用 → 严格解析（D-B7-6）→ 最终事务（bundle 落库 + envelope + invocation/task
 * 终态，全有或全无）→ 补偿。
 *
 * - BLUEPRINT_GENERATE 与 RESEARCH_EXECUTE 同为 artifact-only 节点（图契约
 *   `out(null,'storyBlueprint')`）：envelope `outcome: null`；
 * - D-B7-5：版本号在本执行器的最终事务内取该项目现有 `MAX(version) + 1`
 *   （`StoryBlueprintRepositoryPort.getMaxVersion`），与 envelope 的 `artifactVersion`
 *   保持同事务一致（resolver 会校验两者相等）；
 * - D-B7-7：`researchBundleId` 为 null 时（`research_decision=none` 或
 *   `skip_research` 升级路径）prompt 显式声明"本项目未做调研"，不得把缺失伪装成空调研；
 * - D-B7-13：B6 交付的来源排除（`research_source_exclusions`）在此闭合——此前没有任何
 *   消费方，用户排除来源后蓝图照样把它当依据（用户可见的空承诺）。装配 prompt 时读取
 *   该项目的排除集合，过滤 bundle 内容；**不改 bundle 行本身**（artifact 不可变，
 *   D-B5-2 行链语义），只影响本次 prompt 的可见内容。见 `filterResearchForPrompt`；
 * - D-B7-4：改写循环无 feedback 承载（TD-029-1），仅用 `rewriteAttempt`
 *   （snapshot 里 `budget.blueprintRewrite` 计数）告知模型"这是第 N 次改写，需产出
 *   实质不同的蓝图"。
 */

import type {
  CreationContractVersionRepositoryPort,
  GrillSessionRepositoryPort,
  ModelInvocationData,
  NodeExecutionRepositoryPort,
  ResearchBundleRepositoryPort,
  ResearchSourceExclusionRepositoryPort,
  StoryBlueprintRepositoryPort,
  TaskData,
} from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import {
  createStoryBlueprint,
  validateCreationContractSections,
  type BlueprintCharacter,
  type BlueprintChapter,
  type BlueprintPlotline,
  type StoryBlueprint,
} from '@ai-novel/domain';
import type { ResearchBundle } from '@ai-novel/research-engine';
import { sha256Hex, TaskExecutionError, type TaskEngineDeps } from './index.js';
import { compensateFinalization } from './chapter-generation.js';

// ── deps / 类型 ───────────────────────────────────────────────────

export interface BlueprintGenerateExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly specVersionRepo: CreationContractVersionRepositoryPort;
  readonly researchRepo: ResearchBundleRepositoryPort;
  readonly blueprintRepo: StoryBlueprintRepositoryPort;
  /** D-B7-13：project 级来源排除读端口（B6 交付；此前无消费方） */
  readonly sourceExclusionRepo: ResearchSourceExclusionRepositoryPort;
}

export interface BlueprintGenerateExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly blueprintId: string | null;
  readonly version: number | null;
  readonly chapterCount: number;
}

// ── 常量（D-B7-6：模型输出解析边界）────────────────────────────────

const MIN_CHARACTERS = 1;
const MAX_CHARACTERS = 50;
const MAX_RELATIONSHIPS = 100;
const MIN_PLOTLINES = 1;
const MAX_PLOTLINES = 20;
const MIN_CHAPTERS = 1;
const MAX_CHAPTERS = 200;
const MAX_CHAPTER_GOAL_LENGTH = 500;
const MAX_CHAPTER_TITLE_LENGTH = 200;
const MAX_LONG_FIELD_LENGTH = 4000;
const MAX_SHORT_FIELD_LENGTH = 300;

export const BLUEPRINT_GENERATE_SYSTEM_PROMPT = [
  '你是小说故事蓝图生成助手。输入是创作想法、创作要求，以及（若有）调研资料。',
  '你的职责：产出完整的故事蓝图，至少包含核心前提、主角与关键人物、主要关系、世界背景、',
  '主要冲突、结局方向、主要情节线、章节结构与每章目标。',
  '若 rewriteAttempt 大于 0，说明用户对上一版蓝图请求了改写，本次必须产出实质不同的蓝图',
  '（更换叙事角度、结构安排或核心冲突的处理方式），不得只做措辞层面的微调。',
  '若调研信息标注 conducted=false，说明本项目未做事实调研，蓝图不得依赖具体的事实性',
  '细节（真实地名、机构、技术数据等），应基于创作要求自由设定自洽的虚构世界观。',
  'conducted=true 且 availableAfterExclusion=false 时，写作策略与 conducted=false 相同——',
  '不得依赖具体事实性细节；reason 字段说明具体原因（不改变写作策略，但改变你对上下文的',
  '理解）：reason=skipped_by_user 表示用户已审阅调研结果，主动决定不采用（这是用户的',
  '明确决定，调研本身是做过的，不是失败也不是被排除，不得说成"未做调研"）；',
  'reason=no_sources_gathered 表示调研已执行但未获得任何可用来源（抓取失败等，与任何人',
  '的排除操作无关）；reason=all_sources_excluded 表示原本获得了来源，但用户已将其全部排除。',
  'conducted=true 且 availableAfterExclusion=true 时应参考给出的调研结论与事实笔记，',
  '保持设定与事实一致；factNotes/questions 中出现的来源已是用户排除后的剩余集合，',
  '某个 question 的 sources 为空数组时说明该问题当前没有可用来源（可能被排除），仅供',
  '了解调研意图，不得为其杜撰事实性来源。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"premise":"...","characters":[{"name":"...","role":"...","description":"..."}],' +
    '"relationships":["..."],"world":"...","conflict":"...","ending":"...",' +
    '"plotlines":[{"name":"...","summary":"..."}],"chapters":[{"title":"...","goal":"..."}]}',
  `字段边界：characters ${MIN_CHARACTERS}..${MAX_CHARACTERS} 个；relationships 0..${MAX_RELATIONSHIPS} 条` +
    `（可为空数组）；plotlines ${MIN_PLOTLINES}..${MAX_PLOTLINES} 条；` +
    `chapters ${MIN_CHAPTERS}..${MAX_CHAPTERS} 章，每章 goal 不超过 ${MAX_CHAPTER_GOAL_LENGTH} 字。`,
  '除 relationships 外全部字符串字段禁止为空。',
].join('\n');

// ── prompt 构造 ───────────────────────────────────────────────────

export interface BlueprintFactNoteContext {
  readonly text: string;
  readonly sourceUrls: ReadonlyArray<string>;
}

export interface BlueprintQuestionContext {
  readonly text: string;
  readonly sources: ReadonlyArray<{ readonly url: string; readonly title: string }>;
}

export interface BlueprintResearchContext {
  readonly conclusion: string;
  readonly factNotes: ReadonlyArray<BlueprintFactNoteContext>;
  readonly questions: ReadonlyArray<BlueprintQuestionContext>;
}

/**
 * D-B7-13：来源排除消费点——按项目排除集合过滤 bundle 内容，**只影响本次 prompt 的
 * 可见内容，不修改 bundle 行**（bundle 是不可变 artifact，D-B5-2 行链语义；排除是
 * project 级、跨版本生效，见 research.ts 里 ResearchSourceExclusionRepositoryPort
 * 的注释）。
 *
 * 规则（BLK-1 复查修复，整条剔除语义）：
 * - factNotes：**只要笔记引用的来源中有任意一个被排除，整条笔记（含 text）一起剔除**；
 *   完全未涉及排除来源的笔记原样保留。
 *   —— 原因：`factNote.text` 是 research-engine orchestrator 按问题把该问题下**全部**
 *   抓取文档正文拼接而成的聚合体（见 orchestrator.ts 的 `noteText`），并非逐来源可
 *   分割的内容；light/deep 抓取本就是多来源常态。若只按 URL 裁剪 `sourceUrls` 而
 *   `text` 原样透传，被排除来源的正文仍会整段留在 prompt 里，且被错误地重新归属给
 *   幸存来源——排除动作从"看得见"变成"看不见"，用户的排除决定没有真正生效。
 *   因此"任一来源被排除即整条剔除"是与"text 不可拆分"这一数据模型自洽的唯一正确
 *   语义；代价是幸存来源的内容也会随之消失，但这是保守但正确的选择；
 * - questions[].sources：与 factNotes 不同，每条 source 只是独立的 `{url, title}`
 *   记录、彼此不聚合正文，因此仍按来源逐条过滤（不适用整条剔除规则）；过滤后变空的
 *   问题本身仍保留（问题文本仍是有效的调研意图），prompt 里以空数组体现"当前无可用
 *   来源"（系统提示词已说明该语义，见 BLUEPRINT_GENERATE_SYSTEM_PROMPT）。
 *
 * 措辞选择：被排除的来源**直接不出现**在 prompt 里，而不是列出来源后加"已排除、
 * 不得作为依据"这类说明——理由：一旦把排除来源的 URL/标题送进模型上下文，就不再是
 * "模型没见过"而是"模型见过但被告知不要用"，对指令遵循能力较弱的模型这道防线更脆弱
 * （更容易被后续改写/越狱式追问带出来）；直接不出现是更强的边界，且实现更简单。
 *
 * 返回 null 表示过滤后已无任何可用事实笔记——即"做过调研但被排空"，与 D-B7-7 的
 * "根本没做调研"是两种不同语义，调用方需要分别措辞（不能都说成 conducted=false）。
 */
export function filterResearchForPrompt(
  bundle: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'>,
  excludedUrls: ReadonlySet<string>,
): BlueprintResearchContext | null {
  const factNotes: BlueprintFactNoteContext[] = bundle.factNotes
    .filter((note) => note.sourceUrls.every((url) => !excludedUrls.has(url)))
    .map((note) => ({ text: note.text, sourceUrls: note.sourceUrls }));

  if (factNotes.length === 0) return null;

  const questions: BlueprintQuestionContext[] = bundle.questions.map((question) => ({
    text: question.text,
    sources: question.sources
      .filter((source) => !excludedUrls.has(source.url))
      .map((source) => ({ url: source.url, title: source.title })),
  }));

  return { conclusion: bundle.conclusion, factNotes, questions };
}

/**
 * 把（可能为 null 的）bundle + 排除集合归类为四态之一（见 `BlueprintResearchInput`）。
 * 抽成独立纯函数是为了让"零 factNotes（no_sources_gathered）"与"过滤后清空
 * （all_excluded）"这两种此前会被误判为同一句话的情形可以脱离完整 executor / DB
 * 独立单测（BLK-2 附带修复）。
 */
export function classifyResearchInput(
  bundle: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> | null,
  excludedUrls: ReadonlySet<string>,
): BlueprintResearchInput {
  if (bundle === null) return { status: 'not_conducted' };
  const filtered = filterResearchForPrompt(bundle, excludedUrls);
  if (filtered !== null) return { status: 'available', context: filtered };
  if (bundle.factNotes.length === 0) {
    // bundle 本身一条事实笔记都没有（典型成因是抓取全失败），与任何排除操作无关——
    // 不得说成"用户已将全部可用来源排除"（对模型说假话）。
    return { status: 'no_sources_gathered' };
  }
  // bundle 原本有事实笔记，是过滤（排除）把它们清空的，才是真正的"全部被排除"。
  return { status: 'all_excluded' };
}

/**
 * 蓝图 prompt 的调研输入态（BLK-2 附带修复 + D-B7-14：把"无可用事实笔记"拆成互不
 * 相同的原因,不能都说成同一句话）：
 * - `not_conducted`：根本没做调研（`research_decision=none`）；
 * - `skipped_by_user`（D-B7-14）：调研做过（bundle 存在），但用户在调研升级面板
 *   审阅后主动选择 `skip_research`——这是用户的明确决定，不是调研失败也不是来源
 *   被排除，措辞必须与另外两种"无可用内容"态区分开，不得说成"未做调研"；
 * - `no_sources_gathered`：做过调研，但 bundle 本身一条事实笔记都没获得
 *   （抓取全失败——这正是走到 RESEARCH_ESCALATION 的典型成因），与任何人的排除操作
 *   无关；此前的实现会把这种情况也标成"用户已将全部可用来源排除"，对模型说了假话
 *   （bundle.factNotes 为 0 时压根没有"来源"可供排除）；
 * - `all_excluded`：做过调研且原本有事实笔记，但用户通过来源排除 UI 把它们全部排除；
 * - `available`：过滤后仍有可用事实笔记。
 *
 * 四种"无可用内容"态对模型的写作策略要求相同（不得依赖具体事实性细节），但措辞各自
 * 如实，不相互冒充。
 */
export type BlueprintResearchInput =
  | { readonly status: 'not_conducted' }
  | { readonly status: 'skipped_by_user' }
  | { readonly status: 'no_sources_gathered' }
  | { readonly status: 'all_excluded' }
  | { readonly status: 'available'; readonly context: BlueprintResearchContext };

/** 用户消息（确定性序列化）。D-B7-7：无调研时显式标注 conducted=false，不伪装成空调研。 */
export function buildBlueprintGeneratePrompt(context: {
  readonly idea: string;
  readonly creationSpecSummary: unknown;
  readonly research: BlueprintResearchInput;
  readonly rewriteAttempt: number;
}): string {
  let researchPayload: unknown;
  if (context.research.status === 'not_conducted') {
    researchPayload = { conducted: false as const };
  } else if (context.research.status === 'skipped_by_user') {
    researchPayload = {
      conducted: true as const,
      availableAfterExclusion: false as const,
      reason: 'skipped_by_user' as const,
    };
  } else if (context.research.status === 'no_sources_gathered') {
    researchPayload = {
      conducted: true as const,
      availableAfterExclusion: false as const,
      reason: 'no_sources_gathered' as const,
    };
  } else if (context.research.status === 'all_excluded') {
    researchPayload = {
      conducted: true as const,
      availableAfterExclusion: false as const,
      reason: 'all_sources_excluded' as const,
    };
  } else {
    researchPayload = {
      conducted: true as const,
      availableAfterExclusion: true as const,
      conclusion: context.research.context.conclusion,
      factNotes: context.research.context.factNotes,
      questions: context.research.context.questions,
    };
  }
  return [
    '以下是创作想法、创作要求与调研信息（JSON）：',
    JSON.stringify({
      idea: context.idea,
      creationSpec: context.creationSpecSummary,
      research: researchPayload,
      rewriteAttempt: context.rewriteAttempt,
    }),
    '',
    context.rewriteAttempt > 0
      ? `这是第 ${context.rewriteAttempt} 次改写，必须产出与之前实质不同的蓝图。`
      : '现在输出结果 JSON。',
  ].join('\n');
}

// ── payload 解析 ──────────────────────────────────────────────────

interface BlueprintGeneratePayload {
  readonly ideaSessionId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string | null;
  /** D-B7-14：用户在 RESEARCH_ESCALATION 显式选择 skip_research（与 researchBundleId
   * 缺失的"根本没做调研"区分开，见 executeBlueprintGenerate 里的 research 分支）。 */
  readonly researchSkippedByUser: boolean;
  readonly rewriteAttempt: number;
}

/** 严格解析任务 payload：exact keys（镜像 spec-extract / research-run parsePayload 纪律） */
function parsePayload(payloadJson: string): BlueprintGeneratePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  const obj = parsed as Record<string, unknown>;
  const expected = [
    'creationSpecVersionId',
    'ideaSessionId',
    'researchBundleId',
    'researchSkippedByUser',
    'rewriteAttempt',
  ];
  const keys = Object.keys(obj).sort();
  if (keys.length !== expected.length || !expected.every((k) => k in obj)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (typeof obj.ideaSessionId !== 'string' || obj.ideaSessionId.trim().length === 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (
    typeof obj.creationSpecVersionId !== 'string' ||
    obj.creationSpecVersionId.trim().length === 0
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (
    obj.researchBundleId !== null &&
    (typeof obj.researchBundleId !== 'string' || obj.researchBundleId.length === 0)
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (typeof obj.researchSkippedByUser !== 'boolean') {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (obj.researchSkippedByUser === true && obj.researchBundleId !== null) {
    // researchSkippedByUser=true 时 prepareTask 恒不传 researchBundleId（见
    // blueprint-executors.ts）；两者同时出现说明 payload 被破坏或伪造，fail-closed。
    throw new TaskExecutionError(
      'TASK_EXECUTION_FAILED',
      '任务 payload 不一致：跳过调研却携带 bundle 引用',
    );
  }
  if (
    typeof obj.rewriteAttempt !== 'number' ||
    !Number.isInteger(obj.rewriteAttempt) ||
    obj.rewriteAttempt < 0
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload rewriteAttempt 非法');
  }
  return {
    ideaSessionId: obj.ideaSessionId,
    creationSpecVersionId: obj.creationSpecVersionId,
    researchBundleId: obj.researchBundleId as string | null,
    researchSkippedByUser: obj.researchSkippedByUser,
    rewriteAttempt: obj.rewriteAttempt,
  };
}

// ── 模型输出解析（D-B7-6）───────────────────────────────────────────

/** 解析出的蓝图（chapters 尚无 id——由 executor 在最终事务内分配，见 D-B7-5 附近说明） */
export interface ParsedBlueprintGenerate {
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotline>;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly goal: string }>;
}

function isNonEmptyBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function requireExactKeys(
  obj: Record<string, unknown>,
  expected: ReadonlyArray<string>,
  errorMessage: string,
): void {
  const keys = Object.keys(obj).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || !sortedExpected.every((k, i) => k === keys[i])) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', errorMessage);
  }
}

/** 严格解析模型输出：exact top-level keys + 逐字段类型/长度/数量边界；越界一律 MODEL_RESPONSE_INVALID */
export function parseBlueprintGenerateV1(text: string): ParsedBlueprintGenerate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  requireExactKeys(
    obj,
    [
      'schemaVersion',
      'premise',
      'characters',
      'relationships',
      'world',
      'conflict',
      'ending',
      'plotlines',
      'chapters',
    ],
    '蓝图生成结果顶层字段不符',
  );
  if (obj.schemaVersion !== 1) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果 schemaVersion 不符');
  }
  if (!isNonEmptyBoundedString(obj.premise, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 premise 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.world, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 world 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.conflict, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 conflict 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.ending, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 ending 越界或为空');
  }

  if (
    !Array.isArray(obj.characters) ||
    obj.characters.length < MIN_CHARACTERS ||
    obj.characters.length > MAX_CHARACTERS
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `characters 数须为 ${MIN_CHARACTERS}..${MAX_CHARACTERS}`,
    );
  }
  const characters: BlueprintCharacter[] = obj.characters.map((c) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'character 条目结构无效');
    }
    const rec = c as Record<string, unknown>;
    requireExactKeys(rec, ['name', 'role', 'description'], 'character 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.name, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.role, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.description, MAX_LONG_FIELD_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'character 字段内容越界或为空');
    }
    return { name: rec.name, role: rec.role, description: rec.description };
  });

  if (!Array.isArray(obj.relationships) || obj.relationships.length > MAX_RELATIONSHIPS) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `relationships 数不得超过 ${MAX_RELATIONSHIPS}`,
    );
  }
  const relationships: string[] = obj.relationships.map((r) => {
    if (!isNonEmptyBoundedString(r, MAX_SHORT_FIELD_LENGTH)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'relationship 条目内容越界或为空');
    }
    return r;
  });

  if (
    !Array.isArray(obj.plotlines) ||
    obj.plotlines.length < MIN_PLOTLINES ||
    obj.plotlines.length > MAX_PLOTLINES
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `plotlines 数须为 ${MIN_PLOTLINES}..${MAX_PLOTLINES}`,
    );
  }
  const plotlines: BlueprintPlotline[] = obj.plotlines.map((p) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'plotline 条目结构无效');
    }
    const rec = p as Record<string, unknown>;
    requireExactKeys(rec, ['name', 'summary'], 'plotline 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.name, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.summary, MAX_LONG_FIELD_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'plotline 字段内容越界或为空');
    }
    return { name: rec.name, summary: rec.summary };
  });

  if (
    !Array.isArray(obj.chapters) ||
    obj.chapters.length < MIN_CHAPTERS ||
    obj.chapters.length > MAX_CHAPTERS
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `chapters 数须为 ${MIN_CHAPTERS}..${MAX_CHAPTERS}`,
    );
  }
  const chapters = obj.chapters.map((c) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'chapter 条目结构无效');
    }
    const rec = c as Record<string, unknown>;
    requireExactKeys(rec, ['title', 'goal'], 'chapter 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.title, MAX_CHAPTER_TITLE_LENGTH) ||
      !isNonEmptyBoundedString(rec.goal, MAX_CHAPTER_GOAL_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'chapter 字段内容越界或为空');
    }
    return { title: rec.title, goal: rec.goal };
  });

  return {
    premise: obj.premise,
    characters,
    relationships,
    world: obj.world,
    conflict: obj.conflict,
    ending: obj.ending,
    plotlines,
    chapters,
  };
}

/**
 * D-B7-6 第二道域校验（复查随行修复 note 2：错误码归属一致性）。
 *
 * `createStoryBlueprint` 校验的是模型输出内容（premise/world/chapters 等）的最小
 * 不变量，与 `parseBlueprintGenerateV1` 同属"模型输出不合格"范畴，理应共享
 * `MODEL_RESPONSE_INVALID`。此前该校验被塞进最终成功事务内，失败后统一走
 * `compensateFinalization` 补偿，被无差别记成通用 `TASK_EXECUTION_FAILED`
 * ——与 parse 失败的错误码不一致，误导运维排查方向（parse 失败与域校验失败
 * 明明是同一类问题）。
 *
 * 用占位 id/version/chapter-id 在事务外预跑一遍（纯函数、不接触 DB，可重复调用）：
 * 真正落库时仍在最终事务内用真实 id/version 重新构造（D-B7-5 要求版本号必须在同一
 * 事务内取 MAX+1，不能挪到事务外，否则并发下会产生重复版本）。这两次调用的输入
 * （premise/world/chapters 等内容字段）完全相同，因此结果一致；事务内那次唯一剩余
 * 的失败面是 id 判空——那只可能是 idGenerator 基础设施故障而非模型问题，届时仍走
 * `compensateFinalization` 记 `TASK_EXECUTION_FAILED` 是恰当的（不应该也记成
 * MODEL_RESPONSE_INVALID，那会误导成"模型的错"）。
 *
 * 注：`parseBlueprintGenerateV1` 对内容字段的边界（非空、长度上限）已经等于或严于
 * `createStoryBlueprint` 的对应检查，因此在真实的解析产物上，本函数在生产路径里
 * 不会再失败——保留它是防御性收口 + 错误码一致性，而不是期望它在生产中被触发。
 */
export function assertBlueprintDomainInvariants(
  parsed: ParsedBlueprintGenerate,
  createdAt: string,
): void {
  try {
    createStoryBlueprint({
      id: 'precheck',
      projectId: 'precheck',
      version: 1,
      premise: parsed.premise,
      characters: parsed.characters,
      relationships: parsed.relationships,
      world: parsed.world,
      conflict: parsed.conflict,
      ending: parsed.ending,
      plotlines: parsed.plotlines,
      chapters: parsed.chapters.map((c, i) => ({
        id: `precheck-${i}`,
        title: c.title,
        goal: c.goal,
      })),
      createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '蓝图域校验失败';
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', message);
  }
}

// ── 执行 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

function failedResult(
  deps: BlueprintGenerateExecutionDeps,
  taskId: string,
  invocationId: string | null,
): BlueprintGenerateExecutionResult {
  return {
    task: deps.taskRepo.getById(taskId)!,
    invocation: invocationId ? deps.invocationRepo.getById(invocationId) : null,
    blueprintId: null,
    version: null,
    chapterCount: 0,
  };
}

export async function executeBlueprintGenerate(
  deps: BlueprintGenerateExecutionDeps,
  taskId: string,
): Promise<BlueprintGenerateExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    invokeModel,
    transaction,
  } = deps;

  const task = taskRepo.getById(taskId);
  if (!task) throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.taskType !== 'BLUEPRINT_GENERATE') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  const payload = parsePayload(task.payloadJson);

  // ── claim 前配置校验（缺配置不增 attempt，保持 PENDING；镜像 spec-extract，无 search key）──
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

  // ── 权威 execution context（从 DB 反查）──
  const execution = deps.nodeExecutionRepo.getByTaskId(taskId);
  if (!execution) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_NOT_BOUND', '任务未绑定 node execution'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }

  // ── 上下文装配：idea（session goal）+ creationSpec（完整 sections）+（可能有的）researchBundle ──
  const session = deps.sessionRepo.getById(payload.ideaSessionId);
  const specVersion = deps.specVersionRepo.getById(task.projectId, payload.creationSpecVersionId);
  if (!session || session.projectId !== task.projectId || !specVersion) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '蓝图生成上下文缺失（session/spec）'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }
  let creationSpecSummary: unknown;
  try {
    creationSpecSummary = validateCreationContractSections(JSON.parse(specVersion.sectionsJson));
  } catch {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', 'creationSpec sections 损坏'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }

  // D-B7-7/D-B7-14：researchBundleId 为 null 时分两种语义——`research_decision=none`
  // （根本没做调研）与用户在 RESEARCH_ESCALATION 显式选择 skip_research（调研做过、
  // 用户主动决定不用，见 payload.researchSkippedByUser，D-B7-14 图契约追加声明后
  // prepareTask 能区分两者）。不得把两者混同措辞；有 bundle 时若找不到底层行视为
  // 上下文缺失（确定性失败）。D-B7-13：有 bundle 时按项目排除集合过滤 prompt 可见
  // 内容（不改 bundle 行）。
  let research: BlueprintResearchInput = payload.researchSkippedByUser
    ? { status: 'skipped_by_user' }
    : { status: 'not_conducted' };
  if (payload.researchBundleId !== null) {
    const bundle = deps.researchRepo.getById(task.projectId, payload.researchBundleId);
    if (!bundle) {
      transaction(() => {
        requireCas(
          taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '引用的调研资料包不存在'),
          '无法标记任务失败',
        );
      });
      return failedResult(deps, taskId, null);
    }
    const excludedUrls = new Set(deps.sourceExclusionRepo.listByProject(task.projectId));
    research = classifyResearchInput(bundle, excludedUrls);
  }

  const prompt = buildBlueprintGeneratePrompt({
    idea: session.goal,
    creationSpecSummary,
    research,
    rewriteAttempt: payload.rewriteAttempt,
  });

  const updatedTask = taskRepo.getById(taskId)!;
  const invocationId = idGenerator.generate();
  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'blueprint_generate',
    promptHash: sha256Hex(prompt),
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      rewriteAttempt: payload.rewriteAttempt,
      researchStatus: research.status,
    }),
  });
  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  const result = await invokeModel({
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey,
    prompt,
    systemPrompt: BLUEPRINT_GENERATE_SYSTEM_PROMPT,
    protocol,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : '模型调用异常';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'PROVIDER_CONNECTION_FAILED',
          message,
          null,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
        '无法标记任务失败',
      );
    });
    return { failed: true as const };
  });
  if ('failed' in result) return failedResult(deps, taskId, invocationId);

  if (result.errorCode) {
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          result.errorCode!,
          result.errorMessage ?? '模型调用失败',
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(
          taskId,
          'TASK_EXECUTION_FAILED',
          result.errorMessage ?? '模型调用失败',
        ),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, invocationId);
  }

  let parsedResult: ParsedBlueprintGenerate;
  try {
    parsedResult = parseBlueprintGenerateV1(result.text);
  } catch (err) {
    const message = err instanceof TaskExecutionError ? err.message : '模型输出解析失败';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'MODEL_RESPONSE_INVALID',
          message,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, invocationId);
  }

  const now = deps.clock.now();

  // 域校验前置到最终事务外（复查随行修复 note 2）：与 parse 失败共享同一套错误码
  // 归属（invocation=MODEL_RESPONSE_INVALID / task=TASK_EXECUTION_FAILED），不再
  // 被最终事务失败后的通用 compensateFinalization 统一冲成 TASK_EXECUTION_FAILED。
  try {
    assertBlueprintDomainInvariants(parsedResult, now);
  } catch (err) {
    const message = err instanceof TaskExecutionError ? err.message : '蓝图域校验失败';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'MODEL_RESPONSE_INVALID',
          message,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, invocationId);
  }

  // ── 最终事务：版本号取 MAX+1（D-B7-5）+ 落库 + envelope + invocation/task 终态 ──
  // 定值断言：赋值发生在下方 transaction() 回调内（同步执行），TS 跨闭包分析看不到这点。
  let blueprint!: StoryBlueprint;
  try {
    transaction(() => {
      const blueprintId = idGenerator.generate();
      const version = deps.blueprintRepo.getMaxVersion(task.projectId) + 1;
      const chapters: BlueprintChapter[] = parsedResult.chapters.map((c) => ({
        id: idGenerator.generate(),
        title: c.title,
        goal: c.goal,
      }));
      // 内容字段已由上面的 assertBlueprintDomainInvariants 预校验（同一批输入，结果
      // 一致）；这里若仍然抛错，只可能是 blueprintId/chapter id 判空——即 idGenerator
      // 基础设施故障，不再包一层转 MODEL_RESPONSE_INVALID，让它按原样落入下面的
      // catch → compensateFinalization（记 TASK_EXECUTION_FAILED，如实反映"不是模型
      // 的错"）。
      blueprint = createStoryBlueprint({
        id: blueprintId,
        projectId: task.projectId,
        version,
        premise: parsedResult.premise,
        characters: parsedResult.characters,
        relationships: parsedResult.relationships,
        world: parsedResult.world,
        conflict: parsedResult.conflict,
        ending: parsedResult.ending,
        plotlines: parsedResult.plotlines,
        chapters,
        createdAt: now,
      });

      deps.blueprintRepo.save(blueprint, false);

      // execution-bound durable envelope：task 成功前必达（RW-1 不变量）。
      // BLUEPRINT_GENERATE 契约 out(null,'storyBlueprint')：artifact-only，无 outcome。
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
        artifactKind: 'storyBlueprint',
        artifactId: blueprint.id,
        artifactVersion: blueprint.version,
        contentJson: JSON.stringify(blueprint),
        outcome: null,
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
      requireCas(
        taskRepo.completeRunning(
          taskId,
          JSON.stringify({
            blueprintId: blueprint.id,
            version: blueprint.version,
            chapterCount: blueprint.chapters.length,
          }),
        ),
        '无法标记任务完成',
      );
    });
  } catch (err) {
    compensateFinalization(deps, taskId, invocationId, '任务最终提交失败，已补偿标记失败');
    throw err;
  }

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    blueprintId: blueprint.id,
    version: blueprint.version,
    chapterCount: blueprint.chapters.length,
  };
}
