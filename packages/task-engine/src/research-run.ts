/**
 * RESEARCH_RUN 任务执行器（GE-4 / B5，设计见 docs/development/b5-research-wiring-design.md）。
 *
 * 镜像 executeSpecExtract 的结构：claim 前配置校验（缺配置不增 attempt）→ claim →
 * 权威 execution 反查 → 上下文装配 → （首轮）模型产问题计划 → 搜索/抓取编排 →
 * 最终事务（bundle 落库 + envelope + invocation/task 终态，全有或全无）→ 补偿。
 *
 * - 首轮（priorBundleId=null）：模型调用（prompt research-plan-v1）产问题计划；
 * - 重试（validate invalid 回环）：复用上一轮 bundle 的问题计划，不再调模型（D-B5-1）；
 * - Tavily key 经 secret-store 槽位（D-B5-6）；缺失 → SEARCH_KEY_REQUIRED 保持 PENDING；
 * - 搜索/抓取端口注入（生产 Tavily + SafeWebFetch；测试 fake）。
 */

import type {
  NodeExecutionRepositoryPort,
  GrillSessionRepositoryPort,
  CreationContractVersionRepositoryPort,
  ResearchBundleRepositoryPort,
  ModelInvocationData,
  TaskData,
} from '@ai-novel/application';
import {
  ProviderNotConfiguredError,
  resolveProviderForTask,
  TAVILY_SEARCH_SECRET_REF,
} from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import type {
  ResearchBundle,
  ResearchDepth,
  WebFetchPort,
  WebSearchPort,
} from '@ai-novel/research-engine';
import { orchestrateResearch } from '@ai-novel/research-engine';
import { sha256Hex, TaskExecutionError, type TaskEngineDeps } from './index.js';
import { compensateFinalization } from './chapter-generation.js';

// ── deps / 类型 ───────────────────────────────────────────────────

export interface ResearchRunExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly specVersionRepo: CreationContractVersionRepositoryPort;
  readonly researchRepo: ResearchBundleRepositoryPort;
  /** 由 Tavily key 构造搜索端口（生产 createTavilySearchProvider；测试注入 fake） */
  readonly buildSearchPort: (apiKey: string) => WebSearchPort;
  /** 抓取端口（生产 createSafeWebFetch；测试注入 fake） */
  readonly webFetch: WebFetchPort;
}

export interface ResearchRunExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly bundleId: string | null;
  readonly questionCount: number;
  readonly factNoteCount: number;
}

// ── 常量 ──────────────────────────────────────────────────────────

const MAX_PLAN_QUESTIONS = 5;

export const RESEARCH_PLAN_SYSTEM_PROMPT = [
  '你是小说创作前期调研的问题规划助手。输入是创作想法与创作要求摘要。',
  '你的职责：规划少量值得上网查证的事实性问题（史实、地理、职业细节、技术设定的现实依据等）。',
  '只规划确实需要外部事实支撑的问题；纯虚构设定不需要调研。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"questions":[{"text":"..."}]}',
  'questions 为 1 到 5 个；每个问题一句话、可直接用作搜索查询、彼此不重复。',
].join('\n');

/** 用户消息（确定性序列化） */
export function buildResearchPlanPrompt(context: {
  readonly idea: string;
  readonly creationSpecSummary: string;
  readonly depth: ResearchDepth;
}): string {
  return [
    '以下是创作想法与创作要求摘要（JSON）：',
    JSON.stringify({
      idea: context.idea,
      creationSpecSummary: context.creationSpecSummary,
      depth: context.depth,
    }),
    '',
    'depth=light 时规划 1-2 个最关键的问题；depth=deep 时规划 3-5 个。',
    '现在输出结果 JSON。',
  ].join('\n');
}

// ── payload 解析 ──────────────────────────────────────────────────

interface ResearchRunPayload {
  readonly depth: 'light' | 'deep';
  readonly ideaSessionId: string;
  readonly creationSpecVersionId: string;
  readonly priorBundleId: string | null;
}

/** 严格解析任务 payload：exact keys（镜像 spec-extract parsePayload 纪律） */
function parsePayload(payloadJson: string): ResearchRunPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  const obj = parsed as Record<string, unknown>;
  const expected = ['creationSpecVersionId', 'depth', 'ideaSessionId', 'priorBundleId'];
  const keys = Object.keys(obj).sort();
  if (keys.length !== expected.length || !expected.every((k) => k in obj)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (obj.depth !== 'light' && obj.depth !== 'deep') {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload depth 非法');
  }
  if (typeof obj.ideaSessionId !== 'string' || obj.ideaSessionId.trim().length === 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (
    typeof obj.creationSpecVersionId !== 'string' ||
    obj.creationSpecVersionId.trim().length === 0
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (
    obj.priorBundleId !== null &&
    (typeof obj.priorBundleId !== 'string' || obj.priorBundleId.length === 0)
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  return {
    depth: obj.depth,
    ideaSessionId: obj.ideaSessionId,
    creationSpecVersionId: obj.creationSpecVersionId,
    priorBundleId: obj.priorBundleId as string | null,
  };
}

// ── 模型输出解析 ──────────────────────────────────────────────────

/** 严格解析问题计划：exact top-level keys + 数量/内容边界 */
export function parseResearchPlanV1(text: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题计划不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题计划不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || !('questions' in obj) || !('schemaVersion' in obj)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题计划顶层字段不符');
  }
  if (obj.schemaVersion !== 1) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题计划 schemaVersion 不符');
  }
  if (
    !Array.isArray(obj.questions) ||
    obj.questions.length < 1 ||
    obj.questions.length > MAX_PLAN_QUESTIONS
  ) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', `问题数须为 1..${MAX_PLAN_QUESTIONS}`);
  }
  const out: string[] = [];
  for (const q of obj.questions as ReadonlyArray<unknown>) {
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题条目结构无效');
    }
    const rec = q as Record<string, unknown>;
    if (Object.keys(rec).length !== 1 || typeof rec.text !== 'string') {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题条目字段不符');
    }
    const text2 = rec.text.trim();
    if (text2.length === 0 || text2.length > 300) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题内容越界或为空');
    }
    out.push(text2);
  }
  return out;
}

// ── 执行 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

function failedResult(
  deps: ResearchRunExecutionDeps,
  taskId: string,
  invocationId: string | null,
): ResearchRunExecutionResult {
  return {
    task: deps.taskRepo.getById(taskId)!,
    invocation: invocationId ? deps.invocationRepo.getById(invocationId) : null,
    bundleId: null,
    questionCount: 0,
    factNoteCount: 0,
  };
}

/** creationSpec sections 的确定性摘要（premise + 类型/受众等要点，供搜索规划） */
function summarizeSpecSections(sectionsJson: string): string {
  try {
    const s = JSON.parse(sectionsJson) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof s.premise === 'string') parts.push(s.premise);
    if (Array.isArray(s.genre)) parts.push(`类型: ${(s.genre as string[]).join('/')}`);
    if (typeof s.targetAudience === 'string') parts.push(`读者: ${s.targetAudience}`);
    if (Array.isArray(s.tone)) parts.push(`基调: ${(s.tone as string[]).join('/')}`);
    return parts.join('；');
  } catch {
    return '';
  }
}

export async function executeResearchRun(
  deps: ResearchRunExecutionDeps,
  taskId: string,
): Promise<ResearchRunExecutionResult> {
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
  if (task.taskType !== 'RESEARCH_RUN') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  const payload = parsePayload(task.payloadJson);

  // ── claim 前配置校验（缺配置不增 attempt，保持 PENDING）──
  // Tavily key（D-B5-6/D-B5-7）
  let tavilyKey: string | null;
  try {
    tavilyKey = await secretStore.getSecret(
      TAVILY_SEARCH_SECRET_REF.service,
      TAVILY_SEARCH_SECRET_REF.account,
    );
  } catch {
    throw new TaskExecutionError('SEARCH_KEY_READ_FAILED', '无法读取搜索服务 API Key');
  }
  if (!tavilyKey) {
    throw new TaskExecutionError('SEARCH_KEY_REQUIRED', '请先配置 Tavily 搜索 API Key');
  }

  // 模型 provider：仅首轮（需要问题计划）要求
  let profile: ReturnType<typeof resolveProviderForTask> | null = null;
  let protocol: ProviderProtocol | undefined;
  let modelApiKey: string | null = null;
  if (payload.priorBundleId === null) {
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
    protocol = profile.providerType;
    try {
      modelApiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
    } catch {
      throw new TaskExecutionError('API_KEY_READ_FAILED', '无法读取 API Key');
    }
    if (!modelApiKey) throw new TaskExecutionError('API_KEY_REQUIRED', '请先配置 API Key');
  }

  if (!deps.nodeExecutionResultStore) {
    throw new TaskExecutionError(
      'TASK_EXECUTION_FAILED',
      'task-backed 执行缺少 nodeExecutionResultStore（无法持久化产物）',
    );
  }
  const nodeExecutionResultStore = deps.nodeExecutionResultStore;

  if (!taskRepo.claimPending(taskId)) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', '任务已被其他进程领取');
  }

  // ── 权威 execution context（从 DB 反查）──
  const execution = deps.nodeExecutionRepo.getByTaskId(taskId);
  if (!execution) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_NOT_BOUND', '任务未绑定 node execution'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }

  // ── 上下文装配：idea（session goal）+ creationSpec 摘要 ──
  const session = deps.sessionRepo.getById(payload.ideaSessionId);
  const specVersion = deps.specVersionRepo.getById(task.projectId, payload.creationSpecVersionId);
  if (!session || session.projectId !== task.projectId || !specVersion) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '调研上下文缺失（session/spec）'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }
  const idea = session.goal;
  const creationSpecSummary = summarizeSpecSections(specVersion.sectionsJson);

  // ── 问题计划：重试复用上一轮；首轮模型规划 ──
  let questions: ReadonlyArray<string>;
  let invocationId: string | null = null;
  let modelUsageSummary: Record<string, unknown> | null = null;

  if (payload.priorBundleId !== null) {
    const prior = deps.researchRepo.getById(task.projectId, payload.priorBundleId);
    if (!prior || prior.questions.length === 0) {
      transaction(() => {
        requireCas(
          taskRepo.failRunning(
            taskId,
            'TASK_EXECUTION_FAILED',
            '重试引用的上一轮调研不存在或无问题计划',
          ),
          '无法标记任务失败',
        );
      });
      return failedResult(deps, taskId, null);
    }
    questions = prior.questions.map((q) => q.text);
  } else {
    const prompt = buildResearchPlanPrompt({ idea, creationSpecSummary, depth: payload.depth });
    const updatedTask = taskRepo.getById(taskId)!;
    invocationId = idGenerator.generate();
    invocationRepo.create({
      id: invocationId,
      projectId: task.projectId,
      taskId: task.id,
      providerProfileId: profile!.id,
      model: profile!.model,
      attemptNumber: updatedTask.attemptCount,
      requestKind: 'research_plan',
      promptHash: sha256Hex(prompt),
      requestMetadataJson: JSON.stringify({
        promptLength: prompt.length,
        depth: payload.depth,
      }),
    });
    transaction(() => {
      requireCas(invocationRepo.markRunning(invocationId!, 'PENDING'), '无法标记调用为 RUNNING');
    });

    const result = await invokeModel({
      baseUrl: profile!.baseUrl,
      model: profile!.model,
      apiKey: modelApiKey!,
      prompt,
      systemPrompt: RESEARCH_PLAN_SYSTEM_PROMPT,
      protocol,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : '模型调用异常';
      transaction(() => {
        requireCas(
          invocationRepo.markFailed(
            invocationId!,
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
      return { failed: true as const };
    });
    if ('failed' in result) return failedResult(deps, taskId, invocationId);

    if (result.errorCode) {
      transaction(() => {
        requireCas(
          invocationRepo.markFailed(
            invocationId!,
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
      return failedResult(deps, taskId, invocationId);
    }

    try {
      questions = parseResearchPlanV1(result.text);
    } catch (err) {
      const message = err instanceof TaskExecutionError ? err.message : '模型输出解析失败';
      transaction(() => {
        requireCas(
          invocationRepo.markFailed(
            invocationId!,
            ['RUNNING'],
            'MODEL_RESPONSE_INVALID',
            message,
            result.latencyMs,
          ),
          '无法标记调用失败',
        );
        requireCas(
          taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
          '无法标记任务失败',
        );
      });
      return failedResult(deps, taskId, invocationId);
    }

    modelUsageSummary = {
      finishReason: result.finishReason ?? null,
      providerRequestId: result.providerRequestId ?? null,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cacheReadTokens: result.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      latencyMs: result.latencyMs ?? null,
    };
  }

  // ── 搜索 + 抓取编排（失败来源跳过；整体异常按确定性失败处理）──
  let bundle: ResearchBundle;
  try {
    const orchestrated = await orchestrateResearch(
      {
        search: deps.buildSearchPort(tavilyKey),
        fetch: deps.webFetch,
        idGenerator,
        clock: deps.clock,
      },
      { projectId: task.projectId, depth: payload.depth, idea, questions },
    );
    bundle = { ...orchestrated, basedOnBundleId: payload.priorBundleId };
  } catch (err) {
    const message = err instanceof Error ? err.message : '调研编排异常';
    transaction(() => {
      if (invocationId) {
        requireCas(
          invocationRepo.markFailed(
            invocationId,
            ['RUNNING'],
            'TASK_EXECUTION_FAILED',
            message,
            null,
          ),
          '无法标记调用失败',
        );
      }
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, invocationId);
  }

  // ── 最终事务：bundle 落库 + envelope + invocation/task 终态（全有或全无）──
  const now = deps.clock.now();
  try {
    transaction(() => {
      deps.researchRepo.save(bundle, now);

      // execution-bound durable envelope：task 成功前必达（RW-1 不变量）。
      // RESEARCH_EXECUTE 契约 out(null,'researchBundle')：artifact-only，无 outcome。
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
        artifactKind: 'researchBundle',
        artifactId: bundle.id,
        artifactVersion: bundle.version,
        contentJson: JSON.stringify(bundle),
        outcome: null,
        createdAt: now,
      });

      if (invocationId) {
        requireCas(
          invocationRepo.markSucceeded(invocationId, 'RUNNING', {
            responseMetadataJson: JSON.stringify(modelUsageSummary ?? {}),
            inputTokens: (modelUsageSummary?.inputTokens as number | null) ?? null,
            outputTokens: (modelUsageSummary?.outputTokens as number | null) ?? null,
            cacheReadTokens: (modelUsageSummary?.cacheReadTokens as number | null) ?? null,
            cacheWriteTokens: (modelUsageSummary?.cacheWriteTokens as number | null) ?? null,
            totalTokens: (modelUsageSummary?.totalTokens as number | null) ?? null,
            latencyMs: (modelUsageSummary?.latencyMs as number | null) ?? null,
            finishReason: (modelUsageSummary?.finishReason as string | null) ?? null,
            providerRequestId: (modelUsageSummary?.providerRequestId as string | null) ?? null,
          }),
          '无法标记调用成功',
        );
      }
      requireCas(
        taskRepo.completeRunning(
          taskId,
          JSON.stringify({
            bundleId: bundle.id,
            questionCount: bundle.questions.length,
            factNoteCount: bundle.factNotes.length,
            sourceCount: bundle.questions.reduce((n, q) => n + q.sources.length, 0),
          }),
        ),
        '无法标记任务完成',
      );
    });
  } catch (err) {
    if (invocationId) {
      compensateFinalization(deps, taskId, invocationId, '任务最终提交失败，已补偿标记失败');
    } else {
      try {
        transaction(() => {
          taskRepo.failRunning(taskId, 'TASK_STATE_CONFLICT', '任务最终提交失败，已补偿标记失败');
        });
      } catch {
        // 补偿失败不掩盖原始错误
      }
    }
    throw err;
  }

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationId ? invocationRepo.getById(invocationId) : null,
    bundleId: bundle.id,
    questionCount: bundle.questions.length,
    factNoteCount: bundle.factNotes.length,
  };
}
