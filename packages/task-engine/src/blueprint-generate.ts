/**
 * BLUEPRINT_GENERATE 任务执行器（GE-5 / B7，设计见 docs/development/b7-blueprint-wiring-design.md）。
 *
 * 骨架照 research-run.ts：payload 严格解析 → claim 前配置校验（照 spec-extract.ts，
 * provider + API key，无 search key）→ claimPending → 权威 execution 反查 → 上下文装配
 * → 模型调用 → 严格解析（D-B7-6）→ 最终事务（bundle 落库 + envelope + invocation/task
 * 终态，全有或全无）→ 补偿。
 *
 * - BLUEPRINT_GENERATE 与 RESEARCH_EXECUTE 同为 artifact-only 节点（图契约
 *   `out(null,'storyBlueprint')`）：envelope `outcome: null`；
 * - D-B7-5：版本号在本执行器的最终事务内取该项目现有 `MAX(version) + 1`
 *   （`StoryBlueprintRepositoryPort.getMaxVersion`），与 envelope 的 `artifactVersion`
 *   保持同事务一致（resolver 会校验两者相等）；
 * - D-B7-7：`researchBundleId` 为 null 时（`research_decision=none` 或
 *   `skip_research` 升级路径）prompt 显式声明"本项目未做调研"，不得把缺失伪装成空调研；
 * - D-B7-4：改写循环无 feedback 承载（TD-029-1），仅用 `rewriteAttempt`
 *   （snapshot 里 `budget.blueprintRewrite` 计数）告知模型"这是第 N 次改写，需产出
 *   实质不同的蓝图"。
 */

import type {
  CreationContractVersionRepositoryPort,
  GrillSessionRepositoryPort,
  ModelInvocationData,
  NodeExecutionRepositoryPort,
  ResearchBundleRepositoryPort,
  StoryBlueprintRepositoryPort,
  TaskData,
} from '@ai-novel/application';
import { resolveProviderForTask, ProviderNotConfiguredError } from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import {
  createStoryBlueprint,
  validateCreationContractSections,
  type BlueprintCharacter,
  type BlueprintChapter,
  type BlueprintPlotline,
  type StoryBlueprint,
} from '@ai-novel/domain';
import { sha256Hex, TaskExecutionError, type TaskEngineDeps } from './index.js';
import { compensateFinalization } from './chapter-generation.js';

// ── deps / 类型 ───────────────────────────────────────────────────

export interface BlueprintGenerateExecutionDeps extends TaskEngineDeps {
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly specVersionRepo: CreationContractVersionRepositoryPort;
  readonly researchRepo: ResearchBundleRepositoryPort;
  readonly blueprintRepo: StoryBlueprintRepositoryPort;
}

export interface BlueprintGenerateExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly blueprintId: string | null;
  readonly version: number | null;
  readonly chapterCount: number;
}

// ── 常量（D-B7-6：模型输出解析边界）────────────────────────────────

const MIN_CHARACTERS = 1;
const MAX_CHARACTERS = 50;
const MAX_RELATIONSHIPS = 100;
const MIN_PLOTLINES = 1;
const MAX_PLOTLINES = 20;
const MIN_CHAPTERS = 1;
const MAX_CHAPTERS = 200;
const MAX_CHAPTER_GOAL_LENGTH = 500;
const MAX_CHAPTER_TITLE_LENGTH = 200;
const MAX_LONG_FIELD_LENGTH = 4000;
const MAX_SHORT_FIELD_LENGTH = 300;

export const BLUEPRINT_GENERATE_SYSTEM_PROMPT = [
  '你是小说故事蓝图生成助手。输入是创作想法、创作要求，以及（若有）调研资料。',
  '你的职责：产出完整的故事蓝图，至少包含核心前提、主角与关键人物、主要关系、世界背景、',
  '主要冲突、结局方向、主要情节线、章节结构与每章目标。',
  '若 rewriteAttempt 大于 0，说明用户对上一版蓝图请求了改写，本次必须产出实质不同的蓝图',
  '（更换叙事角度、结构安排或核心冲突的处理方式），不得只做措辞层面的微调。',
  '若调研信息标注 conducted=false，说明本项目未做事实调研，蓝图不得依赖具体的事实性',
  '细节（真实地名、机构、技术数据等），应基于创作要求自由设定自洽的虚构世界观；',
  'conducted=true 时应参考给出的调研结论与事实笔记，保持设定与事实一致。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"premise":"...","characters":[{"name":"...","role":"...","description":"..."}],' +
    '"relationships":["..."],"world":"...","conflict":"...","ending":"...",' +
    '"plotlines":[{"name":"...","summary":"..."}],"chapters":[{"title":"...","goal":"..."}]}',
  `字段边界：characters ${MIN_CHARACTERS}..${MAX_CHARACTERS} 个；relationships 0..${MAX_RELATIONSHIPS} 条` +
    `（可为空数组）；plotlines ${MIN_PLOTLINES}..${MAX_PLOTLINES} 条；` +
    `chapters ${MIN_CHAPTERS}..${MAX_CHAPTERS} 章，每章 goal 不超过 ${MAX_CHAPTER_GOAL_LENGTH} 字。`,
  '除 relationships 外全部字符串字段禁止为空。',
].join('\n');

// ── prompt 构造 ───────────────────────────────────────────────────

export interface BlueprintResearchContext {
  readonly conclusion: string;
  readonly factNotes: ReadonlyArray<string>;
}

/** 用户消息（确定性序列化）。D-B7-7：无调研时显式标注 conducted=false，不伪装成空调研。 */
export function buildBlueprintGeneratePrompt(context: {
  readonly idea: string;
  readonly creationSpecSummary: unknown;
  readonly research: BlueprintResearchContext | null;
  readonly rewriteAttempt: number;
}): string {
  const researchPayload =
    context.research === null
      ? { conducted: false as const }
      : {
          conducted: true as const,
          conclusion: context.research.conclusion,
          factNotes: context.research.factNotes,
        };
  return [
    '以下是创作想法、创作要求与调研信息（JSON）：',
    JSON.stringify({
      idea: context.idea,
      creationSpec: context.creationSpecSummary,
      research: researchPayload,
      rewriteAttempt: context.rewriteAttempt,
    }),
    '',
    context.rewriteAttempt > 0
      ? `这是第 ${context.rewriteAttempt} 次改写，必须产出与之前实质不同的蓝图。`
      : '现在输出结果 JSON。',
  ].join('\n');
}

// ── payload 解析 ──────────────────────────────────────────────────

interface BlueprintGeneratePayload {
  readonly ideaSessionId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string | null;
  readonly rewriteAttempt: number;
}

/** 严格解析任务 payload：exact keys（镜像 spec-extract / research-run parsePayload 纪律） */
function parsePayload(payloadJson: string): BlueprintGeneratePayload {
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
  const expected = ['creationSpecVersionId', 'ideaSessionId', 'researchBundleId', 'rewriteAttempt'];
  const keys = Object.keys(obj).sort();
  if (keys.length !== expected.length || !expected.every((k) => k in obj)) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
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
    obj.researchBundleId !== null &&
    (typeof obj.researchBundleId !== 'string' || obj.researchBundleId.length === 0)
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload 无效');
  }
  if (
    typeof obj.rewriteAttempt !== 'number' ||
    !Number.isInteger(obj.rewriteAttempt) ||
    obj.rewriteAttempt < 0
  ) {
    throw new TaskExecutionError('TASK_EXECUTION_FAILED', '任务 payload rewriteAttempt 非法');
  }
  return {
    ideaSessionId: obj.ideaSessionId,
    creationSpecVersionId: obj.creationSpecVersionId,
    researchBundleId: obj.researchBundleId as string | null,
    rewriteAttempt: obj.rewriteAttempt,
  };
}

// ── 模型输出解析（D-B7-6）───────────────────────────────────────────

/** 解析出的蓝图（chapters 尚无 id——由 executor 在最终事务内分配，见 D-B7-5 附近说明） */
export interface ParsedBlueprintGenerate {
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotline>;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly goal: string }>;
}

function isNonEmptyBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function requireExactKeys(
  obj: Record<string, unknown>,
  expected: ReadonlyArray<string>,
  errorMessage: string,
): void {
  const keys = Object.keys(obj).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || !sortedExpected.every((k, i) => k === keys[i])) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', errorMessage);
  }
}

/** 严格解析模型输出：exact top-level keys + 逐字段类型/长度/数量边界；越界一律 MODEL_RESPONSE_INVALID */
export function parseBlueprintGenerateV1(text: string): ParsedBlueprintGenerate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  requireExactKeys(
    obj,
    [
      'schemaVersion',
      'premise',
      'characters',
      'relationships',
      'world',
      'conflict',
      'ending',
      'plotlines',
      'chapters',
    ],
    '蓝图生成结果顶层字段不符',
  );
  if (obj.schemaVersion !== 1) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图生成结果 schemaVersion 不符');
  }
  if (!isNonEmptyBoundedString(obj.premise, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 premise 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.world, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 world 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.conflict, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 conflict 越界或为空');
  }
  if (!isNonEmptyBoundedString(obj.ending, MAX_LONG_FIELD_LENGTH)) {
    throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '蓝图 ending 越界或为空');
  }

  if (
    !Array.isArray(obj.characters) ||
    obj.characters.length < MIN_CHARACTERS ||
    obj.characters.length > MAX_CHARACTERS
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `characters 数须为 ${MIN_CHARACTERS}..${MAX_CHARACTERS}`,
    );
  }
  const characters: BlueprintCharacter[] = obj.characters.map((c) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'character 条目结构无效');
    }
    const rec = c as Record<string, unknown>;
    requireExactKeys(rec, ['name', 'role', 'description'], 'character 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.name, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.role, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.description, MAX_LONG_FIELD_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'character 字段内容越界或为空');
    }
    return { name: rec.name, role: rec.role, description: rec.description };
  });

  if (!Array.isArray(obj.relationships) || obj.relationships.length > MAX_RELATIONSHIPS) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `relationships 数不得超过 ${MAX_RELATIONSHIPS}`,
    );
  }
  const relationships: string[] = obj.relationships.map((r) => {
    if (!isNonEmptyBoundedString(r, MAX_SHORT_FIELD_LENGTH)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'relationship 条目内容越界或为空');
    }
    return r;
  });

  if (
    !Array.isArray(obj.plotlines) ||
    obj.plotlines.length < MIN_PLOTLINES ||
    obj.plotlines.length > MAX_PLOTLINES
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `plotlines 数须为 ${MIN_PLOTLINES}..${MAX_PLOTLINES}`,
    );
  }
  const plotlines: BlueprintPlotline[] = obj.plotlines.map((p) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'plotline 条目结构无效');
    }
    const rec = p as Record<string, unknown>;
    requireExactKeys(rec, ['name', 'summary'], 'plotline 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.name, MAX_SHORT_FIELD_LENGTH) ||
      !isNonEmptyBoundedString(rec.summary, MAX_LONG_FIELD_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'plotline 字段内容越界或为空');
    }
    return { name: rec.name, summary: rec.summary };
  });

  if (
    !Array.isArray(obj.chapters) ||
    obj.chapters.length < MIN_CHAPTERS ||
    obj.chapters.length > MAX_CHAPTERS
  ) {
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `chapters 数须为 ${MIN_CHAPTERS}..${MAX_CHAPTERS}`,
    );
  }
  const chapters = obj.chapters.map((c) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'chapter 条目结构无效');
    }
    const rec = c as Record<string, unknown>;
    requireExactKeys(rec, ['title', 'goal'], 'chapter 条目字段不符');
    if (
      !isNonEmptyBoundedString(rec.title, MAX_CHAPTER_TITLE_LENGTH) ||
      !isNonEmptyBoundedString(rec.goal, MAX_CHAPTER_GOAL_LENGTH)
    ) {
      throw new TaskExecutionError('MODEL_RESPONSE_INVALID', 'chapter 字段内容越界或为空');
    }
    return { title: rec.title, goal: rec.goal };
  });

  return {
    premise: obj.premise,
    characters,
    relationships,
    world: obj.world,
    conflict: obj.conflict,
    ending: obj.ending,
    plotlines,
    chapters,
  };
}

// ── 执行 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
  }
}

function failedResult(
  deps: BlueprintGenerateExecutionDeps,
  taskId: string,
  invocationId: string | null,
): BlueprintGenerateExecutionResult {
  return {
    task: deps.taskRepo.getById(taskId)!,
    invocation: invocationId ? deps.invocationRepo.getById(invocationId) : null,
    blueprintId: null,
    version: null,
    chapterCount: 0,
  };
}

export async function executeBlueprintGenerate(
  deps: BlueprintGenerateExecutionDeps,
  taskId: string,
): Promise<BlueprintGenerateExecutionResult> {
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
  if (task.taskType !== 'BLUEPRINT_GENERATE') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务状态不是 PENDING: ${task.status}`);
  }
  const payload = parsePayload(task.payloadJson);

  // ── claim 前配置校验（缺配置不增 attempt，保持 PENDING；镜像 spec-extract，无 search key）──
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

  // ── 上下文装配：idea（session goal）+ creationSpec（完整 sections）+（可能有的）researchBundle ──
  const session = deps.sessionRepo.getById(payload.ideaSessionId);
  const specVersion = deps.specVersionRepo.getById(task.projectId, payload.creationSpecVersionId);
  if (!session || session.projectId !== task.projectId || !specVersion) {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '蓝图生成上下文缺失（session/spec）'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }
  let creationSpecSummary: unknown;
  try {
    creationSpecSummary = validateCreationContractSections(JSON.parse(specVersion.sectionsJson));
  } catch {
    transaction(() => {
      requireCas(
        taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', 'creationSpec sections 损坏'),
        '无法标记任务失败',
      );
    });
    return failedResult(deps, taskId, null);
  }

  // D-B7-7：researchBundleId 为 null 时（none / skip_research）显式声明"未做调研"，
  // 不得把缺失伪装成空调研；有 bundle 时若找不到底层行视为上下文缺失（确定性失败）。
  let research: BlueprintResearchContext | null = null;
  if (payload.researchBundleId !== null) {
    const bundle = deps.researchRepo.getById(task.projectId, payload.researchBundleId);
    if (!bundle) {
      transaction(() => {
        requireCas(
          taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', '引用的调研资料包不存在'),
          '无法标记任务失败',
        );
      });
      return failedResult(deps, taskId, null);
    }
    research = {
      conclusion: bundle.conclusion,
      factNotes: bundle.factNotes.map((n) => n.text),
    };
  }

  const prompt = buildBlueprintGeneratePrompt({
    idea: session.goal,
    creationSpecSummary,
    research,
    rewriteAttempt: payload.rewriteAttempt,
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
    requestKind: 'blueprint_generate',
    promptHash: sha256Hex(prompt),
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      rewriteAttempt: payload.rewriteAttempt,
      hasResearch: research !== null,
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
    systemPrompt: BLUEPRINT_GENERATE_SYSTEM_PROMPT,
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
  if ('failed' in result) return failedResult(deps, taskId, invocationId);

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
    return failedResult(deps, taskId, invocationId);
  }

  let parsedResult: ParsedBlueprintGenerate;
  try {
    parsedResult = parseBlueprintGenerateV1(result.text);
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
    return failedResult(deps, taskId, invocationId);
  }

  // ── 最终事务：版本号取 MAX+1（D-B7-5）+ 域校验 + 落库 + envelope + invocation/task 终态 ──
  const now = deps.clock.now();
  // 定值断言：赋值发生在下方 transaction() 回调内（同步执行），TS 跨闭包分析看不到这点。
  let blueprint!: StoryBlueprint;
  try {
    transaction(() => {
      const blueprintId = idGenerator.generate();
      const version = deps.blueprintRepo.getMaxVersion(task.projectId) + 1;
      const chapters: BlueprintChapter[] = parsedResult.chapters.map((c) => ({
        id: idGenerator.generate(),
        title: c.title,
        goal: c.goal,
      }));
      try {
        blueprint = createStoryBlueprint({
          id: blueprintId,
          projectId: task.projectId,
          version,
          premise: parsedResult.premise,
          characters: parsedResult.characters,
          relationships: parsedResult.relationships,
          world: parsedResult.world,
          conflict: parsedResult.conflict,
          ending: parsedResult.ending,
          plotlines: parsedResult.plotlines,
          chapters,
          createdAt: now,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '蓝图域校验失败';
        throw new TaskExecutionError('MODEL_RESPONSE_INVALID', message);
      }

      deps.blueprintRepo.save(blueprint, false);

      // execution-bound durable envelope：task 成功前必达（RW-1 不变量）。
      // BLUEPRINT_GENERATE 契约 out(null,'storyBlueprint')：artifact-only，无 outcome。
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
        artifactKind: 'storyBlueprint',
        artifactId: blueprint.id,
        artifactVersion: blueprint.version,
        contentJson: JSON.stringify(blueprint),
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
      requireCas(
        taskRepo.completeRunning(
          taskId,
          JSON.stringify({
            blueprintId: blueprint.id,
            version: blueprint.version,
            chapterCount: blueprint.chapters.length,
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
    blueprintId: blueprint.id,
    version: blueprint.version,
    chapterCount: blueprint.chapters.length,
  };
}
