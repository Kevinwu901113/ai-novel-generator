/**
 * 创作契约草案任务执行引擎（CREATION_CONTRACT_DRAFT）。
 *
 * AI 只生成 CreationContractProposal（不可变、非权威），绝不直接创建
 * ContractVersion、绝不修改 current pointer、绝不自动接受。
 *
 * 关键约束：
 * - 任务输入严格解析（exact keys / canonical bytes / 完整 baseline ref）；
 * - claim 前验证 provider profile / API Key（缺失不增加 attempt）；
 * - 调用模型前重新校验 Grill session + contract baseline（stale-before-call → STALE）；
 * - 调用模型后再次校验（stale-after-call → invocation SUCCEEDED + task STALE，丢弃结果）；
 * - 严格模型输出解析（拒绝非 JSON/markdown/额外字段/额外文本/无效 sections）；
 * - 锁保护（generation-time CONTRACT_MODEL_LOCK_VIOLATION）；
 * - stable identity（protagonist.characterKey 不变，引用完整性由 domain 验证）；
 * - proposal + invocation success + task complete 在单个 BEGIN IMMEDIATE 事务中
 *   原子提交，最终事务内再次校验 stale；
 * - prompt 不持久化（仅 hash），API Key / raw model text / baseline sections
 *   不进入数据库、日志或错误；
 * - task.result 仅保存安全摘要。
 */

import type {
  TaskData,
  TaskRepositoryPort,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  IdGenerator,
  Clock,
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillProposalRepositoryPort,
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  Sha256Port,
  CreationContractVersionData,
} from '@ai-novel/application';
import {
  validateProposalAgainstLocks,
  validateAuthoritativeContractVersionSnapshot,
  ContractModelLockViolationError,
  ContractDataCorruptionError,
} from '@ai-novel/application';
import {
  validateContractDraftContext,
  type ValidatedContractDraftContext,
} from './contract-draft-context.js';
import type { ErrorCode } from '@ai-novel/contracts';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import {
  CREATION_CONTRACT_SCHEMA_VERSION,
  validateContractBaselineRef,
  validateCreationContractSections,
  canonicalSerializeContractSections,
  isLowercaseSha256Hex,
  type ContractBaselineRef,
  type CreationContractSections,
} from '@ai-novel/domain';
import { sha256Hex, TaskExecutionError } from './index.js';

// ── 依赖接口 ──────────────────────────────────────────────────────

export interface ContractDraftEngineDeps {
  readonly taskRepo: TaskRepositoryPort;
  readonly invocationRepo: ModelInvocationRepositoryPort;
  readonly secretStore: SecretStore;
  readonly providerRepo: ProviderProfileRepository;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly questionRepo: GrillQuestionRepositoryPort;
  readonly answerRepo: GrillAnswerRepositoryPort;
  readonly grillProposalRepo: GrillProposalRepositoryPort;
  readonly ccProposalRepo: CreationContractProposalRepositoryPort;
  readonly ccVersionRepo: CreationContractVersionRepositoryPort;
  readonly ccCurrentRepo: CreationContractCurrentRepositoryPort;
  readonly sha256Port: Sha256Port;
  readonly invokeModel: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }) => Promise<ModelInvocationOutput>;
  /** 最终提交使用 BEGIN IMMEDIATE（由 runner 注入 transactionImmediate） */
  readonly transaction: <T>(fn: () => T) => T;
}

export interface ContractDraftExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly proposalId: string | null;
}

// ── 常量 ──────────────────────────────────────────────────────────

const CONTRACT_MAX_TOKENS = 8192;
const CONTRACT_TEMPERATURE = 0.3;

const CONTRACT_DRAFT_INPUT_KEYS = [
  'grillSessionId',
  'baseGrillSessionVersion',
  'contractBaseline',
  'schemaVersion',
  'providerProfileId',
] as const;

// ── 内部哨兵 ──────────────────────────────────────────────────────

/** 基线已变化（stale）。由最终事务抛出并在外部转为 invocation SUCCEEDED + task STALE。 */
class StaleBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleBaselineError';
  }
}

/** 最终事务中 task/invocation 状态非 RUNNING（并发已终结）。回滚后交给 runner settlement。 */
class FinalStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalStateConflictError';
  }
}

// ── 工具 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

interface ContractDraftTaskInput {
  readonly grillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly contractBaseline: ContractBaselineRef;
  readonly schemaVersion: number;
  readonly providerProfileId: string;
}

/** 严格解析任务输入：exact keys、canonical bytes、完整 baseline。 */
function parseTaskInput(inputVersionJson: string): ContractDraftTaskInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputVersionJson);
  } catch {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length !== CONTRACT_DRAFT_INPUT_KEYS.length ||
    !CONTRACT_DRAFT_INPUT_KEYS.every((k) => k in obj)
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  // canonical bytes：round-trip 必须一致（紧凑、固定 key 顺序、无多余空白）
  if (JSON.stringify(obj) !== inputVersionJson) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }

  const {
    grillSessionId,
    baseGrillSessionVersion,
    contractBaseline,
    schemaVersion,
    providerProfileId,
  } = obj;
  if (typeof grillSessionId !== 'string' || grillSessionId.trim().length === 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  if (
    typeof baseGrillSessionVersion !== 'number' ||
    !Number.isSafeInteger(baseGrillSessionVersion) ||
    baseGrillSessionVersion < 1
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  if (schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  if (typeof providerProfileId !== 'string' || providerProfileId.trim().length === 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }

  let baseline: ContractBaselineRef;
  try {
    baseline = validateContractBaselineRef(contractBaseline);
  } catch {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }

  return {
    grillSessionId,
    baseGrillSessionVersion,
    contractBaseline: baseline,
    schemaVersion,
    providerProfileId,
  };
}

// ── Baseline 验证 ─────────────────────────────────────────────────

interface BaselineContext {
  readonly session: { goal: string; status: string; version: number };
  readonly baselineSections: CreationContractSections | null;
  readonly lockedFieldPaths: readonly string[];
  readonly baselineVersion: CreationContractVersionData | null;
}

/**
 * 重新读取并验证 Grill session + current contract baseline 与任务输入一致。
 *
 * 正确顺序（stale-before-call / stale-after-call / final transaction 三次调用
 * 使用同一验证路径）：
 * 1. Grill session：存在 / 属于 project / version 匹配 / 状态仍允许生成（COMPLETED）。
 * 2. Contract baseline：
 *    - 首次（baseline 三字段 null）：current pointer 必须仍不存在，否则 STALE；
 *    - 已有基线：
 *      a. 读取 current；pointer ID 不同 → STALE；
 *      b. 读取对应 version；缺失或 ownership/identity 损坏 → INTERNAL_ERROR；
 *      c. 调用共享严格 snapshot validator（canonical bytes / provenance /
 *         lineage / active locks / recomputed hash）；
 *      d. 严格验证成功后再比较 version number / contractSnapshotHash：
 *         真实但不同的权威 snapshot → STALE；数据库自身不完整 → FAILED / INTERNAL_ERROR。
 *
 * source of truth 变化 → 抛 StaleBaselineError（调用方转为 task STALE）。
 * 数据损坏 → 抛 ContractDataCorruptionError（FAILED）。
 */
function readBaselineForExecution(
  deps: ContractDraftEngineDeps,
  task: TaskData,
  input: ContractDraftTaskInput,
): BaselineContext {
  const session = deps.sessionRepo.getById(input.grillSessionId);
  if (!session) throw new StaleBaselineError('grill session missing');
  if (session.projectId !== task.projectId) {
    throw new ContractDataCorruptionError('grill session 不属于该项目');
  }
  if (session.version !== input.baseGrillSessionVersion) {
    throw new StaleBaselineError('grill session version changed');
  }
  if (session.status !== 'COMPLETED') {
    throw new StaleBaselineError('grill session status changed');
  }

  const baseline = input.contractBaseline;
  const current = deps.ccCurrentRepo.get(task.projectId);

  if (baseline.contractVersionId === null) {
    if (current !== null) {
      throw new StaleBaselineError('contract appeared during draft');
    }
    return {
      session: { goal: session.goal, status: session.status, version: session.version },
      baselineSections: null,
      lockedFieldPaths: [],
      baselineVersion: null,
    };
  }

  if (current === null) {
    throw new StaleBaselineError('contract current pointer disappeared');
  }
  if (current.currentVersionId !== baseline.contractVersionId) {
    throw new StaleBaselineError('contract current pointer changed');
  }

  const version = deps.ccVersionRepo.getById(task.projectId, baseline.contractVersionId);
  const validated = validateAuthoritativeContractVersionSnapshot({
    requestedProjectId: task.projectId,
    current,
    version,
    sha256Port: deps.sha256Port,
    context: 'creation_contract_draft baseline',
  });
  if (!validated.hasCurrent || validated.version === null || validated.sections === null) {
    throw new ContractDataCorruptionError(
      'creation_contract_draft baseline: 权威 snapshot 验证失败',
    );
  }

  // 严格验证成功后再比较 baseline（真实但不同的权威 snapshot → STALE）
  if (validated.version.version !== baseline.contractVersion) {
    throw new StaleBaselineError('contract version number changed');
  }
  if (validated.version.contractSnapshotHash !== baseline.contractSnapshotHash) {
    throw new StaleBaselineError('contract snapshot hash changed');
  }

  return {
    session: { goal: session.goal, status: session.status, version: session.version },
    baselineSections: validated.sections,
    lockedFieldPaths: validated.lockedFieldPaths,
    baselineVersion: validated.version,
  };
}

// ── Prompt 构建（仅内存，不持久化）──────────────────────────────

const CONTRACT_SYSTEM_PROMPT = [
  '你是中文小说创作契约（Creation Contract）的生成器。',
  '根据 Grill 会话的目标、问题、用户答案与已接受的推理提案，输出完整的小说创作契约快照。',
  '严格输出单个 JSON 对象，不要使用 markdown 代码块，不要在 JSON 前后添加任何文字。',
  '顶层结构必须精确为：{"schemaVersion":1,"sections":{...}}，不要输出任何额外顶层字段。',
  'sections 是完整快照，不是 patch：必须包含全部 required section，缺失 optional section 即表示未决定。',
  '若提供了当前契约基线，在基线基础上修订：保持未修改字段与基线一致，不输出 diff。',
  'lockedFieldPaths 中列出的字段必须逐字保持与基线 canonical 等价；locked-absent 字段必须保持缺失。',
  '不得改变稳定的 protagonist.characterKey；不得重命名任何既有角色或关系 key。',
  'relationships 的 fromCharacterKey/toCharacterKey 必须引用本快照中存在的角色。',
  '尚未解决或无法从已有信息推断的内容放入 unresolvedQuestions，不要编造用户明确否定的内容。',
  '字段长度与枚举必须符合 schema 限制。不要输出数据库 ID、proposalId、taskId 或任何内部标识。',
].join('\n');

function deterministicSort<T>(items: ReadonlyArray<T>, key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * 从 SQLite source of truth 加载上下文并构建 prompt（deterministic）。
 *
 * 相同 source-of-truth snapshot 产生相同 promptHash。prompt 只存在于内存。
 */
export function buildContractDraftPrompt(context: {
  readonly sessionGoal: string;
  readonly questions: ReadonlyArray<GrillQuestionData>;
  readonly answers: ReadonlyArray<GrillAnswerData>;
  readonly acceptedProposals: ReadonlyArray<GrillProposalData>;
  readonly baseline: {
    readonly sections: CreationContractSections | null;
    readonly lockedFieldPaths: readonly string[];
    readonly schemaVersion: number;
  };
}): string {
  const questions = deterministicSort(context.questions, (q) => q.id).map((q) => ({
    id: q.id,
    topic: q.topic,
    text: q.text,
    status: q.status,
    dependsOn: q.dependsOnQuestionIds,
  }));
  const answers = deterministicSort(context.answers, (a) => a.id).map((a) => ({
    id: a.id,
    questionId: a.questionId,
    source: a.source,
    text: a.text,
    revision: a.revision,
  }));
  // accepted proposals 已通过 validateContractDraftContext 严格验证：
  // proposedValueJson 必为有效 JSON、basedOnAnswerIds 可解析且引用合法。
  // 此处直接解析，不允许静默降级为 null。
  const acceptedProposals = deterministicSort(context.acceptedProposals, (p) => p.id).map((p) => ({
    id: p.id,
    key: p.key,
    confirmedValue: JSON.parse(p.proposedValueJson),
  }));

  const payload = {
    sessionGoal: context.sessionGoal,
    schemaVersion: context.baseline.schemaVersion,
    questions,
    answers,
    acceptedProposals,
    currentContractBaseline: context.baseline.sections
      ? {
          sections: context.baseline.sections,
          lockedFieldPaths: context.baseline.lockedFieldPaths,
          schemaVersion: context.baseline.schemaVersion,
        }
      : null,
  };

  return [
    'Grill 会话信息（JSON）：',
    JSON.stringify(payload),
    '',
    '请输出完整创作契约快照，严格按系统要求的 JSON 结构。',
  ].join('\n');
}

// ── Provider 输出安全边界 ─────────────────────────────────────────

/**
 * Provider 错误码白名单与固定安全映射。
 *
 * errorCode 来自可替换 adapter，不能信任其 errorMessage。
 * - errorCode 在 whitelist 内：使用本地固定消息；
 * - 未知或非 provider error code：映射为安全 PROVIDER_RESPONSE_INVALID；
 * - 绝不持久化 adapter 的原始 errorMessage（可能包含 Bearer token / API Key /
 *   URL / response body）。
 */
const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  PROVIDER_AUTH_FAILED: 'API Key 认证失败',
  PROVIDER_ACCESS_DENIED: '访问被拒绝',
  PROVIDER_MODEL_UNAVAILABLE: '模型不可用',
  PROVIDER_RATE_LIMITED: '请求频率超限',
  PROVIDER_TIMEOUT: '连接超时',
  NETWORK_UNAVAILABLE: '网络连接失败',
  PROVIDER_CONNECTION_FAILED: '连接失败',
  PROVIDER_RESPONSE_INVALID: '响应格式异常',
};

function safeProviderError(errorCode: unknown): { code: ErrorCode; message: string } {
  if (
    typeof errorCode === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_MESSAGES, errorCode)
  ) {
    return { code: errorCode as ErrorCode, message: PROVIDER_ERROR_MESSAGES[errorCode] };
  }
  return {
    code: 'PROVIDER_RESPONSE_INVALID',
    message: PROVIDER_ERROR_MESSAGES.PROVIDER_RESPONSE_INVALID,
  };
}

/** 非负有限安全数值（拒绝 NaN/Infinity/负数/非数值） */
function isSafeNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** null 或非负安全整数（token counts 必须为整数） */
function isSafeTokenCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** null 或非负有限数值（latencyMs 允许小数） */
function isSafeLatencyMs(value: unknown): value is number | null {
  return value === null || isSafeNonNegativeFinite(value);
}

/** null 或 string */
function isSafeStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * 将模型输出元数据映射为安全的 invocation 成功结果。
 *
 * 任何字段为 NaN / Infinity / 负数 / 错误类型 → 返回 null（调用方映射为
 * 安全 provider-response failure，不污染数据库）。
 */
function sanitizeInvocationSuccess(result: ModelInvocationOutput): {
  readonly responseMetadataJson: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly providerRequestId: string | null;
} | null {
  if (!isSafeStringOrNull(result.providerRequestId)) return null;
  if (!isSafeStringOrNull(result.finishReason)) return null;
  if (!isSafeTokenCount(result.usage.inputTokens)) return null;
  if (!isSafeTokenCount(result.usage.outputTokens)) return null;
  if (!isSafeTokenCount(result.usage.cacheReadTokens)) return null;
  if (!isSafeTokenCount(result.usage.cacheWriteTokens)) return null;
  if (!isSafeTokenCount(result.usage.totalTokens)) return null;
  if (!isSafeLatencyMs(result.latencyMs)) return null;
  return {
    responseMetadataJson: JSON.stringify({ textLength: result.text.length }),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    totalTokens: result.usage.totalTokens,
    latencyMs: result.latencyMs,
    finishReason: result.finishReason,
    providerRequestId: result.providerRequestId,
  };
}

// ── 模型输出严格解析 ─────────────────────────────────────────────

function parseAndValidateModelOutput(text: string): CreationContractSections {
  const trimmed = text.trim();

  // 非 JSON / markdown / 前后额外文本
  if (trimmed.startsWith('```') || trimmed.endsWith('```')) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出被 markdown 代码块包裹');
  }
  if (!trimmed.startsWith('{')) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出不是 JSON 对象');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出不是有效 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出不是 JSON 对象');
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  // exact top-level keys：仅 schemaVersion + sections
  if (keys.length !== 2 || !('schemaVersion' in obj) || !('sections' in obj)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出顶层字段无效');
  }
  if (obj.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出 schemaVersion 无效');
  }

  try {
    return validateCreationContractSections(obj.sections);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '模型输出的创作契约无效');
  }
}

// ── 任务执行 ──────────────────────────────────────────────────────

export async function executeCreationContractDraft(
  deps: ContractDraftEngineDeps,
  taskId: string,
): Promise<ContractDraftExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    clock,
    sha256Port,
    invokeModel,
    transaction,
  } = deps;

  // 1. 读取任务
  const task = taskRepo.getById(taskId);
  if (!task) {
    throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  if (task.taskType !== 'CREATION_CONTRACT_DRAFT') {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务类型不正确');
  }

  // claim 前终结：CAS failPending（attemptCount 保持 0），不创建 invocation
  const failBeforeClaim = (code: ErrorCode, message: string): ContractDraftExecutionResult => {
    const failed = taskRepo.failPending(taskId, code, message);
    if (!failed) {
      throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务状态冲突，无法终结为 FAILED');
    }
    return { task: taskRepo.getById(taskId)!, invocation: null, proposalId: null };
  };

  // 2. 严格解析任务输入（损坏输入 → claim 前 failPending）
  let input: ContractDraftTaskInput;
  try {
    input = parseTaskInput(task.inputVersionJson);
  } catch {
    return failBeforeClaim('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }

  // 3. claim 前加载 provider profile
  const profile = providerRepo.getById(input.providerProfileId);
  if (!profile || !profile.enabled) {
    return failBeforeClaim('PROVIDER_NOT_CONFIGURED', '模型提供商未配置或已禁用');
  }
  if (!profile.baseUrl || !profile.model || !profile.keychainService || !profile.keychainAccount) {
    return failBeforeClaim('PROVIDER_NOT_CONFIGURED', '模型提供商配置无效');
  }

  // 4. claim 前读取 API Key（失败不创建 invocation、不增加 attempt）
  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    return failBeforeClaim('API_KEY_READ_FAILED', '无法读取 API Key');
  }
  if (!apiKey) {
    return failBeforeClaim('API_KEY_REQUIRED', '请先配置 API Key');
  }

  // 5. CAS claim：PENDING → RUNNING + attempt_count++
  const claimed = taskRepo.claimPending(taskId);
  if (!claimed) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
  }
  const updatedTask = taskRepo.getById(taskId)!;

  // 6. stale-before-call：重新校验 session + contract baseline
  let baselineCtx: BaselineContext;
  try {
    baselineCtx = readBaselineForExecution(deps, task, input);
  } catch (e) {
    if (e instanceof StaleBaselineError) {
      transaction(() => {
        requireCas(taskRepo.markStale(taskId, ['RUNNING']), '无法标记任务为 STALE');
      });
      return { task: taskRepo.getById(taskId)!, invocation: null, proposalId: null };
    }
    throw e;
  }

  // 7. 加载上下文并严格验证 source-of-truth（损坏 → task 安全 FAILED，不调用模型）
  const questions = deps.questionRepo.listBySession(input.grillSessionId);
  const answers = deps.answerRepo.listCurrentBySession(input.grillSessionId);
  const grillProposals = deps.grillProposalRepo.listBySession(input.grillSessionId);
  let validatedContext: ValidatedContractDraftContext;
  try {
    validatedContext = validateContractDraftContext({
      sessionId: input.grillSessionId,
      questions,
      answers,
      proposals: grillProposals,
      answerRepo: deps.answerRepo,
    });
  } catch (e) {
    if (e instanceof ContractDataCorruptionError) {
      transaction(() => {
        requireCas(
          taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '创作契约草案数据完整性异常'),
          '无法标记任务失败',
        );
      });
      return { task: taskRepo.getById(taskId)!, invocation: null, proposalId: null };
    }
    throw e;
  }
  const acceptedProposals = validatedContext.acceptedProposals;
  const prompt = buildContractDraftPrompt({
    sessionGoal: baselineCtx.session.goal,
    questions,
    answers,
    acceptedProposals,
    baseline: {
      sections: baselineCtx.baselineSections,
      lockedFieldPaths: baselineCtx.lockedFieldPaths,
      schemaVersion: input.schemaVersion,
    },
  });
  const promptHash = sha256Hex(prompt);
  const promptLength = prompt.length;

  // 8. 创建 invocation（PENDING）
  const invocationId = idGenerator.generate();
  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: input.providerProfileId,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'creation_contract_draft',
    promptHash,
    requestMetadataJson: JSON.stringify({
      promptLength,
      schemaVersion: input.schemaVersion,
      baseGrillSessionVersion: input.baseGrillSessionVersion,
      baseContractVersion: input.contractBaseline.contractVersion,
      maxTokens: CONTRACT_MAX_TOKENS,
      temperature: CONTRACT_TEMPERATURE,
    }),
  });

  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  // 9. 调用模型（不自动 retry）
  let result: ModelInvocationOutput;
  try {
    result = await invokeModel({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      prompt,
      systemPrompt: CONTRACT_SYSTEM_PROMPT,
      maxTokens: CONTRACT_MAX_TOKENS,
      temperature: CONTRACT_TEMPERATURE,
    });
  } catch {
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'PROVIDER_CONNECTION_FAILED',
          '模型调用异常',
          null,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '模型调用异常'),
        '无法标记任务失败',
      );
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  // Provider 返回稳定错误码：白名单 + 固定安全映射。绝不持久化 adapter 的
  // errorMessage（可能包含 Bearer token / API Key / URL / response body）。
  if (result.errorCode) {
    const { code, message } = safeProviderError(result.errorCode);
    const latencyMs = isSafeLatencyMs(result.latencyMs) ? result.latencyMs : null;
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(invocationId, ['RUNNING'], code, message, latencyMs),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, code, message), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  // 元数据安全边界：NaN/Infinity/负数/错误类型 → 安全 provider-response failure，
  // 不得污染数据库。
  const invocationSuccess = sanitizeInvocationSuccess(result);
  if (invocationSuccess === null) {
    const { code, message } = safeProviderError('PROVIDER_RESPONSE_INVALID');
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(invocationId, ['RUNNING'], code, message, null),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, code, message), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  // 10. stale-after-call：再次校验；变化则丢弃模型 text，不创建 proposal
  try {
    readBaselineForExecution(deps, task, input);
  } catch (e) {
    if (e instanceof StaleBaselineError) {
      transaction(() => {
        requireCas(
          invocationRepo.markSucceeded(invocationId, 'RUNNING', invocationSuccess),
          '无法标记调用成功',
        );
        requireCas(taskRepo.markStale(taskId, ['RUNNING']), '无法标记任务为 STALE');
      });
      return {
        task: taskRepo.getById(taskId)!,
        invocation: invocationRepo.getById(invocationId),
        proposalId: null,
      };
    }
    throw e;
  }

  // 11. 严格解析模型输出
  let sections: CreationContractSections;
  try {
    sections = parseAndValidateModelOutput(result.text);
  } catch {
    const errorCode: ErrorCode = 'MODEL_RESPONSE_INVALID';
    const errorMessage = '模型返回的创作契约无效';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          errorCode,
          errorMessage,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, errorCode, errorMessage), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  // 12. 锁保护（generation-time）：locked present 值 canonical 相同 / locked absent 仍缺失
  if (baselineCtx.baselineSections !== null && baselineCtx.lockedFieldPaths.length > 0) {
    try {
      validateProposalAgainstLocks(
        sections,
        baselineCtx.baselineSections,
        baselineCtx.lockedFieldPaths,
      );
    } catch (e) {
      if (e instanceof ContractModelLockViolationError) {
        const errorCode: ErrorCode = 'CONTRACT_MODEL_LOCK_VIOLATION';
        const errorMessage = '模型输出修改了受保护字段';
        transaction(() => {
          requireCas(
            invocationRepo.markFailed(
              invocationId,
              ['RUNNING'],
              errorCode,
              errorMessage,
              result.latencyMs,
            ),
            '无法标记调用失败',
          );
          requireCas(taskRepo.failRunning(taskId, errorCode, errorMessage), '无法标记任务失败');
        });
        return {
          task: taskRepo.getById(taskId)!,
          invocation: invocationRepo.getById(invocationId),
          proposalId: null,
        };
      }
      throw e;
    }
  }

  // 13. Stable identity：protagonist.characterKey 不变。
  // 引用完整性（relationships 引用角色、key 唯一）由 validateCreationContractSections 保证。
  if (baselineCtx.baselineSections !== null) {
    if (
      sections.protagonist.characterKey !== baselineCtx.baselineSections.protagonist.characterKey
    ) {
      const errorCode: ErrorCode = 'MODEL_RESPONSE_INVALID';
      const errorMessage = '模型输出的主角身份无效';
      transaction(() => {
        requireCas(
          invocationRepo.markFailed(
            invocationId,
            ['RUNNING'],
            errorCode,
            errorMessage,
            result.latencyMs,
          ),
          '无法标记调用失败',
        );
        requireCas(taskRepo.failRunning(taskId, errorCode, errorMessage), '无法标记任务失败');
      });
      return {
        task: taskRepo.getById(taskId)!,
        invocation: invocationRepo.getById(invocationId),
        proposalId: null,
      };
    }
  }

  // 14. 最终原子提交（BEGIN IMMEDIATE）：proposal + invocation SUCCEEDED + task SUCCEEDED
  const sectionsJson = canonicalSerializeContractSections(sections);
  const sectionsHash = sha256Port.digestUtf8(sectionsJson);
  if (!isLowercaseSha256Hex(sectionsHash)) {
    throw new ContractDataCorruptionError('sha256 端口返回非 lowercase SHA-256');
  }
  const proposalId = idGenerator.generate();
  const now = clock.now();
  const safeResult = {
    proposalId,
    schemaVersion: input.schemaVersion,
    baseGrillSessionVersion: input.baseGrillSessionVersion,
    baseContractVersion: input.contractBaseline.contractVersion,
    sectionCount: Object.keys(sections).length,
  };

  try {
    transaction(() => {
      // a. 再次读取并验证 task 仍 RUNNING
      const taskNow = taskRepo.getById(taskId);
      if (!taskNow || taskNow.status !== 'RUNNING') {
        throw new FinalStateConflictError('task no longer RUNNING');
      }
      // b. invocation 仍 RUNNING
      const invNow = invocationRepo.getById(invocationId);
      if (!invNow || invNow.status !== 'RUNNING') {
        throw new FinalStateConflictError('invocation no longer RUNNING');
      }
      // c. 再次验证 Grill session baseline
      // d. 再次验证 current contract baseline
      readBaselineForExecution(deps, task, input);

      // e–h. 创建不可变 proposal
      deps.ccProposalRepo.create({
        id: proposalId,
        projectId: task.projectId,
        taskId: task.id,
        invocationId,
        baseGrillSessionId: input.grillSessionId,
        baseGrillSessionVersion: input.baseGrillSessionVersion,
        baseContractVersion: input.contractBaseline.contractVersion,
        schemaVersion: input.schemaVersion,
        sectionsJson,
        sectionsHash,
        createdAt: now,
        updatedAt: now,
      });
      // i. invocation RUNNING → SUCCEEDED
      requireCas(
        invocationRepo.markSucceeded(invocationId, 'RUNNING', invocationSuccess),
        '无法标记调用成功',
      );
      // j. task RUNNING → SUCCEEDED
      requireCas(taskRepo.completeRunning(taskId, JSON.stringify(safeResult)), '无法标记任务成功');
    });
  } catch (e) {
    if (e instanceof StaleBaselineError) {
      // 最终事务回滚后：单独事务记录 invocation SUCCEEDED（token/latency）+ task STALE，不创建 proposal
      transaction(() => {
        requireCas(
          invocationRepo.markSucceeded(invocationId, 'RUNNING', invocationSuccess),
          '无法标记调用成功',
        );
        requireCas(taskRepo.markStale(taskId, ['RUNNING']), '无法标记任务为 STALE');
      });
      return {
        task: taskRepo.getById(taskId)!,
        invocation: invocationRepo.getById(invocationId),
        proposalId: null,
      };
    }
    // FinalStateConflictError 或其它：事务已回滚，交给 runner settlement
    throw e;
  }

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    proposalId,
  };
}
