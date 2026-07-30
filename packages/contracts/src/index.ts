/**
 * @ai-novel/contracts
 *
 * Main、Preload、Renderer 和 Worker 共用的 IPC 类型及运行时验证边界。
 *
 * 设计原则：
 * - 所有进程共享此包
 * - 只包含类型定义和验证函数
 * - 不暴露内部绝对路径给 Renderer
 * - 不暴露堆栈信息给 Renderer
 */

// ── 错误码 ────────────────────────────────────────────────────────

/** 应用错误码 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_DIRECTORY_MISSING'
  | 'PROJECT_DATABASE_INVALID'
  | 'DATABASE_VERSION_UNSUPPORTED'
  | 'PROJECT_CREATE_FAILED'
  | 'WORKER_UNAVAILABLE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'API_KEY_REQUIRED'
  | 'API_KEY_STORE_FAILED'
  | 'API_KEY_READ_FAILED'
  | 'API_KEY_DELETE_FAILED'
  | 'PROVIDER_CONNECTION_FAILED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_ACCESS_DENIED'
  | 'PROVIDER_MODEL_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'NETWORK_UNAVAILABLE'
  | 'TASK_NOT_FOUND'
  | 'TASK_STATE_CONFLICT'
  | 'TASK_INTERRUPTED'
  | 'TASK_EXECUTION_FAILED'
  | 'INVOCATION_INTERRUPTED'
  | 'MODEL_RESPONSE_INVALID'
  | 'GRILL_SESSION_NOT_FOUND'
  | 'GRILL_QUESTION_NOT_FOUND'
  | 'GRILL_ANSWER_NOT_FOUND'
  | 'GRILL_PROPOSAL_NOT_FOUND'
  | 'GRILL_STATE_CONFLICT'
  | 'GRILL_VERSION_CONFLICT'
  | 'GRILL_OWNERSHIP_CONFLICT'
  | 'GRILL_VALIDATION_ERROR'
  | 'GRILL_PLAN_ALREADY_RUNNING'
  | 'GRILL_PLAN_STALE'
  | 'GRILL_PLAN_SCHEMA_INVALID'
  | 'GRILL_PLAN_REFERENCE_INVALID'
  | 'GRILL_PLAN_CYCLE_DETECTED'
  | 'GRILL_PLAN_PROPOSAL_NOT_FOUND'
  | 'GRILL_PLAN_PROPOSAL_NOT_ACCEPTABLE'
  | 'CONTRACT_VERSION_CONFLICT'
  | 'CONTRACT_PROPOSAL_STALE'
  | 'CONTRACT_PROPOSAL_NOT_FOUND'
  | 'CONTRACT_PROPOSAL_NOT_ACCEPTABLE'
  | 'CONTRACT_LOCK_CONFLICT'
  | 'CONTRACT_MODEL_LOCK_VIOLATION'
  | 'CONTRACT_SCHEMA_UNSUPPORTED'
  | 'CONTRACT_VALIDATION_FAILED'
  | 'INTERNAL_ERROR';

/** 结构化应用错误 —— 返回给 Renderer，不含堆栈和绝对路径 */
export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
}

// ── 健康检查 ──────────────────────────────────────────────────────

/** 健康检查响应 */
export interface HealthCheckResponse {
  readonly ok: boolean;
  readonly timestamp: string;
  readonly version: string;
}

// ── 项目 IPC 类型 ─────────────────────────────────────────────────

/** 创建项目输入 */
export interface CreateProjectInput {
  readonly name: string;
  readonly initialIdea: string;
}

/** 创建项目结果 —— 返回给 Renderer 的安全数据 */
export interface CreateProjectResult {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目列表项 —— 不含初始想法全文和绝对路径 */
export interface ProjectListItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
  readonly isMissing: boolean;
}

/** 项目列表结果 */
export type ListProjectsResult = ReadonlyArray<ProjectListItem>;

/** 打开项目输入 */
export interface OpenProjectInput {
  readonly projectId: string;
}

/** 打开项目结果 */
export interface OpenProjectResult {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
}

// ── 提供商类型 ─────────────────────────────────────────────────────

/** 提供商类型 */
export type ProviderType = 'anthropic-compatible';

/** 连接测试状态 */
export type ConnectionTestStatus = 'never' | 'success' | 'failed';

/** 提供商公开状态 —— 返回给 Renderer，不含 secret */
export interface ProviderPublicState {
  readonly id: string;
  readonly displayName: string;
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly hasApiKey: boolean;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: ConnectionTestStatus;
  readonly lastTestErrorCode: string | null;
  readonly lastTestLatencyMs: number | null;
}

/** 连接测试结果 */
export interface ConnectionTestResult {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** 保存 API Key 输入 */
export interface SaveApiKeyInput {
  readonly apiKey: string;
}

// ── 任务类型 ──────────────────────────────────────────────────────

/** 任务公开数据 —— 返回给 Renderer，不含 prompt、API Key 或完整响应 */
export interface TaskPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly result: unknown | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** 创建模型调用测试输入 */
export interface CreateModelInvocationTestInput {
  readonly projectId: string;
  readonly prompt: string;
}

/** 任务统计公开数据 */
export interface TaskStatsPublicData {
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
}

// ── IPC 频道 ──────────────────────────────────────────────────────

/** IPC 频道定义 */
export const IPC_CHANNELS = {
  HEALTH_CHECK: 'ipc:health-check',
  PROJECT_CREATE: 'ipc:project-create',
  PROJECT_LIST: 'ipc:project-list',
  PROJECT_OPEN: 'ipc:project-open',
  PROVIDER_GET_STATE: 'ipc:provider-get-state',
  PROVIDER_SAVE_API_KEY: 'ipc:provider-save-api-key',
  PROVIDER_DELETE_API_KEY: 'ipc:provider-delete-api-key',
  PROVIDER_TEST_CONNECTION: 'ipc:provider-test-connection',
  TASK_CREATE_MODEL_INVOCATION_TEST: 'ipc:task-create-model-invocation-test',
  TASK_GET: 'ipc:task-get',
  TASK_LIST: 'ipc:task-list',
  TASK_GET_STATS: 'ipc:task-get-stats',
  GRILL_CREATE_SESSION: 'ipc:grill-create-session',
  GRILL_GET_SESSION: 'ipc:grill-get-session',
  GRILL_LIST_SESSIONS: 'ipc:grill-list-sessions',
  GRILL_LIST_QUESTIONS: 'ipc:grill-list-questions',
  GRILL_START_SESSION: 'ipc:grill-start-session',
  GRILL_PAUSE_SESSION: 'ipc:grill-pause-session',
  GRILL_RESUME_SESSION: 'ipc:grill-resume-session',
  GRILL_COMPLETE_SESSION: 'ipc:grill-complete-session',
  GRILL_ABANDON_SESSION: 'ipc:grill-abandon-session',
  GRILL_ADD_QUESTIONS: 'ipc:grill-add-questions',
  GRILL_MARK_QUESTION_ASKED: 'ipc:grill-mark-question-asked',
  GRILL_ANSWER_QUESTION: 'ipc:grill-answer-question',
  GRILL_SKIP_QUESTION: 'ipc:grill-skip-question',
  GRILL_SUPERSEDE_QUESTION: 'ipc:grill-supersede-question',
  GRILL_GET_CURRENT_ANSWERS: 'ipc:grill-get-current-answers',
  GRILL_LIST_ANSWER_HISTORY: 'ipc:grill-list-answer-history',
  GRILL_CREATE_PROPOSAL: 'ipc:grill-create-proposal',
  GRILL_REVIEW_PROPOSAL: 'ipc:grill-review-proposal',
  GRILL_LIST_PROPOSALS: 'ipc:grill-list-proposals',
  GRILL_REQUEST_QUESTION_PLAN: 'ipc:grill-request-question-plan',
  GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL: 'ipc:grill-accept-question-plan-proposal',
  GRILL_LIST_QUESTION_PLAN_PROPOSALS: 'ipc:grill-list-question-plan-proposals',
  GRILL_GET_QUESTION_PLAN_PROPOSAL: 'ipc:grill-get-question-plan-proposal',
} as const;

// ── 桌面 API ──────────────────────────────────────────────────────

/** 任务 API */
export interface TasksAPI {
  createModelInvocationTest(input: CreateModelInvocationTestInput): Promise<TaskPublicData>;
  get(projectId: string, taskId: string): Promise<TaskPublicData>;
  list(projectId: string): Promise<ReadonlyArray<TaskPublicData>>;
  getStats(projectId: string): Promise<TaskStatsPublicData>;
}

/** 项目 API */
export interface ProjectsAPI {
  create(input: CreateProjectInput): Promise<CreateProjectResult>;
  list(): Promise<ListProjectsResult>;
  open(projectId: string): Promise<OpenProjectResult>;
}

/** 提供商 API */
export interface ProviderAPI {
  getState(): Promise<ProviderPublicState>;
  saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState>;
  deleteApiKey(): Promise<ProviderPublicState>;
  testConnection(): Promise<ConnectionTestResult>;
}

/** 列出问题输入 */
export interface GrillListQuestionsInput {
  readonly projectId: string;
  readonly sessionId: string;
}

/** Grill-me API */
export interface GrillAPI {
  createSession(input: GrillCreateSessionInput): Promise<GrillSessionPublicData>;
  getSession(projectId: string, sessionId: string): Promise<GrillSessionPublicData>;
  listSessions(projectId: string): Promise<ReadonlyArray<GrillSessionPublicData>>;
  listQuestions(input: GrillListQuestionsInput): Promise<ReadonlyArray<GrillQuestionPublicData>>;
  startSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData>;
  pauseSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData>;
  resumeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData>;
  completeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData>;
  abandonSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData>;
  addQuestions(input: GrillAddQuestionsInput): Promise<ReadonlyArray<GrillQuestionPublicData>>;
  markQuestionAsked(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData>;
  answerQuestion(input: GrillAnswerQuestionInput): Promise<GrillAnswerPublicData>;
  skipQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData>;
  supersedeQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData>;
  getCurrentAnswers(
    projectId: string,
    sessionId: string,
  ): Promise<ReadonlyArray<GrillAnswerPublicData>>;
  listAnswerHistory(
    input: GrillListAnswerHistoryInput,
  ): Promise<ReadonlyArray<GrillAnswerPublicData>>;
  createProposal(input: GrillCreateProposalInput): Promise<GrillProposalPublicData>;
  reviewProposal(input: GrillReviewProposalInput): Promise<GrillProposalPublicData>;
  listProposals(input: GrillListProposalsInput): Promise<ReadonlyArray<GrillProposalPublicData>>;
  requestQuestionPlan(
    input: GrillRequestQuestionPlanInput,
  ): Promise<GrillRequestQuestionPlanResult>;
  acceptQuestionPlanProposal(
    input: GrillAcceptQuestionPlanProposalInput,
  ): Promise<ReadonlyArray<GrillQuestionPublicData>>;
  listQuestionPlanProposals(
    input: GrillListQuestionPlanProposalsInput,
  ): Promise<ReadonlyArray<GrillQuestionPlanProposalPublicData>>;
  getQuestionPlanProposal(
    input: GrillQuestionPlanProposalIdInput,
  ): Promise<GrillQuestionPlanProposalPublicData>;
}

/** 数据服务状态 */
export type DataServiceStatus = 'starting' | 'ready' | 'failed' | 'disconnected';

/** 数据服务状态响应 */
export interface DataServiceStatusResponse {
  readonly status: DataServiceStatus;
}

/** 桌面 API 接口 —— 通过 contextBridge 暴露给 Renderer */
export interface DesktopAPI {
  healthCheck(): Promise<HealthCheckResponse>;
  getDataServiceStatus(): Promise<DataServiceStatusResponse>;
  retryDataService(): Promise<DataServiceStatusResponse>;
  projects: ProjectsAPI;
  provider: ProviderAPI;
  tasks: TasksAPI;
  grill: GrillAPI;
}

// ── 运行时验证 ────────────────────────────────────────────────────

/** 验证健康检查响应结构 */
export function isValidHealthCheckResponse(data: unknown): data is HealthCheckResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.ok === 'boolean' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.version === 'string'
  );
}

/** 验证创建项目输入 */
export function isValidCreateProjectInput(data: unknown): data is CreateProjectInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.name === 'string' && typeof obj.initialIdea === 'string';
}

/** 验证打开项目输入 */
export function isValidOpenProjectInput(data: unknown): data is OpenProjectInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string';
}

/** 验证 AppError 结构 */
export function isAppError(data: unknown): data is AppError {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validCodes: ReadonlySet<string> = new Set([
    'VALIDATION_ERROR',
    'PROJECT_NOT_FOUND',
    'PROJECT_DIRECTORY_MISSING',
    'PROJECT_DATABASE_INVALID',
    'DATABASE_VERSION_UNSUPPORTED',
    'PROJECT_CREATE_FAILED',
    'WORKER_UNAVAILABLE',
    'PROVIDER_NOT_CONFIGURED',
    'API_KEY_REQUIRED',
    'API_KEY_STORE_FAILED',
    'API_KEY_READ_FAILED',
    'API_KEY_DELETE_FAILED',
    'PROVIDER_CONNECTION_FAILED',
    'PROVIDER_AUTH_FAILED',
    'PROVIDER_ACCESS_DENIED',
    'PROVIDER_MODEL_UNAVAILABLE',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RESPONSE_INVALID',
    'NETWORK_UNAVAILABLE',
    'TASK_NOT_FOUND',
    'TASK_STATE_CONFLICT',
    'TASK_INTERRUPTED',
    'TASK_EXECUTION_FAILED',
    'INVOCATION_INTERRUPTED',
    'MODEL_RESPONSE_INVALID',
    'GRILL_SESSION_NOT_FOUND',
    'GRILL_QUESTION_NOT_FOUND',
    'GRILL_ANSWER_NOT_FOUND',
    'GRILL_PROPOSAL_NOT_FOUND',
    'GRILL_STATE_CONFLICT',
    'GRILL_VERSION_CONFLICT',
    'GRILL_OWNERSHIP_CONFLICT',
    'GRILL_VALIDATION_ERROR',
    'GRILL_PLAN_ALREADY_RUNNING',
    'GRILL_PLAN_STALE',
    'GRILL_PLAN_SCHEMA_INVALID',
    'GRILL_PLAN_REFERENCE_INVALID',
    'GRILL_PLAN_CYCLE_DETECTED',
    'GRILL_PLAN_PROPOSAL_NOT_FOUND',
    'GRILL_PLAN_PROPOSAL_NOT_ACCEPTABLE',
    'CONTRACT_VERSION_CONFLICT',
    'CONTRACT_PROPOSAL_STALE',
    'CONTRACT_PROPOSAL_NOT_FOUND',
    'CONTRACT_PROPOSAL_NOT_ACCEPTABLE',
    'CONTRACT_LOCK_CONFLICT',
    'CONTRACT_MODEL_LOCK_VIOLATION',
    'CONTRACT_SCHEMA_UNSUPPORTED',
    'CONTRACT_VALIDATION_FAILED',
    'INTERNAL_ERROR',
  ]);
  return (
    typeof obj.code === 'string' && validCodes.has(obj.code) && typeof obj.message === 'string'
  );
}

/** 验证保存 API Key 输入 */
export function isValidSaveApiKeyInput(data: unknown): data is SaveApiKeyInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.apiKey === 'string';
}

/** 验证 ProviderPublicState 结构 */
export function isValidProviderPublicState(data: unknown): data is ProviderPublicState {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validProviderTypes: ReadonlySet<string> = new Set(['anthropic-compatible']);
  const validTestStatuses: ReadonlySet<string> = new Set(['never', 'success', 'failed']);
  return (
    typeof obj.id === 'string' &&
    typeof obj.displayName === 'string' &&
    typeof obj.providerType === 'string' &&
    validProviderTypes.has(obj.providerType) &&
    typeof obj.baseUrl === 'string' &&
    typeof obj.model === 'string' &&
    typeof obj.enabled === 'boolean' &&
    typeof obj.hasApiKey === 'boolean' &&
    (obj.lastTestedAt === null || typeof obj.lastTestedAt === 'string') &&
    typeof obj.lastTestStatus === 'string' &&
    validTestStatuses.has(obj.lastTestStatus) &&
    (obj.lastTestErrorCode === null || typeof obj.lastTestErrorCode === 'string') &&
    (obj.lastTestLatencyMs === null || typeof obj.lastTestLatencyMs === 'number')
  );
}

/** 验证 ConnectionTestResult 结构 */
export function isValidConnectionTestResult(data: unknown): data is ConnectionTestResult {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.success === 'boolean' &&
    typeof obj.latencyMs === 'number' &&
    (obj.errorCode === null || typeof obj.errorCode === 'string') &&
    (obj.errorMessage === null || typeof obj.errorMessage === 'string')
  );
}

/** 验证 CreateModelInvocationTestInput 结构 */
export function isValidCreateModelInvocationTestInput(
  data: unknown,
): data is CreateModelInvocationTestInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.prompt === 'string';
}

/** 验证 TaskPublicData 结构 */
export function isValidTaskPublicData(data: unknown): data is TaskPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validStatuses: ReadonlySet<string> = new Set([
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'STALE',
  ]);
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.taskType === 'string' &&
    typeof obj.status === 'string' &&
    validStatuses.has(obj.status) &&
    typeof obj.attemptCount === 'number' &&
    (obj.errorCode === null || typeof obj.errorCode === 'string') &&
    (obj.errorMessage === null || typeof obj.errorMessage === 'string') &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string' &&
    (obj.startedAt === null || typeof obj.startedAt === 'string') &&
    (obj.finishedAt === null || typeof obj.finishedAt === 'string')
  );
}

/** 验证 TaskStatsPublicData 结构 */
export function isValidTaskStatsPublicData(data: unknown): data is TaskStatsPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.invocationCount === 'number' &&
    typeof obj.succeededCount === 'number' &&
    typeof obj.failedCount === 'number' &&
    typeof obj.totalInputTokens === 'number' &&
    typeof obj.totalOutputTokens === 'number' &&
    typeof obj.totalTokens === 'number' &&
    typeof obj.totalLatencyMs === 'number'
  );
}

// ── Grill-me 类型 ─────────────────────────────────────────────────

/** 创建烧烤会话输入 */
export interface GrillCreateSessionInput {
  readonly projectId: string;
  readonly goal: string;
}

/** 烧烤会话 ID 输入 */
export interface GrillSessionIdInput {
  readonly projectId: string;
  readonly sessionId: string;
}

/** 烧烤会话版本输入 */
export interface GrillSessionVersionInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
}

/** 添加问题输入 */
export interface GrillAddQuestionsInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly questions: ReadonlyArray<{
    id?: string;
    topic: string;
    text: string;
    rationale: string;
    dependsOnQuestionIds: ReadonlyArray<string>;
  }>;
}

/** 回答问题输入 */
export interface GrillAnswerQuestionInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly questionId: string;
  readonly text: string;
  readonly source: 'USER' | 'IMPORTED';
}

/** 问题操作输入 */
export interface GrillQuestionActionInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly questionId: string;
}

/** 创建提案输入 */
export interface GrillCreateProposalInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
}

/** 审核提案输入 */
export interface GrillReviewProposalInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly proposalId: string;
  readonly decision: 'ACCEPTED' | 'REJECTED';
}

/** 列出提案输入 */
export interface GrillListProposalsInput {
  readonly projectId: string;
  readonly sessionId: string;
}

/** 列出答案历史输入 */
export interface GrillListAnswerHistoryInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly questionId: string;
}

/** 请求问题规划输入 */
export interface GrillRequestQuestionPlanInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedSessionVersion: number;
}

/** 接受问题规划提案输入 */
export interface GrillAcceptQuestionPlanProposalInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly expectedSessionVersion: number;
}

/** 列出问题规划提案输入 */
export interface GrillListQuestionPlanProposalsInput {
  readonly projectId: string;
  readonly sessionId: string;
}

/** 问题规划提案 ID 输入 */
export interface GrillQuestionPlanProposalIdInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly proposalId: string;
}

/** 烧烤会话公开数据 */
export interface GrillSessionPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly version: number;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly abandonedAt: string | null;
}

/** 烧烤问题公开数据 */
export interface GrillQuestionPublicData {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly status: string;
  readonly dependsOnQuestionIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly askedAt: string | null;
  readonly answeredAt: string | null;
  readonly skippedAt: string | null;
  readonly supersededAt: string | null;
}

/** 烧烤回答公开数据 */
export interface GrillAnswerPublicData {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly source: string;
  readonly text: string;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

/** 推理提案公开数据 */
export interface GrillProposalPublicData {
  readonly id: string;
  readonly sessionId: string;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValue: unknown;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: string;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

/** 请求问题规划结果 —— 仅含任务引用，不含任何模型结果 */
export interface GrillRequestQuestionPlanResult {
  readonly taskId: string;
  readonly sessionId: string;
  readonly baseSessionVersion: number;
}

/** 规划问题依赖公开数据 */
export interface GrillPlannedDependencyPublicData {
  readonly kind: 'existing' | 'planned';
  readonly questionId?: string;
  readonly questionKey?: string;
}

/** 规划问题公开数据（经验证的规范化计划项） */
export interface GrillPlannedQuestionPublicData {
  readonly key: string;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly dependencies: ReadonlyArray<GrillPlannedDependencyPublicData>;
}

/** 问题规划提案公开数据 —— 仅含经验证的规范化计划，不含原始模型输出 */
export interface GrillQuestionPlanProposalPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly status: string;
  readonly questions: ReadonlyArray<GrillPlannedQuestionPublicData>;
  readonly questionCount: number;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

// ── Grill-me 运行时验证 ───────────────────────────────────────────

export function isValidGrillCreateSessionInput(data: unknown): data is GrillCreateSessionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.goal === 'string';
}

export function isValidGrillSessionIdInput(data: unknown): data is GrillSessionIdInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.sessionId === 'string';
}

export function isValidGrillSessionVersionInput(data: unknown): data is GrillSessionVersionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.expectedVersion === 'number'
  );
}

export function isValidGrillAddQuestionsInput(data: unknown): data is GrillAddQuestionsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    typeof obj.projectId !== 'string' ||
    typeof obj.sessionId !== 'string' ||
    typeof obj.expectedVersion !== 'number' ||
    !Array.isArray(obj.questions)
  ) {
    return false;
  }
  return obj.questions.every(
    (q: unknown) =>
      typeof q === 'object' &&
      q !== null &&
      ((q as Record<string, unknown>).id === undefined ||
        typeof (q as Record<string, unknown>).id === 'string') &&
      typeof (q as Record<string, unknown>).topic === 'string' &&
      typeof (q as Record<string, unknown>).text === 'string' &&
      typeof (q as Record<string, unknown>).rationale === 'string' &&
      Array.isArray((q as Record<string, unknown>).dependsOnQuestionIds),
  );
}

export function isValidGrillAnswerQuestionInput(data: unknown): data is GrillAnswerQuestionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validSources: ReadonlySet<string> = new Set(['USER', 'IMPORTED']);
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.expectedVersion === 'number' &&
    typeof obj.questionId === 'string' &&
    typeof obj.text === 'string' &&
    typeof obj.source === 'string' &&
    validSources.has(obj.source)
  );
}

export function isValidGrillQuestionActionInput(data: unknown): data is GrillQuestionActionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.expectedVersion === 'number' &&
    typeof obj.questionId === 'string'
  );
}

export function isValidGrillCreateProposalInput(data: unknown): data is GrillCreateProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.expectedVersion === 'number' &&
    Array.isArray(obj.basedOnAnswerIds) &&
    typeof obj.key === 'string' &&
    typeof obj.proposedValueJson === 'string' &&
    typeof obj.confidence === 'number' &&
    typeof obj.rationale === 'string'
  );
}

export function isValidGrillReviewProposalInput(data: unknown): data is GrillReviewProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validDecisions: ReadonlySet<string> = new Set(['ACCEPTED', 'REJECTED']);
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.expectedVersion === 'number' &&
    typeof obj.proposalId === 'string' &&
    typeof obj.decision === 'string' &&
    validDecisions.has(obj.decision)
  );
}

export function isValidGrillListProposalsInput(data: unknown): data is GrillListProposalsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.sessionId === 'string';
}

export function isValidGrillListQuestionsInput(data: unknown): data is GrillListQuestionsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.sessionId === 'string';
}

export function isValidGrillListAnswerHistoryInput(
  data: unknown,
): data is GrillListAnswerHistoryInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.questionId === 'string'
  );
}

// ── Grill 问题规划器严格验证 ──────────────────────────────────────

/** 规划器 ID 字段长度上限（Unicode code points） */
const PLANNER_MAX_ID_LENGTH = 128;

function plannerCodePointLength(str: string): number {
  return [...str].length;
}

/** 严格 ID：非空、trim 后非空、长度不超过上限 */
function isPlannerId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return plannerCodePointLength(trimmed) <= PLANNER_MAX_ID_LENGTH;
}

/** 严格版本：安全整数且 >= 1（拒绝 NaN/Infinity/0/负数/小数） */
function isPlannerVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 拒绝额外字段 */
function hasOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(obj).every((key) => allowedSet.has(key));
}

export function isValidGrillRequestQuestionPlanInput(
  data: unknown,
): data is GrillRequestQuestionPlanInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasOnlyKeys(obj, ['projectId', 'sessionId', 'expectedSessionVersion'])) return false;
  return (
    isPlannerId(obj.projectId) &&
    isPlannerId(obj.sessionId) &&
    isPlannerVersion(obj.expectedSessionVersion)
  );
}

export function isValidGrillAcceptQuestionPlanProposalInput(
  data: unknown,
): data is GrillAcceptQuestionPlanProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasOnlyKeys(obj, ['projectId', 'sessionId', 'proposalId', 'expectedSessionVersion'])) {
    return false;
  }
  return (
    isPlannerId(obj.projectId) &&
    isPlannerId(obj.sessionId) &&
    isPlannerId(obj.proposalId) &&
    isPlannerVersion(obj.expectedSessionVersion)
  );
}

export function isValidGrillListQuestionPlanProposalsInput(
  data: unknown,
): data is GrillListQuestionPlanProposalsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasOnlyKeys(obj, ['projectId', 'sessionId'])) return false;
  return isPlannerId(obj.projectId) && isPlannerId(obj.sessionId);
}

export function isValidGrillQuestionPlanProposalIdInput(
  data: unknown,
): data is GrillQuestionPlanProposalIdInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasOnlyKeys(obj, ['projectId', 'sessionId', 'proposalId'])) return false;
  return isPlannerId(obj.projectId) && isPlannerId(obj.sessionId) && isPlannerId(obj.proposalId);
}

// ── 创作契约 DTO ────────────────────────────────────────────────

/** 创作契约 sections 公开数据 —— 解析后的 typed sections，不含原始 JSON */
export interface CreationContractSectionsPublicData {
  readonly premise: string;
  readonly genre: ReadonlyArray<string>;
  readonly tone: ReadonlyArray<string>;
  readonly themes?: ReadonlyArray<string>;
  readonly targetAudience: string;
  readonly narrativePov: 'FIRST' | 'THIRD_LIMITED' | 'THIRD_OMNISCIENT' | 'SECOND' | 'OTHER';
  readonly tense: 'PAST' | 'PRESENT' | 'MIXED';
  readonly targetLength?: { readonly unit: 'words' | 'chapters'; readonly value: number };
  readonly structure?: string;
  readonly protagonist: {
    readonly characterKey: string;
    readonly name: string;
    readonly role?: string;
    readonly motivation?: string;
    readonly arc?: string;
    readonly traits?: ReadonlyArray<string>;
  };
  readonly supportingCharacters?: ReadonlyArray<{
    readonly characterKey: string;
    readonly name: string;
    readonly role?: string;
    readonly relationship?: string;
    readonly traits?: ReadonlyArray<string>;
  }>;
  readonly relationships?: ReadonlyArray<{
    readonly relationshipKey: string;
    readonly fromCharacterKey: string;
    readonly toCharacterKey: string;
    readonly type: string;
    readonly dynamic?: string;
  }>;
  readonly worldRules?: ReadonlyArray<string>;
  readonly mustInclude?: ReadonlyArray<string>;
  readonly mustAvoid?: ReadonlyArray<string>;
  readonly contentBoundaries?: {
    readonly rating?: string;
    readonly allowedContent?: ReadonlyArray<string>;
    readonly prohibitedContent?: ReadonlyArray<string>;
    readonly notes?: string;
  };
  readonly unresolvedQuestions?: ReadonlyArray<string>;
}

/** 创作契约版本公开数据 —— 返回给调用方的安全数据 */
export interface ContractVersionPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly sourceProposalId: string | null;
  readonly basedOnGrillSessionId: string | null;
  readonly basedOnGrillSessionVersion: number | null;
  readonly sections: CreationContractSectionsPublicData;
  readonly lockedFieldPaths: ReadonlyArray<string>;
  readonly contractSnapshotHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** 创作契约版本摘要 —— 列表展示用 */
export interface ContractVersionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly contractSnapshotHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** 创作契约提案公开数据 */
export interface ProposalPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly status: string;
  readonly baseGrillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly schemaVersion: number;
  readonly sections: CreationContractSectionsPublicData;
  readonly sectionsHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创作契约基线引用 DTO */
export interface ContractBaselineRefPublicData {
  readonly contractVersionId: string | null;
  readonly contractVersion: number | null;
  readonly contractSnapshotHash: string | null;
}

/** 查询当前创作契约输入 */
export interface GetCurrentCreationContractInput {
  readonly projectId: string;
}

/** 列出创作契约版本输入 */
export interface ListCreationContractVersionsInput {
  readonly projectId: string;
}

/** 获取创作契约提案输入 */
export interface GetCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
}

/** 列出创作契约提案输入 */
export interface ListCreationContractProposalsInput {
  readonly projectId: string;
}

// ── 创作契约 ContractPatchOperation DTO ─────────────────────────

/** DTO 版 ContractPatchOperation —— IPC 传输用，无 branded type */
export type ContractPatchOperationDTO =
  | ContractPatchSetScalarDTO
  | ContractPatchSetStringListDTO
  | ContractPatchSetStructuredDTO
  | ContractPatchRemoveFieldDTO
  | ContractPatchUpsertProtagonistDTO
  | ContractPatchUpsertSupportingCharacterDTO
  | ContractPatchUpsertRelationshipDTO
  | ContractPatchRemoveCharacterDTO
  | ContractPatchRemoveRelationshipDTO;

export interface ContractPatchSetScalarDTO {
  readonly kind: 'set-scalar';
  readonly path: string;
  readonly value: string | number;
}

export interface ContractPatchSetStringListDTO {
  readonly kind: 'set-string-list';
  readonly path: string;
  readonly value: ReadonlyArray<string>;
}

export interface ContractPatchSetStructuredDTO {
  readonly kind: 'set-structured';
  readonly path: '/targetLength' | '/contentBoundaries';
  readonly value: unknown;
}

export interface ContractPatchRemoveFieldDTO {
  readonly kind: 'remove-field';
  readonly path: string;
}

export interface ContractPatchUpsertProtagonistDTO {
  readonly kind: 'upsert-protagonist';
  readonly value: unknown;
}

export interface ContractPatchUpsertSupportingCharacterDTO {
  readonly kind: 'upsert-supporting-character';
  readonly target: string;
  readonly value: unknown;
}

export interface ContractPatchUpsertRelationshipDTO {
  readonly kind: 'upsert-relationship';
  readonly target: string;
  readonly value: unknown;
}

export interface ContractPatchRemoveCharacterDTO {
  readonly kind: 'remove-character';
  readonly target: string;
}

export interface ContractPatchRemoveRelationshipDTO {
  readonly kind: 'remove-relationship';
  readonly target: string;
}

// ── 创作契约 Mutation DTO ───────────────────────────────────────

/** 接受创作契约提案输入 */
export interface AcceptCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
  readonly expectedGrillSessionVersion: number;
  readonly expectedContractVersion: number | null;
  readonly operations: ReadonlyArray<ContractPatchOperationDTO>;
}

/** 拒绝创作契约提案输入 */
export interface RejectCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
}

/** 锁定创作契约字段输入 */
export interface LockCreationContractFieldInput {
  readonly projectId: string;
  readonly fieldPath: string;
  readonly expectedContractVersion: number;
}

/** 解锁创作契约字段输入 */
export interface UnlockCreationContractFieldInput {
  readonly projectId: string;
  readonly fieldPath: string;
  readonly expectedContractVersion: number;
}

/** 用户直接编辑创作契约输入 */
export interface UpdateCreationContractByUserInput {
  readonly projectId: string;
  readonly expectedContractVersion: number;
  readonly operations: ReadonlyArray<ContractPatchOperationDTO>;
}

/** 请求创作契约提案输入（触发 AI task） */
export interface RequestCreationContractProposalInput {
  readonly projectId: string;
  readonly expectedGrillSessionVersion: number;
}

// ── 创作契约 IPC 频道 ───────────────────────────────────────────

export const CONTRACT_IPC_CHANNELS = {
  GET_CURRENT: 'ipc:contract-get-current',
  LIST_VERSIONS: 'ipc:contract-list-versions',
  GET_PROPOSAL: 'ipc:contract-get-proposal',
  LIST_PROPOSALS: 'ipc:contract-list-proposals',
  ACCEPT_PROPOSAL: 'ipc:contract-accept-proposal',
  REJECT_PROPOSAL: 'ipc:contract-reject-proposal',
  LOCK_FIELD: 'ipc:contract-lock-field',
  UNLOCK_FIELD: 'ipc:contract-unlock-field',
  UPDATE_BY_USER: 'ipc:contract-update-by-user',
  REQUEST_PROPOSAL: 'ipc:contract-request-proposal',
} as const;

// ── 创作契约 ContractAPI ────────────────────────────────────────

/** 创作契约 API —— 通过 contextBridge 暴露给 Renderer */
export interface ContractAPI {
  getCurrent(input: GetCurrentCreationContractInput): Promise<ContractVersionPublicData | null>;
  listVersions(
    input: ListCreationContractVersionsInput,
  ): Promise<ReadonlyArray<ContractVersionSummary>>;
  getProposal(input: GetCreationContractProposalInput): Promise<ProposalPublicData>;
  listProposals(
    input: ListCreationContractProposalsInput,
  ): Promise<ReadonlyArray<ProposalPublicData>>;
  acceptProposal(input: AcceptCreationContractProposalInput): Promise<ContractVersionPublicData>;
  rejectProposal(input: RejectCreationContractProposalInput): Promise<ProposalPublicData>;
  lockField(input: LockCreationContractFieldInput): Promise<ContractVersionPublicData>;
  unlockField(input: UnlockCreationContractFieldInput): Promise<ContractVersionPublicData>;
  updateByUser(input: UpdateCreationContractByUserInput): Promise<ContractVersionPublicData>;
  requestProposal(
    input: RequestCreationContractProposalInput,
  ): Promise<{ readonly taskId: string }>;
}

// ── 创作契约 DTO 运行时验证 ─────────────────────────────────────

const VALID_NARRATIVE_POV: ReadonlySet<string> = new Set([
  'FIRST',
  'THIRD_LIMITED',
  'THIRD_OMNISCIENT',
  'SECOND',
  'OTHER',
]);
const VALID_TENSE: ReadonlySet<string> = new Set(['PAST', 'PRESENT', 'MIXED']);
const VALID_TARGET_LENGTH_UNIT: ReadonlySet<string> = new Set(['words', 'chapters']);
const VALID_PROPOSAL_STATUS: ReadonlySet<string> = new Set([
  'PROPOSED',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
  'STALE',
]);
const VALID_CREATED_BY: ReadonlySet<string> = new Set([
  'user',
  'ai-proposal-accepted',
  'lock',
  'unlock',
]);
const VALID_PATCH_KINDS: ReadonlySet<string> = new Set([
  'set-scalar',
  'set-string-list',
  'set-structured',
  'remove-field',
  'upsert-protagonist',
  'upsert-supporting-character',
  'upsert-relationship',
  'remove-character',
  'remove-relationship',
]);

export function isValidContractPatchOperationDTO(data: unknown): data is ContractPatchOperationDTO {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !VALID_PATCH_KINDS.has(obj.kind)) return false;
  switch (obj.kind) {
    case 'set-scalar':
      return (
        typeof obj.path === 'string' &&
        (typeof obj.value === 'string' || typeof obj.value === 'number')
      );
    case 'set-string-list':
      return (
        typeof obj.path === 'string' &&
        Array.isArray(obj.value) &&
        (obj.value as unknown[]).every((v) => typeof v === 'string')
      );
    case 'set-structured':
      return (
        (obj.path === '/targetLength' || obj.path === '/contentBoundaries') &&
        obj.value !== null &&
        typeof obj.value === 'object'
      );
    case 'remove-field':
      return typeof obj.path === 'string';
    case 'upsert-protagonist':
      return typeof obj.value === 'object' && obj.value !== null;
    case 'upsert-supporting-character':
    case 'upsert-relationship':
    case 'remove-character':
    case 'remove-relationship':
      return typeof obj.target === 'string';
    default:
      return false;
  }
}

export function isValidContractPatchOperationsDTO(
  data: unknown,
): data is ReadonlyArray<ContractPatchOperationDTO> {
  if (!Array.isArray(data)) return false;
  return data.every(isValidContractPatchOperationDTO);
}

export function isValidAcceptCreationContractProposalInput(
  data: unknown,
): data is AcceptCreationContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.proposalId === 'string' &&
    typeof obj.expectedProposalSectionsHash === 'string' &&
    typeof obj.expectedGrillSessionVersion === 'number' &&
    (obj.expectedContractVersion === null || typeof obj.expectedContractVersion === 'number') &&
    isValidContractPatchOperationsDTO(obj.operations)
  );
}

export function isValidRejectCreationContractProposalInput(
  data: unknown,
): data is RejectCreationContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.proposalId === 'string' &&
    typeof obj.expectedProposalSectionsHash === 'string'
  );
}

export function isValidLockCreationContractFieldInput(
  data: unknown,
): data is LockCreationContractFieldInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.fieldPath === 'string' &&
    typeof obj.expectedContractVersion === 'number'
  );
}

export function isValidUnlockCreationContractFieldInput(
  data: unknown,
): data is UnlockCreationContractFieldInput {
  return isValidLockCreationContractFieldInput(data);
}

export function isValidUpdateCreationContractByUserInput(
  data: unknown,
): data is UpdateCreationContractByUserInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    typeof obj.expectedContractVersion === 'number' &&
    isValidContractPatchOperationsDTO(obj.operations)
  );
}

export function isValidRequestCreationContractProposalInput(
  data: unknown,
): data is RequestCreationContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' && typeof obj.expectedGrillSessionVersion === 'number'
  );
}

export function isValidCreationContractSectionsPublicData(
  data: unknown,
): data is CreationContractSectionsPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.premise !== 'string') return false;
  if (!Array.isArray(obj.genre) || !obj.genre.every((v: unknown) => typeof v === 'string'))
    return false;
  if (!Array.isArray(obj.tone) || !obj.tone.every((v: unknown) => typeof v === 'string'))
    return false;
  if (obj.themes !== undefined && !Array.isArray(obj.themes)) return false;
  if (typeof obj.targetAudience !== 'string') return false;
  if (typeof obj.narrativePov !== 'string' || !VALID_NARRATIVE_POV.has(obj.narrativePov))
    return false;
  if (typeof obj.tense !== 'string' || !VALID_TENSE.has(obj.tense)) return false;
  if (obj.targetLength !== undefined) {
    if (typeof obj.targetLength !== 'object' || obj.targetLength === null) return false;
    const tl = obj.targetLength as Record<string, unknown>;
    if (typeof tl.unit !== 'string' || !VALID_TARGET_LENGTH_UNIT.has(tl.unit)) return false;
    if (typeof tl.value !== 'number') return false;
  }
  if (obj.structure !== undefined && typeof obj.structure !== 'string') return false;
  if (typeof obj.protagonist !== 'object' || obj.protagonist === null) return false;
  const prot = obj.protagonist as Record<string, unknown>;
  if (typeof prot.characterKey !== 'string' || typeof prot.name !== 'string') return false;
  return true;
}

export function isValidContractVersionPublicData(
  data: unknown,
): data is ContractVersionPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.version === 'number' &&
    typeof obj.schemaVersion === 'number' &&
    (obj.sourceProposalId === null || typeof obj.sourceProposalId === 'string') &&
    (obj.basedOnGrillSessionId === null || typeof obj.basedOnGrillSessionId === 'string') &&
    (obj.basedOnGrillSessionVersion === null || typeof obj.basedOnGrillSessionVersion === 'number') &&
    isValidCreationContractSectionsPublicData(obj.sections) &&
    Array.isArray(obj.lockedFieldPaths) &&
    typeof obj.contractSnapshotHash === 'string' &&
    typeof obj.createdAt === 'string' &&
    typeof obj.createdBy === 'string' &&
    VALID_CREATED_BY.has(obj.createdBy)
  );
}

export function isValidProposalPublicData(data: unknown): data is ProposalPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.taskId === 'string' &&
    typeof obj.invocationId === 'string' &&
    typeof obj.status === 'string' &&
    VALID_PROPOSAL_STATUS.has(obj.status) &&
    typeof obj.baseGrillSessionId === 'string' &&
    typeof obj.baseGrillSessionVersion === 'number' &&
    (obj.baseContractVersion === null || typeof obj.baseContractVersion === 'number') &&
    typeof obj.schemaVersion === 'number' &&
    isValidCreationContractSectionsPublicData(obj.sections) &&
    typeof obj.sectionsHash === 'string' &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string'
  );
}
