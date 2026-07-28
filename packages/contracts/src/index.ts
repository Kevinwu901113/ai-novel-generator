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
