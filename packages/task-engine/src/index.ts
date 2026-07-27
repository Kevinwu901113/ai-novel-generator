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
 * - 成功/失败路径在同一事务中提交 task + invocation
 * - prompt 不持久化，API Key 不进入日志/数据库/错误
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

// ── 任务执行 ──────────────────────────────────────────────────────

/**
 * 执行 MODEL_INVOCATION_TEST 任务。
 *
 * 流程：
 * 1. 读取任务，验证 PENDING
 * 2. CAS claim（PENDING → RUNNING + attempt_count++）
 * 3. 读取 provider profile
 * 4. 创建 invocation（PENDING）
 * 5. 读取 API Key（失败则 invocation + task 同事务标记 FAILED）
 * 6. 标记 invocation RUNNING
 * 7. 调用 model gateway
 * 8. 原子提交 success/failure（task + invocation 同事务）
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

  // 2. CAS claim：PENDING → RUNNING + attempt_count++（原子）
  const claimed = taskRepo.claimPending(taskId);
  if (!claimed) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
  }

  // 读取更新后的任务（attempt_count 已递增）
  const updatedTask = taskRepo.getById(taskId)!;

  // 3. 获取 provider profile
  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    // Provider 缺失：task FAILED（无 invocation 需要创建）
    taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '模型提供商未配置');
    const failedTask = taskRepo.getById(taskId)!;
    return { task: failedTask, invocation: null };
  }

  // 4. 创建 invocation
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

  // 5. 读取 API Key
  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    // Keychain 读取失败：invocation + task 同事务标记 FAILED
    transaction(() => {
      invocationRepo.markFailed(
        invocationId,
        ['PENDING'],
        'API_KEY_READ_FAILED',
        '无法读取 API Key',
        null,
      );
      taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '无法读取 API Key');
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation };
  }

  if (!apiKey) {
    // API Key 缺失：invocation + task 同事务标记 FAILED
    transaction(() => {
      invocationRepo.markFailed(
        invocationId,
        ['PENDING'],
        'API_KEY_REQUIRED',
        '请先配置 API Key',
        null,
      );
      taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '请先配置 API Key');
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation };
  }

  // 6. 标记 invocation RUNNING
  const invRunning = invocationRepo.markRunning(invocationId, 'PENDING');
  if (!invRunning) {
    // invocation 状态冲突（理论上不应发生）
    taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '调用状态冲突');
    const failedTask = taskRepo.getById(taskId)!;
    return { task: failedTask, invocation: invocationRepo.getById(invocationId) };
  }

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
    // 调用异常：invocation + task 同事务标记 FAILED
    transaction(() => {
      invocationRepo.markFailed(
        invocationId,
        ['RUNNING'],
        'PROVIDER_CONNECTION_FAILED',
        '模型调用异常',
        null,
      );
      taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '模型调用异常');
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation };
  }

  // 8. 原子提交 success/failure
  if (result.errorCode) {
    transaction(() => {
      invocationRepo.markFailed(
        invocationId,
        ['RUNNING'],
        result.errorCode!,
        result.errorMessage ?? '模型调用失败',
        result.latencyMs,
      );
      taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', result.errorMessage ?? '模型调用失败');
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
    });
    taskRepo.completeRunning(taskId, JSON.stringify(safeResult));
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
