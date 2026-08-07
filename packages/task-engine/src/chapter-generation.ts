/**
 * 章节生成任务引擎（GE-6 base，RW-1-R5 加固）。
 *
 * CHAPTER_DRAFT 任务：任务先落库再调用模型，严格解析输出，原子提交。
 * prompt 不持久化；task.result 只存安全摘要（title + contentHash + 场景数）；
 * 完整正文由调用方（graph executor）放进 execution-bound 权威 result envelope。
 *
 * RW-1-R5：
 * - 权威 execution context 经 nodeExecutionRepo.getByTaskId(taskId) 从 DB 取得
 *   （不信任调用方手拼 context）；
 * - result save + invocation success + task success 同一事务；result store 用
 *   saveOrVerifySame 幂等（同内容 no-op，异内容拒绝覆盖）；
 * - 最终事务失败 → 补偿：仍 RUNNING 的 invocation/task 标记 FAILED（不留半成品）。
 */

import { createHash } from 'node:crypto';
import { TaskExecutionError } from './index.js';
import { sha256Hex, type TaskEngineDeps, type TaskExecutionResult } from './index.js';
import type { NodeExecutionRepositoryPort } from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';

/** 章节草稿（严格解析 V1） */
export interface ChapterDraftV1 {
  readonly title: string;
  readonly content: string;
  readonly scenePlans: ReadonlyArray<string>;
}

export interface ChapterDraftExecutionResult extends TaskExecutionResult {
  readonly draft: ChapterDraftV1 | null;
  /** 真实 generation artifact ID（execution-bound envelope 内） */
  readonly artifactId: string | null;
}

/** task-backed CHAPTER_DRAFT 的依赖（含权威 execution 反查） */
export interface ChapterDraftExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
}

/**
 * 严格解析模型输出为 ChapterDraftV1。
 * 拒绝：非 JSON、非对象、缺字段、额外字段、非字符串字段、空 title/content。
 */
export function parseChapterDraftV1(text: string): ChapterDraftV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节草稿不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节草稿不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const allowed = new Set(['title', 'content', 'scenePlans']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `章节草稿含多余字段: ${key}`);
    }
  }
  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节草稿缺少 title');
  }
  if (typeof obj.content !== 'string' || obj.content.trim().length === 0) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节草稿缺少 content');
  }
  const scenePlans = obj.scenePlans;
  if (!Array.isArray(scenePlans) || !scenePlans.every((s) => typeof s === 'string')) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '章节草稿 scenePlans 非法');
  }
  return {
    title: obj.title.trim(),
    content: obj.content.trim(),
    scenePlans,
  };
}

/** 补偿：最终提交事务失败后，仍 RUNNING 的 invocation/task 标记 FAILED（best-effort）。
 *  导出供其他 task-backed 执行器（spec-extract 等）复用同一补偿语义。 */
export function compensateFinalization(
  deps: TaskEngineDeps,
  taskId: string,
  invocationId: string,
  message: string,
): void {
  try {
    deps.transaction(() => {
      const inv = deps.invocationRepo.getById(invocationId);
      if (inv !== null && inv.status === 'RUNNING') {
        requireCas(
          deps.invocationRepo.markFailed(
            invocationId,
            ['RUNNING'],
            'TASK_EXECUTION_FAILED',
            message,
            null,
          ),
          '无法补偿标记调用失败',
        );
      }
      const task = deps.taskRepo.getById(taskId);
      if (task !== null && task.status === 'RUNNING') {
        requireCas(
          deps.taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
          '无法补偿标记任务失败',
        );
      }
    });
  } catch {
    // 补偿本身失败不掩盖原始错误
  }
}

/**
 * 执行 CHAPTER_DRAFT 任务。
 * 成功返回解析后的 draft + 真实 artifactId；失败/异常把 task+invocation 同事务标记 FAILED。
 */
export async function executeChapterDraft(
  deps: ChapterDraftExecutionDeps,
  taskId: string,
  prompt: string,
): Promise<ChapterDraftExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    invokeModel,
    transaction,
    nodeExecutionResultStore,
    nodeExecutionRepo,
  } = deps;

  const task = taskRepo.getById(taskId);
  if (!task) throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }

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

  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    throw new TaskExecutionError('API_KEY_READ_FAILED', '无法读取 API Key');
  }
  if (!apiKey) throw new TaskExecutionError('API_KEY_REQUIRED', '请先配置 API Key');

  if (!taskRepo.claimPending(taskId)) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
  }

  // ── 权威 execution context（从 DB 反查，不信任调用方手拼 context）──
  const execution = nodeExecutionRepo.getByTaskId(taskId);
  if (!execution) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_NOT_BOUND', '任务未绑定 node execution'),
        '无法标记任务失败',
      );
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: null,
      draft: null,
      artifactId: null,
    };
  }

  const updatedTask = taskRepo.getById(taskId)!;
  const invocationId = idGenerator.generate();
  const promptHash = sha256Hex(prompt);

  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'chapter_draft',
    promptHash,
    requestMetadataJson: JSON.stringify({ promptLength: prompt.length, maxTokens: 4096 }),
  });
  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  const result = await invokeModel({
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey,
    prompt,
    protocol,
  }).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : '模型调用异常';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'PROVIDER_CONNECTION_FAILED',
          message,
          null,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
        '无法标记任务失败',
      );
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return {
      failed: true as const,
      task: failedTask,
      invocation: failedInvocation,
    };
  });

  if ('failed' in result) {
    return { task: result.task, invocation: result.invocation, draft: null, artifactId: null };
  }

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
    return { task: failedTask, invocation: failedInvocation, draft: null, artifactId: null };
  }

  // 严格解析（无效输出 → 任务失败，不留半成品；错误码透传 MODEL_RESPONSE_INVALID）
  let draft: ChapterDraftV1;
  try {
    draft = parseChapterDraftV1(result.text);
  } catch (err) {
    const code = err instanceof TaskExecutionError ? err.code : 'TASK_EXECUTION_FAILED';
    const message = err instanceof Error ? err.message : '章节草稿解析失败';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(invocationId, ['RUNNING'], code, message, result.latencyMs),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, code, message), '无法标记任务失败');
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation, draft: null, artifactId: null };
  }

  const contentHash = createHash('sha256').update(draft.content).digest('hex');
  // 真实 generation artifact ID（execution-bound envelope 内持久化；非任意字符串）
  const artifactId = idGenerator.generate();
  const resultJson = JSON.stringify({
    title: draft.title,
    contentHash,
    sceneCount: draft.scenePlans.length,
    artifactId,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  });

  // RW-1-R5：task 成功前先把完整解析输出持久化到权威 execution-bound result envelope
  // （node_execution_results，execution_id 唯一；saveOrVerifySame 幂等）。崩溃发生在 task
  // success 与 settlement 之间时，启动后可按 executionId 幂等 settlement。持久化失败 →
  // 最终事务失败 → 补偿标记仍 RUNNING 的 invocation/task FAILED，不留半成品。
  if (!nodeExecutionResultStore) {
    const failMsg = 'task-backed 执行缺少 nodeExecutionResultStore（无法持久化产物）';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          'TASK_EXECUTION_FAILED',
          failMsg,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', failMsg),
        '无法标记任务失败',
      );
    });
    const failedTask = taskRepo.getById(taskId)!;
    const failedInvocation = invocationRepo.getById(invocationId);
    return { task: failedTask, invocation: failedInvocation, draft: null, artifactId: null };
  }
  const contentJson = JSON.stringify({ kind: 'generationRun', draft });
  const now = deps.clock.now();

  try {
    transaction(() => {
      nodeExecutionResultStore.saveOrVerifySame({
        executionId: execution.id,
        projectId: task.projectId,
        graphRunId: execution.graphRunId,
        nodeId: execution.nodeId,
        taskId,
        activationNo: execution.activationNo,
        attemptNo: execution.attemptNo,
        executorId: execution.executorId,
        executorVersion: execution.executorVersion,
        inputHash: execution.inputHash,
        artifactKind: 'generationRun',
        artifactId,
        artifactVersion: 1,
        contentJson,
        outcome: null,
        createdAt: now,
      });
      requireCas(
        invocationRepo.markSucceeded(invocationId, 'RUNNING', {
          responseMetadataJson: JSON.stringify({
            finishReason: result.finishReason ?? null,
            providerRequestId: result.providerRequestId ?? null,
          }),
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          cacheReadTokens: result.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
          totalTokens: result.usage?.totalTokens ?? null,
          latencyMs: result.latencyMs ?? null,
          finishReason: result.finishReason ?? null,
          providerRequestId: result.providerRequestId ?? null,
        }),
        '无法标记调用成功',
      );
      requireCas(taskRepo.completeRunning(taskId, resultJson), '无法标记任务完成');
    });
  } catch (err) {
    compensateFinalization(deps, taskId, invocationId, '任务最终提交失败，已补偿标记失败');
    throw err;
  }

  const completedTask = taskRepo.getById(taskId)!;
  const completedInvocation = invocationRepo.getById(invocationId);
  return { task: completedTask, invocation: completedInvocation, draft, artifactId };
}

function requireCas(updated: boolean, message: string): void {
  if (!updated) throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
}
