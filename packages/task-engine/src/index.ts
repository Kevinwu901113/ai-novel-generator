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
  GenerationArtifactStorePort,
} from '@ai-novel/application';
import type { ErrorCode } from '@ai-novel/contracts';
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
  }) => Promise<ModelInvocationOutput>;
  readonly transaction: <T>(fn: () => T) => T;
  /** RW-1：task 成功前持久化完整解析输出的权威存储（task-backed 节点必需） */
  readonly generationArtifactStore?: GenerationArtifactStorePort;
}

/** 任务执行结果（公开数据，不含 prompt 或 API Key） */
export interface TaskExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
}

// ── 常量 ──────────────────────────────────────────────────────────

const FIXED_PROVIDER_ID = 'mimo-token-plan-cn';

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
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }

  // 2. 验证 provider profile（claim 前，不增加 attempt_count）
  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    throw new TaskExecutionError('PROVIDER_NOT_CONFIGURED', '模型提供商未配置');
  }

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
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
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
    providerProfileId: FIXED_PROVIDER_ID,
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

export { validateContractDraftContext } from './contract-draft-context.js';
export type {
  ContractDraftContextDeps,
  ValidatedContractDraftContext,
} from './contract-draft-context.js';

export { executeChapterDraft, parseChapterDraftV1 } from './chapter-generation.js';
export type {
  ChapterDraftV1,
  ChapterDraftExecutionResult,
  ChapterDraftContext,
} from './chapter-generation.js';
