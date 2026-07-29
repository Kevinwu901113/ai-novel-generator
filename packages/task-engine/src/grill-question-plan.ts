/**
 * Grill-me 问题规划任务执行引擎。
 *
 * AI 只生成“问题计划提案”，绝不直接创建正式问题。
 *
 * 关键约束：
 * - claim 前验证 provider/API Key（缺失不增加 attempt）；
 * - 调用模型前重新读取会话并校验版本（stale-before-call → STALE，不调用模型）；
 * - 调用模型后再次校验版本（stale-after-call → STALE，丢弃结果，不保存 proposal）；
 * - 严格结构化输出解析（拒绝非 JSON/markdown/额外文本/额外字段）；
 * - 完整依赖图验证（引用 + 环）在 proposal 持久化前执行；
 * - proposal 与 task completion 在同一事务提交（一致性边界）；
 * - prompt 不持久化（仅 hash），API Key 不进入日志/数据库/错误；
 * - task.result 仅保存安全摘要 {proposalId, questionCount, baseSessionVersion}。
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
  GrillQuestionPlanProposalRepositoryPort,
  GrillQuestionData,
} from '@ai-novel/application';
import { existingDepsFromQuestions } from '@ai-novel/application';
import type { ErrorCode } from '@ai-novel/contracts';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import {
  GRILL_QUESTION_PLAN_SCHEMA_VERSION,
  parseQuestionPlanV1,
  validatePlanReferences,
  validateExistingGraphIntegrity,
  topologicalPlanOrder,
  type NormalizedQuestionPlan,
} from '@ai-novel/domain';
import { sha256Hex, TaskExecutionError } from './index.js';

// ── 依赖接口 ──────────────────────────────────────────────────────

export interface GrillQuestionPlanEngineDeps {
  readonly taskRepo: TaskRepositoryPort;
  readonly invocationRepo: ModelInvocationRepositoryPort;
  readonly secretStore: SecretStore;
  readonly providerRepo: ProviderProfileRepository;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly questionRepo: GrillQuestionRepositoryPort;
  readonly answerRepo: GrillAnswerRepositoryPort;
  readonly planProposalRepo: GrillQuestionPlanProposalRepositoryPort;
  readonly invokeModel: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }) => Promise<ModelInvocationOutput>;
  readonly transaction: <T>(fn: () => T) => T;
}

/** 规划任务执行结果（公开数据，不含 prompt、raw output 或 API Key） */
export interface GrillQuestionPlanExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly proposalId: string | null;
}

// ── 常量 ──────────────────────────────────────────────────────────

const PLAN_MAX_TOKENS = 4096;
const PLAN_TEMPERATURE = 0.3;

// ── 工具 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

interface PlanTaskInput {
  readonly sessionId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly providerProfileId: string;
}

function parseTaskInput(inputVersionJson: string): PlanTaskInput {
  const parsed = JSON.parse(inputVersionJson) as Record<string, unknown>;
  if (
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.baseSessionVersion !== 'number' ||
    typeof parsed.schemaVersion !== 'number' ||
    typeof parsed.providerProfileId !== 'string' ||
    parsed.providerProfileId.trim().length === 0
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }
  return {
    sessionId: parsed.sessionId,
    baseSessionVersion: parsed.baseSessionVersion,
    schemaVersion: parsed.schemaVersion,
    providerProfileId: parsed.providerProfileId,
  };
}

// ── Prompt 构建（仅存在于规划层，不持久化）────────────────────────

const PLAN_SYSTEM_PROMPT = [
  '你是小说创作需求澄清（Grill-me）的问题规划器。',
  '根据会话目标和已有问答，规划下一批需要向用户提问的问题。',
  '严格输出单个 JSON 对象，不要使用 markdown 代码块，不要在 JSON 前后添加任何文字。',
  '顶层结构必须精确为：{"schemaVersion":1,"questions":[...]}。',
  'questions 数组每项精确包含字段：key、topic、text、rationale、dependencies。',
  'key 为计划内唯一短标识；topic 为问题主题；text 为问题正文；rationale 为提问理由；',
  'dependencies 为数组，每项为 {"kind":"existing","questionId":"..."} 或 {"kind":"planned","questionKey":"..."}。',
  'existing 依赖只能引用已存在的问题 id；planned 依赖只能引用本计划内其他问题的 key。',
  '禁止自依赖、重复依赖与任何形式的循环依赖。不要输出任何额外字段。',
].join('\n');

function buildPlanPrompt(context: {
  goal: string;
  questions: ReadonlyArray<GrillQuestionData>;
  answersByQuestion: ReadonlyMap<string, string>;
}): string {
  const existingQuestions = context.questions.map((q) => ({
    id: q.id,
    topic: q.topic,
    text: q.text,
    status: q.status,
    dependsOn: q.dependsOnQuestionIds,
    answer: context.answersByQuestion.get(q.id) ?? null,
  }));

  const payload = {
    sessionGoal: context.goal,
    schemaVersion: GRILL_QUESTION_PLAN_SCHEMA_VERSION,
    existingQuestions,
  };

  return [
    '会话目标：',
    context.goal,
    '',
    '已有问题与当前答案（JSON）：',
    JSON.stringify(payload),
    '',
    '请规划下一批问题，严格按系统要求的 JSON 结构输出。',
  ].join('\n');
}

// ── 任务执行 ──────────────────────────────────────────────────────

export async function executeGrillQuestionPlan(
  deps: GrillQuestionPlanEngineDeps,
  taskId: string,
): Promise<GrillQuestionPlanExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    sessionRepo,
    questionRepo,
    answerRepo,
    planProposalRepo,
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

  // claim 前终结：将任务置为 FAILED（CAS，不递增 attempt_count），不留下 PENDING
  const failBeforeClaim = (code: ErrorCode, message: string): GrillQuestionPlanExecutionResult => {
    const failed = taskRepo.failPending(taskId, code, message);
    if (!failed) {
      throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务状态冲突，无法终结为 FAILED');
    }
    return { task: taskRepo.getById(taskId)!, invocation: null, proposalId: null };
  };

  // 2. 解析任务输入（含 providerProfileId 稳定引用）
  let input: PlanTaskInput;
  try {
    input = parseTaskInput(task.inputVersionJson);
  } catch {
    return failBeforeClaim('TASK_EXECUTION_FAILED', '任务输入版本数据无效');
  }

  // 3. claim 前按任务输入解析 provider profile（不增加 attempt_count）
  const profile = providerRepo.getById(input.providerProfileId);
  if (!profile || !profile.enabled) {
    return failBeforeClaim('PROVIDER_NOT_CONFIGURED', '模型提供商未配置或已禁用');
  }

  // 4. claim 前读取 API Key（不增加 attempt_count）
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

  // 5. stale-before-call：重新读取会话并校验版本
  const sessionBefore = sessionRepo.getById(input.sessionId);
  if (!sessionBefore || sessionBefore.version !== input.baseSessionVersion) {
    transaction(() => {
      requireCas(taskRepo.markStale(taskId, ['RUNNING']), '无法标记任务为 STALE');
    });
    return { task: taskRepo.getById(taskId)!, invocation: null, proposalId: null };
  }

  // 6. 从 SQLite source of truth 重新加载上下文并构建 prompt（不持久化）
  const questions = questionRepo.listBySession(input.sessionId);
  const currentAnswers = answerRepo.listCurrentBySession(input.sessionId);
  const answersByQuestion = new Map<string, string>();
  for (const a of currentAnswers) {
    answersByQuestion.set(a.questionId, a.text);
  }
  const prompt = buildPlanPrompt({ goal: sessionBefore.goal, questions, answersByQuestion });
  const promptHash = sha256Hex(prompt);

  // 7. 创建 invocation（PENDING）
  const invocationId = idGenerator.generate();
  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: input.providerProfileId,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'grill_question_plan',
    promptHash,
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      maxTokens: PLAN_MAX_TOKENS,
      schemaVersion: GRILL_QUESTION_PLAN_SCHEMA_VERSION,
    }),
  });

  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  // 8. 调用模型
  let result: ModelInvocationOutput;
  try {
    result = await invokeModel({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      prompt,
      systemPrompt: PLAN_SYSTEM_PROMPT,
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
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

  // 9. provider 返回稳定错误码
  if (result.errorCode) {
    const errorCode: ErrorCode = result.errorCode;
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          errorCode,
          result.errorMessage ?? '模型调用失败',
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(
        taskRepo.failRunning(taskId, errorCode, result.errorMessage ?? '模型调用失败'),
        '无法标记任务失败',
      );
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  const invocationSuccess = {
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

  // 10. stale-after-call：再次校验会话版本；变化则丢弃结果，不保存 proposal
  const sessionAfter = sessionRepo.getById(input.sessionId);
  if (!sessionAfter || sessionAfter.version !== input.baseSessionVersion) {
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

  // 11. 严格结构化输出解析
  const parsed = parseQuestionPlanV1(result.text);
  if (!parsed.ok) {
    const errorCode: ErrorCode = parsed.stage === 'json' ? 'MODEL_RESPONSE_INVALID' : parsed.code;
    const errorMessage = '模型返回的问题计划无效';
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

  // 12. proposal 持久化前再次执行完整验证（引用 + 环）
  const questionsNow = questionRepo.listBySession(input.sessionId);
  const existingIds = new Set(questionsNow.map((q) => q.id));
  const refs = validatePlanReferences(parsed.plan, existingIds);
  if (!refs.ok) {
    const errorMessage = '模型返回的问题计划引用无效';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          refs.code,
          errorMessage,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, refs.code, errorMessage), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  const existingDeps = existingDepsFromQuestions(questionsNow);
  const integrity = validateExistingGraphIntegrity(existingDeps);
  if (!integrity.ok) {
    const errorMessage = '已有问题依赖图完整性校验失败';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
          ['RUNNING'],
          integrity.code,
          errorMessage,
          result.latencyMs,
        ),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, integrity.code, errorMessage), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      proposalId: null,
    };
  }

  const order = topologicalPlanOrder(parsed.plan, existingDeps);
  if (!order.ok) {
    const errorCode: ErrorCode = 'GRILL_PLAN_CYCLE_DETECTED';
    const errorMessage = '模型返回的问题计划存在循环依赖';
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

  // 13. 在同一事务中持久化 proposal + 标记调用成功 + 完成任务（一致性边界）
  const proposalId = idGenerator.generate();
  const questionsJson = JSON.stringify(parsed.plan);
  const safeResult = {
    proposalId,
    questionCount: parsed.plan.questions.length,
    baseSessionVersion: input.baseSessionVersion,
  };

  transaction(() => {
    planProposalRepo.create({
      id: proposalId,
      projectId: task.projectId,
      sessionId: input.sessionId,
      taskId: task.id,
      invocationId,
      baseSessionVersion: input.baseSessionVersion,
      schemaVersion: GRILL_QUESTION_PLAN_SCHEMA_VERSION,
      questionsJson,
    });
    requireCas(
      invocationRepo.markSucceeded(invocationId, 'RUNNING', invocationSuccess),
      '无法标记调用成功',
    );
    requireCas(taskRepo.completeRunning(taskId, JSON.stringify(safeResult)), '无法标记任务成功');
  });

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    proposalId,
  };
}

// 供测试与 worker 复用的规范化计划类型
export type { NormalizedQuestionPlan };
