/**
 * SPEC_EXTRACT 任务执行器（B3 / GE-3）。
 *
 * 一次模型调用同时产出三件事（见 docs/development/b3-intake-wiring-design.md D-B3-4）：
 * 1. decision：'ask_more'（还需追问）| 'spec_complete'（创作要求已完备）；
 * 2. 结构化创作要求（复用 Creation Contract sections 域模型与校验器）；
 * 3. decision='ask_more' 时的下一批追问问题（1..3 个，写入 grill_questions，
 *    由 ASK_QUESTION 同步 executor 逐个 markAsked）。
 *
 * 持久化（最终事务，全有或全无）：
 * - 新 creation_contract_versions 行（createdBy='ai-proposal-accepted'，GE-3 不走审批链，
 *   见 D-B3-3）+ current 指针 insertFirst/casUpdate；
 * - 追问问题（若 ask_more）；
 * - execution-bound durable envelope（artifactKind='creationSpec'，artifactId=版本 id，
 *   outcome={clarification_remaining, decision}）——task 成功前必达，崩溃后可重放结算（RW-1）；
 * - invocation SUCCEEDED + task SUCCEEDED（resultJson 只存安全摘要，不含正文）。
 *
 * 安全：prompt 只存在于内存（payloadJson 仅 {sessionId}）；API Key 不入日志不入返回值。
 * 失败路径与 chapter-generation 一致：业务失败标记 task/invocation FAILED 后返回（不抛），
 * 最终事务失败走 compensateFinalization 后抛出。
 */

import type {
  CreationContractCurrentRepositoryPort,
  CreationContractVersionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillSessionRepositoryPort,
  ModelInvocationData,
  NodeExecutionRepositoryPort,
  TaskData,
} from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import {
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  canonicalSerializeLockedFieldPaths,
  CREATION_CONTRACT_SCHEMA_VERSION,
  validateCreationContractSections,
  type CreationContractSections,
} from '@ai-novel/domain';
import { sha256Hex, TaskExecutionError, type TaskEngineDeps } from './index.js';
import { compensateFinalization } from './chapter-generation.js';

// ── deps / 类型 ───────────────────────────────────────────────────

export interface SpecExtractExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly questionRepo: GrillQuestionRepositoryPort;
  readonly answerRepo: GrillAnswerRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
}

export type SpecExtractDecision = 'ask_more' | 'spec_complete';

/** 执行结果（镜像 ChapterDraftExecutionResult 形状：失败时 versionId/decision 为 null） */
export interface SpecExtractExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly versionId: string | null;
  readonly versionNumber: number | null;
  readonly decision: SpecExtractDecision | null;
  readonly questionCount: number;
}

// ── 常量 ──────────────────────────────────────────────────────────

const MAX_NEXT_QUESTIONS = 3;

export const SPEC_EXTRACT_SYSTEM_PROMPT = [
  '你是小说创作要求的抽取助手。用户给出一段模糊的创作想法，可能附带此前的问答补充。',
  '你的职责：把已表达的信息整理为结构化创作要求；只在信息确实缺失且值得追问时提出下一批问题。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"decision":"ask_more"或"spec_complete","sections":{...},"nextQuestions":[...]}',
  'sections 的结构与字段约束遵循用户消息中给出的 schema 说明；未知信息使用 schema 允许的空值表达，不得编造。',
  'decision 判定标准：题材/视角/篇幅/基调等关键要求已可支撑开始创作即 spec_complete；否则 ask_more。',
  'nextQuestions 规则：spec_complete 时必须为空数组；ask_more 时给 1 到 3 个问题，',
  '每个问题为 {"topic":"...","text":"...","rationale":"..."}，只问缺失且影响创作的信息，禁止重复已回答内容。',
].join('\n');

// ── payload 解析 ──────────────────────────────────────────────────

interface SpecExtractPayload {
  readonly sessionId: string;
}

/** 严格解析任务 payload：exact keys（镜像 contract-draft parseTaskInput 纪律） */
function parsePayload(payloadJson: string): SpecExtractPayload {
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
  const keys = Object.keys(obj);
  if (keys.length !== 1 || !('sessionId' in obj)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (typeof obj.sessionId !== 'string' || obj.sessionId.trim().length === 0) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  return { sessionId: obj.sessionId };
}

// ── prompt 构造 ───────────────────────────────────────────────────

interface QaEntry {
  readonly question: string;
  readonly topic: string;
  readonly status: string;
  readonly answer: string | null;
}

/** 用户消息：想法 + 既有创作要求基线 + 问答记录 + sections schema 说明（确定性序列化） */
export function buildSpecExtractPrompt(context: {
  readonly initialIdea: string;
  readonly baselineSections: CreationContractSections | null;
  readonly qa: ReadonlyArray<QaEntry>;
}): string {
  const payload = {
    initialIdea: context.initialIdea,
    baselineSections: context.baselineSections,
    qa: context.qa,
  };
  return [
    '以下是创作想法与已知信息（JSON）：',
    JSON.stringify(payload),
    '',
    'sections 的 schema 与 Creation Contract sections 域模型一致：包含题材类型、目标读者、',
    '篇幅目标、作品形式、叙事视角、基调、节奏、语言偏好、必须包含、必须避免、内容边界、',
    '人物、世界观等分区；结构必须能通过严格校验，枚举值与嵌套字段不得自造。',
    '基线（baselineSections）非空时在其上增量修订：保留用户已确认的内容，只补充或修正新信息。',
    '现在输出结果 JSON。',
  ].join('\n');
}

// ── 模型输出解析 ──────────────────────────────────────────────────

export interface ParsedSpecExtract {
  readonly decision: SpecExtractDecision;
  readonly sections: CreationContractSections;
  readonly nextQuestions: ReadonlyArray<{
    readonly topic: string;
    readonly text: string;
    readonly rationale: string;
  }>;
}

function isNonEmptyBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** 严格解析模型输出：exact top-level keys；sections 走域校验器；问题数量/形状/边界受限 */
export function parseSpecExtractV1(text: string): ParsedSpecExtract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '创作要求抽取结果不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '创作要求抽取结果不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = ['decision', 'nextQuestions', 'schemaVersion', 'sections'];
  if (keys.length !== expected.length || !expected.every((k) => k in obj)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '抽取结果顶层字段不符');
  }
  if (obj.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '抽取结果 schemaVersion 不符');
  }
  if (obj.decision !== 'ask_more' && obj.decision !== 'spec_complete') {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '抽取结果 decision 非法');
  }
  const decision = obj.decision as SpecExtractDecision;

  let sections: CreationContractSections;
  try {
    sections = validateCreationContractSections(obj.sections);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '抽取结果 sections 未通过域校验');
  }

  if (!Array.isArray(obj.nextQuestions)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '抽取结果 nextQuestions 非数组');
  }
  const rawQuestions = obj.nextQuestions as ReadonlyArray<unknown>;
  if (decision === 'spec_complete' && rawQuestions.length !== 0) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      'spec_complete 时 nextQuestions 必须为空',
    );
  }
  if (
    decision === 'ask_more' &&
    (rawQuestions.length < 1 || rawQuestions.length > MAX_NEXT_QUESTIONS)
  ) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'ask_more 时问题数须为 1..3');
  }
  const nextQuestions = rawQuestions.map((q) => {
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题条目结构无效');
    }
    const rec = q as Record<string, unknown>;
    const qKeys = Object.keys(rec).sort();
    if (qKeys.length !== 3 || !['rationale', 'text', 'topic'].every((k) => k in rec)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题条目字段不符');
    }
    if (
      !isNonEmptyBoundedString(rec.topic, 64) ||
      !isNonEmptyBoundedString(rec.text, 500) ||
      !isNonEmptyBoundedString(rec.rationale, 300)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '问题条目内容越界或为空');
    }
    return { topic: rec.topic, text: rec.text, rationale: rec.rationale };
  });

  return { decision, sections, nextQuestions };
}

// ── 执行 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

export async function executeSpecExtract(
  deps: SpecExtractExecutionDeps,
  taskId: string,
): Promise<SpecExtractExecutionResult> {
  const {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    invokeModel,
    transaction,
    nodeExecutionRepo,
    nodeExecutionResultStore,
  } = deps;

  const task = taskRepo.getById(taskId);
  if (!task) throw new TaskExecutionError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (task.taskType !== 'SPEC_EXTRACT') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  const payload = parsePayload(task.payloadJson);

  // provider 路由（D6 两层）与密钥 —— claim 前解析，配置缺失不增加 attempt_count
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

  if (!nodeExecutionResultStore) {
    throw new TaskExecutionError(
      'TASK_EXECUTION_FAILED',
      'task-backed 执行缺少 nodeExecutionResultStore（无法持久化产物）',
    );
  }

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
      versionId: null,
      versionNumber: null,
      decision: null,
      questionCount: 0,
    };
  }

  // ── 上下文装配：session（goal=播种的初始想法）+ 问答记录 + 既有创作要求基线 ──
  const session = deps.sessionRepo.getById(payload.sessionId);
  if (!session || session.projectId !== task.projectId) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', 'intake session 不存在'),
        '无法标记任务失败',
      );
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: null,
      versionId: null,
      versionNumber: null,
      decision: null,
      questionCount: 0,
    };
  }
  const questions = deps.questionRepo.listBySession(payload.sessionId);
  const currentAnswers = deps.answerRepo.listCurrentBySession(payload.sessionId);
  const answerByQuestion = new Map(currentAnswers.map((a) => [a.questionId, a.text]));
  const qa: ReadonlyArray<QaEntry> = questions.map((q) => ({
    question: q.text,
    topic: q.topic,
    status: q.status,
    answer: answerByQuestion.get(q.id) ?? null,
  }));
  const currentPointer = deps.currentRepo.get(task.projectId);
  // BLK-3：并发防护基线——最终事务将与此值比对。模型调用在途期间用户手工修改
  // 创作要求（current 指针移动）时，本次抽取基于旧 baseline，必须作废而非静默覆盖。
  const expectedCurrentVersionId = currentPointer?.currentVersionId ?? null;
  const baselineVersion = currentPointer
    ? deps.versionRepo.getById(task.projectId, currentPointer.currentVersionId)
    : null;
  let baselineSections: CreationContractSections | null = null;
  if (baselineVersion) {
    try {
      baselineSections = validateCreationContractSections(JSON.parse(baselineVersion.sectionsJson));
    } catch {
      baselineSections = null; // 基线损坏不阻断抽取，按无基线处理
    }
  }

  const prompt = buildSpecExtractPrompt({
    initialIdea: session.goal,
    baselineSections,
    qa,
  });

  const updatedTask = taskRepo.getById(taskId)!;
  const invocationId = idGenerator.generate();

  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: updatedTask.attemptCount,
    requestKind: 'spec_extract',
    promptHash: sha256Hex(prompt),
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      sessionId: payload.sessionId,
      qaCount: qa.length,
    }),
  });
  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  const result = await invokeModel({
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey,
    prompt,
    systemPrompt: SPEC_EXTRACT_SYSTEM_PROMPT,
    protocol,
  }).catch((err: unknown) => {
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
    return { failed: true as const };
  });

  if ('failed' in result) {
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      versionId: null,
      versionNumber: null,
      decision: null,
      questionCount: 0,
    };
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
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      versionId: null,
      versionNumber: null,
      decision: null,
      questionCount: 0,
    };
  }

  let parsedResult: ParsedSpecExtract;
  try {
    parsedResult = parseSpecExtractV1(result.text);
  } catch (err) {
    const message = err instanceof TaskExecutionError ? err.message : '模型输出解析失败';
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(
          invocationId,
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
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      versionId: null,
      versionNumber: null,
      decision: null,
      questionCount: 0,
    };
  }

  // ── 最终事务：版本 + 指针 + 问题 + envelope + invocation/task 终态（全有或全无）──
  const versionId = idGenerator.generate();
  const now = deps.clock.now();
  const sectionsJson = canonicalSerializeContractSections(parsedResult.sections);
  const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths([]);
  const snapshotHash = sha256Hex(
    canonicalSerializeContractSnapshot({
      sections: parsedResult.sections,
      lockedFieldPaths: [],
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    }),
  );
  let versionNumber = 1;
  try {
    transaction(() => {
      const pointer = deps.currentRepo.get(task.projectId);
      // BLK-3：与调用前捕获的期望指针比对（事务内重读再自比是自证式伪 CAS，挡不住
      // 装配→模型调用→落库窗口内的用户修改）。不一致 → 本次抽取作废，用户版本保持 current。
      if ((pointer?.currentVersionId ?? null) !== expectedCurrentVersionId) {
        throw new TaskExecutionError(
          'TASK_STATE_CONFLICT',
          '创作要求在抽取期间被用户修改，本次抽取结果作废',
        );
      }
      const current = pointer
        ? deps.versionRepo.getById(task.projectId, pointer.currentVersionId)
        : null;
      versionNumber = current ? current.version + 1 : 1;

      deps.versionRepo.create({
        id: versionId,
        projectId: task.projectId,
        version: versionNumber,
        schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
        sourceProposalId: null,
        basedOnGrillSessionId: payload.sessionId,
        basedOnGrillSessionVersion: session.version,
        sectionsJson,
        lockedFieldPathsJson,
        contractSnapshotHash: snapshotHash,
        // provenance 数组形状受 validateProvenanceArray 强校验（每 sectionKey 唯一）；
        // 版本级溯源记在 /premise 一条：AI 直接抽取 + task/invocation 引用
        provenanceJson: JSON.stringify([
          {
            sectionKey: '/premise',
            source: 'AI_PROPOSAL',
            grillAnswerIds: [],
            grillProposalIds: [],
            aiTaskId: taskId,
            modelInvocationId: invocationId,
            sourceProposalId: null,
            previousFieldHash: null,
            rationale: `spec-extract-v1 直接抽取（execution ${execution.id}）`,
          },
        ]),
        createdAt: now,
        createdBy: 'ai-proposal-accepted',
      });
      if (pointer) {
        requireCas(
          deps.currentRepo.casUpdate(task.projectId, pointer.currentVersionId, versionId, now),
          'current 指针 CAS 失败（创作要求被并发修改）',
        );
      } else {
        requireCas(
          deps.currentRepo.insertFirst(task.projectId, versionId, now),
          'current 指针并发首建冲突',
        );
      }

      // 追问问题（ask_more 时；由 ASK_QUESTION 同步 executor 逐个 markAsked）
      let sequence = deps.questionRepo.getMaxSequence(payload.sessionId);
      for (const q of parsedResult.nextQuestions) {
        sequence += 1;
        deps.questionRepo.create({
          id: idGenerator.generate(),
          sessionId: payload.sessionId,
          sequence,
          topic: q.topic,
          text: q.text,
          rationale: q.rationale,
          dependsOnQuestionIds: [],
        });
      }

      // execution-bound durable envelope：task 成功前必达（RW-1 不变量）
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
        artifactKind: 'creationSpec',
        artifactId: versionId,
        artifactVersion: versionNumber,
        contentJson: sectionsJson,
        outcome: { condition: 'clarification_remaining', value: parsedResult.decision },
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
      requireCas(
        taskRepo.completeRunning(
          taskId,
          JSON.stringify({
            versionId,
            versionNumber,
            decision: parsedResult.decision,
            questionCount: parsedResult.nextQuestions.length,
            inputTokens: result.usage?.inputTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
          }),
        ),
        '无法标记任务完成',
      );
    });
  } catch (err) {
    compensateFinalization(deps, taskId, invocationId, '任务最终提交失败，已补偿标记失败');
    throw err;
  }

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    versionId,
    versionNumber,
    decision: parsedResult.decision,
    questionCount: parsedResult.nextQuestions.length,
  };
}
