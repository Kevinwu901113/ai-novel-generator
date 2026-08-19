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

import { isBoundedTrimmedId, hasRequiredExactKeys } from './idea-to-novel-graph.js';
import type {
  GraphProgressProjectionDto,
  GraphRunKind,
  RunTerminalStatusDto,
} from './idea-to-novel-graph.js';

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
  | 'SEARCH_KEY_REQUIRED'
  | 'SEARCH_KEY_READ_FAILED'
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
  | 'CONTRACT_DRAFT_ALREADY_RUNNING'
  | 'MANUSCRIPT_NOT_FOUND'
  | 'MANUSCRIPT_STATE_CONFLICT'
  | 'MANUSCRIPT_VERSION_CONFLICT'
  | 'MANUSCRIPT_POSITION_OVERFLOW'
  | 'CHAPTER_NOT_FOUND'
  | 'CHAPTER_VERSION_NOT_FOUND'
  | 'GRAPH_RUN_NOT_FOUND'
  | 'GRAPH_RUN_VERSION_CONFLICT'
  | 'GRAPH_RUN_STATE_CONFLICT'
  | 'GRAPH_RUN_VALIDATION_ERROR'
  | 'GRAPH_RUN_IDEMPOTENCY_CONFLICT'
  | 'GRAPH_RUN_INTERRUPTED'
  | 'NODE_EXECUTION_NOT_FOUND'
  | 'NODE_EXECUTION_STATE_CONFLICT'
  | 'NODE_EXECUTION_IDENTITY_MISMATCH'
  | 'NODE_EXECUTOR_UNAVAILABLE'
  | 'NODE_SETTLEMENT_ARTIFACT_INVALID'
  | 'NODE_SETTLEMENT_ARTIFACT_MISSING'
  | 'NODE_SETTLEMENT_STALE_INPUT'
  | 'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED'
  | 'INTERNAL_ERROR';

/** 结构化应用错误 —— 返回给 Renderer，不含堆栈和绝对路径 */
export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
}

// ── IPC 错误码传输编码 ────────────────────────────────────────────
//
// Electron 的 ipcMain.handle 只把 handler 抛出错误的 `error.toString()`
// 回传给调用方（preload → renderer）：抛出的 Error 上挂的自定义 `.code`
// 属性在这一跳就已丢失，renderer 侧拿到的是重建的纯 Error，message 形如：
//   Error invoking remote method '<channel>': Error: <原 message>
// （Electron 43.2.0 实测确认。）因此 main 侧改为把 code 编进 message 文本
// 传输，renderer 侧用固定格式的正则解码。编码/解码格式集中定义于此，
// main 与 renderer 共用同一份运行时实现，避免两处字面量各自维护而漂移。
//
// B13 注：Electron 已退役。HTTP 信封 {error:{code,message}} 结构化携带 code，
// desktop-client 把 code 直挂 Error.code，safe-error 优先读 .code——本编码层
// 只剩 message 兜底解码在用，整层清理登记为 TD-036。

/** 编码段格式：`[CODE:XXX_YYY]`，仅允许大写字母、数字、下划线。 */
const ERROR_CODE_PATTERN = /\[CODE:([A-Z0-9_]+)\]/;

/** 把错误码编入 message，供跨 IPC 边界传输（Electron 会丢失 Error 的自定义属性）。 */
export function encodeErrorCode(code: string, message: string): string {
  return `[CODE:${code}] ${message}`;
}

/**
 * 从（可能被 Electron 包裹过的）message 中解码出错误码。
 * 未命中编码段，或编码段格式非法（含小写字母等），返回 null。
 */
export function decodeErrorCode(message: string): string | null {
  const match = ERROR_CODE_PATTERN.exec(message);
  return match ? match[1] : null;
}

/**
 * 从 message 中剥离 `[CODE:...]` 编码段，返回剩余展示文案（首尾空白已清理）。
 * 未命中编码段时原样返回（仅 trim），不改变既有展示行为。
 */
export function stripErrorCode(message: string): string {
  return message.replace(ERROR_CODE_PATTERN, '').trim();
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

/**
 * 提供商协议（D6：只做两种最小形态的协议适配）。
 *
 * - `anthropic-messages`：Anthropic Messages API（`POST {baseUrl}/v1/messages`）；
 * - `openai-chat`：OpenAI Chat Completions 兼容端点（`POST {baseUrl}/chat/completions`，
 *   覆盖 OpenAI / DeepSeek 等兼容服务）。
 *
 * 不做负载均衡、自动 fallback、流式与复杂路由。
 */
export type ProviderProtocol = 'anthropic-messages' | 'openai-chat';

export const PROVIDER_PROTOCOLS: ReadonlyArray<ProviderProtocol> = [
  'anthropic-messages',
  'openai-chat',
];

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'anthropic-messages' || value === 'openai-chat';
}

/** 连接测试状态 */
export type ConnectionTestStatus = 'never' | 'success' | 'failed';

/** 提供商公开状态 —— 返回给 Renderer，不含 secret */
export interface ProviderPublicState {
  readonly id: string;
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly enabled: boolean;
  /** 是否为全局默认 provider（D6 路由第一层） */
  readonly isDefault: boolean;
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

/** 保存 API Key 输入（每 profile 一个 key 槽位） */
export interface SaveApiKeyInput {
  readonly profileId: string;
  readonly apiKey: string;
}

/** 仅按 profile id 定位的输入（删除 / 设为默认 / 删除 Key / 测试连接） */
export interface ProviderProfileIdInput {
  readonly profileId: string;
}

/** 新建 provider profile 输入（不含 API Key；Key 经 SaveApiKey 单独写入 Keychain） */
export interface CreateProviderProfileInput {
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
}

/** 更新 provider profile 输入（不含 API Key） */
export interface UpdateProviderProfileInput {
  readonly profileId: string;
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly enabled: boolean;
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

// ── 桌面 API ──（B13：IPC_CHANNELS 已随 Electron 退役，命令面见 RPC_COMMANDS）

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

/** 提供商 API（多 provider；每个操作按 profileId 定位） */
export interface ProviderAPI {
  list(): Promise<ReadonlyArray<ProviderPublicState>>;
  create(input: CreateProviderProfileInput): Promise<ProviderPublicState>;
  update(input: UpdateProviderProfileInput): Promise<ProviderPublicState>;
  remove(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>>;
  setDefault(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>>;
  saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState>;
  deleteApiKey(input: ProviderProfileIdInput): Promise<ProviderPublicState>;
  testConnection(input: ProviderProfileIdInput): Promise<ConnectionTestResult>;
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

/** 创作契约 API（客户端经 window.desktop 调用，B12 起为 HTTP 实现） */
export interface ContractAPI {
  getCurrent(input: GetCurrentCreationContractInput): Promise<ContractVersionPublicData | null>;
  listVersions(
    input: ListCreationContractVersionsInput,
  ): Promise<ReadonlyArray<ContractVersionSummary>>;
  getProposal(input: GetCreationContractProposalInput): Promise<ProposalPublicData>;
  listProposals(
    input: ListCreationContractProposalsInput,
  ): Promise<ReadonlyArray<ProposalPublicData>>;
  requestDraft(input: RequestContractDraftInput): Promise<RequestContractDraftResult>;
  acceptProposal(input: AcceptContractProposalInput): Promise<ContractVersionPublicData>;
  rejectProposal(input: RejectContractProposalInput): Promise<ProposalPublicData>;
  updateByUser(input: UpdateContractByUserInput): Promise<ContractVersionPublicData>;
  lockField(input: LockContractFieldInput): Promise<ContractVersionPublicData>;
  unlockField(input: UnlockContractFieldInput): Promise<ContractVersionPublicData>;
}

// ── Graph Run 命令 DTO（GE-1，Renderer 面 5 通道）────────────────

/** 创建 Project run 命令输入 */
export interface CreateProjectRunInputDto {
  readonly projectId: string;
  readonly idempotencyKey: string;
}

export function isValidCreateProjectRunInput(value: unknown): value is CreateProjectRunInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'idempotencyKey'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.idempotencyKey);
}

/** 创建 Chapter run 命令输入 */
export interface CreateChapterRunInputDto {
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string | null;
  readonly storyBlueprintId: string;
  readonly blueprintChapterId: string;
  readonly idempotencyKey: string;
}

export function isValidCreateChapterRunInput(value: unknown): value is CreateChapterRunInputDto {
  if (
    !hasRequiredExactKeys(value, [
      'projectId',
      'creationSpecVersionId',
      'researchBundleId',
      'storyBlueprintId',
      'blueprintChapterId',
      'idempotencyKey',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    isBoundedTrimmedId(obj.projectId) &&
    isBoundedTrimmedId(obj.creationSpecVersionId) &&
    (obj.researchBundleId === null || isBoundedTrimmedId(obj.researchBundleId)) &&
    isBoundedTrimmedId(obj.storyBlueprintId) &&
    isBoundedTrimmedId(obj.blueprintChapterId) &&
    isBoundedTrimmedId(obj.idempotencyKey)
  );
}

/** 获取 run 进度命令输入 */
export interface GetRunProgressInputDto {
  readonly projectId: string;
  readonly runId: string;
}

export function isValidGetRunProgressInput(value: unknown): value is GetRunProgressInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'runId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.runId);
}

/** 人工决策命令输入（闭合判别联合；intake answer 携带原始回答，worker 先落库再推进） */
export type ApplyHumanDecisionInputDto =
  | {
      readonly kind: 'intake_answer';
      readonly projectId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly sessionId: string;
      readonly questionId: string;
      readonly text: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'intake_skip';
      readonly projectId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'intake_finish';
      readonly projectId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'gate' | 'escalation';
      readonly projectId: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly outcome: string;
      readonly idempotencyKey: string;
    };

export function isValidApplyHumanDecisionInput(
  value: unknown,
): value is ApplyHumanDecisionInputDto {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== 'string') return false;
  if (typeof obj.projectId !== 'string' || !isBoundedTrimmedId(obj.projectId)) return false;
  if (typeof obj.runId !== 'string' || !isBoundedTrimmedId(obj.runId)) return false;
  if (typeof obj.nodeId !== 'string' || !isBoundedTrimmedId(obj.nodeId)) return false;
  if (typeof obj.idempotencyKey !== 'string' || !isBoundedTrimmedId(obj.idempotencyKey)) {
    return false;
  }
  switch (obj.kind) {
    case 'intake_answer':
      return (
        typeof obj.sessionId === 'string' &&
        isBoundedTrimmedId(obj.sessionId) &&
        typeof obj.questionId === 'string' &&
        isBoundedTrimmedId(obj.questionId) &&
        typeof obj.text === 'string'
      );
    case 'intake_skip':
    case 'intake_finish':
      return hasRequiredExactKeys(value, [
        'kind',
        'projectId',
        'runId',
        'nodeId',
        'idempotencyKey',
      ]);
    case 'gate':
    case 'escalation':
      return (
        typeof obj.outcome === 'string' &&
        hasRequiredExactKeys(value, [
          'kind',
          'projectId',
          'runId',
          'nodeId',
          'outcome',
          'idempotencyKey',
        ])
      );
    default:
      return false;
  }
}

/** 列出 run 命令输入 */
export interface ListRunsInputDto {
  readonly projectId: string;
}

export function isValidListRunsInput(value: unknown): value is ListRunsInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId);
}

// ── Graph Run 执行器面命令输入（GE-2 起 worker 内部用；GE-1 校验）──

/** advanceNode 命令输入（执行器成功产物） */
export interface AdvanceNodeInputDto {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly outcome?: { readonly condition: string; readonly value: string };
  readonly artifactRef?: { readonly kind: string; readonly artifactId: string };
  readonly idempotencyKey: string;
}

export function isValidAdvanceNodeInput(value: unknown): value is AdvanceNodeInputDto {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!isBoundedTrimmedId(obj.projectId)) return false;
  if (!isBoundedTrimmedId(obj.runId)) return false;
  if (!isBoundedTrimmedId(obj.nodeId)) return false;
  if (!isBoundedTrimmedId(obj.idempotencyKey)) return false;
  if (obj.outcome !== undefined) {
    if (obj.outcome === null || typeof obj.outcome !== 'object') return false;
    const oc = obj.outcome as Record<string, unknown>;
    if (typeof oc.condition !== 'string' || typeof oc.value !== 'string') return false;
  }
  if (obj.artifactRef !== undefined) {
    if (obj.artifactRef === null || typeof obj.artifactRef !== 'object') return false;
    const ar = obj.artifactRef as Record<string, unknown>;
    if (typeof ar.kind !== 'string' || typeof ar.artifactId !== 'string') return false;
  }
  return true;
}

/** failNode / requestHumanDecision 命令输入 */
export interface FailNodeInputDto {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
}

export function isValidFailNodeInput(value: unknown): value is FailNodeInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'runId', 'nodeId', 'idempotencyKey'])) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    isBoundedTrimmedId(obj.projectId) &&
    isBoundedTrimmedId(obj.runId) &&
    isBoundedTrimmedId(obj.nodeId) &&
    isBoundedTrimmedId(obj.idempotencyKey)
  );
}

/** run 摘要（listRuns 返回值） */
export interface GraphRunSummaryDto {
  readonly runId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly kind: GraphRunKind;
  readonly terminalStatus: RunTerminalStatusDto | null;
  readonly createdAt: string;
}

/** Graph Run API（GE-1；客户端经 window.desktop 调用） */
export interface GraphAPI {
  createProjectRun(input: CreateProjectRunInputDto): Promise<GraphProgressProjectionDto>;
  createChapterRun(input: CreateChapterRunInputDto): Promise<GraphProgressProjectionDto>;
  getRunProgress(input: GetRunProgressInputDto): Promise<GraphProgressProjectionDto>;
  applyHumanDecision(input: ApplyHumanDecisionInputDto): Promise<GraphProgressProjectionDto>;
  listRuns(input: ListRunsInputDto): Promise<ReadonlyArray<GraphRunSummaryDto>>;
}

// ── Intake API（GE-3/B4）─────────────────────────────────────────

/** intake.getActiveIntakeSession 输入 */
export interface GetActiveIntakeSessionInputDto {
  readonly projectId: string;
}

/** intake.propagateSpecInvalidation 输入 */
export interface PropagateSpecInvalidationInputDto {
  readonly projectId: string;
  readonly creationSpecVersionId: string;
}

/** intake.propagateSpecInvalidation 结果（每个受影响的非终态 project run 一条） */
export interface SpecInvalidationResultDto {
  readonly runId: string;
  readonly invalidatedKinds: ReadonlyArray<string>;
}

/**
 * Idea Intake API（B4/D-B4-3）：对话式访谈的最小补充通道。
 * 会话创建是 IDEA_CAPTURE executor 的内部职责，不在 RPC 面。
 */
export interface IntakeAPI {
  getActiveIntakeSession(
    input: GetActiveIntakeSessionInputDto,
  ): Promise<GrillSessionPublicData | null>;
  propagateSpecInvalidation(
    input: PropagateSpecInvalidationInputDto,
  ): Promise<ReadonlyArray<SpecInvalidationResultDto>>;
}

/** 验证 intake.getActiveIntakeSession 输入 */
export function isValidGetActiveIntakeSessionInput(
  input: unknown,
): input is GetActiveIntakeSessionInputDto {
  if (input === null || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.projectId === 'string' && obj.projectId.trim().length > 0;
}

/** 验证 intake.propagateSpecInvalidation 输入 */
export function isValidPropagateSpecInvalidationInput(
  input: unknown,
): input is PropagateSpecInvalidationInputDto {
  if (input === null || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    obj.projectId.trim().length > 0 &&
    typeof obj.creationSpecVersionId === 'string' &&
    obj.creationSpecVersionId.trim().length > 0
  );
}

// ── Search key API（B5/D-B5-6：Tavily 槽位）──────────────────────

/** search.saveApiKey 输入 */
export interface SaveSearchApiKeyInputDto {
  readonly apiKey: string;
}

/** search key 状态（key 本身永不回显） */
export interface SearchKeyStateDto {
  readonly hasApiKey: boolean;
}

/** 验证 search.saveApiKey 输入 */
export function isValidSaveSearchApiKeyInput(input: unknown): input is SaveSearchApiKeyInputDto {
  if (input === null || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.apiKey === 'string' && obj.apiKey.trim().length > 0;
}

/** 搜索服务（Tavily）key 管理：只写/删/查有无，不回显 */
export interface SearchKeyAPI {
  saveApiKey(input: SaveSearchApiKeyInputDto): Promise<SearchKeyStateDto>;
  deleteApiKey(): Promise<SearchKeyStateDto>;
  hasApiKey(): Promise<SearchKeyStateDto>;
}

// ── Research API（GE-4/B6：只读调研态 + ResearchBundle 查看 + 来源排除）──

/** 调研强度三档（镜像 research-engine 的 ResearchDepth） */
export type ResearchDepthDto = 'none' | 'light' | 'deep';

export function isValidResearchDepthDto(value: unknown): value is ResearchDepthDto {
  return value === 'none' || value === 'light' || value === 'deep';
}

/** 调研校验结论（RESEARCH_VALIDATE 的 research_valid outcome） */
export type ResearchValidDto = 'valid' | 'invalid';

export function isValidResearchValidDto(value: unknown): value is ResearchValidDto {
  return value === 'valid' || value === 'invalid';
}

/** 来源记录（绑定问题/事实） */
export interface ResearchSourceRecordDto {
  readonly url: string;
  readonly title: string;
  readonly fetchedAt: string;
  readonly excerpt: string;
}

export function isValidResearchSourceRecordDto(value: unknown): value is ResearchSourceRecordDto {
  if (!hasRequiredExactKeys(value, ['url', 'title', 'fetchedAt', 'excerpt'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.url === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.fetchedAt === 'string' &&
    typeof obj.excerpt === 'string'
  );
}

/** 调研问题（含来源绑定） */
export interface ResearchQuestionDto {
  readonly id: string;
  readonly text: string;
  readonly sources: ReadonlyArray<ResearchSourceRecordDto>;
}

export function isValidResearchQuestionDto(value: unknown): value is ResearchQuestionDto {
  if (!hasRequiredExactKeys(value, ['id', 'text', 'sources'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.text === 'string' &&
    Array.isArray(obj.sources) &&
    obj.sources.every((s) => isValidResearchSourceRecordDto(s))
  );
}

/** 事实笔记（绑定来源 URL） */
export interface FactNoteDto {
  readonly id: string;
  readonly text: string;
  readonly sourceUrls: ReadonlyArray<string>;
}

export function isValidFactNoteDto(value: unknown): value is FactNoteDto {
  if (!hasRequiredExactKeys(value, ['id', 'text', 'sourceUrls'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.text === 'string' &&
    Array.isArray(obj.sourceUrls) &&
    obj.sourceUrls.every((u) => typeof u === 'string')
  );
}

/** 权威 ResearchBundle 公开投影（版本化；版本链以行链表达，D-B5-2） */
export interface ResearchBundleDto {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly depth: ResearchDepthDto;
  readonly questions: ReadonlyArray<ResearchQuestionDto>;
  readonly factNotes: ReadonlyArray<FactNoteDto>;
  readonly conclusion: string;
  readonly createdAt: string;
  /** 重试路径上游 bundle（B5：validate→execute 回环时记链；首轮为 null） */
  readonly basedOnBundleId: string | null;
}

export function isValidResearchBundleDto(value: unknown): value is ResearchBundleDto {
  if (
    !hasRequiredExactKeys(value, [
      'id',
      'projectId',
      'version',
      'depth',
      'questions',
      'factNotes',
      'conclusion',
      'createdAt',
      'basedOnBundleId',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.version === 'number' &&
    isValidResearchDepthDto(obj.depth) &&
    Array.isArray(obj.questions) &&
    obj.questions.every((q) => isValidResearchQuestionDto(q)) &&
    Array.isArray(obj.factNotes) &&
    obj.factNotes.every((n) => isValidFactNoteDto(n)) &&
    typeof obj.conclusion === 'string' &&
    typeof obj.createdAt === 'string' &&
    (obj.basedOnBundleId === null || typeof obj.basedOnBundleId === 'string')
  );
}

/**
 * 调研态读取投影（D-B6-3）：最新 project run 的调研相关节点结果，独立于
 * GraphProgressProjectionDto（exact-keys 校验器破坏面大，且 outcome/artifact 属
 * research 专用视图）。无 project run 时全 null / false / 0。
 */
export interface ResearchStateDto {
  readonly runId: string | null;
  readonly researchDecision: ResearchDepthDto | null;
  readonly researchValid: ResearchValidDto | null;
  readonly bundleRef: string | null;
  /**
   * bundleRef 指向的资料包是否已失效（创作要求变更 → researchBundle 进
   * invalidatedArtifacts）。失效时 artifacts.researchBundle 仍保留旧 ref
   * （applyArtifactChange 只追加失效列表、不清空槽位），故必须单独标记，
   * 否则 UI 会把作废的资料包当现行内容展示。
   */
  readonly bundleInvalidated: boolean;
  readonly escalationActive: boolean;
  readonly researchRetryUsed: number;
}

export function isValidResearchStateDto(value: unknown): value is ResearchStateDto {
  if (
    !hasRequiredExactKeys(value, [
      'runId',
      'researchDecision',
      'researchValid',
      'bundleRef',
      'bundleInvalidated',
      'escalationActive',
      'researchRetryUsed',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    (obj.runId === null || typeof obj.runId === 'string') &&
    (obj.researchDecision === null || isValidResearchDepthDto(obj.researchDecision)) &&
    (obj.researchValid === null || isValidResearchValidDto(obj.researchValid)) &&
    (obj.bundleRef === null || typeof obj.bundleRef === 'string') &&
    typeof obj.bundleInvalidated === 'boolean' &&
    typeof obj.escalationActive === 'boolean' &&
    typeof obj.researchRetryUsed === 'number'
  );
}

/** research.getResearchState 输入 */
export interface GetResearchStateInputDto {
  readonly projectId: string;
}

export function isValidGetResearchStateInput(value: unknown): value is GetResearchStateInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

/** research.getBundle 输入 */
export interface GetResearchBundleInputDto {
  readonly projectId: string;
  readonly bundleId: string;
}

export function isValidGetResearchBundleInput(value: unknown): value is GetResearchBundleInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'bundleId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.bundleId);
}

/** research.listBundles 输入 */
export interface ListResearchBundlesInputDto {
  readonly projectId: string;
}

export function isValidListResearchBundlesInput(
  value: unknown,
): value is ListResearchBundlesInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

/** 公共 URL 长度上限（防御性上界；来源/排除 URL 均适用） */
const MAX_PUBLIC_URL_LENGTH = 2048;

function isBoundedUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= MAX_PUBLIC_URL_LENGTH
  );
}

/** research.setSourceExclusion 输入（D-B6-2：project 级 URL 排除） */
export interface SetSourceExclusionInputDto {
  readonly projectId: string;
  readonly url: string;
  readonly excluded: boolean;
}

export function isValidSetSourceExclusionInput(
  value: unknown,
): value is SetSourceExclusionInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'url', 'excluded'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    isBoundedTrimmedId(obj.projectId) && isBoundedUrl(obj.url) && typeof obj.excluded === 'boolean'
  );
}

/** research.listSourceExclusions 输入 */
export interface ListSourceExclusionsInputDto {
  readonly projectId: string;
}

export function isValidListSourceExclusionsInput(
  value: unknown,
): value is ListSourceExclusionsInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

/** Research API（GE-4/B6；客户端经 window.desktop 调用） */
export interface ResearchAPI {
  getResearchState(input: GetResearchStateInputDto): Promise<ResearchStateDto>;
  getBundle(input: GetResearchBundleInputDto): Promise<ResearchBundleDto | null>;
  listBundles(input: ListResearchBundlesInputDto): Promise<ReadonlyArray<ResearchBundleDto>>;
  setSourceExclusion(input: SetSourceExclusionInputDto): Promise<ReadonlyArray<string>>;
  listSourceExclusions(input: ListSourceExclusionsInputDto): Promise<ReadonlyArray<string>>;
}

/**
 * 蓝图态读取投影（GE-5/B7，D-B7-10）：最新 project run 的蓝图相关节点结果，镜像
 * B6 的 ResearchStateDto。预埋读通道——B8 的蓝图 UI 与 GE-6 的 createChapterRun
 * （需要"当前已接受蓝图 + 章节"）都依赖它。无 project run 时全 null / false / 0。
 */
export interface BlueprintStateDto {
  readonly runId: string | null;
  readonly blueprintRef: string | null;
  /** blueprintRef 指向的蓝图是否已被用户显式接受（story_blueprints.accepted） */
  readonly accepted: boolean;
  /**
   * blueprintRef 指向的蓝图是否已失效（创作要求变更 → storyBlueprint 进
   * invalidatedArtifacts）。失效时 artifacts.storyBlueprint 仍保留旧 ref
   * （applyArtifactChange 只追加失效列表、不清空槽位），故必须单独标记。
   */
  readonly blueprintInvalidated: boolean;
  readonly gateActive: boolean;
  readonly escalationActive: boolean;
  readonly rewriteUsed: number;
}

export function isValidBlueprintStateDto(value: unknown): value is BlueprintStateDto {
  if (
    !hasRequiredExactKeys(value, [
      'runId',
      'blueprintRef',
      'accepted',
      'blueprintInvalidated',
      'gateActive',
      'escalationActive',
      'rewriteUsed',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    (obj.runId === null || typeof obj.runId === 'string') &&
    (obj.blueprintRef === null || typeof obj.blueprintRef === 'string') &&
    typeof obj.accepted === 'boolean' &&
    typeof obj.blueprintInvalidated === 'boolean' &&
    typeof obj.gateActive === 'boolean' &&
    typeof obj.escalationActive === 'boolean' &&
    typeof obj.rewriteUsed === 'number'
  );
}

/** blueprint.getState 输入 */
export interface GetBlueprintStateInputDto {
  readonly projectId: string;
}

export function isValidGetBlueprintStateInput(value: unknown): value is GetBlueprintStateInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

/** 蓝图人物（StoryBlueprint.characters 的公开投影） */
export interface BlueprintCharacterDto {
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export function isValidBlueprintCharacterDto(value: unknown): value is BlueprintCharacterDto {
  if (!hasRequiredExactKeys(value, ['name', 'role', 'description'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.role === 'string' &&
    typeof obj.description === 'string'
  );
}

/** 蓝图情节线 */
export interface BlueprintPlotlineDto {
  readonly name: string;
  readonly summary: string;
}

export function isValidBlueprintPlotlineDto(value: unknown): value is BlueprintPlotlineDto {
  if (!hasRequiredExactKeys(value, ['name', 'summary'])) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === 'string' && typeof obj.summary === 'string';
}

/** 蓝图章节结构条目（GE-6 由 blueprintChapterId 绑定 ChapterGenerationRun） */
export interface BlueprintChapterDto {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
}

export function isValidBlueprintChapterDto(value: unknown): value is BlueprintChapterDto {
  if (!hasRequiredExactKeys(value, ['id', 'title', 'goal'])) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' && typeof obj.title === 'string' && typeof obj.goal === 'string'
  );
}

/**
 * 权威 StoryBlueprint 公开投影（GE-5/B8，D-B8-1）。
 *
 * B7 只给了状态投影（BlueprintStateDto 七个标量），渲染进程拿不到蓝图正文；
 * 蓝图 UI 的核心交付（查看前提/人物/关系/世界/冲突/情节线/章节结构/结局）依赖本 DTO。
 * 镜像 B6 的 ResearchBundleDto：worker 侧由 toStoryBlueprintDto 投影，不外泄
 * domain 内部字段（accepted 属状态、由 BlueprintStateDto 承载，不重复第二事实源）。
 */
export interface StoryBlueprintDto {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacterDto>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotlineDto>;
  readonly chapters: ReadonlyArray<BlueprintChapterDto>;
  readonly createdAt: string;
}

export function isValidStoryBlueprintDto(value: unknown): value is StoryBlueprintDto {
  if (
    !hasRequiredExactKeys(value, [
      'id',
      'projectId',
      'version',
      'premise',
      'characters',
      'relationships',
      'world',
      'conflict',
      'ending',
      'plotlines',
      'chapters',
      'createdAt',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.version === 'number' &&
    typeof obj.premise === 'string' &&
    Array.isArray(obj.characters) &&
    obj.characters.every((c) => isValidBlueprintCharacterDto(c)) &&
    Array.isArray(obj.relationships) &&
    obj.relationships.every((r) => typeof r === 'string') &&
    typeof obj.world === 'string' &&
    typeof obj.conflict === 'string' &&
    typeof obj.ending === 'string' &&
    Array.isArray(obj.plotlines) &&
    obj.plotlines.every((p) => isValidBlueprintPlotlineDto(p)) &&
    Array.isArray(obj.chapters) &&
    obj.chapters.every((c) => isValidBlueprintChapterDto(c)) &&
    typeof obj.createdAt === 'string'
  );
}

/** blueprint.getBlueprint 输入（D-B8-1） */
export interface GetBlueprintInputDto {
  readonly projectId: string;
  readonly blueprintId: string;
}

export function isValidGetBlueprintInput(value: unknown): value is GetBlueprintInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'blueprintId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.blueprintId);
}

/** Blueprint API（GE-5/B7 读通道 D-B7-10；B8 扩 getBlueprint；客户端经 window.desktop 调用） */
export interface BlueprintAPI {
  getState(input: GetBlueprintStateInputDto): Promise<BlueprintStateDto>;
  getBlueprint(input: GetBlueprintInputDto): Promise<StoryBlueprintDto | null>;
}

// ── 章节生成（GE-6 / B10）────────────────────────────────────────

/**
 * 章节生成阶段（作者语言投影）。
 *
 * 由 worker 按 Graph 节点状态派生，**渲染进程不自行推导 Graph 语义**（与 B4/B6/B8
 * 同一纪律）。刻意不暴露节点 id / 任务 / token 等工程概念（PRODUCT_DIRECTION §4）。
 *
 * `accepted_pending_commit`：用户已在候选确认环节选择"采用"，但写入权威稿件
 * （MANUSCRIPT_COMMIT）属 GE-7，尚未接线——run 停在该节点。界面必须如实说明，
 * 不得让"采用"看起来像"已保存进稿件"。
 */
export type ChapterRunPhaseDto =
  | 'idle'
  | 'planning'
  | 'drafting'
  | 'reviewing'
  | 'rewriting'
  | 'awaiting_decision'
  | 'awaiting_escalation'
  | 'accepted_pending_commit'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'failed';

const CHAPTER_RUN_PHASES: ReadonlySet<string> = new Set<ChapterRunPhaseDto>([
  'idle',
  'planning',
  'drafting',
  'reviewing',
  'rewriting',
  'awaiting_decision',
  'awaiting_escalation',
  'accepted_pending_commit',
  'completed',
  'blocked',
  'cancelled',
  'failed',
]);

export function isChapterRunPhaseDto(value: unknown): value is ChapterRunPhaseDto {
  return typeof value === 'string' && CHAPTER_RUN_PHASES.has(value);
}

/** 审查维度（三个 Critic 节点的公开投影，不暴露节点 id） */
export type ChapterCritiqueDimensionDto = 'continuity' | 'style' | 'requirement';

export interface ChapterCritiqueIssueDto {
  readonly severity: 'minor' | 'major';
  readonly excerpt: string;
  readonly problem: string;
  readonly suggestion: string;
}

export interface ChapterCritiqueDto {
  readonly dimension: ChapterCritiqueDimensionDto;
  readonly verdict: 'pass' | 'needs_rewrite';
  readonly summary: string;
  readonly issues: ReadonlyArray<ChapterCritiqueIssueDto>;
}

/** 候选正文的一个修订（当前候选 = 同 run 内最大修订号，见 B9 D-B9-1） */
export interface ChapterCandidateDto {
  readonly revisionNo: number;
  /** 首稿还是按审查意见/用户要求改写出来的版本 */
  readonly source: 'DRAFT' | 'REWRITE';
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
}

/** 一次章节生成 run 的完整状态投影 */
export interface ChapterRunStateDto {
  readonly runId: string;
  readonly blueprintChapterId: string;
  readonly phase: ChapterRunPhaseDto;
  readonly terminalStatus: RunTerminalStatusDto | null;
  readonly gateActive: boolean;
  readonly escalationActive: boolean;
  readonly candidate: ChapterCandidateDto | null;
  /** 针对当前候选修订的审查结论（无候选或尚未审查时为空数组） */
  readonly critiques: ReadonlyArray<ChapterCritiqueDto>;
  /** 三个循环预算的已用次数（用于"还能改写几次"的如实提示） */
  readonly rewriteUsed: number;
  readonly candidateRewriteUsed: number;
  readonly regenerateUsed: number;
}

/** 蓝图章节 + 其最新一次生成 run 的概览（章节列表用） */
export interface ChapterOverviewItemDto {
  readonly blueprintChapterId: string;
  readonly title: string;
  readonly goal: string;
  readonly runId: string | null;
  readonly phase: ChapterRunPhaseDto;
  readonly hasCandidate: boolean;
}

export interface ChapterOverviewDto {
  /** 已接受的蓝图 id；未就绪时为 null（此时 chapters 为空数组） */
  readonly blueprintId: string | null;
  readonly chapters: ReadonlyArray<ChapterOverviewItemDto>;
}

export interface GetChapterOverviewInputDto {
  readonly projectId: string;
}

export function isValidGetChapterOverviewInput(
  value: unknown,
): value is GetChapterOverviewInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

export interface StartChapterRunInputDto {
  readonly projectId: string;
  readonly blueprintChapterId: string;
}

export function isValidStartChapterRunInput(value: unknown): value is StartChapterRunInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'blueprintChapterId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.blueprintChapterId);
}

export interface GetChapterRunStateInputDto {
  readonly projectId: string;
  readonly runId: string;
}

export function isValidGetChapterRunStateInput(
  value: unknown,
): value is GetChapterRunStateInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'runId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.runId);
}

/**
 * 章节生成三个循环预算的上限（与 CHAPTER_GENERATION_GRAPH_V1 的 loop.maxIterations
 * 一致）。界面要如实显示"还能改写几次"，就必须知道上限；contracts 是渲染进程唯一
 * 能引用到的共享层（domain 不在其依赖内）。
 *
 * 这是一处**跨层手抄面**（TD-030-3 同族），因此由 `apps/worker/src/chapter-graph-parity.test.ts`
 * 逐条比对图定义的真源；图上调整预算而这里没跟上时该测试即红。
 */
export const CHAPTER_REWRITE_LIMIT = 3;
export const CHAPTER_CANDIDATE_REWRITE_LIMIT = 5;
export const CHAPTER_REGENERATE_LIMIT = 5;

/** 候选确认环节的最大改写意见长度（超出由 main 侧拒绝，不静默截断） */
export const MAX_CHAPTER_FEEDBACK_LENGTH = 2000;

/**
 * 候选 Gate / 升级 Gate 的决策提交。
 *
 * `feedback` 只在 `kind='gate' && outcome='request_rewrite'` 时有意义：worker 会先把
 * 它写进权威存储（供 REWRITE 任务消费），再推进 Graph（B10 D-B10-3）。其余组合必须
 * 传 null —— 不接受"存了但没人读"的字段。
 */
export interface SubmitChapterDecisionInputDto {
  readonly projectId: string;
  readonly runId: string;
  readonly kind: 'gate' | 'escalation';
  readonly outcome: string;
  readonly feedback: string | null;
  readonly idempotencyKey: string;
}

export function isValidSubmitChapterDecisionInput(
  value: unknown,
): value is SubmitChapterDecisionInputDto {
  if (
    !hasRequiredExactKeys(value, [
      'projectId',
      'runId',
      'kind',
      'outcome',
      'feedback',
      'idempotencyKey',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isBoundedTrimmedId(obj.projectId) || !isBoundedTrimmedId(obj.runId)) return false;
  if (!isBoundedTrimmedId(obj.idempotencyKey)) return false;
  if (obj.kind !== 'gate' && obj.kind !== 'escalation') return false;
  if (!isBoundedTrimmedId(obj.outcome)) return false;
  if (obj.feedback !== null) {
    if (typeof obj.feedback !== 'string') return false;
    if (obj.feedback.trim().length === 0) return false;
    if (obj.feedback.length > MAX_CHAPTER_FEEDBACK_LENGTH) return false;
    // 只有"请求改写"这一条决策会消费意见；其余组合必须传 null
    if (obj.kind !== 'gate' || obj.outcome !== 'request_rewrite') return false;
  }
  return true;
}

export interface ChapterAPI {
  getOverview(input: GetChapterOverviewInputDto): Promise<ChapterOverviewDto>;
  startRun(input: StartChapterRunInputDto): Promise<ChapterRunStateDto>;
  getRunState(input: GetChapterRunStateInputDto): Promise<ChapterRunStateDto | null>;
  submitDecision(input: SubmitChapterDecisionInputDto): Promise<ChapterRunStateDto>;
}

// ── 稿件工作区（GE-7）───────────────────────────────────────────

/** 稿件章节摘要（左侧章节列表） */
export interface ManuscriptChapterSummaryDto {
  readonly chapterId: string;
  readonly title: string;
  readonly position: number;
  readonly currentVersionId: string | null;
  /** 正文字数（UTF-16 code point 计数，去掉空白） */
  readonly wordCount: number;
  /** 该章由哪个蓝图章节生成而来；手工新增的章节为 null */
  readonly blueprintChapterId: string | null;
}

export interface ManuscriptWorkspaceDto {
  /** 尚无稿件（还没有任何一章被接受）时为 null，chapters 为空数组 */
  readonly manuscriptId: string | null;
  readonly title: string;
  readonly chapters: ReadonlyArray<ManuscriptChapterSummaryDto>;
}

/** 单章正文（编辑器加载用） */
export interface ManuscriptChapterDetailDto {
  readonly chapterId: string;
  readonly title: string;
  readonly content: string;
  /** CAS 基线：保存时必须原样回传，服务端据此拒绝覆盖他人/后续版本 */
  readonly currentVersionId: string | null;
  readonly versionNumber: number | null;
  readonly versionCount: number;
}

export interface GetManuscriptWorkspaceInputDto {
  readonly projectId: string;
}

export function isValidGetManuscriptWorkspaceInput(
  value: unknown,
): value is GetManuscriptWorkspaceInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

// ── 故事图谱（D14 / B22，纯后台：无 UI 入口，验收用命令直接驱动）──

/** 重建整个项目的故事图谱（清空 extracted 层后逐章重抽，D-B22-6） */
export interface RebuildStoryGraphInputDto {
  readonly projectId: string;
}

export function isValidRebuildStoryGraphInput(value: unknown): value is RebuildStoryGraphInputDto {
  if (!hasRequiredExactKeys(value, ['projectId'])) return false;
  return isBoundedTrimmedId((value as Record<string, unknown>).projectId);
}

/** 重建结果：清掉多少 extracted 记录、排了多少章的抽取任务 */
export interface RebuildStoryGraphResultDto {
  readonly clearedStates: number;
  readonly clearedThreads: number;
  readonly clearedEntities: number;
  readonly clearedExtractions: number;
  readonly enqueuedChapters: number;
  readonly skippedChapters: number;
}

export interface GetManuscriptChapterInputDto {
  readonly projectId: string;
  readonly chapterId: string;
}

export function isValidGetManuscriptChapterInput(
  value: unknown,
): value is GetManuscriptChapterInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'chapterId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.chapterId);
}

/** 正文长度上限（与 domain validateChapterContent 一致的量级，main 侧先挡一道） */
export const MAX_MANUSCRIPT_CONTENT_LENGTH = 200000;

/**
 * 保存一章（追加新版本 + 移动 current 指针）。
 *
 * `expectedCurrentVersionId` 是 CAS 基线：**不静默覆盖**用户正文的实现手段——
 * 加载时拿到哪一版，保存时就必须回传哪一版；期间若有别的写入（例如又一次
 * MANUSCRIPT_COMMIT），服务端拒绝并让用户看到冲突，而不是悄悄盖掉。
 */
export interface SaveManuscriptChapterInputDto {
  readonly projectId: string;
  readonly chapterId: string;
  readonly title: string;
  readonly content: string;
  readonly expectedCurrentVersionId: string | null;
}

export function isValidSaveManuscriptChapterInput(
  value: unknown,
): value is SaveManuscriptChapterInputDto {
  if (
    !hasRequiredExactKeys(value, [
      'projectId',
      'chapterId',
      'title',
      'content',
      'expectedCurrentVersionId',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isBoundedTrimmedId(obj.projectId) || !isBoundedTrimmedId(obj.chapterId)) return false;
  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) return false;
  if (obj.title.length > 200) return false;
  if (typeof obj.content !== 'string' || obj.content.trim().length === 0) return false;
  if (obj.content.length > MAX_MANUSCRIPT_CONTENT_LENGTH) return false;
  if (obj.expectedCurrentVersionId !== null && !isBoundedTrimmedId(obj.expectedCurrentVersionId)) {
    return false;
  }
  return true;
}

export type ManuscriptExportFormatDto = 'txt' | 'markdown';

export interface ExportManuscriptInputDto {
  readonly projectId: string;
  readonly format: ManuscriptExportFormatDto;
}

export function isValidExportManuscriptInput(value: unknown): value is ExportManuscriptInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'format'])) return false;
  const obj = value as Record<string, unknown>;
  if (!isBoundedTrimmedId(obj.projectId)) return false;
  return obj.format === 'txt' || obj.format === 'markdown';
}

/**
 * 导出结果（B12 起）：worker 只负责按稿件顺序渲染出内容，落盘由浏览器端触发下载。
 * 原 `saved` / `filePath` 属原生保存对话框语义，随 Electron 退役删除。
 */
export interface ExportManuscriptResultDto {
  readonly fileName: string;
  readonly content: string;
  readonly chapterCount: number;
}

/**
 * 版本历史条目（不含正文——历史列表只做定位，正文按需在恢复后读取）。
 * `source` 说明这一版是谁写的：AI 生成 / AI 改写 / 用户手写 / 导入 / 恢复。
 */
export interface ManuscriptVersionSummaryDto {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly source: 'USER' | 'AI_GENERATION' | 'AI_REWRITE' | 'IMPORT' | 'RESTORE';
  readonly createdAt: string;
  readonly isCurrent: boolean;
}

export interface ListManuscriptVersionsInputDto {
  readonly projectId: string;
  readonly chapterId: string;
}

export function isValidListManuscriptVersionsInput(
  value: unknown,
): value is ListManuscriptVersionsInputDto {
  if (!hasRequiredExactKeys(value, ['projectId', 'chapterId'])) return false;
  const obj = value as Record<string, unknown>;
  return isBoundedTrimmedId(obj.projectId) && isBoundedTrimmedId(obj.chapterId);
}

/**
 * 恢复到某个历史版本：只移动 current 指针，**不删除任何版本**
 * （被恢复走的那一版仍在历史里，可以再切回来）。同样带 CAS 基线。
 */
export interface RestoreManuscriptVersionInputDto {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly expectedCurrentVersionId: string | null;
}

export function isValidRestoreManuscriptVersionInput(
  value: unknown,
): value is RestoreManuscriptVersionInputDto {
  if (
    !hasRequiredExactKeys(value, [
      'projectId',
      'chapterId',
      'versionId',
      'expectedCurrentVersionId',
    ])
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isBoundedTrimmedId(obj.projectId) || !isBoundedTrimmedId(obj.chapterId)) return false;
  if (!isBoundedTrimmedId(obj.versionId)) return false;
  return obj.expectedCurrentVersionId === null || isBoundedTrimmedId(obj.expectedCurrentVersionId);
}

// ── 章节草稿（TD-033-3：编辑无自动保存的后端草稿层）────────────────
// 草稿独立于版本链：autosave 只写 chapter_drafts，绝不产生版本、绝不推进
// currentVersionId。显式保存（saveChapter）成功后同事务清草稿。

/** 章节草稿公开数据。stale=true 表示当前版本已偏离草稿基线，上层自行决定。 */
export interface ChapterDraftDto {
  readonly chapterId: string;
  readonly title: string | null;
  readonly content: string;
  readonly baseVersionId: string | null;
  readonly currentVersionId: string | null;
  readonly stale: boolean;
  readonly updatedAt: string;
}

export function isValidChapterDraftDto(data: unknown): data is ChapterDraftDto {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, [
      'chapterId',
      'title',
      'content',
      'baseVersionId',
      'currentVersionId',
      'stale',
      'updatedAt',
    ]) &&
    isBoundedTrimmedId(obj.chapterId) &&
    (obj.title === null || (typeof obj.title === 'string' && obj.title.length <= 200)) &&
    typeof obj.content === 'string' &&
    obj.content.length <= MAX_MANUSCRIPT_CONTENT_LENGTH &&
    (obj.baseVersionId === null || isBoundedTrimmedId(obj.baseVersionId)) &&
    (obj.currentVersionId === null || isBoundedTrimmedId(obj.currentVersionId)) &&
    typeof obj.stale === 'boolean' &&
    typeof obj.updatedAt === 'string' &&
    obj.updatedAt.trim().length > 0
  );
}

export interface SaveChapterDraftInputDto {
  readonly projectId: string;
  readonly chapterId: string;
  readonly title: string | null;
  readonly content: string;
  readonly baseVersionId: string | null;
}

export function isValidSaveChapterDraftInput(value: unknown): value is SaveChapterDraftInputDto {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'chapterId', 'title', 'content', 'baseVersionId'])) {
    return false;
  }
  if (!isBoundedTrimmedId(obj.projectId) || !isBoundedTrimmedId(obj.chapterId)) return false;
  if (obj.title !== null && (typeof obj.title !== 'string' || obj.title.length > 200)) return false;
  if (typeof obj.content !== 'string') return false;
  if (obj.content.length > MAX_MANUSCRIPT_CONTENT_LENGTH) return false;
  return obj.baseVersionId === null || isBoundedTrimmedId(obj.baseVersionId);
}

export interface GetChapterDraftInputDto {
  readonly projectId: string;
  readonly chapterId: string;
}

export function isValidGetChapterDraftInput(value: unknown): value is GetChapterDraftInputDto {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'chapterId']) &&
    isBoundedTrimmedId(obj.projectId) &&
    isBoundedTrimmedId(obj.chapterId)
  );
}

export interface DiscardChapterDraftInputDto {
  readonly projectId: string;
  readonly chapterId: string;
}

export function isValidDiscardChapterDraftInput(
  value: unknown,
): value is DiscardChapterDraftInputDto {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'chapterId']) &&
    isBoundedTrimmedId(obj.projectId) &&
    isBoundedTrimmedId(obj.chapterId)
  );
}

export interface ManuscriptAPI {
  getWorkspace(input: GetManuscriptWorkspaceInputDto): Promise<ManuscriptWorkspaceDto>;
  getChapter(input: GetManuscriptChapterInputDto): Promise<ManuscriptChapterDetailDto | null>;
  saveChapter(input: SaveManuscriptChapterInputDto): Promise<ManuscriptChapterDetailDto>;
  saveDraft(input: SaveChapterDraftInputDto): Promise<void>;
  getDraft(input: GetChapterDraftInputDto): Promise<ChapterDraftDto | null>;
  discardDraft(input: DiscardChapterDraftInputDto): Promise<boolean>;
  exportManuscript(input: ExportManuscriptInputDto): Promise<ExportManuscriptResultDto>;
  listVersions(
    input: ListManuscriptVersionsInputDto,
  ): Promise<ReadonlyArray<ManuscriptVersionSummaryDto>>;
  restoreVersion(input: RestoreManuscriptVersionInputDto): Promise<ManuscriptChapterDetailDto>;
}

/** 客户端 API 接口（历史名 DesktopAPI 保留）：浏览器端 window.desktop 的完整类型面，B12 起由 HTTP 客户端实现 */
export interface DesktopAPI {
  healthCheck(): Promise<HealthCheckResponse>;
  getDataServiceStatus(): Promise<DataServiceStatusResponse>;
  retryDataService(): Promise<DataServiceStatusResponse>;
  projects: ProjectsAPI;
  provider: ProviderAPI;
  tasks: TasksAPI;
  grill: GrillAPI;
  contract: ContractAPI;
  graph: GraphAPI;
  intake: IntakeAPI;
  search: SearchKeyAPI;
  research: ResearchAPI;
  blueprint: BlueprintAPI;
  chapter: ChapterAPI;
  manuscript: ManuscriptAPI;
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
    'SEARCH_KEY_REQUIRED',
    'SEARCH_KEY_READ_FAILED',
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
    'CONTRACT_DRAFT_ALREADY_RUNNING',
    'MANUSCRIPT_NOT_FOUND',
    'MANUSCRIPT_STATE_CONFLICT',
    'MANUSCRIPT_VERSION_CONFLICT',
    'MANUSCRIPT_POSITION_OVERFLOW',
    'CHAPTER_NOT_FOUND',
    'CHAPTER_VERSION_NOT_FOUND',
    'GRAPH_RUN_NOT_FOUND',
    'GRAPH_RUN_VERSION_CONFLICT',
    'GRAPH_RUN_STATE_CONFLICT',
    'GRAPH_RUN_VALIDATION_ERROR',
    'GRAPH_RUN_IDEMPOTENCY_CONFLICT',
    'GRAPH_RUN_INTERRUPTED',
    'NODE_EXECUTION_NOT_FOUND',
    'NODE_EXECUTION_STATE_CONFLICT',
    'NODE_EXECUTION_IDENTITY_MISMATCH',
    'NODE_EXECUTOR_UNAVAILABLE',
    'NODE_SETTLEMENT_ARTIFACT_INVALID',
    'NODE_SETTLEMENT_ARTIFACT_MISSING',
    'NODE_SETTLEMENT_STALE_INPUT',
    'NODE_SETTLEMENT_TASK_NOT_SUCCEEDED',
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
  return (
    typeof obj.profileId === 'string' && obj.profileId.length > 0 && typeof obj.apiKey === 'string'
  );
}

/** 验证仅含 profileId 的输入 */
export function isValidProviderProfileIdInput(data: unknown): data is ProviderProfileIdInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.profileId === 'string' && obj.profileId.length > 0;
}

/**
 * provider baseUrl 的传输层校验：必须是 http/https 绝对 URL，无空白字符。
 *
 * contracts 是环境中立包（不引入 DOM / Node 类型），因此不使用 `URL` 构造器解析；
 * 这里只挡明显非法输入，更严格的私网 / 重定向边界属于调用层。
 */
function isValidProviderBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false;
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(value);
}

function isNonEmptyString(value: unknown, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** 验证新建 provider profile 输入 */
export function isValidCreateProviderProfileInput(
  data: unknown,
): data is CreateProviderProfileInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    isNonEmptyString(obj.label, 100) &&
    isProviderProtocol(obj.protocol) &&
    isValidProviderBaseUrl(obj.baseUrl) &&
    isNonEmptyString(obj.model, 200)
  );
}

/** 验证更新 provider profile 输入 */
export function isValidUpdateProviderProfileInput(
  data: unknown,
): data is UpdateProviderProfileInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.profileId === 'string' &&
    obj.profileId.length > 0 &&
    isNonEmptyString(obj.label, 100) &&
    isProviderProtocol(obj.protocol) &&
    isValidProviderBaseUrl(obj.baseUrl) &&
    isNonEmptyString(obj.model, 200) &&
    typeof obj.enabled === 'boolean'
  );
}

/** 验证 ProviderPublicState 结构 */
export function isValidProviderPublicState(data: unknown): data is ProviderPublicState {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  const validTestStatuses: ReadonlySet<string> = new Set(['never', 'success', 'failed']);
  return (
    typeof obj.id === 'string' &&
    typeof obj.label === 'string' &&
    isProviderProtocol(obj.protocol) &&
    typeof obj.baseUrl === 'string' &&
    typeof obj.model === 'string' &&
    typeof obj.enabled === 'boolean' &&
    typeof obj.isDefault === 'boolean' &&
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

// ── 创作契约 DTO ──────────────────────────────────────────────────

// ── Self-contained literal unions (no domain dependency) ─────────

export type ProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED' | 'STALE';
export type ContractVersionCreatedBy = 'user' | 'ai-proposal-accepted' | 'lock' | 'unlock';
export type NarrativePov = 'FIRST' | 'THIRD_LIMITED' | 'THIRD_OMNISCIENT' | 'SECOND' | 'OTHER';
export type Tense = 'PAST' | 'PRESENT' | 'MIXED';
export type TargetLengthUnit = 'words' | 'chapters';
export type ProvenanceSource =
  'GRILL_ANSWER' | 'AI_PROPOSAL' | 'USER_EDIT' | 'PREVIOUS_VERSION' | 'DEFAULT';

// ── Sections public DTO (closed, typed) ───────────────────────────

export interface CreationContractSectionsPublicData {
  readonly premise: string;
  readonly genre: ReadonlyArray<string>;
  readonly tone: ReadonlyArray<string>;
  readonly themes?: ReadonlyArray<string>;
  readonly targetAudience: string;
  readonly narrativePov: NarrativePov;
  readonly tense: Tense;
  readonly targetLength?: { readonly unit: TargetLengthUnit; readonly value: number };
  readonly chapterLength?: {
    readonly targetCharacters: number;
    readonly minimumCharacters?: number;
    readonly maximumCharacters?: number;
  };
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

// ── Field provenance DTO (full model) ───────────────────────────

export interface ContractFieldProvenanceDTO {
  readonly sectionKey: string;
  readonly source: ProvenanceSource;
  readonly grillAnswerIds: ReadonlyArray<string>;
  readonly grillProposalIds: ReadonlyArray<string>;
  readonly aiTaskId: string | null;
  readonly modelInvocationId: string | null;
  readonly sourceProposalId: string | null;
  readonly previousFieldHash: string | null;
  readonly rationale: string | null;
}

// ── Version public DTO ────────────────────────────────────────────

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
  readonly provenance: ReadonlyArray<ContractFieldProvenanceDTO>;
  readonly createdAt: string;
  readonly createdBy: ContractVersionCreatedBy;
}

export interface ContractVersionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly contractSnapshotHash: string;
  readonly createdAt: string;
  readonly createdBy: ContractVersionCreatedBy;
}

// ── Proposal public DTO ───────────────────────────────────────────

export interface ProposalPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly status: ProposalStatus;
  readonly baseGrillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly schemaVersion: number;
  readonly sections: CreationContractSectionsPublicData;
  readonly sectionsHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Query input DTOs ──────────────────────────────────────────────

export interface GetCurrentCreationContractInput {
  readonly projectId: string;
}

export interface ListCreationContractVersionsInput {
  readonly projectId: string;
}

export interface GetCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
}

export interface ListCreationContractProposalsInput {
  readonly projectId: string;
}

// ── Creation contract draft request DTO ───────────────────────────
// Renderer 不传 providerProfileId / ID / 时间戳 / hash —— 全部由 Worker 注入。

export interface RequestContractDraftInput {
  readonly projectId: string;
  readonly grillSessionId: string;
  readonly expectedGrillSessionVersion: number;
  readonly expectedContractVersion: number | null;
}

export interface RequestContractDraftResult {
  readonly taskId: string;
  readonly grillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
}

// ── Creation contract mutation input DTOs ─────────────────────────
// now / newVersionId / lockEventId 由 Worker 生成，Renderer 不得传入。

export interface AcceptContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
  readonly expectedGrillSessionVersion: number;
  readonly expectedContractVersion: number | null;
  readonly operations: ReadonlyArray<ContractPatchOperationDTO>;
}

export interface RejectContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
}

export interface UpdateContractByUserInput {
  readonly projectId: string;
  readonly expectedContractVersion: number;
  readonly operations: ReadonlyArray<ContractPatchOperationDTO>;
}

export interface LockContractFieldInput {
  readonly projectId: string;
  readonly expectedContractVersion: number;
  readonly fieldPath: string;
}

export interface UnlockContractFieldInput {
  readonly projectId: string;
  readonly expectedContractVersion: number;
  readonly fieldPath: string;
}

// ── Closed-path ContractPatchOperation DTO ────────────────────────

export type ContractPatchOperationDTO =
  | ContractPatchSetPremiseLikeDTO
  | ContractPatchSetNarrativePovDTO
  | ContractPatchSetTenseDTO
  | ContractPatchSetProtagonistScalarDTO
  | ContractPatchSetTargetLengthUnitDTO
  | ContractPatchSetTargetLengthValueDTO
  | ContractPatchSetChapterLengthValueDTO
  | ContractPatchSetContentBoundariesScalarDTO
  | ContractPatchSetSupportingCharScalarDTO
  | ContractPatchSetRelationshipScalarDTO
  | ContractPatchSetStringListTopLevelDTO
  | ContractPatchSetProtagonistTraitsDTO
  | ContractPatchSetContentBoundariesListDTO
  | ContractPatchSetSupportingCharTraitsDTO
  | ContractPatchSetTargetLengthDTO
  | ContractPatchSetChapterLengthDTO
  | ContractPatchSetContentBoundariesDTO
  | ContractPatchRemoveOptionalFieldDTO
  | ContractPatchUpsertProtagonistDTO
  | ContractPatchUpsertSupportingCharacterDTO
  | ContractPatchUpsertRelationshipDTO
  | ContractPatchRemoveCharacterDTO
  | ContractPatchRemoveRelationshipDTO;

/** set-scalar: premise-like string paths */
export interface ContractPatchSetPremiseLikeDTO {
  readonly kind: 'set-scalar';
  readonly path: '/premise' | '/targetAudience' | '/structure';
  readonly value: string;
}

/** set-scalar: narrativePov with NarrativePov enum */
export interface ContractPatchSetNarrativePovDTO {
  readonly kind: 'set-scalar';
  readonly path: '/narrativePov';
  readonly value: NarrativePov;
}

/** set-scalar: tense with Tense enum */
export interface ContractPatchSetTenseDTO {
  readonly kind: 'set-scalar';
  readonly path: '/tense';
  readonly value: Tense;
}

/** set-scalar: protagonist child fields */
export interface ContractPatchSetProtagonistScalarDTO {
  readonly kind: 'set-scalar';
  readonly path:
    '/protagonist/name' | '/protagonist/role' | '/protagonist/motivation' | '/protagonist/arc';
  readonly value: string;
}

/** set-scalar: targetLength/unit with TargetLengthUnit enum */
export interface ContractPatchSetTargetLengthUnitDTO {
  readonly kind: 'set-scalar';
  readonly path: '/targetLength/unit';
  readonly value: TargetLengthUnit;
}

/** set-scalar: targetLength/value with number */
export interface ContractPatchSetTargetLengthValueDTO {
  readonly kind: 'set-scalar';
  readonly path: '/targetLength/value';
  readonly value: number;
}

/** set-scalar: chapterLength numeric children */
export interface ContractPatchSetChapterLengthValueDTO {
  readonly kind: 'set-scalar';
  readonly path:
    | '/chapterLength/targetCharacters'
    | '/chapterLength/minimumCharacters'
    | '/chapterLength/maximumCharacters';
  readonly value: number;
}

/** set-scalar: contentBoundaries scalar children */
export interface ContractPatchSetContentBoundariesScalarDTO {
  readonly kind: 'set-scalar';
  readonly path: '/contentBoundaries/rating' | '/contentBoundaries/notes';
  readonly value: string;
}

/** set-scalar: supporting character fields */
export interface ContractPatchSetSupportingCharScalarDTO {
  readonly kind: 'set-scalar';
  readonly path:
    | `/supportingCharacters/${string}/name`
    | `/supportingCharacters/${string}/role`
    | `/supportingCharacters/${string}/relationship`;
  readonly value: string;
}

/** set-scalar: relationship fields */
export interface ContractPatchSetRelationshipScalarDTO {
  readonly kind: 'set-scalar';
  readonly path: `/relationships/${string}/type` | `/relationships/${string}/dynamic`;
  readonly value: string;
}

/** set-string-list: top-level list paths */
export interface ContractPatchSetStringListTopLevelDTO {
  readonly kind: 'set-string-list';
  readonly path:
    | '/genre'
    | '/tone'
    | '/themes'
    | '/worldRules'
    | '/mustInclude'
    | '/mustAvoid'
    | '/unresolvedQuestions';
  readonly value: ReadonlyArray<string>;
}

/** set-string-list: protagonist/traits */
export interface ContractPatchSetProtagonistTraitsDTO {
  readonly kind: 'set-string-list';
  readonly path: '/protagonist/traits';
  readonly value: ReadonlyArray<string>;
}

/** set-string-list: contentBoundaries list children */
export interface ContractPatchSetContentBoundariesListDTO {
  readonly kind: 'set-string-list';
  readonly path: '/contentBoundaries/allowedContent' | '/contentBoundaries/prohibitedContent';
  readonly value: ReadonlyArray<string>;
}

/** set-string-list: supporting character traits */
export interface ContractPatchSetSupportingCharTraitsDTO {
  readonly kind: 'set-string-list';
  readonly path: `/supportingCharacters/${string}/traits`;
  readonly value: ReadonlyArray<string>;
}

/** set-structured: /targetLength → { unit, value } */
export interface ContractPatchSetTargetLengthDTO {
  readonly kind: 'set-structured';
  readonly path: '/targetLength';
  readonly value: { readonly unit: TargetLengthUnit; readonly value: number };
}

/** set-structured: /chapterLength → 单章正文字符目标 */
export interface ContractPatchSetChapterLengthDTO {
  readonly kind: 'set-structured';
  readonly path: '/chapterLength';
  readonly value: {
    readonly targetCharacters: number;
    readonly minimumCharacters?: number;
    readonly maximumCharacters?: number;
  };
}

/** set-structured: /contentBoundaries → object */
export interface ContractPatchSetContentBoundariesDTO {
  readonly kind: 'set-structured';
  readonly path: '/contentBoundaries';
  readonly value: {
    readonly rating?: string;
    readonly allowedContent?: ReadonlyArray<string>;
    readonly prohibitedContent?: ReadonlyArray<string>;
    readonly notes?: string;
  };
}

/** remove-field (complete set matching domain) */
export interface ContractPatchRemoveOptionalFieldDTO {
  readonly kind: 'remove-field';
  readonly path:
    | '/themes'
    | '/targetLength'
    | '/chapterLength'
    | '/structure'
    | '/supportingCharacters'
    | '/relationships'
    | '/worldRules'
    | '/mustInclude'
    | '/mustAvoid'
    | '/contentBoundaries'
    | '/unresolvedQuestions'
    | '/protagonist/role'
    | '/protagonist/motivation'
    | '/protagonist/arc'
    | '/protagonist/traits'
    | '/contentBoundaries/rating'
    | '/contentBoundaries/allowedContent'
    | '/contentBoundaries/prohibitedContent'
    | '/contentBoundaries/notes';
}

/** upsert-protagonist */
export interface ContractPatchUpsertProtagonistDTO {
  readonly kind: 'upsert-protagonist';
  readonly value: {
    readonly characterKey: string;
    readonly name: string;
    readonly role?: string;
    readonly motivation?: string;
    readonly arc?: string;
    readonly traits?: ReadonlyArray<string>;
  };
}

/** upsert-supporting-character */
export interface ContractPatchUpsertSupportingCharacterDTO {
  readonly kind: 'upsert-supporting-character';
  readonly target: string;
  readonly value: {
    readonly characterKey: string;
    readonly name: string;
    readonly role?: string;
    readonly relationship?: string;
    readonly traits?: ReadonlyArray<string>;
  };
}

/** upsert-relationship */
export interface ContractPatchUpsertRelationshipDTO {
  readonly kind: 'upsert-relationship';
  readonly target: string;
  readonly value: {
    readonly relationshipKey: string;
    readonly fromCharacterKey: string;
    readonly toCharacterKey: string;
    readonly type: string;
    readonly dynamic?: string;
  };
}

/** remove-character */
export interface ContractPatchRemoveCharacterDTO {
  readonly kind: 'remove-character';
  readonly target: string;
}

/** remove-relationship */
export interface ContractPatchRemoveRelationshipDTO {
  readonly kind: 'remove-relationship';
  readonly target: string;
}

// ── Runtime validation constants ──────────────────────────────────

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

const VALID_NARRATIVE_POV: ReadonlySet<string> = new Set([
  'FIRST',
  'THIRD_LIMITED',
  'THIRD_OMNISCIENT',
  'SECOND',
  'OTHER',
]);

const VALID_TENSE: ReadonlySet<string> = new Set(['PAST', 'PRESENT', 'MIXED']);

const VALID_TARGET_LENGTH_UNIT: ReadonlySet<string> = new Set(['words', 'chapters']);

const VALID_PROVENANCE_SOURCE: ReadonlySet<string> = new Set([
  'GRILL_ANSWER',
  'AI_PROPOSAL',
  'USER_EDIT',
  'PREVIOUS_VERSION',
  'DEFAULT',
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

const STABLE_KEY_RE = /^[a-z0-9_-]{1,50}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const SET_SCALAR_STRING_PATHS: ReadonlySet<string> = new Set([
  '/premise',
  '/targetAudience',
  '/structure',
  '/protagonist/name',
  '/protagonist/role',
  '/protagonist/motivation',
  '/protagonist/arc',
  '/contentBoundaries/rating',
  '/contentBoundaries/notes',
]);

const SET_SCALAR_ENUM_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/narrativePov', VALID_NARRATIVE_POV],
  ['/tense', VALID_TENSE],
  ['/targetLength/unit', VALID_TARGET_LENGTH_UNIT],
]);

const SET_SCALAR_NUMBER_PATHS: ReadonlySet<string> = new Set([
  '/targetLength/value',
  '/chapterLength/targetCharacters',
  '/chapterLength/minimumCharacters',
  '/chapterLength/maximumCharacters',
]);

const STRING_LIST_PATHS: ReadonlySet<string> = new Set([
  '/genre',
  '/tone',
  '/themes',
  '/worldRules',
  '/mustInclude',
  '/mustAvoid',
  '/unresolvedQuestions',
  '/protagonist/traits',
  '/contentBoundaries/allowedContent',
  '/contentBoundaries/prohibitedContent',
]);

const STRUCTURED_PATHS: ReadonlySet<string> = new Set([
  '/targetLength',
  '/chapterLength',
  '/contentBoundaries',
]);

const REMOVE_FIELD_PATHS: ReadonlySet<string> = new Set([
  '/themes',
  '/targetLength',
  '/chapterLength',
  '/structure',
  '/supportingCharacters',
  '/relationships',
  '/worldRules',
  '/mustInclude',
  '/mustAvoid',
  '/contentBoundaries',
  '/unresolvedQuestions',
  '/protagonist/role',
  '/protagonist/motivation',
  '/protagonist/arc',
  '/protagonist/traits',
  '/contentBoundaries/rating',
  '/contentBoundaries/allowedContent',
  '/contentBoundaries/prohibitedContent',
  '/contentBoundaries/notes',
]);

const SUPPORTING_CHAR_SCALAR_RE = /^\/supportingCharacters\/([^/]+)\/(name|role|relationship)$/;
const RELATIONSHIP_SCALAR_RE = /^\/relationships\/([^/]+)\/(type|dynamic)$/;
const SUPPORTING_CHAR_TRAITS_RE = /^\/supportingCharacters\/([^/]+)\/traits$/;

// ── Runtime validators ────────────────────────────────────────────

function isStringArray(v: unknown): v is ReadonlyArray<string> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function hasExactKeys(obj: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const objKeys = Object.keys(obj).sort();
  const expected = [...keys].sort();
  return objKeys.length === expected.length && objKeys.every((k, i) => k === expected[i]);
}

function hasKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) return false;
  }
  for (const r of required) {
    if (!(r in obj)) return false;
  }
  return true;
}

function isValidSetScalarDTO(obj: Record<string, unknown>): boolean {
  if (typeof obj.path !== 'string') return false;
  const path = obj.path;

  if (SET_SCALAR_STRING_PATHS.has(path)) {
    return typeof obj.value === 'string' && obj.value.trim().length > 0;
  }
  const enumSet = SET_SCALAR_ENUM_PATHS.get(path);
  if (enumSet) {
    return typeof obj.value === 'string' && enumSet.has(obj.value);
  }
  if (SET_SCALAR_NUMBER_PATHS.has(path)) {
    return (
      typeof obj.value === 'number' &&
      Number.isFinite(obj.value) &&
      Number.isSafeInteger(obj.value) &&
      obj.value > 0
    );
  }
  const supportingMatch = SUPPORTING_CHAR_SCALAR_RE.exec(path);
  if (supportingMatch) {
    return STABLE_KEY_RE.test(supportingMatch[1]) && typeof obj.value === 'string';
  }
  const relMatch = RELATIONSHIP_SCALAR_RE.exec(path);
  if (relMatch) {
    return STABLE_KEY_RE.test(relMatch[1]) && typeof obj.value === 'string';
  }
  return false;
}

function isValidStringListDTO(obj: Record<string, unknown>): boolean {
  if (typeof obj.path !== 'string') return false;
  const path = obj.path;
  if (!isStringArray(obj.value)) return false;

  if (STRING_LIST_PATHS.has(path)) return true;

  const traitsMatch = SUPPORTING_CHAR_TRAITS_RE.exec(path);
  if (traitsMatch) return STABLE_KEY_RE.test(traitsMatch[1]);

  return false;
}

function isValidStructuredDTO(obj: Record<string, unknown>): boolean {
  if (typeof obj.path !== 'string' || obj.value === null || typeof obj.value !== 'object')
    return false;
  if (!STRUCTURED_PATHS.has(obj.path)) return false;

  if (obj.path === '/targetLength') {
    const v = obj.value as Record<string, unknown>;
    return (
      hasExactKeys(v, ['unit', 'value']) &&
      typeof v.unit === 'string' &&
      VALID_TARGET_LENGTH_UNIT.has(v.unit) &&
      typeof v.value === 'number' &&
      Number.isSafeInteger(v.value) &&
      v.value > 0
    );
  }
  if (obj.path === '/chapterLength') {
    const v = obj.value as Record<string, unknown>;
    if (
      !hasKeys(
        v,
        ['targetCharacters', 'minimumCharacters', 'maximumCharacters'],
        ['targetCharacters'],
      )
    ) {
      return false;
    }
    const isCharacters = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 500 && value <= 40_000;
    if (!isCharacters(v.targetCharacters)) return false;
    if (v.minimumCharacters !== undefined && !isCharacters(v.minimumCharacters)) return false;
    if (v.maximumCharacters !== undefined && !isCharacters(v.maximumCharacters)) return false;
    if (typeof v.minimumCharacters === 'number' && v.minimumCharacters > v.targetCharacters) {
      return false;
    }
    if (typeof v.maximumCharacters === 'number' && v.maximumCharacters < v.targetCharacters) {
      return false;
    }
    return true;
  }
  if (obj.path === '/contentBoundaries') {
    const v = obj.value as Record<string, unknown>;
    const allowed = ['rating', 'allowedContent', 'prohibitedContent', 'notes'];
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) return false;
    }
    if (v.rating !== undefined && (typeof v.rating !== 'string' || v.rating === null)) return false;
    if (v.allowedContent !== undefined && !isStringArray(v.allowedContent)) return false;
    if (v.prohibitedContent !== undefined && !isStringArray(v.prohibitedContent)) return false;
    if (v.notes !== undefined && (typeof v.notes !== 'string' || v.notes === null)) return false;
    return true;
  }
  return false;
}

export function isValidContractPatchOperationDTO(data: unknown): data is ContractPatchOperationDTO {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !VALID_PATCH_KINDS.has(obj.kind)) return false;

  switch (obj.kind) {
    case 'set-scalar':
      return hasExactKeys(obj, ['kind', 'path', 'value']) && isValidSetScalarDTO(obj);
    case 'set-string-list':
      return hasExactKeys(obj, ['kind', 'path', 'value']) && isValidStringListDTO(obj);
    case 'set-structured':
      return hasExactKeys(obj, ['kind', 'path', 'value']) && isValidStructuredDTO(obj);
    case 'remove-field':
      return (
        hasExactKeys(obj, ['kind', 'path']) &&
        typeof obj.path === 'string' &&
        REMOVE_FIELD_PATHS.has(obj.path)
      );
    case 'upsert-protagonist':
      return (
        hasExactKeys(obj, ['kind', 'value']) &&
        typeof obj.value === 'object' &&
        obj.value !== null &&
        hasKeys(
          obj.value as Record<string, unknown>,
          ['characterKey', 'name', 'role', 'motivation', 'arc', 'traits'],
          ['characterKey', 'name'],
        ) &&
        typeof (obj.value as Record<string, unknown>).characterKey === 'string' &&
        STABLE_KEY_RE.test((obj.value as Record<string, unknown>).characterKey as string) &&
        typeof (obj.value as Record<string, unknown>).name === 'string'
      );
    case 'upsert-supporting-character':
      return (
        hasExactKeys(obj, ['kind', 'target', 'value']) &&
        typeof obj.target === 'string' &&
        STABLE_KEY_RE.test(obj.target) &&
        typeof obj.value === 'object' &&
        obj.value !== null &&
        hasKeys(
          obj.value as Record<string, unknown>,
          ['characterKey', 'name', 'role', 'relationship', 'traits'],
          ['characterKey', 'name'],
        ) &&
        typeof (obj.value as Record<string, unknown>).characterKey === 'string' &&
        (obj.value as Record<string, unknown>).characterKey === obj.target &&
        typeof (obj.value as Record<string, unknown>).name === 'string'
      );
    case 'upsert-relationship':
      return (
        hasExactKeys(obj, ['kind', 'target', 'value']) &&
        typeof obj.target === 'string' &&
        STABLE_KEY_RE.test(obj.target) &&
        typeof obj.value === 'object' &&
        obj.value !== null &&
        hasKeys(
          obj.value as Record<string, unknown>,
          ['relationshipKey', 'fromCharacterKey', 'toCharacterKey', 'type', 'dynamic'],
          ['relationshipKey', 'fromCharacterKey', 'toCharacterKey', 'type'],
        ) &&
        typeof (obj.value as Record<string, unknown>).relationshipKey === 'string' &&
        (obj.value as Record<string, unknown>).relationshipKey === obj.target &&
        typeof (obj.value as Record<string, unknown>).fromCharacterKey === 'string' &&
        typeof (obj.value as Record<string, unknown>).toCharacterKey === 'string' &&
        typeof (obj.value as Record<string, unknown>).type === 'string'
      );
    case 'remove-character':
      return (
        hasExactKeys(obj, ['kind', 'target']) &&
        typeof obj.target === 'string' &&
        STABLE_KEY_RE.test(obj.target)
      );
    case 'remove-relationship':
      return (
        hasExactKeys(obj, ['kind', 'target']) &&
        typeof obj.target === 'string' &&
        STABLE_KEY_RE.test(obj.target)
      );
    default:
      return false;
  }
}

export function isValidContractPatchOperationsDTO(
  data: unknown,
): data is ReadonlyArray<ContractPatchOperationDTO> {
  return Array.isArray(data) && data.every(isValidContractPatchOperationDTO);
}

// ── Provenance runtime validator ─────────────────────────────────

export function isValidContractFieldProvenanceDTO(
  data: unknown,
): data is ContractFieldProvenanceDTO {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasExactKeys(obj, [
      'sectionKey',
      'source',
      'grillAnswerIds',
      'grillProposalIds',
      'aiTaskId',
      'modelInvocationId',
      'sourceProposalId',
      'previousFieldHash',
      'rationale',
    ])
  )
    return false;
  if (typeof obj.sectionKey !== 'string' || obj.sectionKey.length === 0) return false;
  if (typeof obj.source !== 'string' || !VALID_PROVENANCE_SOURCE.has(obj.source)) return false;
  if (!isStringArray(obj.grillAnswerIds)) return false;
  if (!isStringArray(obj.grillProposalIds)) return false;
  if (obj.aiTaskId !== null && typeof obj.aiTaskId !== 'string') return false;
  if (obj.modelInvocationId !== null && typeof obj.modelInvocationId !== 'string') return false;
  if (obj.sourceProposalId !== null && typeof obj.sourceProposalId !== 'string') return false;
  if (obj.previousFieldHash !== null) {
    if (typeof obj.previousFieldHash !== 'string' || !SHA256_HEX_RE.test(obj.previousFieldHash))
      return false;
  }
  if (obj.rationale !== null && typeof obj.rationale !== 'string') return false;
  return true;
}

export function isValidProvenanceArray(
  data: unknown,
): data is ReadonlyArray<ContractFieldProvenanceDTO> {
  if (!Array.isArray(data)) return false;
  const seenKeys = new Set<string>();
  for (const item of data) {
    if (!isValidContractFieldProvenanceDTO(item)) return false;
    if (seenKeys.has(item.sectionKey)) return false;
    seenKeys.add(item.sectionKey);
  }
  return true;
}

// ── Sections runtime validator ────────────────────────────────────

export function isValidCreationContractSectionsPublicData(
  data: unknown,
): data is CreationContractSectionsPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  const allowedTopKeys = [
    'premise',
    'genre',
    'tone',
    'themes',
    'targetAudience',
    'narrativePov',
    'tense',
    'targetLength',
    'chapterLength',
    'structure',
    'protagonist',
    'supportingCharacters',
    'relationships',
    'worldRules',
    'mustInclude',
    'mustAvoid',
    'contentBoundaries',
    'unresolvedQuestions',
  ];
  for (const k of Object.keys(obj)) {
    if (!allowedTopKeys.includes(k)) return false;
  }

  if (typeof obj.premise !== 'string') return false;
  if (!isStringArray(obj.genre)) return false;
  if (!isStringArray(obj.tone)) return false;
  if (obj.themes !== undefined && !isStringArray(obj.themes)) return false;
  if (typeof obj.targetAudience !== 'string') return false;
  if (typeof obj.narrativePov !== 'string' || !VALID_NARRATIVE_POV.has(obj.narrativePov))
    return false;
  if (typeof obj.tense !== 'string' || !VALID_TENSE.has(obj.tense)) return false;

  if (obj.targetLength !== undefined) {
    if (typeof obj.targetLength !== 'object' || obj.targetLength === null) return false;
    const tl = obj.targetLength as Record<string, unknown>;
    if (typeof tl.unit !== 'string' || !VALID_TARGET_LENGTH_UNIT.has(tl.unit)) return false;
    if (typeof tl.value !== 'number' || !Number.isSafeInteger(tl.value) || tl.value <= 0)
      return false;
    if (!hasExactKeys(tl, ['unit', 'value'])) return false;
  }

  if (obj.chapterLength !== undefined) {
    if (typeof obj.chapterLength !== 'object' || obj.chapterLength === null) return false;
    const cl = obj.chapterLength as Record<string, unknown>;
    if (
      !hasKeys(
        cl,
        ['targetCharacters', 'minimumCharacters', 'maximumCharacters'],
        ['targetCharacters'],
      )
    ) {
      return false;
    }
    const validCharacters = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 500 && value <= 40_000;
    if (!validCharacters(cl.targetCharacters)) return false;
    if (cl.minimumCharacters !== undefined && !validCharacters(cl.minimumCharacters)) return false;
    if (cl.maximumCharacters !== undefined && !validCharacters(cl.maximumCharacters)) return false;
    if (typeof cl.minimumCharacters === 'number' && cl.minimumCharacters > cl.targetCharacters) {
      return false;
    }
    if (typeof cl.maximumCharacters === 'number' && cl.maximumCharacters < cl.targetCharacters) {
      return false;
    }
  }

  if (obj.structure !== undefined && typeof obj.structure !== 'string') return false;

  if (typeof obj.protagonist !== 'object' || obj.protagonist === null) return false;
  const prot = obj.protagonist as Record<string, unknown>;
  if (typeof prot.characterKey !== 'string' || !STABLE_KEY_RE.test(prot.characterKey)) return false;
  if (typeof prot.name !== 'string') return false;
  const protAllowed = ['characterKey', 'name', 'role', 'motivation', 'arc', 'traits'];
  for (const k of Object.keys(prot)) {
    if (!protAllowed.includes(k)) return false;
  }

  if (obj.supportingCharacters !== undefined) {
    if (!Array.isArray(obj.supportingCharacters)) return false;
    for (const c of obj.supportingCharacters) {
      if (typeof c !== 'object' || c === null) return false;
      const ch = c as Record<string, unknown>;
      if (typeof ch.characterKey !== 'string' || !STABLE_KEY_RE.test(ch.characterKey)) return false;
      if (typeof ch.name !== 'string') return false;
      const chAllowed = ['characterKey', 'name', 'role', 'relationship', 'traits'];
      for (const k of Object.keys(ch)) {
        if (!chAllowed.includes(k)) return false;
      }
    }
  }

  if (obj.relationships !== undefined) {
    if (!Array.isArray(obj.relationships)) return false;
    for (const r of obj.relationships) {
      if (typeof r !== 'object' || r === null) return false;
      const rel = r as Record<string, unknown>;
      if (typeof rel.relationshipKey !== 'string' || !STABLE_KEY_RE.test(rel.relationshipKey))
        return false;
      if (typeof rel.fromCharacterKey !== 'string') return false;
      if (typeof rel.toCharacterKey !== 'string') return false;
      if (typeof rel.type !== 'string') return false;
      const relAllowed = [
        'relationshipKey',
        'fromCharacterKey',
        'toCharacterKey',
        'type',
        'dynamic',
      ];
      for (const k of Object.keys(rel)) {
        if (!relAllowed.includes(k)) return false;
      }
    }
  }

  if (obj.worldRules !== undefined && !isStringArray(obj.worldRules)) return false;
  if (obj.mustInclude !== undefined && !isStringArray(obj.mustInclude)) return false;
  if (obj.mustAvoid !== undefined && !isStringArray(obj.mustAvoid)) return false;

  if (obj.contentBoundaries !== undefined) {
    if (typeof obj.contentBoundaries !== 'object' || obj.contentBoundaries === null) return false;
    const cb = obj.contentBoundaries as Record<string, unknown>;
    const cbAllowed = ['rating', 'allowedContent', 'prohibitedContent', 'notes'];
    for (const k of Object.keys(cb)) {
      if (!cbAllowed.includes(k)) return false;
    }
    if (cb.rating !== undefined && typeof cb.rating !== 'string') return false;
    if (cb.allowedContent !== undefined && !isStringArray(cb.allowedContent)) return false;
    if (cb.prohibitedContent !== undefined && !isStringArray(cb.prohibitedContent)) return false;
    if (cb.notes !== undefined && typeof cb.notes !== 'string') return false;
  }

  if (obj.unresolvedQuestions !== undefined && !isStringArray(obj.unresolvedQuestions))
    return false;

  return true;
}

export function isValidContractVersionPublicData(data: unknown): data is ContractVersionPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.projectId === 'string' &&
    typeof obj.version === 'number' &&
    Number.isSafeInteger(obj.version) &&
    obj.version > 0 &&
    typeof obj.schemaVersion === 'number' &&
    Number.isSafeInteger(obj.schemaVersion) &&
    obj.schemaVersion > 0 &&
    (obj.sourceProposalId === null || typeof obj.sourceProposalId === 'string') &&
    (obj.basedOnGrillSessionId === null || typeof obj.basedOnGrillSessionId === 'string') &&
    (obj.basedOnGrillSessionVersion === null ||
      typeof obj.basedOnGrillSessionVersion === 'number') &&
    isValidCreationContractSectionsPublicData(obj.sections) &&
    Array.isArray(obj.lockedFieldPaths) &&
    obj.lockedFieldPaths.every((p: unknown) => typeof p === 'string') &&
    typeof obj.contractSnapshotHash === 'string' &&
    SHA256_HEX_RE.test(obj.contractSnapshotHash) &&
    isValidProvenanceArray(obj.provenance) &&
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
    Number.isSafeInteger(obj.baseGrillSessionVersion) &&
    obj.baseGrillSessionVersion > 0 &&
    (obj.baseContractVersion === null ||
      (typeof obj.baseContractVersion === 'number' &&
        Number.isSafeInteger(obj.baseContractVersion) &&
        obj.baseContractVersion > 0)) &&
    typeof obj.schemaVersion === 'number' &&
    Number.isSafeInteger(obj.schemaVersion) &&
    obj.schemaVersion > 0 &&
    isValidCreationContractSectionsPublicData(obj.sections) &&
    typeof obj.sectionsHash === 'string' &&
    SHA256_HEX_RE.test(obj.sectionsHash) &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string'
  );
}

// ── 创作契约 IPC 输入严格验证 ───────────────────────────────────────

/** 契约 ID 长度上限（Unicode code points） */
const CONTRACT_MAX_ID_LENGTH = 128;

function contractCodePointLength(str: string): number {
  return [...str].length;
}

/** 严格 ID：非空、trim 后非空、长度不超过上限 */
function isContractId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return contractCodePointLength(trimmed) <= CONTRACT_MAX_ID_LENGTH;
}

/** 严格正安全整数（拒绝 NaN/Infinity/0/负数/小数） */
function isContractPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** null 或正安全整数（严格 null 语义） */
function isContractNullablePositiveInt(value: unknown): boolean {
  return value === null || isContractPositiveInt(value);
}

/**
 * 拒绝继承/额外 key：允许的 key 集合必须与 obj 完全一致。
 *
 * 除 own exact keys 外，还拒绝：
 * - 自定义 prototype（enumerable inherited property）；
 * - class instance；
 * - array。
 *
 * 通过要求原型必须是 Object.prototype 或 null，并确认所有 key 均为 own property，
 * 防止 `Object.create({ now: 'inherited' })` + `Object.assign(obj, valid)` 之类
 * 的对象绕过 key 校验。
 */
function hasContractExactKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
): boolean {
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

// ── Canonical field path（自包含实现，与 domain grammar 一致）──────

const CONTRACT_VALID_SECTIONS: ReadonlySet<string> = new Set([
  'premise',
  'genre',
  'tone',
  'themes',
  'targetAudience',
  'narrativePov',
  'tense',
  'targetLength',
  'chapterLength',
  'structure',
  'protagonist',
  'supportingCharacters',
  'relationships',
  'worldRules',
  'mustInclude',
  'mustAvoid',
  'contentBoundaries',
  'unresolvedQuestions',
]);

const CONTRACT_STRUCTURED_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['targetLength', new Set(['unit', 'value'])],
  ['chapterLength', new Set(['targetCharacters', 'minimumCharacters', 'maximumCharacters'])],
  ['contentBoundaries', new Set(['rating', 'allowedContent', 'prohibitedContent', 'notes'])],
  ['protagonist', new Set(['characterKey', 'name', 'role', 'motivation', 'arc', 'traits'])],
]);

const CONTRACT_COLLECTION_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['supportingCharacters', new Set(['characterKey', 'name', 'role', 'relationship', 'traits'])],
  [
    'relationships',
    new Set(['relationshipKey', 'fromCharacterKey', 'toCharacterKey', 'type', 'dynamic']),
  ],
]);

const CONTRACT_STABLE_KEY_RE = /^[a-z0-9_-]{1,50}$/;

export function isCanonicalContractFieldPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  const segments = value.split('/').slice(1);
  if (segments.length === 0) return false;
  const section = segments[0];
  if (!CONTRACT_VALID_SECTIONS.has(section)) return false;
  if (segments.length === 1) return true;
  const structured = CONTRACT_STRUCTURED_CHILDREN.get(section);
  if (structured) {
    if (segments.length !== 2 || !structured.has(segments[1])) return false;
    return true;
  }
  const collection = CONTRACT_COLLECTION_CHILDREN.get(section);
  if (collection) {
    if (segments.length < 2 || segments.length > 3) return false;
    if (!CONTRACT_STABLE_KEY_RE.test(segments[1])) return false;
    if (segments.length === 3 && !collection.has(segments[2])) return false;
    return true;
  }
  return false;
}

// ── Query input validators ─────────────────────────────────────────

export function isValidGetCurrentCreationContractInput(
  data: unknown,
): data is GetCurrentCreationContractInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasContractExactKeys(obj, ['projectId']) && isContractId(obj.projectId);
}

export function isValidListCreationContractVersionsInput(
  data: unknown,
): data is ListCreationContractVersionsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasContractExactKeys(obj, ['projectId']) && isContractId(obj.projectId);
}

export function isValidGetCreationContractProposalInput(
  data: unknown,
): data is GetCreationContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'proposalId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.proposalId)
  );
}

export function isValidListCreationContractProposalsInput(
  data: unknown,
): data is ListCreationContractProposalsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return hasContractExactKeys(obj, ['projectId']) && isContractId(obj.projectId);
}

// ── Draft request validator ────────────────────────────────────────

export function isValidRequestContractDraftInput(data: unknown): data is RequestContractDraftInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractExactKeys(obj, [
      'projectId',
      'grillSessionId',
      'expectedGrillSessionVersion',
      'expectedContractVersion',
    ])
  ) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.grillSessionId) &&
    isContractPositiveInt(obj.expectedGrillSessionVersion) &&
    isContractNullablePositiveInt(obj.expectedContractVersion)
  );
}

// ── Mutation input validators ──────────────────────────────────────

export function isValidAcceptContractProposalInput(
  data: unknown,
): data is AcceptContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractExactKeys(obj, [
      'projectId',
      'proposalId',
      'expectedProposalSectionsHash',
      'expectedGrillSessionVersion',
      'expectedContractVersion',
      'operations',
    ])
  ) {
    return false;
  }
  if (
    !isContractId(obj.projectId) ||
    !isContractId(obj.proposalId) ||
    typeof obj.expectedProposalSectionsHash !== 'string' ||
    !SHA256_HEX_RE.test(obj.expectedProposalSectionsHash)
  ) {
    return false;
  }
  return (
    isContractPositiveInt(obj.expectedGrillSessionVersion) &&
    isContractNullablePositiveInt(obj.expectedContractVersion) &&
    isValidContractPatchOperationsDTO(obj.operations)
  );
}

export function isValidRejectContractProposalInput(
  data: unknown,
): data is RejectContractProposalInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'proposalId', 'expectedProposalSectionsHash'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.proposalId) &&
    typeof obj.expectedProposalSectionsHash === 'string' &&
    SHA256_HEX_RE.test(obj.expectedProposalSectionsHash)
  );
}

export function isValidUpdateContractByUserInput(data: unknown): data is UpdateContractByUserInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'expectedContractVersion', 'operations'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractPositiveInt(obj.expectedContractVersion) &&
    isValidContractPatchOperationsDTO(obj.operations)
  );
}

export function isValidLockContractFieldInput(data: unknown): data is LockContractFieldInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'expectedContractVersion', 'fieldPath'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractPositiveInt(obj.expectedContractVersion) &&
    isCanonicalContractFieldPath(obj.fieldPath)
  );
}

export function isValidUnlockContractFieldInput(data: unknown): data is UnlockContractFieldInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'expectedContractVersion', 'fieldPath'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractPositiveInt(obj.expectedContractVersion) &&
    isCanonicalContractFieldPath(obj.fieldPath)
  );
}

// ── 稿件 / 章节 / 章节版本 DTO ────────────────────────────────────

export type ManuscriptStatus = 'active' | 'archived';
export type ChapterStatus = 'active' | 'archived';
export type ChapterVersionSourceType =
  'USER' | 'AI_GENERATION' | 'AI_REWRITE' | 'IMPORT' | 'RESTORE';

/** 稿件公开数据 —— 返回给 Renderer */
export interface ManuscriptPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ManuscriptStatus;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 章节版本摘要 —— listChapterVersions 返回，**不含 content**（§7.3） */
export interface ChapterVersionSummary {
  readonly id: string;
  readonly chapterId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdAt: string;
  readonly parentVersionId: string | null;
  readonly creationContractVersionId: string | null;
  readonly contentHash: string;
}

/** 章节版本公开数据 —— getChapterVersion / createChapterVersion / promote 返回，含 content */
export interface ChapterVersionPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly parentVersionId: string | null;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdByTaskId: string | null;
  readonly invocationId: string | null;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
}

/** 章节列表项 —— 当前版本标题与版本数（UI 展示用） */
export interface ChapterSummary {
  readonly id: string;
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly position: number;
  readonly currentVersionId: string | null;
  readonly status: ChapterStatus;
  /** 当前版本标题；空章节为 null（UI 显示占位「未命名章节」） */
  readonly currentTitle: string | null;
  readonly versionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 章节公开数据 —— 含当前版本摘要与版本数 */
export interface ChapterPublicData {
  readonly id: string;
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly position: number;
  readonly currentVersionId: string | null;
  readonly status: ChapterStatus;
  readonly currentVersion: ChapterVersionSummary | null;
  readonly versionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── 稿件 / 章节 / 版本输入 DTO（Renderer 面，§7.1/§7.2）────────────
// Renderer 不传新 ID / now / sourceType / taskId / invocationId ——
// 全部由 Worker 或 application 注入。

export interface GetOrCreateManuscriptInput {
  readonly projectId: string;
  readonly title?: string;
}

export interface GetManuscriptInput {
  readonly projectId: string;
  readonly manuscriptId: string;
}

export interface ListChaptersInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly includeArchived?: boolean;
}

export interface GetChapterInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly chapterId: string;
}

export interface GetCurrentChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
}

export interface ListChapterVersionsInput {
  readonly projectId: string;
  readonly chapterId: string;
}

export interface GetChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
}

export interface CreateChapterInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly insertBeforeChapterId: string | null;
}

export interface CreateChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly title: string;
  readonly content: string;
  readonly expectedCurrentVersionId: string | null;
  readonly creationContractVersionId?: string | null;
}

export interface PromoteChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly expectedCurrentVersionId: string | null;
}

export interface UpdateChapterOrderInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly chapterId: string;
  readonly insertBeforeChapterId: string | null;
}

export interface ArchiveChapterInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly expectedCurrentVersionId: string | null;
}

export interface RestoreChapterInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly expectedCurrentVersionId: string | null;
}

export interface UpdateManuscriptTitleInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly title: string;
  readonly expectedUpdatedAt: string;
}

// ── 稿件 / 章节 / 版本严格输入验证 ─────────────────────────────────
// 与创作契约同一套严格约束：exact keys（拒绝继承/多余字段）、
// ID trim 非空且 ≤128 code points、position/versionNumber 正安全整数、
// null 语义严格。

/**
 * 允许子集 + 必需字段的严格 key 校验（可选字段输入用）。
 *
 * 与 hasContractExactKeys 同一强度：拒绝 array / 自定义 prototype /
 * 非 own enumerable key，且只允许 allowed 中的 key；
 * 与 hasContractExactKeys 不同：allowed 中可选字段可以缺失，
 * 但 required 中每个字段都必须存在（own property）。
 */
function hasContractAllowedKeys(
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

const MANUSCRIPT_STATUS_SET: ReadonlySet<string> = new Set(['active', 'archived']);
const CHAPTER_VERSION_SOURCE_SET: ReadonlySet<string> = new Set([
  'USER',
  'AI_GENERATION',
  'AI_REWRITE',
  'IMPORT',
  'RESTORE',
]);
const MANUSCRIPT_TITLE_MAX = 200;
const CHAPTER_CONTENT_MAX = 1_000_000;

function isManuscriptStatusValue(value: unknown): value is ManuscriptStatus {
  return typeof value === 'string' && MANUSCRIPT_STATUS_SET.has(value);
}

function isChapterStatusValue(value: unknown): value is ChapterStatus {
  return typeof value === 'string' && MANUSCRIPT_STATUS_SET.has(value);
}

function isChapterVersionSourceValue(value: unknown): value is ChapterVersionSourceType {
  return typeof value === 'string' && CHAPTER_VERSION_SOURCE_SET.has(value);
}

/** 严格标题：trim 后非空且 ≤ 200 UTF-16 code units */
function isManuscriptTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return trimmed.length <= MANUSCRIPT_TITLE_MAX;
}

/** 严格正文：string 且 ≤ 1,000,000 UTF-16 code units（允许空串，不 trim） */
function isChapterContent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.length <= CHAPTER_CONTENT_MAX;
}

/** 严格 position / versionNumber：正安全整数 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** null 或非空 ID */
function isNullableId(value: unknown): boolean {
  return value === null || isContractId(value);
}

/** 严格更新时间戳（宽松结构校验：非空字符串） */
function isIsoTimestampLike(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLowercaseSha256HexLike(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isValidGetOrCreateManuscriptInput(
  data: unknown,
): data is GetOrCreateManuscriptInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractAllowedKeys(obj, ['projectId', 'title'], ['projectId'])) return false;
  if (!isContractId(obj.projectId)) return false;
  if (obj.title !== undefined && !isManuscriptTitle(obj.title)) return false;
  return true;
}

export function isValidGetManuscriptInput(data: unknown): data is GetManuscriptInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'manuscriptId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId)
  );
}

export function isValidListChaptersInput(data: unknown): data is ListChaptersInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractAllowedKeys(
      obj,
      ['projectId', 'manuscriptId', 'includeArchived'],
      ['projectId', 'manuscriptId'],
    )
  ) {
    return false;
  }
  if (!isContractId(obj.projectId) || !isContractId(obj.manuscriptId)) return false;
  if (obj.includeArchived !== undefined && typeof obj.includeArchived !== 'boolean') return false;
  return true;
}

export function isValidGetChapterInput(data: unknown): data is GetChapterInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'manuscriptId', 'chapterId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId) &&
    isContractId(obj.chapterId)
  );
}

export function isValidGetCurrentChapterVersionInput(
  data: unknown,
): data is GetCurrentChapterVersionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'chapterId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId)
  );
}

export function isValidListChapterVersionsInput(data: unknown): data is ListChapterVersionsInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'chapterId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId)
  );
}

export function isValidGetChapterVersionInput(data: unknown): data is GetChapterVersionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, ['projectId', 'chapterId', 'versionId']) &&
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isContractId(obj.versionId)
  );
}

export function isValidCreateChapterInput(data: unknown): data is CreateChapterInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'manuscriptId', 'insertBeforeChapterId'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId) &&
    isNullableId(obj.insertBeforeChapterId)
  );
}

export function isValidCreateChapterVersionInput(data: unknown): data is CreateChapterVersionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractAllowedKeys(
      obj,
      [
        'projectId',
        'chapterId',
        'title',
        'content',
        'expectedCurrentVersionId',
        'creationContractVersionId',
      ],
      ['projectId', 'chapterId', 'title', 'content', 'expectedCurrentVersionId'],
    )
  ) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isManuscriptTitle(obj.title) &&
    isChapterContent(obj.content) &&
    isNullableId(obj.expectedCurrentVersionId) &&
    (obj.creationContractVersionId === undefined ||
      obj.creationContractVersionId === null ||
      isContractId(obj.creationContractVersionId))
  );
}

export function isValidPromoteChapterVersionInput(
  data: unknown,
): data is PromoteChapterVersionInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractExactKeys(obj, ['projectId', 'chapterId', 'versionId', 'expectedCurrentVersionId'])
  ) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isContractId(obj.versionId) &&
    isNullableId(obj.expectedCurrentVersionId)
  );
}

export function isValidUpdateChapterOrderInput(data: unknown): data is UpdateChapterOrderInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractExactKeys(obj, ['projectId', 'manuscriptId', 'chapterId', 'insertBeforeChapterId'])
  ) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId) &&
    isContractId(obj.chapterId) &&
    isNullableId(obj.insertBeforeChapterId)
  );
}

export function isValidArchiveChapterInput(data: unknown): data is ArchiveChapterInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'chapterId', 'expectedCurrentVersionId'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isNullableId(obj.expectedCurrentVersionId)
  );
}

export function isValidRestoreChapterInput(data: unknown): data is RestoreChapterInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'chapterId', 'expectedCurrentVersionId'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isNullableId(obj.expectedCurrentVersionId)
  );
}

export function isValidUpdateManuscriptTitleInput(
  data: unknown,
): data is UpdateManuscriptTitleInput {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!hasContractExactKeys(obj, ['projectId', 'manuscriptId', 'title', 'expectedUpdatedAt'])) {
    return false;
  }
  return (
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId) &&
    isManuscriptTitle(obj.title) &&
    isIsoTimestampLike(obj.expectedUpdatedAt)
  );
}

// ── 稿件 / 章节 / 版本公开数据验证 ─────────────────────────────────

export function isValidManuscriptPublicData(data: unknown): data is ManuscriptPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, [
      'id',
      'projectId',
      'title',
      'status',
      'creationContractVersionId',
      'createdAt',
      'updatedAt',
    ]) &&
    isContractId(obj.id) &&
    isContractId(obj.projectId) &&
    isManuscriptTitle(obj.title) &&
    isManuscriptStatusValue(obj.status) &&
    (obj.creationContractVersionId === null || isContractId(obj.creationContractVersionId)) &&
    isIsoTimestampLike(obj.createdAt) &&
    isIsoTimestampLike(obj.updatedAt)
  );
}

export function isValidChapterVersionSummary(data: unknown): data is ChapterVersionSummary {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, [
      'id',
      'chapterId',
      'versionNumber',
      'title',
      'sourceType',
      'createdAt',
      'parentVersionId',
      'creationContractVersionId',
      'contentHash',
    ]) &&
    isContractId(obj.id) &&
    isContractId(obj.chapterId) &&
    isPositiveSafeInteger(obj.versionNumber) &&
    isManuscriptTitle(obj.title) &&
    isChapterVersionSourceValue(obj.sourceType) &&
    isIsoTimestampLike(obj.createdAt) &&
    isNullableId(obj.parentVersionId) &&
    (obj.creationContractVersionId === null ||
      obj.creationContractVersionId === undefined ||
      isContractId(obj.creationContractVersionId)) &&
    isLowercaseSha256HexLike(obj.contentHash)
  );
}

export function isValidChapterVersionPublicData(data: unknown): data is ChapterVersionPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, [
      'id',
      'projectId',
      'chapterId',
      'versionNumber',
      'title',
      'content',
      'contentHash',
      'parentVersionId',
      'sourceType',
      'createdByTaskId',
      'invocationId',
      'creationContractVersionId',
      'createdAt',
    ]) &&
    isContractId(obj.id) &&
    isContractId(obj.projectId) &&
    isContractId(obj.chapterId) &&
    isPositiveSafeInteger(obj.versionNumber) &&
    isManuscriptTitle(obj.title) &&
    isChapterContent(obj.content) &&
    isLowercaseSha256HexLike(obj.contentHash) &&
    isNullableId(obj.parentVersionId) &&
    isChapterVersionSourceValue(obj.sourceType) &&
    isNullableId(obj.createdByTaskId) &&
    isNullableId(obj.invocationId) &&
    (obj.creationContractVersionId === null ||
      obj.creationContractVersionId === undefined ||
      isContractId(obj.creationContractVersionId)) &&
    isIsoTimestampLike(obj.createdAt)
  );
}

export function isValidChapterSummary(data: unknown): data is ChapterSummary {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    hasContractExactKeys(obj, [
      'id',
      'projectId',
      'manuscriptId',
      'position',
      'currentVersionId',
      'status',
      'currentTitle',
      'versionCount',
      'createdAt',
      'updatedAt',
    ]) &&
    isContractId(obj.id) &&
    isContractId(obj.projectId) &&
    isContractId(obj.manuscriptId) &&
    isPositiveSafeInteger(obj.position) &&
    isNullableId(obj.currentVersionId) &&
    isChapterStatusValue(obj.status) &&
    (obj.currentTitle === null || isManuscriptTitle(obj.currentTitle)) &&
    typeof obj.versionCount === 'number' &&
    Number.isSafeInteger(obj.versionCount) &&
    obj.versionCount >= 0 &&
    isIsoTimestampLike(obj.createdAt) &&
    isIsoTimestampLike(obj.updatedAt)
  );
}

export function isValidChapterPublicData(data: unknown): data is ChapterPublicData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (
    !hasContractExactKeys(obj, [
      'id',
      'projectId',
      'manuscriptId',
      'position',
      'currentVersionId',
      'status',
      'currentVersion',
      'versionCount',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return false;
  }
  if (
    !isContractId(obj.id) ||
    !isContractId(obj.projectId) ||
    !isContractId(obj.manuscriptId) ||
    !isPositiveSafeInteger(obj.position) ||
    !isNullableId(obj.currentVersionId) ||
    !isChapterStatusValue(obj.status) ||
    !(
      typeof obj.versionCount === 'number' &&
      Number.isSafeInteger(obj.versionCount) &&
      obj.versionCount >= 0
    ) ||
    !isIsoTimestampLike(obj.createdAt) ||
    !isIsoTimestampLike(obj.updatedAt)
  ) {
    return false;
  }
  if (obj.currentVersion === null) return true;
  return isValidChapterVersionSummary(obj.currentVersion);
}

// ── Idea-to-Novel Graph 跨进程契约 ─────────────────────────────────

export * from './idea-to-novel-graph.js';

// ── B11：Web RPC 命令面（apps/server HTTP 传输用）──────────────────
//
// 背景：Electron IPC → HTTP RPC 迁移。worker 的 dispatchCommand（apps/worker/src/index.ts）
// 接受 `{ requestId, command, payload }` 信封，82 个命令。此前全部输入校验挂在
// apps/desktop/src/main/index.ts 的 82 个 ipcMain.handle 里（renderer→main 边界）；
// HTTP 化后 main 这层不存在了，校验必须搬到这里供 apps/server 复用——否则部分
// handler（如 research 域）内部对 payload 零校验，会把不设防的入口直接暴露给
// 公网请求（安全关键）。
//
// 校验器语义：校验的是 worker dispatchCommand **收到的 payload**（即 main 转发时
// 组装后的形状），不是 renderer 的原始参数——绝大多数命令两者相同（main 校验完
// 原样转发 `input`），只有 project.open 这类命令 main 会先把裸参数包装成对象
// 再转发，但因为其校验函数本身接受的就是包装后的对象形状，直接复用即可。

/** worker dispatchCommand 接受的全部命令（与 apps/worker/src/index.ts 的 switch 一一对应） */
export const RPC_COMMANDS = {
  // 项目
  PROJECT_CREATE: 'project.create',
  PROJECT_LIST: 'project.list',
  PROJECT_OPEN: 'project.open',
  // 提供商
  PROVIDER_LIST: 'provider.list',
  PROVIDER_CREATE: 'provider.create',
  PROVIDER_UPDATE: 'provider.update',
  PROVIDER_DELETE: 'provider.delete',
  PROVIDER_SET_DEFAULT: 'provider.setDefault',
  PROVIDER_SAVE_API_KEY: 'provider.saveApiKey',
  PROVIDER_DELETE_API_KEY: 'provider.deleteApiKey',
  PROVIDER_TEST_CONNECTION: 'provider.testConnection',
  // 搜索 key（Tavily；B5/D-B5-6）
  SEARCH_SAVE_API_KEY: 'search.saveApiKey',
  SEARCH_DELETE_API_KEY: 'search.deleteApiKey',
  SEARCH_HAS_API_KEY: 'search.hasApiKey',
  // 任务
  TASK_CREATE_MODEL_INVOCATION_TEST: 'task.createModelInvocationTest',
  TASK_GET: 'task.get',
  TASK_LIST: 'task.list',
  TASK_GET_STATS: 'task.getStats',
  // Grill-me
  GRILL_CREATE_SESSION: 'grill.createSession',
  GRILL_GET_SESSION: 'grill.getSession',
  GRILL_LIST_SESSIONS: 'grill.listSessions',
  GRILL_LIST_QUESTIONS: 'grill.listQuestions',
  GRILL_START_SESSION: 'grill.startSession',
  GRILL_PAUSE_SESSION: 'grill.pauseSession',
  GRILL_RESUME_SESSION: 'grill.resumeSession',
  GRILL_COMPLETE_SESSION: 'grill.completeSession',
  GRILL_ABANDON_SESSION: 'grill.abandonSession',
  GRILL_ADD_QUESTIONS: 'grill.addQuestions',
  GRILL_MARK_QUESTION_ASKED: 'grill.markQuestionAsked',
  GRILL_ANSWER_QUESTION: 'grill.answerQuestion',
  GRILL_SKIP_QUESTION: 'grill.skipQuestion',
  GRILL_SUPERSEDE_QUESTION: 'grill.supersedeQuestion',
  GRILL_GET_CURRENT_ANSWERS: 'grill.getCurrentAnswers',
  GRILL_LIST_ANSWER_HISTORY: 'grill.listAnswerHistory',
  GRILL_CREATE_PROPOSAL: 'grill.createProposal',
  GRILL_REVIEW_PROPOSAL: 'grill.reviewProposal',
  GRILL_LIST_PROPOSALS: 'grill.listProposals',
  GRILL_REQUEST_QUESTION_PLAN: 'grill.requestQuestionPlan',
  GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL: 'grill.acceptQuestionPlanProposal',
  GRILL_LIST_QUESTION_PLAN_PROPOSALS: 'grill.listQuestionPlanProposals',
  GRILL_GET_QUESTION_PLAN_PROPOSAL: 'grill.getQuestionPlanProposal',
  // 创作契约
  CONTRACT_GET_CURRENT: 'contract.getCurrent',
  CONTRACT_LIST_VERSIONS: 'contract.listVersions',
  CONTRACT_GET_PROPOSAL: 'contract.getProposal',
  CONTRACT_LIST_PROPOSALS: 'contract.listProposals',
  CONTRACT_REQUEST_DRAFT: 'contract.requestDraft',
  CONTRACT_ACCEPT_PROPOSAL: 'contract.acceptProposal',
  CONTRACT_REJECT_PROPOSAL: 'contract.rejectProposal',
  CONTRACT_UPDATE_BY_USER: 'contract.updateByUser',
  CONTRACT_LOCK_FIELD: 'contract.lockField',
  CONTRACT_UNLOCK_FIELD: 'contract.unlockField',
  // Graph run（GE-1）。仅 renderer 安全命令：advanceNode/failNode/requestHumanDecision
  // 不在 RPC 面上（见 apps/worker/src/index.ts dispatchCommand 顶部说明）。
  GRAPH_CREATE_PROJECT_RUN: 'graph.createProjectRun',
  GRAPH_CREATE_CHAPTER_RUN: 'graph.createChapterRun',
  GRAPH_GET_RUN_PROGRESS: 'graph.getRunProgress',
  GRAPH_APPLY_HUMAN_DECISION: 'graph.applyHumanDecision',
  GRAPH_LIST_RUNS: 'graph.listRuns',
  // Idea Intake（GE-3）。INTAKE_CREATE_SESSION 在 worker switch 里存在，但
  // apps/desktop/src/main/index.ts 从未为它开过 IPC 通道（初始 idea 播种目前只在
  // 内部流程中触发）。
  INTAKE_CREATE_SESSION: 'intake.createIntakeSession',
  INTAKE_GET_ACTIVE_SESSION: 'intake.getActiveIntakeSession',
  INTAKE_PROPAGATE_SPEC_INVALIDATION: 'intake.propagateSpecInvalidation',
  // Web Research（GE-4/B6）。RESEARCH_EXECUTE 同样在 worker switch 里存在，
  // 但 main 从未开通道（当前只有只读态/Bundle/来源排除五个通道对外）。
  RESEARCH_EXECUTE: 'research.execute',
  RESEARCH_GET_RESEARCH_STATE: 'research.getResearchState',
  RESEARCH_GET_BUNDLE: 'research.getBundle',
  RESEARCH_LIST_BUNDLES: 'research.listBundles',
  RESEARCH_SET_SOURCE_EXCLUSION: 'research.setSourceExclusion',
  RESEARCH_LIST_SOURCE_EXCLUSIONS: 'research.listSourceExclusions',
  // Story Blueprint（GE-5/B7/B8）。BLUEPRINT_LIST_CHAPTERS 同样在 worker switch
  // 里存在，但 main 从未开通道。
  BLUEPRINT_GET_STATE: 'blueprint.getState',
  BLUEPRINT_GET_BLUEPRINT: 'blueprint.getBlueprint',
  BLUEPRINT_LIST_CHAPTERS: 'blueprint.listChapters',
  // 章节生成（GE-6）
  CHAPTER_GET_OVERVIEW: 'chapter.getOverview',
  CHAPTER_START_RUN: 'chapter.startRun',
  CHAPTER_GET_RUN_STATE: 'chapter.getRunState',
  CHAPTER_SUBMIT_DECISION: 'chapter.submitDecision',
  // 稿件工作区与导出（GE-7）
  MANUSCRIPT_GET_WORKSPACE: 'manuscript.getWorkspace',
  MANUSCRIPT_GET_CHAPTER: 'manuscript.getChapter',
  MANUSCRIPT_SAVE_CHAPTER: 'manuscript.saveChapter',
  MANUSCRIPT_SAVE_DRAFT: 'manuscript.saveDraft',
  MANUSCRIPT_GET_DRAFT: 'manuscript.getDraft',
  MANUSCRIPT_DISCARD_DRAFT: 'manuscript.discardDraft',
  MANUSCRIPT_LIST_VERSIONS: 'manuscript.listVersions',
  MANUSCRIPT_RESTORE_VERSION: 'manuscript.restoreVersion',
  MANUSCRIPT_EXPORT: 'manuscript.export',
  // 故事图谱（D14 / B22）
  STORY_GRAPH_REBUILD: 'storyGraph.rebuild',
} as const;

export type RpcCommand = (typeof RPC_COMMANDS)[keyof typeof RPC_COMMANDS];

/** 服务端本地命令（不进 worker dispatch；apps/server 自己处理） */
export const SERVER_COMMANDS = {
  HEALTH_CHECK: 'app.healthCheck',
  DATA_SERVICE_STATUS: 'app.dataServiceStatus',
  DATA_SERVICE_RETRY: 'app.dataServiceRetry',
} as const;

export type ServerCommand = (typeof SERVER_COMMANDS)[keyof typeof SERVER_COMMANDS];

/** RPC payload 校验器：true = 放行。null = 该命令无 payload（服务端要求 payload 为 undefined/null）。 */
export type RpcValidator = (payload: unknown) => boolean;

// —— 以下四个命令 main 历来转发 null/`{}`，worker 侧 handler 完全不读 payload
// （project.list / provider.list 直接忽略；search.deleteApiKey / search.hasApiKey
// 的 handler 签名根本不接收 payload 参数）：按"无 payload"处理，apps/server 应
// 要求 payload 为 undefined/null，不接受任意形状蒙混过关。

// —— 以下四个命令 apps/desktop/src/main/index.ts 从未校验（payload 原样透传给
// forwardToWorker），但 worker 侧确有形状要求：
//   task.get/task.list/task.getStats —— apps/worker/src/index.ts 的
//     handleGetTask/handleListTasks/handleGetTaskStats 内联校验；
//   grill.listSessions —— apps/worker/src/grill-handlers.ts 的 handleListSessions。
// 校验器按 worker 实际读取的字段手写，语义不弱于 worker 现状。

/** task.get 的 RPC payload 形状：{ projectId, taskId } 均为字符串 */
function isValidTaskGetRpcPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj.projectId === 'string' && typeof obj.taskId === 'string';
}

/**
 * 仅含 projectId 的 RPC payload 形状：{ projectId: string }。
 * task.list / task.getStats / grill.listSessions 三个命令共用同一最小形状。
 */
function isValidProjectIdOnlyRpcPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj.projectId === 'string';
}

// —— 以下三个命令在 worker 的 dispatchCommand switch 里存在，但
// apps/desktop/src/main/index.ts 从未为它们开过 IPC 通道，因此没有既有校验器可
// 复用。校验器依据 worker 侧 intake-handlers.ts（assertStringField）/
// research-handlers.ts（assertStringField + assertDepth）/ blueprint-handlers.ts
// （assertStringField）的实际解析逻辑手写。

/** intake.createIntakeSession 的 RPC payload 形状：{ projectId, initialIdea } 均为非空 trimmed 字符串 */
function isValidIntakeCreateSessionRpcPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return (
    typeof obj.projectId === 'string' &&
    obj.projectId.trim().length > 0 &&
    typeof obj.initialIdea === 'string' &&
    obj.initialIdea.trim().length > 0
  );
}

/**
 * research.execute 的 RPC payload 形状：{ projectId, idea, depth, questions? }。
 * worker 侧 questions 缺失/形状不对时会静默降级为 []（不抛错），因此这里只在
 * questions 存在时才要求它是字符串数组——不比 worker 现状更严格。
 */
function isValidResearchExecuteRpcPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.projectId !== 'string' || obj.projectId.trim().length === 0) return false;
  if (typeof obj.idea !== 'string' || obj.idea.trim().length === 0) return false;
  if (obj.depth !== 'none' && obj.depth !== 'light' && obj.depth !== 'deep') return false;
  if (obj.questions !== undefined) {
    if (!Array.isArray(obj.questions) || !obj.questions.every((q) => typeof q === 'string')) {
      return false;
    }
  }
  return true;
}

/** RPC 命令 → payload 校验器的完整映射（TS 穷尽性检查：漏声明任何一个命令即编译失败） */
export const RPC_COMMAND_VALIDATORS: Readonly<Record<RpcCommand, RpcValidator | null>> = {
  [RPC_COMMANDS.PROJECT_CREATE]: isValidCreateProjectInput,
  [RPC_COMMANDS.PROJECT_LIST]: null,
  [RPC_COMMANDS.PROJECT_OPEN]: isValidOpenProjectInput,

  [RPC_COMMANDS.PROVIDER_LIST]: null,
  [RPC_COMMANDS.PROVIDER_CREATE]: isValidCreateProviderProfileInput,
  [RPC_COMMANDS.PROVIDER_UPDATE]: isValidUpdateProviderProfileInput,
  [RPC_COMMANDS.PROVIDER_DELETE]: isValidProviderProfileIdInput,
  [RPC_COMMANDS.PROVIDER_SET_DEFAULT]: isValidProviderProfileIdInput,
  [RPC_COMMANDS.PROVIDER_SAVE_API_KEY]: isValidSaveApiKeyInput,
  [RPC_COMMANDS.PROVIDER_DELETE_API_KEY]: isValidProviderProfileIdInput,
  [RPC_COMMANDS.PROVIDER_TEST_CONNECTION]: isValidProviderProfileIdInput,

  [RPC_COMMANDS.SEARCH_SAVE_API_KEY]: isValidSaveSearchApiKeyInput,
  [RPC_COMMANDS.SEARCH_DELETE_API_KEY]: null,
  [RPC_COMMANDS.SEARCH_HAS_API_KEY]: null,

  [RPC_COMMANDS.TASK_CREATE_MODEL_INVOCATION_TEST]: isValidCreateModelInvocationTestInput,
  [RPC_COMMANDS.TASK_GET]: isValidTaskGetRpcPayload,
  [RPC_COMMANDS.TASK_LIST]: isValidProjectIdOnlyRpcPayload,
  [RPC_COMMANDS.TASK_GET_STATS]: isValidProjectIdOnlyRpcPayload,

  [RPC_COMMANDS.GRILL_CREATE_SESSION]: isValidGrillCreateSessionInput,
  [RPC_COMMANDS.GRILL_GET_SESSION]: isValidGrillSessionIdInput,
  [RPC_COMMANDS.GRILL_LIST_SESSIONS]: isValidProjectIdOnlyRpcPayload,
  [RPC_COMMANDS.GRILL_LIST_QUESTIONS]: isValidGrillListQuestionsInput,
  [RPC_COMMANDS.GRILL_START_SESSION]: isValidGrillSessionVersionInput,
  [RPC_COMMANDS.GRILL_PAUSE_SESSION]: isValidGrillSessionVersionInput,
  [RPC_COMMANDS.GRILL_RESUME_SESSION]: isValidGrillSessionVersionInput,
  [RPC_COMMANDS.GRILL_COMPLETE_SESSION]: isValidGrillSessionVersionInput,
  [RPC_COMMANDS.GRILL_ABANDON_SESSION]: isValidGrillSessionVersionInput,
  [RPC_COMMANDS.GRILL_ADD_QUESTIONS]: isValidGrillAddQuestionsInput,
  [RPC_COMMANDS.GRILL_MARK_QUESTION_ASKED]: isValidGrillQuestionActionInput,
  [RPC_COMMANDS.GRILL_ANSWER_QUESTION]: isValidGrillAnswerQuestionInput,
  [RPC_COMMANDS.GRILL_SKIP_QUESTION]: isValidGrillQuestionActionInput,
  [RPC_COMMANDS.GRILL_SUPERSEDE_QUESTION]: isValidGrillQuestionActionInput,
  [RPC_COMMANDS.GRILL_GET_CURRENT_ANSWERS]: isValidGrillSessionIdInput,
  [RPC_COMMANDS.GRILL_LIST_ANSWER_HISTORY]: isValidGrillListAnswerHistoryInput,
  [RPC_COMMANDS.GRILL_CREATE_PROPOSAL]: isValidGrillCreateProposalInput,
  [RPC_COMMANDS.GRILL_REVIEW_PROPOSAL]: isValidGrillReviewProposalInput,
  [RPC_COMMANDS.GRILL_LIST_PROPOSALS]: isValidGrillListProposalsInput,
  [RPC_COMMANDS.GRILL_REQUEST_QUESTION_PLAN]: isValidGrillRequestQuestionPlanInput,
  [RPC_COMMANDS.GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL]: isValidGrillAcceptQuestionPlanProposalInput,
  [RPC_COMMANDS.GRILL_LIST_QUESTION_PLAN_PROPOSALS]: isValidGrillListQuestionPlanProposalsInput,
  [RPC_COMMANDS.GRILL_GET_QUESTION_PLAN_PROPOSAL]: isValidGrillQuestionPlanProposalIdInput,

  [RPC_COMMANDS.CONTRACT_GET_CURRENT]: isValidGetCurrentCreationContractInput,
  [RPC_COMMANDS.CONTRACT_LIST_VERSIONS]: isValidListCreationContractVersionsInput,
  [RPC_COMMANDS.CONTRACT_GET_PROPOSAL]: isValidGetCreationContractProposalInput,
  [RPC_COMMANDS.CONTRACT_LIST_PROPOSALS]: isValidListCreationContractProposalsInput,
  [RPC_COMMANDS.CONTRACT_REQUEST_DRAFT]: isValidRequestContractDraftInput,
  [RPC_COMMANDS.CONTRACT_ACCEPT_PROPOSAL]: isValidAcceptContractProposalInput,
  [RPC_COMMANDS.CONTRACT_REJECT_PROPOSAL]: isValidRejectContractProposalInput,
  [RPC_COMMANDS.CONTRACT_UPDATE_BY_USER]: isValidUpdateContractByUserInput,
  [RPC_COMMANDS.CONTRACT_LOCK_FIELD]: isValidLockContractFieldInput,
  [RPC_COMMANDS.CONTRACT_UNLOCK_FIELD]: isValidUnlockContractFieldInput,

  [RPC_COMMANDS.GRAPH_CREATE_PROJECT_RUN]: isValidCreateProjectRunInput,
  [RPC_COMMANDS.GRAPH_CREATE_CHAPTER_RUN]: isValidCreateChapterRunInput,
  [RPC_COMMANDS.GRAPH_GET_RUN_PROGRESS]: isValidGetRunProgressInput,
  [RPC_COMMANDS.GRAPH_APPLY_HUMAN_DECISION]: isValidApplyHumanDecisionInput,
  [RPC_COMMANDS.GRAPH_LIST_RUNS]: isValidListRunsInput,

  [RPC_COMMANDS.INTAKE_CREATE_SESSION]: isValidIntakeCreateSessionRpcPayload,
  [RPC_COMMANDS.INTAKE_GET_ACTIVE_SESSION]: isValidGetActiveIntakeSessionInput,
  [RPC_COMMANDS.INTAKE_PROPAGATE_SPEC_INVALIDATION]: isValidPropagateSpecInvalidationInput,

  [RPC_COMMANDS.RESEARCH_EXECUTE]: isValidResearchExecuteRpcPayload,
  [RPC_COMMANDS.RESEARCH_GET_RESEARCH_STATE]: isValidGetResearchStateInput,
  [RPC_COMMANDS.RESEARCH_GET_BUNDLE]: isValidGetResearchBundleInput,
  [RPC_COMMANDS.RESEARCH_LIST_BUNDLES]: isValidListResearchBundlesInput,
  [RPC_COMMANDS.RESEARCH_SET_SOURCE_EXCLUSION]: isValidSetSourceExclusionInput,
  [RPC_COMMANDS.RESEARCH_LIST_SOURCE_EXCLUSIONS]: isValidListSourceExclusionsInput,

  [RPC_COMMANDS.BLUEPRINT_GET_STATE]: isValidGetBlueprintStateInput,
  [RPC_COMMANDS.BLUEPRINT_GET_BLUEPRINT]: isValidGetBlueprintInput,
  // blueprint.listChapters 与 blueprint.getBlueprint 的 worker 端解析形状完全相同
  // （{ projectId, blueprintId }，见 blueprint-handlers.ts），直接复用。
  [RPC_COMMANDS.BLUEPRINT_LIST_CHAPTERS]: isValidGetBlueprintInput,

  [RPC_COMMANDS.CHAPTER_GET_OVERVIEW]: isValidGetChapterOverviewInput,
  [RPC_COMMANDS.CHAPTER_START_RUN]: isValidStartChapterRunInput,
  [RPC_COMMANDS.CHAPTER_GET_RUN_STATE]: isValidGetChapterRunStateInput,
  [RPC_COMMANDS.CHAPTER_SUBMIT_DECISION]: isValidSubmitChapterDecisionInput,

  [RPC_COMMANDS.MANUSCRIPT_GET_WORKSPACE]: isValidGetManuscriptWorkspaceInput,
  [RPC_COMMANDS.MANUSCRIPT_GET_CHAPTER]: isValidGetManuscriptChapterInput,
  [RPC_COMMANDS.MANUSCRIPT_SAVE_CHAPTER]: isValidSaveManuscriptChapterInput,
  [RPC_COMMANDS.MANUSCRIPT_SAVE_DRAFT]: isValidSaveChapterDraftInput,
  [RPC_COMMANDS.MANUSCRIPT_GET_DRAFT]: isValidGetChapterDraftInput,
  [RPC_COMMANDS.MANUSCRIPT_DISCARD_DRAFT]: isValidDiscardChapterDraftInput,
  [RPC_COMMANDS.MANUSCRIPT_LIST_VERSIONS]: isValidListManuscriptVersionsInput,
  [RPC_COMMANDS.MANUSCRIPT_RESTORE_VERSION]: isValidRestoreManuscriptVersionInput,
  [RPC_COMMANDS.MANUSCRIPT_EXPORT]: isValidExportManuscriptInput,

  [RPC_COMMANDS.STORY_GRAPH_REBUILD]: isValidRebuildStoryGraphInput,
};
