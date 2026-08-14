/**
 * @ai-novel/task-engine
 *
 * 任务编排与执行引擎。
 *
 * 本阶段仅实现 MODEL_INVOCATION_TEST 任务类型。
 * 任务先落库再调用模型，确保可审计和可恢复。
 *
 * 关键约束：
 * - claim 和 attempt 原子递增
 * - 所有状态转换使用 CAS（affected rows = 1）
 * - 事务内每个 CAS 返回值必须检查，false 即抛 TASK_STATE_CONFLICT 回滚事务
 * - 成功/失败路径在同一事务中提交 task + invocation
 * - prompt 不持久化，API Key 不进入日志/数据库/错误
 * - Provider profile 在 claim 前验证，缺失时不增加 attempt_count
 */

import { createHash } from 'node:crypto';
import type {
  TaskData,
  TaskRepositoryPort,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  IdGenerator,
  Clock,
  NodeExecutionResultStorePort,
} from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ErrorCode, type ProviderProtocol } from '@ai-novel/contracts';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';

// ── 依赖接口 ──────────────────────────────────────────────────────

/** 任务引擎依赖 */
export interface TaskEngineDeps {
  readonly taskRepo: TaskRepositoryPort;
  readonly invocationRepo: ModelInvocationRepositoryPort;
  readonly secretStore: SecretStore;
  readonly providerRepo: ProviderProfileRepository;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly invokeModel: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    prompt: string;
    /** system/user 分离（B3 起 SPEC_EXTRACT 使用；model-gateway 原生支持） */
    systemPrompt?: string;
    protocol?: ProviderProtocol;
    /**
     * B9：章节正文任务需要突破网关默认 4096 输出上限——一章中文正文（2500~4000 字）
     * 按 ~1.5 token/字算就会撞顶，被截断的输出必然解析失败。省略时沿用网关默认值。
     */
    maxTokens?: number;
  }) => Promise<ModelInvocationOutput>;
  readonly transaction: <T>(fn: () => T) => T;
  /** RW-1：task 成功前持久化 execution-bound 完整解析结果的权威存储（task-backed 节点必需） */
  readonly nodeExecutionResultStore?: NodeExecutionResultStorePort;
}

/** 任务执行结果（公开数据，不含 prompt 或 API Key） */
export interface TaskExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
}

// ── 工具函数 ──────────────────────────────────────────────────────

/** 计算 SHA-256 hex hash */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 检查 CAS 返回值。false 时抛出 TASK_STATE_CONFLICT，使事务回滚。
 */
function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

// ── 任务执行 ──────────────────────────────────────────────────────

/**
 * 执行 MODEL_INVOCATION_TEST 任务。
 *
 * 流程（方案 A：provider profile 在 claim 前验证）：
 * 1. 读取任务，验证 PENDING
 * 2. 验证 provider profile 存在（缺失则不 claim、不增加 attempt）
 * 3. 读取 API Key（失败则不 claim、不增加 attempt）
 * 4. CAS claim（PENDING → RUNNING + attempt_count++）
 * 5. 创建 invocation（PENDING）
 * 6. 标记 invocation RUNNING
 * 7. 调用 model gateway
 * 8. 原子提交 success/failure（task + invocation 同事务，每个 CAS 必须成功）
 *
 * prompt 不写入数据库，只存在于调用栈内。
 */
export async function executeModelInvocationTest(
  deps: TaskEngineDeps,
  taskId: string,
  prompt: string,
): Promise<TaskExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    invokeModel,
    transaction,
  } = deps;

  // 1. 读取任务
  const task = taskRepo.getById(taskId);
  if (!task) {
    throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  }

  if (task.status !== 'PENDING') {
    throw new TaskAlreadyClaimedError(`任务状态不是 PENDING: ${task.status}`);
  }

  // 2. 解析 provider profile（D6 两层路由：任务类型覆盖 → 全局默认；claim 前，不增加 attempt_count）
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

  // 3. 读取 API Key（claim 前，不增加 attempt_count）
  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    throw new TaskExecutionError('API_KEY_READ_FAILED', '无法读取 API Key');
  }

  if (!apiKey) {
    throw new TaskExecutionError('API_KEY_REQUIRED', '请先配置 API Key');
  }

  // 4. CAS claim：PENDING → RUNNING + attempt_count++（原子）
  const claimed = taskRepo.claimPending(taskId);
  if (!claimed) {
    throw new TaskAlreadyClaimedError('任务已被其他进程领取');
  }

  // 读取更新后的任务（attempt_count 已递增）
  const updatedTask = taskRepo.getById(taskId)!;

  // 5. 创建 invocation
  const invocationId = idGenerator.generate();
  const promptHash = sha256Hex(prompt);

  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'model_invocation_test',
    promptHash,
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      maxTokens: 32,
    }),
  });

  // 6. 标记 invocation RUNNING（CAS）
  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  // 7. 调用模型
  let result: ModelInvocationOutput;
  try {
    result = await invokeModel({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      prompt,
      protocol,
    });
  } catch {
    // 调用异常：invocation + task 同事务标记 FAILED，每个 CAS 必须成功
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
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation };
  }

  // 8. 原子提交 success/failure，每个 CAS 必须成功
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
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation };
  }

  // 成功
  const safeResult = {
    accepted: true,
    textLength: result.text.length,
  };

  transaction(() => {
    requireCas(
      invocationRepo.markSucceeded(invocationId, 'RUNNING', {
        responseMetadataJson: JSON.stringify({
          textLength: result.text.length,
        }),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        totalTokens: result.usage.totalTokens,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        providerRequestId: result.providerRequestId,
      }),
      '无法标记调用成功',
    );
    requireCas(taskRepo.completeRunning(taskId, JSON.stringify(safeResult)), '无法标记任务成功');
  });

  const succeededTask = taskRepo.getById(taskId)!;
  const succeededInvocation = invocationRepo.getById(invocationId);
  return { task: succeededTask, invocation: succeededInvocation };
}

// ── 错误类 ────────────────────────────────────────────────────────

/** 任务执行错误 */
export class TaskExecutionError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}

/**
 * CAS claim 未命中：同一 durable task 已被另一 runner 领取或结算。
 *
 * 这是幂等调度中的良性竞争，不应由后到的 runner 反向把先到的 RUNNING task
 * 结算为 FAILED。独立错误类型让 worker 能可靠识别该语义，而不依赖中文消息文本。
 */
export class TaskAlreadyClaimedError extends TaskExecutionError {
  constructor(message: string) {
    super('TASK_STATE_CONFLICT', message);
    this.name = 'TaskAlreadyClaimedError';
  }
}

/**
 * 识别幂等重复领取错误。
 *
 * Electron 开发态、测试替身或打包产物可能加载出不同的模块实例，此时单靠
 * `instanceof` 会误判同一个领域错误。保留 class 判定，同时用稳定的 name/code
 * 作为跨模块边界的结构化标识。
 */
export function isTaskAlreadyClaimedError(error: unknown): error is TaskAlreadyClaimedError {
  if (error instanceof TaskAlreadyClaimedError) return true;
  return (
    error instanceof Error &&
    error.name === 'TaskAlreadyClaimedError' &&
    'code' in error &&
    error.code === 'TASK_STATE_CONFLICT'
  );
}

export {
  executeGrillQuestionPlan,
  type GrillQuestionPlanEngineDeps,
  type GrillQuestionPlanExecutionResult,
} from './grill-question-plan.js';

export {
  executeCreationContractDraft,
  buildContractDraftPrompt,
  type ContractDraftEngineDeps,
  type ContractDraftExecutionResult,
} from './creation-contract-draft.js';

export {
  inferChapterLengthFromStructure,
  inferPerChapterTargetCharacters,
  resolveChapterLengthRequirement,
  MIN_PER_CHAPTER_TARGET,
  MAX_PER_CHAPTER_TARGET,
  MIN_TARGET_RATIO,
  MAX_TARGET_RATIO,
  type ChapterLengthRequirement,
} from './chapter-length.js';

export { analyzeChineseProseQuality, type ChineseProseQualityReport } from './prose-quality.js';

export { validateContractDraftContext } from './contract-draft-context.js';
export type {
  ContractDraftContextDeps,
  ValidatedContractDraftContext,
} from './contract-draft-context.js';

export { compensateFinalization } from './chapter-generation.js';

// ── 章节生成四类模型任务（GE-6 / B9）─────────────────────────────
export {
  executeChapterPlan,
  executeChapterDraftNode,
  executeChapterCritique,
  executeChapterRewrite,
  parseChapterPlanV1,
  parseChapterProseV1,
  parseChapterCritiqueV1,
  parseChapterTaskPayload,
  buildChapterPlanPrompt,
  buildChapterDraftPrompt,
  buildChapterCritiquePrompt,
  buildChapterRewritePrompt,
  criticSystemPrompt,
  CHAPTER_PLAN_SYSTEM_PROMPT,
  CHAPTER_DRAFT_SYSTEM_PROMPT,
  CHAPTER_REWRITE_SYSTEM_PROMPT,
  CRITIC_NODE_IDS,
} from './chapter-nodes.js';
export type {
  ChapterNodeExecutionDeps,
  ChapterNodeExecutionResult,
  ChapterPersistResult,
  ChapterTaskContext,
  ChapterTaskPayload,
  ParsedChapterPlan,
  ParsedChapterProse,
  ParsedChapterCritique,
} from './chapter-nodes.js';
export * from './spec-extract.js';
export * from './research-run.js';
export * from './blueprint-generate.js';
