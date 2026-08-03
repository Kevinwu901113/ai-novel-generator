/**
 * @ai-novel/contracts - Idea-to-Novel 可执行主链 Spine Contracts
 *
 * STATE_A Renderer 可消费的产品契约：
 *   WorkflowStage / ResearchBundle / StoryBlueprint / GenerationRun
 * 的 Public DTO、Input DTO、严格校验器与 DesktopAPI 命名空间形状。
 *
 * 设计原则（与仓库其余契约一致，见 index.ts）：
 * - 自包含：不导入 domain，闭合枚举/DTO/校验器在此处声明；
 * - 只暴露 Renderer 需要的稳定语义，不暴露 SQLite row / task claim /
 *   provider request / worker command envelope / migration version /
 *   内部诊断字段；
 * - 所有公共输入严格校验：exact keys（拒绝 unknown）、非空 ID、闭合枚举、
 *   字符串长度限制、http(s) URL、prototype 注入拒绝；
 * - `creationSpecVersionId` 引用现有 Creation Contract snapshot ——
 *   产品级视图 `CreationSpecSnapshotDTO` 是 `ContractVersionPublicData` 的别名
 *   （见 index.ts），不复制第二套完整 CreationSpec 数据模型；
 * - fixture 与真实实现共享同一 API 形状，本文件不实现任何 fixture。
 */

// ── 闭合枚举（自包含声明）─────────────────────────────────────────

/** 产品工作区阶段。语义见 domain `spine.ts` 的 WorkflowStage 文档。 */
export type WorkflowStage = 'IDEA' | 'RESEARCH' | 'BLUEPRINT' | 'GENERATION' | 'MANUSCRIPT';

/** 调研强度 */
export type ResearchMode = 'NONE' | 'LIGHT' | 'DEEP';

/** ResearchBundle 状态 */
export type ResearchBundleStatus = 'IN_PROGRESS' | 'READY' | 'FINALIZED';

/** GenerationRun 状态（产品级运行生命周期，区别于后台 TaskStatus） */
export type GenerationRunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** GenerationRun 阶段（运行内部细分进度，对齐 idea-to-novel-v1 §6.5） */
export type GenerationStage =
  | 'IDLE'
  | 'SCENE_PLAN'
  | 'DRAFTING'
  | 'ASSEMBLING'
  | 'CHECKING'
  | 'REVISING'
  | 'COMMITTING'
  | 'COMPLETE';

/** 生成结果来源类型 */
export type GenerationSourceType = 'AI_GENERATION' | 'AI_REWRITE';

/** 蓝图人物角色 */
export type BlueprintCharacterRole = 'PROTAGONIST' | 'SUPPORTING' | 'ANTAGONIST' | 'OTHER';

// ── Public DTO ────────────────────────────────────────────────────

/** 调研问题（问题计划中的一项） */
export interface ResearchQuestionPublicData {
  readonly id: string;
  readonly text: string;
}

/** 来源记录 */
export interface ResearchSourcePublicData {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly fetchedAt: string;
}

/** 事实笔记 */
export interface ResearchNotePublicData {
  readonly id: string;
  readonly text: string;
  readonly sourceIds: ReadonlyArray<string>;
}

/** ResearchBundle 公开数据 */
export interface ResearchBundlePublicData {
  readonly id: string;
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly mode: ResearchMode;
  readonly status: ResearchBundleStatus;
  readonly questions: ReadonlyArray<ResearchQuestionPublicData>;
  readonly sources: ReadonlyArray<ResearchSourcePublicData>;
  readonly notes: ReadonlyArray<ResearchNotePublicData>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt: string | null;
}

/** 蓝图人物 */
export interface BlueprintCharacterPublicData {
  readonly id: string;
  readonly name: string;
  readonly role: BlueprintCharacterRole;
  readonly summary: string;
}

/** 蓝图情节线 */
export interface BlueprintPlotLinePublicData {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

/** 蓝图章节规划 */
export interface BlueprintChapterPublicData {
  readonly chapterId: string;
  readonly order: number;
  readonly title: string;
  readonly goal: string;
  readonly summary: string;
}

/** StoryBlueprint 公开数据 */
export interface StoryBlueprintPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string;
  readonly version: number;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacterPublicData>;
  readonly world: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly plotLines: ReadonlyArray<BlueprintPlotLinePublicData>;
  readonly endingDirection: string;
  readonly chapters: ReadonlyArray<BlueprintChapterPublicData>;
  readonly createdAt: string;
}

/** 生成目标 */
export interface GenerationTargetPublicData {
  readonly blueprintChapterId: string;
  readonly title: string;
}

/**
 * 生成结果（显式结构，不是任意 JSON）。
 * STATE_A 不实现提交，committed 恒为 false，三个目标 id 恒为 null。
 */
export interface GenerationRunResultPublicData {
  readonly proposedTitle: string;
  readonly proposedContent: string;
  readonly sourceType: GenerationSourceType;
  readonly committed: boolean;
  readonly manuscriptId: string | null;
  readonly chapterId: string | null;
  readonly chapterVersionId: string | null;
}

/** GenerationRun 公开数据 */
export interface GenerationRunPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly storyBlueprintId: string;
  readonly target: GenerationTargetPublicData;
  readonly status: GenerationRunStatus;
  readonly stage: GenerationStage;
  readonly progress: number;
  readonly result: GenerationRunResultPublicData | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

// ── Input DTO ─────────────────────────────────────────────────────
// Renderer 不传新 ID / 时间戳 —— 全部由 Worker / application 注入。

export interface GetCurrentWorkflowInput {
  readonly projectId: string;
}

export interface GetCurrentResearchBundleInput {
  readonly projectId: string;
}

export interface CreateResearchFixtureInput {
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  /** 缺省为 LIGHT；显式传入可演示 DEEP/NONE */
  readonly mode?: ResearchMode;
}

export interface GetCurrentStoryBlueprintInput {
  readonly projectId: string;
}

export interface CreateStoryBlueprintFixtureInput {
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string;
}

export interface GetCurrentGenerationRunInput {
  readonly projectId: string;
}

export interface RunGenerationFixtureInput {
  readonly projectId: string;
  readonly storyBlueprintId: string;
}

// ── DesktopAPI 命名空间（Renderer 可消费的产品 API 形状）────────────
// 只冻结接口形状；preload / Main / Worker 接线不属于本 PR。

export interface WorkflowAPI {
  getCurrent(input: GetCurrentWorkflowInput): Promise<WorkflowStage>;
}

export interface ResearchAPI {
  getCurrent(input: GetCurrentResearchBundleInput): Promise<ResearchBundlePublicData | null>;
  createFixture(input: CreateResearchFixtureInput): Promise<ResearchBundlePublicData>;
}

export interface BlueprintAPI {
  getCurrent(input: GetCurrentStoryBlueprintInput): Promise<StoryBlueprintPublicData | null>;
  createFixture(input: CreateStoryBlueprintFixtureInput): Promise<StoryBlueprintPublicData>;
}

export interface GenerationAPI {
  getCurrentRun(input: GetCurrentGenerationRunInput): Promise<GenerationRunPublicData | null>;
  runFixture(input: RunGenerationFixtureInput): Promise<GenerationRunPublicData>;
}

// ── 校验助手（自包含，与 index.ts 的 hasContractExactKeys 同强度）─────

const SPINE_ID_MAX_LENGTH = 128;
const SPINE_TITLE_MAX_LENGTH = 200;
const SPINE_BODY_MAX_LENGTH = 20_000;
const SPINE_CONTENT_MAX_LENGTH = 1_000_000;
const SPINE_URL_MAX_LENGTH = 2_048;

function spineCodePointLength(str: string): number {
  return [...str].length;
}

/** 严格 ID：非空、无首尾空白、≤ 128 code points */
function isSpineId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  return spineCodePointLength(value) <= SPINE_ID_MAX_LENGTH;
}

function isNullableSpineId(value: unknown): boolean {
  return value === null || isSpineId(value);
}

/** 标题/名称：trim 非空、≤ 200 code points */
function isSpineTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return spineCodePointLength(trimmed) <= SPINE_TITLE_MAX_LENGTH;
}

/** 正文类文本：trim 非空、≤ 20_000 code points */
function isSpineBodyText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return spineCodePointLength(trimmed) <= SPINE_BODY_MAX_LENGTH;
}

function isNullableSpineBodyText(value: unknown): boolean {
  return value === null || isSpineBodyText(value);
}

/** 生成正文：非空、≤ 1_000_000 code points（不 trim） */
function isSpineContent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  return spineCodePointLength(value) <= SPINE_CONTENT_MAX_LENGTH;
}

/** 时间戳：非空字符串（对齐现有 isIsoTimestampLike 宽松语义） */
function isSpineTimestampLike(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableSpineTimestampLike(value: unknown): boolean {
  return value === null || isSpineTimestampLike(value);
}

/** 正安全整数（order / version） */
function isSpinePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 进度：有限数字，0..1 闭区间 */
function isSpineProgress(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 严格 ID 列表 */
function isSpineIdArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => isSpineId(item));
}

/** 标题类字符串列表（conflicts 等） */
function isSpineTitleArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => isSpineTitle(item));
}

/** exact keys：允许集合必须与 key 集合完全一致（拒绝 unknown / 缺失 / 继承 / 数组） */
function hasSpineExactKeys(obj: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  if (Array.isArray(obj)) return false;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) return false;
  const allowedSet = new Set(allowed);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
    if (!allowedSet.has(k)) return false;
  }
  return true;
}

/** allowed 子集 + required 存在性（可选字段输入用，与 hasContractAllowedKeys 同强度） */
function hasSpineAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean {
  if (Array.isArray(obj)) return false;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(obj);
  const allowedSet = new Set(allowed);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
    if (!allowedSet.has(k)) return false;
  }
  for (const r of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, r)) return false;
  }
  return true;
}

/**
 * 严格 http(s) URL（不依赖 `new URL`，contracts 包 lib 无 DOM）。
 * 契约层范围：协议、空白、credentials、host、端口、长度。
 * 网络安全边界（localhost/私网/重定向等）属于 research-engine Web Research V1
 * 验收门禁，见 docs/development/idea-to-novel-migration-plan.md §3.7。
 */
function isSpineHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value !== value.trim()) return false;
  if (value.length === 0 || value.length > SPINE_URL_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  const lower = value.toLowerCase();
  let rest: string;
  if (lower.startsWith('https://')) rest = value.slice('https://'.length);
  else if (lower.startsWith('http://')) rest = value.slice('http://'.length);
  else return false;
  if (rest.length === 0) return false;
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.length === 0) return false;
  if (authority.includes('@')) return false;
  if (/[^a-zA-Z0-9.:\-[\]]/.test(authority)) return false;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close <= 1) return false;
    const after = authority.slice(close + 1);
    if (after !== '' && !/^:\d+$/.test(after)) return false;
    return true;
  }
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (port.length === 0 || !/^\d+$/.test(port)) return false;
  }
  return true;
}

// ── 枚举值校验 ─────────────────────────────────────────────────────

const WORKFLOW_STAGE_SET: ReadonlySet<string> = new Set([
  'IDEA',
  'RESEARCH',
  'BLUEPRINT',
  'GENERATION',
  'MANUSCRIPT',
]);
const RESEARCH_MODE_SET: ReadonlySet<string> = new Set(['NONE', 'LIGHT', 'DEEP']);
const RESEARCH_BUNDLE_STATUS_SET: ReadonlySet<string> = new Set([
  'IN_PROGRESS',
  'READY',
  'FINALIZED',
]);
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
const BLUEPRINT_CHARACTER_ROLE_SET: ReadonlySet<string> = new Set([
  'PROTAGONIST',
  'SUPPORTING',
  'ANTAGONIST',
  'OTHER',
]);

export function isWorkflowStageValue(value: unknown): value is WorkflowStage {
  return typeof value === 'string' && WORKFLOW_STAGE_SET.has(value);
}

export function isResearchModeValue(value: unknown): value is ResearchMode {
  return typeof value === 'string' && RESEARCH_MODE_SET.has(value);
}

export function isResearchBundleStatusValue(value: unknown): value is ResearchBundleStatus {
  return typeof value === 'string' && RESEARCH_BUNDLE_STATUS_SET.has(value);
}

export function isGenerationRunStatusValue(value: unknown): value is GenerationRunStatus {
  return typeof value === 'string' && GENERATION_RUN_STATUS_SET.has(value);
}

export function isGenerationStageValue(value: unknown): value is GenerationStage {
  return typeof value === 'string' && GENERATION_STAGE_SET.has(value);
}

export function isGenerationSourceTypeValue(value: unknown): value is GenerationSourceType {
  return typeof value === 'string' && GENERATION_SOURCE_TYPE_SET.has(value);
}

export function isBlueprintCharacterRoleValue(value: unknown): value is BlueprintCharacterRole {
  return typeof value === 'string' && BLUEPRINT_CHARACTER_ROLE_SET.has(value);
}

// ── Public DTO 校验器 ─────────────────────────────────────────────

export function isValidResearchQuestionPublicData(
  data: unknown,
): data is ResearchQuestionPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasSpineExactKeys(obj, ['id', 'text']) && isSpineId(obj.id) && isSpineBodyText(obj.text);
}

export function isValidResearchSourcePublicData(data: unknown): data is ResearchSourcePublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['id', 'url', 'canonicalUrl', 'title', 'fetchedAt']) &&
    isSpineId(obj.id) &&
    isSpineHttpUrl(obj.url) &&
    isSpineHttpUrl(obj.canonicalUrl) &&
    isSpineTitle(obj.title) &&
    isSpineTimestampLike(obj.fetchedAt)
  );
}

export function isValidResearchNotePublicData(data: unknown): data is ResearchNotePublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['id', 'text', 'sourceIds']) &&
    isSpineId(obj.id) &&
    isSpineBodyText(obj.text) &&
    isSpineIdArray(obj.sourceIds)
  );
}

export function isValidResearchBundlePublicData(data: unknown): data is ResearchBundlePublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasSpineExactKeys(obj, [
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
    ])
  ) {
    return false;
  }
  if (
    !isSpineId(obj.id) ||
    !isSpineId(obj.projectId) ||
    !isSpineId(obj.creationSpecVersionId) ||
    !isResearchModeValue(obj.mode) ||
    !isResearchBundleStatusValue(obj.status) ||
    !isSpineTimestampLike(obj.createdAt) ||
    !isSpineTimestampLike(obj.updatedAt) ||
    !isNullableSpineTimestampLike(obj.finalizedAt)
  ) {
    return false;
  }
  if (!Array.isArray(obj.questions) || !obj.questions.every(isValidResearchQuestionPublicData)) {
    return false;
  }
  if (!Array.isArray(obj.sources) || !obj.sources.every(isValidResearchSourcePublicData)) {
    return false;
  }
  if (!Array.isArray(obj.notes) || !obj.notes.every(isValidResearchNotePublicData)) {
    return false;
  }
  return true;
}

export function isValidBlueprintCharacterPublicData(
  data: unknown,
): data is BlueprintCharacterPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['id', 'name', 'role', 'summary']) &&
    isSpineId(obj.id) &&
    isSpineTitle(obj.name) &&
    isBlueprintCharacterRoleValue(obj.role) &&
    isSpineBodyText(obj.summary)
  );
}

export function isValidBlueprintPlotLinePublicData(
  data: unknown,
): data is BlueprintPlotLinePublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['id', 'title', 'summary']) &&
    isSpineId(obj.id) &&
    isSpineTitle(obj.title) &&
    isSpineBodyText(obj.summary)
  );
}

export function isValidBlueprintChapterPublicData(
  data: unknown,
): data is BlueprintChapterPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['chapterId', 'order', 'title', 'goal', 'summary']) &&
    isSpineId(obj.chapterId) &&
    isSpinePositiveInt(obj.order) &&
    isSpineTitle(obj.title) &&
    isSpineBodyText(obj.goal) &&
    isSpineBodyText(obj.summary)
  );
}

export function isValidStoryBlueprintPublicData(data: unknown): data is StoryBlueprintPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasSpineExactKeys(obj, [
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
    ])
  ) {
    return false;
  }
  if (
    !isSpineId(obj.id) ||
    !isSpineId(obj.projectId) ||
    !isSpineId(obj.creationSpecVersionId) ||
    !isSpineId(obj.researchBundleId) ||
    !isSpinePositiveInt(obj.version) ||
    !isSpineBodyText(obj.premise) ||
    !isSpineBodyText(obj.world) ||
    !isSpineBodyText(obj.endingDirection) ||
    !isSpineTimestampLike(obj.createdAt) ||
    !isSpineTitleArray(obj.conflicts)
  ) {
    return false;
  }
  if (
    !Array.isArray(obj.characters) ||
    !obj.characters.every(isValidBlueprintCharacterPublicData)
  ) {
    return false;
  }
  if (!Array.isArray(obj.plotLines) || !obj.plotLines.every(isValidBlueprintPlotLinePublicData)) {
    return false;
  }
  if (!Array.isArray(obj.chapters) || !obj.chapters.every(isValidBlueprintChapterPublicData)) {
    return false;
  }
  return true;
}

export function isValidGenerationTargetPublicData(
  data: unknown,
): data is GenerationTargetPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['blueprintChapterId', 'title']) &&
    isSpineId(obj.blueprintChapterId) &&
    isSpineTitle(obj.title)
  );
}

export function isValidGenerationRunResultPublicData(
  data: unknown,
): data is GenerationRunResultPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, [
      'proposedTitle',
      'proposedContent',
      'sourceType',
      'committed',
      'manuscriptId',
      'chapterId',
      'chapterVersionId',
    ]) &&
    isSpineTitle(obj.proposedTitle) &&
    isSpineContent(obj.proposedContent) &&
    isGenerationSourceTypeValue(obj.sourceType) &&
    typeof obj.committed === 'boolean' &&
    isNullableSpineId(obj.manuscriptId) &&
    isNullableSpineId(obj.chapterId) &&
    isNullableSpineId(obj.chapterVersionId)
  );
}

export function isValidGenerationRunPublicData(data: unknown): data is GenerationRunPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasSpineExactKeys(obj, [
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
    ])
  ) {
    return false;
  }
  if (
    !isSpineId(obj.id) ||
    !isSpineId(obj.projectId) ||
    !isSpineId(obj.storyBlueprintId) ||
    !isGenerationRunStatusValue(obj.status) ||
    !isGenerationStageValue(obj.stage) ||
    !isSpineProgress(obj.progress) ||
    !isNullableSpineBodyText(obj.error) ||
    !isSpineTimestampLike(obj.createdAt) ||
    !isNullableSpineTimestampLike(obj.startedAt) ||
    !isNullableSpineTimestampLike(obj.completedAt)
  ) {
    return false;
  }
  if (!isValidGenerationTargetPublicData(obj.target)) return false;
  if (obj.result === null) return true;
  return isValidGenerationRunResultPublicData(obj.result);
}

// ── Input 校验器 ──────────────────────────────────────────────────

export function isValidGetCurrentWorkflowInput(data: unknown): data is GetCurrentWorkflowInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasSpineExactKeys(obj, ['projectId']) && isSpineId(obj.projectId);
}

export function isValidGetCurrentResearchBundleInput(
  data: unknown,
): data is GetCurrentResearchBundleInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasSpineExactKeys(obj, ['projectId']) && isSpineId(obj.projectId);
}

export function isValidCreateResearchFixtureInput(
  data: unknown,
): data is CreateResearchFixtureInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasSpineAllowedKeys(
      obj,
      ['projectId', 'creationSpecVersionId', 'mode'],
      ['projectId', 'creationSpecVersionId'],
    )
  ) {
    return false;
  }
  if (!isSpineId(obj.projectId) || !isSpineId(obj.creationSpecVersionId)) return false;
  if (obj.mode !== undefined && !isResearchModeValue(obj.mode)) return false;
  return true;
}

export function isValidGetCurrentStoryBlueprintInput(
  data: unknown,
): data is GetCurrentStoryBlueprintInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasSpineExactKeys(obj, ['projectId']) && isSpineId(obj.projectId);
}

export function isValidCreateStoryBlueprintFixtureInput(
  data: unknown,
): data is CreateStoryBlueprintFixtureInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['projectId', 'creationSpecVersionId', 'researchBundleId']) &&
    isSpineId(obj.projectId) &&
    isSpineId(obj.creationSpecVersionId) &&
    isSpineId(obj.researchBundleId)
  );
}

export function isValidGetCurrentGenerationRunInput(
  data: unknown,
): data is GetCurrentGenerationRunInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasSpineExactKeys(obj, ['projectId']) && isSpineId(obj.projectId);
}

export function isValidRunGenerationFixtureInput(data: unknown): data is RunGenerationFixtureInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasSpineExactKeys(obj, ['projectId', 'storyBlueprintId']) &&
    isSpineId(obj.projectId) &&
    isSpineId(obj.storyBlueprintId)
  );
}
