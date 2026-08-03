/**
 * @ai-novel/domain - Idea-to-Novel 可执行主链 Spine Domain
 *
 * STATE_A 权威公共契约的领域模型：
 *   WorkflowStage / ResearchBundle / StoryBlueprint / GenerationRun
 * 及相关闭合枚举、branded ID、严格解析函数。
 *
 * 纯 TypeScript —— 不依赖 Electron、SQLite、Node.js 专有 API 或 Renderer。
 * 不负责随机 ID 或当前时间生成 —— ID 与时间由调用方注入。
 *
 * 权威来源：
 * - PRODUCT_DIRECTION.md（Writing-first / Narrative Engine 边界）
 * - docs/product/idea-to-novel-v1.md（Idea-to-Novel 1.0 纵向切片）
 * - docs/development/idea-to-novel-migration-plan.md（迁移矩阵与契约冻结）
 *
 * 设计约束：
 * - 契约代表产品工作区/对象语义，不是数据库表映射；
 * - CreationSpecSnapshot 不另起一套新模型：`creationSpecVersionId` 引用现有
 *   `CreationContractVersion`（迁移计划把 Creation Contract 版本化快照复用为
 *   CreationSpecSnapshot 权威输入，见 docs/development/idea-to-novel-migration-plan.md §3.2）；
 * - WorkflowStage 是产品工作区阶段，与 `ProjectStatus`（生命周期）和
 *   `TaskStatus`（后台任务）是三种不同语义，不得互相替代；
 * - 所有公共对象严格解析：exact keys、branded/非空 ID、闭合枚举、
 *   字符串长度限制、http(s) URL、prototype 注入拒绝。
 */

// ── Unicode 工具（本地实现，避免与 index.ts 形成循环导入）────────────

function codePointLength(str: string): number {
  return [...str].length;
}

// ── 长度常量 ──────────────────────────────────────────────────────

/** 通用 ID 最大长度（Unicode code points） */
export const SPINE_ID_MAX_LENGTH = 128;

/** 标题/名称/冲突/情节线标题 最大长度（Unicode code points） */
export const SPINE_TITLE_MAX_LENGTH = 200;

/** 前提/目标/摘要/世界/结局方向/事实笔记文本 最大长度（Unicode code points） */
export const SPINE_BODY_MAX_LENGTH = 20_000;

/** 生成正文 最大长度（Unicode code points，对齐 ChapterVersion.content） */
export const SPINE_CONTENT_MAX_LENGTH = 1_000_000;

/** URL 最大长度 */
export const SPINE_URL_MAX_LENGTH = 2_048;

// ── WorkflowStage ─────────────────────────────────────────────────

/**
 * 产品工作区阶段（Idea-to-Novel 主链）。
 *
 * 代表产品工作区（用户当前身处哪个工作区），不是后台任务状态。
 * 阶段推进/后退语义由后续 application use case 决定，本契约不实现状态机。
 *
 * 与现有枚举的关系（三种语义独立，不得复用同一枚举表达）：
 * - `ProjectStatus`：项目生命周期进度（idea/grill-me/research/contract/...），
 *   是跨版本跟踪的工程状态；
 * - `TaskStatus`：后台任务引擎状态（PENDING/RUNNING/...）；
 * - `WorkflowStage`：产品工作区（IDEA/RESEARCH/BLUEPRINT/GENERATION/MANUSCRIPT）。
 */
export type WorkflowStage = 'IDEA' | 'RESEARCH' | 'BLUEPRINT' | 'GENERATION' | 'MANUSCRIPT';

const WORKFLOW_STAGE_SET: ReadonlySet<string> = new Set([
  'IDEA',
  'RESEARCH',
  'BLUEPRINT',
  'GENERATION',
  'MANUSCRIPT',
]);

export function isValidWorkflowStage(value: unknown): value is WorkflowStage {
  return typeof value === 'string' && WORKFLOW_STAGE_SET.has(value);
}

export function parseWorkflowStage(value: unknown): WorkflowStage {
  if (isValidWorkflowStage(value)) return value;
  throw new Error(`非法 WorkflowStage: ${JSON.stringify(value)}`);
}

// ── ResearchBundle ────────────────────────────────────────────────

/** 调研强度。NONE = 无需调研；LIGHT/DEEP 为产品级强度档位。 */
export type ResearchMode = 'NONE' | 'LIGHT' | 'DEEP';

/** ResearchBundle 状态。IN_PROGRESS = 调研中；READY = 调研完成可喂蓝图；FINALIZED = 用户确认冻结。 */
export type ResearchBundleStatus = 'IN_PROGRESS' | 'READY' | 'FINALIZED';

export type ResearchBundleId = string & { readonly __brand: 'ResearchBundleId' };

const RESEARCH_MODE_SET: ReadonlySet<string> = new Set(['NONE', 'LIGHT', 'DEEP']);
const RESEARCH_BUNDLE_STATUS_SET: ReadonlySet<string> = new Set([
  'IN_PROGRESS',
  'READY',
  'FINALIZED',
]);

export function isValidResearchMode(value: unknown): value is ResearchMode {
  return typeof value === 'string' && RESEARCH_MODE_SET.has(value);
}

export function isValidResearchBundleStatus(value: unknown): value is ResearchBundleStatus {
  return typeof value === 'string' && RESEARCH_BUNDLE_STATUS_SET.has(value);
}

export function parseResearchMode(value: unknown): ResearchMode {
  if (isValidResearchMode(value)) return value;
  throw new Error(`非法 ResearchMode: ${JSON.stringify(value)}`);
}

export function parseResearchBundleStatus(value: unknown): ResearchBundleStatus {
  if (isValidResearchBundleStatus(value)) return value;
  throw new Error(`非法 ResearchBundleStatus: ${JSON.stringify(value)}`);
}

export function createResearchBundleId(raw: string): ResearchBundleId {
  requireStrictId(raw, 'ResearchBundleId');
  return raw as ResearchBundleId;
}

/** 调研问题（问题计划中的一项） */
export interface ResearchQuestion {
  readonly id: string;
  readonly text: string;
}

/** 来源记录 —— 必须能承载真实 Web Research 元数据，不得做成假结构 */
export interface ResearchSource {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly fetchedAt: string;
}

/** 事实笔记 —— 与来源关联 */
export interface ResearchNote {
  readonly id: string;
  readonly text: string;
  readonly sourceIds: ReadonlyArray<string>;
}

/**
 * ResearchBundle —— 调研问题计划、来源、事实笔记与结论汇总。
 *
 * `creationSpecVersionId` 引用现有 Creation Contract 版本化快照
 * （迁移计划中的 CreationSpecSnapshot 权威输入）。
 */
export interface ResearchBundle {
  readonly id: ResearchBundleId;
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly mode: ResearchMode;
  readonly status: ResearchBundleStatus;
  readonly questions: ReadonlyArray<ResearchQuestion>;
  readonly sources: ReadonlyArray<ResearchSource>;
  readonly notes: ReadonlyArray<ResearchNote>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt: string | null;
}

export function parseResearchQuestion(input: unknown): ResearchQuestion {
  const label = 'ResearchQuestion';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['id', 'text'], label);
  const id = parseStrictId(obj.id, 'id');
  const text = parseBodyText(obj.text, 'text');
  return { id, text };
}

export function parseResearchSource(input: unknown): ResearchSource {
  const label = 'ResearchSource';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['id', 'url', 'canonicalUrl', 'title', 'fetchedAt'], label);
  const id = parseStrictId(obj.id, 'id');
  const url = parseHttpUrl(obj.url, 'url');
  const canonicalUrl = parseHttpUrl(obj.canonicalUrl, 'canonicalUrl');
  const title = parseTitle(obj.title, 'title');
  const fetchedAt = parseTimestamp(obj.fetchedAt, 'fetchedAt');
  return { id, url, canonicalUrl, title, fetchedAt };
}

export function parseResearchNote(input: unknown): ResearchNote {
  const label = 'ResearchNote';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['id', 'text', 'sourceIds'], label);
  const id = parseStrictId(obj.id, 'id');
  const text = parseBodyText(obj.text, 'text');
  const sourceIds = parseStrictIdArray(obj.sourceIds, 'sourceIds');
  return { id, text, sourceIds };
}

export function parseResearchBundle(input: unknown): ResearchBundle {
  const label = 'ResearchBundle';
  const obj = assertPlainObject(input, label);
  requireExactKeys(
    obj,
    [
      'id',
      'projectId',
      'creationSpecVersionId',
      'mode',
      'status',
      'questions',
      'sources',
      'notes',
      'createdAt',
      'updatedAt',
      'finalizedAt',
    ],
    label,
  );
  const id = createResearchBundleId(requireString(obj.id, 'id'));
  const projectId = parseStrictId(obj.projectId, 'projectId');
  const creationSpecVersionId = parseStrictId(obj.creationSpecVersionId, 'creationSpecVersionId');
  const mode = parseResearchMode(obj.mode);
  const status = parseResearchBundleStatus(obj.status);
  const questions = parseArray(obj.questions, parseResearchQuestion, 'questions');
  const sources = parseArray(obj.sources, parseResearchSource, 'sources');
  const notes = parseArray(obj.notes, parseResearchNote, 'notes');
  const createdAt = parseTimestamp(obj.createdAt, 'createdAt');
  const updatedAt = parseTimestamp(obj.updatedAt, 'updatedAt');
  const finalizedAt = parseNullableTimestamp(obj.finalizedAt, 'finalizedAt');
  return {
    id,
    projectId,
    creationSpecVersionId,
    mode,
    status,
    questions,
    sources,
    notes,
    createdAt,
    updatedAt,
    finalizedAt,
  };
}

// ── StoryBlueprint ────────────────────────────────────────────────

/** 蓝图人物角色 */
export type BlueprintCharacterRole = 'PROTAGONIST' | 'SUPPORTING' | 'ANTAGONIST' | 'OTHER';

export type StoryBlueprintId = string & { readonly __brand: 'StoryBlueprintId' };

const BLUEPRINT_CHARACTER_ROLE_SET: ReadonlySet<string> = new Set([
  'PROTAGONIST',
  'SUPPORTING',
  'ANTAGONIST',
  'OTHER',
]);

export function isValidBlueprintCharacterRole(value: unknown): value is BlueprintCharacterRole {
  return typeof value === 'string' && BLUEPRINT_CHARACTER_ROLE_SET.has(value);
}

export function parseBlueprintCharacterRole(value: unknown): BlueprintCharacterRole {
  if (isValidBlueprintCharacterRole(value)) return value;
  throw new Error(`非法 BlueprintCharacterRole: ${JSON.stringify(value)}`);
}

export function createStoryBlueprintId(raw: string): StoryBlueprintId {
  requireStrictId(raw, 'StoryBlueprintId');
  return raw as StoryBlueprintId;
}

/** 蓝图人物 */
export interface BlueprintCharacter {
  readonly id: string;
  readonly name: string;
  readonly role: BlueprintCharacterRole;
  readonly summary: string;
}

/** 蓝图情节线 */
export interface BlueprintPlotLine {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

/**
 * 蓝图章节规划。
 * `chapterId` 是蓝图内章节标识（后续生成时可映射到 Manuscript Chapter）。
 */
export interface BlueprintChapter {
  readonly chapterId: string;
  readonly order: number;
  readonly title: string;
  readonly goal: string;
  readonly summary: string;
}

/**
 * StoryBlueprint —— 基于创作要求（与必要调研）设计的故事蓝图。
 *
 * 属于权威用户数据，AI 不能静默覆盖。
 */
export interface StoryBlueprint {
  readonly id: StoryBlueprintId;
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string;
  readonly version: number;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly world: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly plotLines: ReadonlyArray<BlueprintPlotLine>;
  readonly endingDirection: string;
  readonly chapters: ReadonlyArray<BlueprintChapter>;
  readonly createdAt: string;
}

export function parseBlueprintCharacter(input: unknown): BlueprintCharacter {
  const label = 'BlueprintCharacter';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['id', 'name', 'role', 'summary'], label);
  const id = parseStrictId(obj.id, 'id');
  const name = parseTitle(obj.name, 'name');
  const role = parseBlueprintCharacterRole(obj.role);
  const summary = parseBodyText(obj.summary, 'summary');
  return { id, name, role, summary };
}

export function parseBlueprintPlotLine(input: unknown): BlueprintPlotLine {
  const label = 'BlueprintPlotLine';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['id', 'title', 'summary'], label);
  const id = parseStrictId(obj.id, 'id');
  const title = parseTitle(obj.title, 'title');
  const summary = parseBodyText(obj.summary, 'summary');
  return { id, title, summary };
}

export function parseBlueprintChapter(input: unknown): BlueprintChapter {
  const label = 'BlueprintChapter';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['chapterId', 'order', 'title', 'goal', 'summary'], label);
  const chapterId = parseStrictId(obj.chapterId, 'chapterId');
  const order = parsePositiveInt(obj.order, 'order');
  const title = parseTitle(obj.title, 'title');
  const goal = parseBodyText(obj.goal, 'goal');
  const summary = parseBodyText(obj.summary, 'summary');
  return { chapterId, order, title, goal, summary };
}

export function parseStoryBlueprint(input: unknown): StoryBlueprint {
  const label = 'StoryBlueprint';
  const obj = assertPlainObject(input, label);
  requireExactKeys(
    obj,
    [
      'id',
      'projectId',
      'creationSpecVersionId',
      'researchBundleId',
      'version',
      'premise',
      'characters',
      'world',
      'conflicts',
      'plotLines',
      'endingDirection',
      'chapters',
      'createdAt',
    ],
    label,
  );
  const id = createStoryBlueprintId(requireString(obj.id, 'id'));
  const projectId = parseStrictId(obj.projectId, 'projectId');
  const creationSpecVersionId = parseStrictId(obj.creationSpecVersionId, 'creationSpecVersionId');
  const researchBundleId = parseStrictId(obj.researchBundleId, 'researchBundleId');
  const version = parsePositiveInt(obj.version, 'version');
  const premise = parseBodyText(obj.premise, 'premise');
  const characters = parseArray(obj.characters, parseBlueprintCharacter, 'characters');
  const world = parseBodyText(obj.world, 'world');
  const conflicts = parseStringArray(obj.conflicts, 'conflicts', SPINE_TITLE_MAX_LENGTH);
  const plotLines = parseArray(obj.plotLines, parseBlueprintPlotLine, 'plotLines');
  const endingDirection = parseBodyText(obj.endingDirection, 'endingDirection');
  const chapters = parseArray(obj.chapters, parseBlueprintChapter, 'chapters');
  const createdAt = parseTimestamp(obj.createdAt, 'createdAt');
  return {
    id,
    projectId,
    creationSpecVersionId,
    researchBundleId,
    version,
    premise,
    characters,
    world,
    conflicts,
    plotLines,
    endingDirection,
    chapters,
    createdAt,
  };
}

// ── GenerationRun ─────────────────────────────────────────────────

/**
 * GenerationRun 状态（产品级运行生命周期）。
 *
 * 与 `TaskStatus`（后台任务引擎）是不同语义的类型，即使字符串值相似也
 * 不得互相替代；与 `WorkflowStage`（产品工作区）同样独立。
 */
export type GenerationRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/**
 * GenerationRun 阶段（运行内部的细分进度）。
 *
 * 对齐 docs/product/idea-to-novel-v1.md §6.5 生成流程：
 * SCENE_PLAN（内部场景计划）→ DRAFTING（分场景生成）→ ASSEMBLING（章节组合）
 * → CHECKING（基础检查）→ REVISING（定点修订）→ COMMITTING（写入稿件）。
 * IDLE = 未开始；COMPLETE = 完成。
 */
export type GenerationStage =
  | 'IDLE'
  | 'SCENE_PLAN'
  | 'DRAFTING'
  | 'ASSEMBLING'
  | 'CHECKING'
  | 'REVISING'
  | 'COMMITTING'
  | 'COMPLETE';

/** 生成结果来源类型（对应写入 Manuscript 时的 ChapterVersionSourceType） */
export type GenerationSourceType = 'AI_GENERATION' | 'AI_REWRITE';

export type GenerationRunId = string & { readonly __brand: 'GenerationRunId' };

const GENERATION_RUN_STATUS_SET: ReadonlySet<string> = new Set([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
const GENERATION_STAGE_SET: ReadonlySet<string> = new Set([
  'IDLE',
  'SCENE_PLAN',
  'DRAFTING',
  'ASSEMBLING',
  'CHECKING',
  'REVISING',
  'COMMITTING',
  'COMPLETE',
]);
const GENERATION_SOURCE_TYPE_SET: ReadonlySet<string> = new Set(['AI_GENERATION', 'AI_REWRITE']);

export function isValidGenerationRunStatus(value: unknown): value is GenerationRunStatus {
  return typeof value === 'string' && GENERATION_RUN_STATUS_SET.has(value);
}

export function isValidGenerationStage(value: unknown): value is GenerationStage {
  return typeof value === 'string' && GENERATION_STAGE_SET.has(value);
}

export function isValidGenerationSourceType(value: unknown): value is GenerationSourceType {
  return typeof value === 'string' && GENERATION_SOURCE_TYPE_SET.has(value);
}

export function parseGenerationRunStatus(value: unknown): GenerationRunStatus {
  if (isValidGenerationRunStatus(value)) return value;
  throw new Error(`非法 GenerationRunStatus: ${JSON.stringify(value)}`);
}

export function parseGenerationStage(value: unknown): GenerationStage {
  if (isValidGenerationStage(value)) return value;
  throw new Error(`非法 GenerationStage: ${JSON.stringify(value)}`);
}

export function parseGenerationSourceType(value: unknown): GenerationSourceType {
  if (isValidGenerationSourceType(value)) return value;
  throw new Error(`非法 GenerationSourceType: ${JSON.stringify(value)}`);
}

export function createGenerationRunId(raw: string): GenerationRunId {
  requireStrictId(raw, 'GenerationRunId');
  return raw as GenerationRunId;
}

/** 生成目标 —— 本次运行拟生成的蓝图章节 */
export interface GenerationTarget {
  readonly blueprintChapterId: string;
  readonly title: string;
}

/**
 * 生成结果 —— 显式结构，不是任意 JSON。
 *
 * 表达：拟写入 Manuscript 的标题与正文、来源类型、是否已提交、
 * 以及提交后对应的 manuscriptId / chapterId / chapterVersionId。
 * STATE_A 不实现提交，因此 committed 恒为 false，三个 id 恒为 null。
 */
export interface GenerationRunResult {
  readonly proposedTitle: string;
  readonly proposedContent: string;
  readonly sourceType: GenerationSourceType;
  readonly committed: boolean;
  readonly manuscriptId: string | null;
  readonly chapterId: string | null;
  readonly chapterVersionId: string | null;
}

/**
 * GenerationRun —— 每次章节生成作为一次运行记录。
 *
 * 用于让用户理解与控制生成过程，不做提交（写入由未来 use case 承担）。
 */
export interface GenerationRun {
  readonly id: GenerationRunId;
  readonly projectId: string;
  readonly storyBlueprintId: string;
  readonly target: GenerationTarget;
  readonly status: GenerationRunStatus;
  readonly stage: GenerationStage;
  readonly progress: number;
  readonly result: GenerationRunResult | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function parseGenerationTarget(input: unknown): GenerationTarget {
  const label = 'GenerationTarget';
  const obj = assertPlainObject(input, label);
  requireExactKeys(obj, ['blueprintChapterId', 'title'], label);
  const blueprintChapterId = parseStrictId(obj.blueprintChapterId, 'blueprintChapterId');
  const title = parseTitle(obj.title, 'title');
  return { blueprintChapterId, title };
}

export function parseGenerationRunResult(input: unknown): GenerationRunResult {
  const label = 'GenerationRunResult';
  const obj = assertPlainObject(input, label);
  requireExactKeys(
    obj,
    [
      'proposedTitle',
      'proposedContent',
      'sourceType',
      'committed',
      'manuscriptId',
      'chapterId',
      'chapterVersionId',
    ],
    label,
  );
  const proposedTitle = parseTitle(obj.proposedTitle, 'proposedTitle');
  const proposedContent = parseContent(obj.proposedContent, 'proposedContent');
  const sourceType = parseGenerationSourceType(obj.sourceType);
  if (typeof obj.committed !== 'boolean') {
    throw new Error('committed 必须是布尔值');
  }
  const manuscriptId = parseNullableStrictId(obj.manuscriptId, 'manuscriptId');
  const chapterId = parseNullableStrictId(obj.chapterId, 'chapterId');
  const chapterVersionId = parseNullableStrictId(obj.chapterVersionId, 'chapterVersionId');
  return {
    proposedTitle,
    proposedContent,
    sourceType,
    committed: obj.committed,
    manuscriptId,
    chapterId,
    chapterVersionId,
  };
}

export function parseGenerationRun(input: unknown): GenerationRun {
  const label = 'GenerationRun';
  const obj = assertPlainObject(input, label);
  requireExactKeys(
    obj,
    [
      'id',
      'projectId',
      'storyBlueprintId',
      'target',
      'status',
      'stage',
      'progress',
      'result',
      'error',
      'createdAt',
      'startedAt',
      'completedAt',
    ],
    label,
  );
  const id = createGenerationRunId(requireString(obj.id, 'id'));
  const projectId = parseStrictId(obj.projectId, 'projectId');
  const storyBlueprintId = parseStrictId(obj.storyBlueprintId, 'storyBlueprintId');
  const target = parseGenerationTarget(obj.target);
  const status = parseGenerationRunStatus(obj.status);
  const stage = parseGenerationStage(obj.stage);
  const progress = parseProgress(obj.progress);
  const result = obj.result === null ? null : parseGenerationRunResult(obj.result);
  const error = parseNullableBodyText(obj.error, 'error');
  const createdAt = parseTimestamp(obj.createdAt, 'createdAt');
  const startedAt = parseNullableTimestamp(obj.startedAt, 'startedAt');
  const completedAt = parseNullableTimestamp(obj.completedAt, 'completedAt');
  return {
    id,
    projectId,
    storyBlueprintId,
    target,
    status,
    stage,
    progress,
    result,
    error,
    createdAt,
    startedAt,
    completedAt,
  };
}

// ── 内部解析助手 ──────────────────────────────────────────────────

function assertPlainObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} 必须是对象`);
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} 不允许 class 实例或自定义 prototype`);
  }
  return input as Record<string, unknown>;
}

/** exact keys：允许集合必须与对象 key 集合完全一致（拒绝 unknown / 缺失字段） */
function requireExactKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) {
    throw new Error(`${label} 字段数不符（期望 ${allowed.length}，实际 ${keys.length}）`);
  }
  const allowedSet = new Set(allowed);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      throw new Error(`${label} 包含非 own 字段`);
    }
    if (!allowedSet.has(k)) {
      throw new Error(`${label} 包含未知字段: ${k}`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  return value;
}

/** 严格 ID：非空、无首尾空白、≤ SPINE_ID_MAX_LENGTH code points */
function requireStrictId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  if (value.length === 0) throw new Error(`${label} 不能为空`);
  if (value !== value.trim()) throw new Error(`${label} 不允许首尾空白`);
  if (codePointLength(value) > SPINE_ID_MAX_LENGTH) {
    throw new Error(`${label} 不能超过 ${SPINE_ID_MAX_LENGTH} 个字符`);
  }
  return value;
}

function parseStrictId(value: unknown, label: string): string {
  return requireStrictId(value, label);
}

function parseNullableStrictId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseStrictId(value, label);
}

function parseStrictIdArray(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.map((item, index) => parseStrictId(item, `${label}[${index}]`));
}

/** 标题/名称：trim 非空、≤ SPINE_TITLE_MAX_LENGTH code points */
function parseTitle(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} 不能为空`);
  if (codePointLength(trimmed) > SPINE_TITLE_MAX_LENGTH) {
    throw new Error(`${label} 不能超过 ${SPINE_TITLE_MAX_LENGTH} 个字符`);
  }
  return trimmed;
}

/** 正文类文本：trim 非空、≤ SPINE_BODY_MAX_LENGTH code points */
function parseBodyText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} 不能为空`);
  if (codePointLength(trimmed) > SPINE_BODY_MAX_LENGTH) {
    throw new Error(`${label} 不能超过 ${SPINE_BODY_MAX_LENGTH} 个字符`);
  }
  return trimmed;
}

function parseNullableBodyText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseBodyText(value, label);
}

/** 生成正文：非空、≤ SPINE_CONTENT_MAX_LENGTH code points（不 trim，保真） */
function parseContent(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  if (value.length === 0) throw new Error(`${label} 不能为空`);
  if (codePointLength(value) > SPINE_CONTENT_MAX_LENGTH) {
    throw new Error(`${label} 不能超过 ${SPINE_CONTENT_MAX_LENGTH} 个字符`);
  }
  return value;
}

/** 时间戳：非空字符串（对齐现有 isIsoTimestampLike 宽松语义） */
function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function parseNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseTimestamp(value, label);
}

/** 进度：有限数字，0..1 闭区间 */
function parseProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('progress 必须是 0..1 的有限数字');
  }
  return value;
}

/** 正安全整数（order / version） */
function parsePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正安全整数`);
  }
  return value;
}

function parseArray<T>(value: unknown, parseItem: (item: unknown) => T, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.map((item) => parseItem(item));
}

/** 字符串列表（conflicts 等）：每项 trim 非空且 ≤ max code points */
function parseStringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${label} 元素必须是字符串`);
    const trimmed = item.trim();
    if (trimmed.length === 0) throw new Error(`${label} 元素不能为空`);
    if (codePointLength(trimmed) > max) {
      throw new Error(`${label} 元素不能超过 ${max} 个字符`);
    }
    return trimmed;
  });
}

/**
 * 严格 http(s) URL 校验（不依赖 `new URL`，domain 包 lib 无 DOM）。
 *
 * 校验范围（契约层）：http/https 协议、无首尾/内部空白、无 URL credentials、
 * 非空 host、合法端口、长度上限。
 * 不覆盖的安全边界（属于 research-engine Web Research V1 验收门禁，见
 * docs/development/idea-to-novel-migration-plan.md §3.7）：localhost/loopback/
 * 私网拒绝、重定向后重新校验、响应字节限制等 —— 由后续 fetch 端口实现承载。
 */
function parseHttpUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  if (value !== value.trim()) throw new Error(`${label} 不允许首尾空白`);
  if (value.length === 0) throw new Error(`${label} 不能为空`);
  if (value.length > SPINE_URL_MAX_LENGTH) {
    throw new Error(`${label} 不能超过 ${SPINE_URL_MAX_LENGTH} 字符`);
  }
  if (/\s/.test(value)) throw new Error(`${label} 不允许空白字符`);
  const lower = value.toLowerCase();
  let rest: string;
  if (lower.startsWith('https://')) {
    rest = value.slice('https://'.length);
  } else if (lower.startsWith('http://')) {
    rest = value.slice('http://'.length);
  } else {
    throw new Error(`${label} 必须是 http/https URL`);
  }
  if (rest.length === 0) throw new Error(`${label} 缺少 host`);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.length === 0) throw new Error(`${label} 缺少 host`);
  if (authority.includes('@')) throw new Error(`${label} 不允许 URL credentials`);
  if (/[^a-zA-Z0-9.:\-[\]]/.test(authority)) throw new Error(`${label} host 含非法字符`);
  if (authority.startsWith('[')) {
    // IPv6 字面量：[...]（[:port] 可选）
    const close = authority.indexOf(']');
    if (close <= 1) throw new Error(`${label} 非法 IPv6 host`);
    const after = authority.slice(close + 1);
    if (after !== '' && !/^:\d+$/.test(after)) throw new Error(`${label} 非法端口`);
    return value;
  }
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (port.length === 0 || !/^\d+$/.test(port)) throw new Error(`${label} 非法端口`);
  }
  return value;
}
