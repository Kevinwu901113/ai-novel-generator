/**
 * @ai-novel/domain
 *
 * 纯 TypeScript 领域模型和规则。
 * 不依赖 Electron、React、Node.js 专有 API、SQLite 或具体模型提供商。
 * 不负责随机 ID 生成 —— ID 由调用方注入。
 */

// ── Unicode 工具 ──────────────────────────────────────────────────

/**
 * 计算字符串的 Unicode code point 数量。
 *
 * String.length 返回 UTF-16 code unit 数量，会误判 emoji 和扩展平面字符。
 * 此函数使用 Array.from 按 code point 迭代，得到正确计数。
 */
export function unicodeCodePointLength(str: string): number {
  return [...str].length;
}

// ── 品牌类型 ──────────────────────────────────────────────────────

/** 项目唯一标识符 */
export type ProjectId = string & { readonly __brand: 'ProjectId' };

/** 提供商配置唯一标识符 */
export type ProviderProfileId = string & { readonly __brand: 'ProviderProfileId' };

/** 项目名称（已验证，trim 后 1-100 Unicode code points） */
export type ProjectName = string & { readonly __brand: 'ProjectName' };

/** 初始想法（已验证，trim 后 1-20000 Unicode code points） */
export type InitialIdea = string & { readonly __brand: 'InitialIdea' };

// ── 状态类型 ──────────────────────────────────────────────────────

/** 项目状态 */
export type ProjectStatus =
  | 'idea' // 模糊想法阶段
  | 'grill-me' // 需求澄清中
  | 'research' // 资料研究中
  | 'contract' // 创作契约阶段
  | 'planning' // 规划中
  | 'drafting' // 正文创作中
  | 'reviewing' // 审稿中
  | 'completed'; // 已完成

/** 任务状态 */
export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'STALE';

/** 任务类型 */
export type TaskType =
  | 'PROVIDER_CONNECTION_TEST'
  | 'MODEL_INVOCATION_TEST'
  | 'GRILL_QUESTION_PLAN'
  | 'CREATION_CONTRACT_DRAFT';

/** 模型调用状态 */
export type ModelInvocationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

// ── 状态转换 ──────────────────────────────────────────────────────

/** 允许的任务状态转换 */
const ALLOWED_TASK_TRANSITIONS = new Map<TaskStatus, Set<TaskStatus>>([
  ['PENDING', new Set<TaskStatus>(['RUNNING', 'CANCELLED', 'STALE'])],
  ['RUNNING', new Set<TaskStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'])],
  ['FAILED', new Set<TaskStatus>(['PENDING'])],
  ['CANCELLED', new Set<TaskStatus>(['PENDING'])],
  ['STALE', new Set<TaskStatus>(['PENDING'])],
]);

/**
 * 校验任务状态转换是否合法。
 *
 * 规则：
 * - PENDING -> RUNNING, CANCELLED, STALE
 * - RUNNING -> SUCCEEDED, FAILED, CANCELLED, STALE
 * - FAILED -> PENDING
 * - CANCELLED -> PENDING
 * - STALE -> PENDING
 * - 禁止从 terminal 状态恢复到 RUNNING 或 SUCCEEDED
 */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = ALLOWED_TASK_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * 断言任务状态转换合法。非法时抛出明确错误。
 */
export function assertValidTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTaskTransition(from, to)) {
    throw new Error(`非法任务状态转换: ${from} -> ${to}`);
  }
}

/** 允许的模型调用状态转换 */
const ALLOWED_INVOCATION_TRANSITIONS = new Map<ModelInvocationStatus, Set<ModelInvocationStatus>>([
  ['PENDING', new Set<ModelInvocationStatus>(['RUNNING', 'CANCELLED'])],
  ['RUNNING', new Set<ModelInvocationStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED'])],
]);

/**
 * 校验模型调用状态转换是否合法。
 */
export function isValidInvocationTransition(
  from: ModelInvocationStatus,
  to: ModelInvocationStatus,
): boolean {
  const allowed = ALLOWED_INVOCATION_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * 断言模型调用状态转换合法。
 */
export function assertValidInvocationTransition(
  from: ModelInvocationStatus,
  to: ModelInvocationStatus,
): void {
  if (!isValidInvocationTransition(from, to)) {
    throw new Error(`非法调用状态转换: ${from} -> ${to}`);
  }
}

/** 检查任务是否处于终态 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/** 检查调用是否处于终态 */
export function isTerminalInvocationStatus(status: ModelInvocationStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/** 决策范围 */
export type DecisionScope =
  | 'project' // 项目级决策
  | 'chapter' // 章节级决策
  | 'scene' // 场景级决策
  | 'line'; // 行级决策

// ── 接口 ──────────────────────────────────────────────────────────

/** 项目摘要 —— 用于列表展示，不含初始想法全文 */
export interface ProjectSummary {
  readonly id: ProjectId;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
}

/** 完整项目 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
}

/** 变更集 —— 跨模块更新的最小单位 */
export interface ChangeSet {
  readonly id: string;
  readonly scope: DecisionScope;
  readonly targetId: string;
  readonly changes: ReadonlyArray<ChangeEntry>;
  readonly createdAt: string;
  readonly reason: string;
}

/** 变更条目 */
export interface ChangeEntry {
  readonly field: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

// ── 验证函数 ──────────────────────────────────────────────────────

const MAX_PROJECT_NAME_LENGTH = 100;
const MAX_INITIAL_IDEA_LENGTH = 20_000;

/** 创建 ProjectId（验证，不生成） */
export function createProjectId(raw: string): ProjectId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('ProjectId 不能为空');
  }
  return raw as ProjectId;
}

/** 创建 ProviderProfileId（验证，不生成） */
export function createProviderProfileId(raw: string): ProviderProfileId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('ProviderProfileId 不能为空');
  }
  return raw as ProviderProfileId;
}

/**
 * 验证并创建 ProjectName。
 *
 * 规则：
 * - trim 后不能为空
 * - 最大 100 Unicode code points
 */
export function createProjectName(raw: string): ProjectName {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('项目名称不能为空');
  }
  const length = unicodeCodePointLength(trimmed);
  if (length > MAX_PROJECT_NAME_LENGTH) {
    throw new Error(`项目名称不能超过 ${MAX_PROJECT_NAME_LENGTH} 个字符（当前 ${length} 个）`);
  }
  return trimmed as ProjectName;
}

/**
 * 验证并创建 InitialIdea。
 *
 * 规则：
 * - trim 后不能为空
 * - 最大 20,000 Unicode code points
 */
export function createInitialIdea(raw: string): InitialIdea {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('初始想法不能为空');
  }
  const length = unicodeCodePointLength(trimmed);
  if (length > MAX_INITIAL_IDEA_LENGTH) {
    throw new Error(`初始想法不能超过 ${MAX_INITIAL_IDEA_LENGTH} 个字符（当前 ${length} 个）`);
  }
  return trimmed as InitialIdea;
}

/**
 * 创建 ChangeSet。
 *
 * id 和 createdAt 由调用方注入，domain 不负责随机 ID 生成。
 * 这样 Node 基础设施侧可用 crypto.randomUUID()，测试可注入固定值。
 */
export function createChangeSet(
  id: string,
  scope: DecisionScope,
  targetId: string,
  changes: ReadonlyArray<ChangeEntry>,
  reason: string,
  createdAt: string,
): ChangeSet {
  if (!id || id.trim().length === 0) {
    throw new Error('ChangeSet id 不能为空');
  }
  return { id, scope, targetId, changes, createdAt, reason };
}

// ── Grill-me 领域模型 ─────────────────────────────────────────────

export * from './grill.js';
export * from './grill-question-plan.js';

// ── 创作契约领域模型 ─────────────────────────────────────────────

export * from './creation-contract.js';

// ── 稿件 / 章节 / 章节版本领域模型 ────────────────────────────────

export * from './manuscript.js';

// ── Idea-to-Novel Graph 定义与转移 ───────────────────────────────

export * from './idea-to-novel-graph.js';
export * from './idea-to-novel-graph-state.js';
export * from './idea-to-novel-graph-state-validation.js';
export * from './idea-to-novel-graph-invalidation.js';
export * from './idea-to-novel-graph-transitions.js';
export * from './idea-to-novel-graph-stages.js';
export * from './idea-to-novel-graph-validator.js';
export * from './story-blueprint.js';
