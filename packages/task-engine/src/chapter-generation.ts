/**
 * 章节生成任务引擎（GE-6）。
 *
 * CHAPTER_DRAFT 任务：任务先落库再调用模型，严格解析输出，原子提交。
 * prompt 不持久化；task.result 只存安全摘要（title + contentHash + 场景数）；
 * 完整正文由调用方（graph executor）放进 generationRun artifact（Graph 权威存储）。
 */

import { createHash } from 'node:crypto';
import { TaskExecutionError } from './index.js';
import { sha256Hex, type TaskEngineDeps, type TaskExecutionResult } from './index.js';

/** 章节草稿（严格解析 V1） */
export interface ChapterDraftV1 {
  readonly title: string;
  readonly content: string;
  readonly scenePlans: ReadonlyArray<string>;
}

export interface ChapterDraftExecutionResult extends TaskExecutionResult {
  readonly draft: ChapterDraftV1;
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

/**
 * 执行 CHAPTER_DRAFT 任务（镜像 executeModelInvocationTest 的生命周期）。
 * 成功返回解析后的 draft；失败/异常把 task+invocation 同事务标记 FAILED。
 */
export async function executeChapterDraft(
  deps: TaskEngineDeps,
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
  } = deps;

  const task = taskRepo.getById(taskId);
  if (!task) throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }

  const profile = providerRepo.getById('mimo-token-plan-cn');
  if (!profile) throw new TaskExecutionError('PROVIDER_NOT_CONFIGURED', '模型提供商未配置');

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
  const updatedTask = taskRepo.getById(taskId)!;
  const invocationId = idGenerator.generate();
  const promptHash = sha256Hex(prompt);

  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: 'mimo-token-plan-cn',
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
    return { task: result.task, invocation: result.invocation, draft: null as never };
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
    return { task: failedTask, invocation: failedInvocation, draft: null as never };
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
    return { task: failedTask, invocation: failedInvocation, draft: null as never };
  }

  const contentHash = createHash('sha256').update(draft.content).digest('hex');
  const resultJson = JSON.stringify({
    title: draft.title,
    contentHash,
    sceneCount: draft.scenePlans.length,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  });

  transaction(() => {
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

  const completedTask = taskRepo.getById(taskId)!;
  const completedInvocation = invocationRepo.getById(invocationId);
  return { task: completedTask, invocation: completedInvocation, draft };
}

function requireCas(updated: boolean, message: string): void {
  if (!updated) throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
}
