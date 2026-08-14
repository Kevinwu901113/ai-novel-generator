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
import {
  sha256Hex,
  TaskAlreadyClaimedError,
  TaskExecutionError,
  type TaskEngineDeps,
} from './index.js';
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

/**
 * MiMo 等推理模型会把内部推理也计入输出额度。默认 4096 token 可能在真正的 JSON
 * 完成前耗尽，表现为正文末尾缺少闭合括号。抽取结果本身很短，但仍需给推理留足空间。
 */
export const SPEC_EXTRACT_MAX_TOKENS = 8192;

const SECTIONS_SCHEMA_INSTRUCTIONS = [
  'sections 必须严格遵守以下字段表；不得输出未列出的字段，不得用 null 表示未知值：',
  '必填字段：premise（非空字符串）、genre（1..5 个字符串）、tone（1..5 个字符串）、',
  'targetAudience（非空字符串）、narrativePov（FIRST|THIRD_LIMITED|THIRD_OMNISCIENT|SECOND|OTHER）、',
  'tense（PAST|PRESENT|MIXED）、protagonist。',
  '用户未明确语法时态时 tense 固定用 PAST；故事发生在未来不等于 FUTURE 时态，禁止输出枚举表以外的值。',
  'protagonist 必须至少含 characterKey 与 name；characterKey 只能用 1..50 位小写英文字母、数字、_、-，',
  '未知姓名可用用户原称谓（例如“老板娘”），characterKey 可用 protagonist。可选字段仅有 role、motivation、arc、traits。',
  'sections 可选字段：themes、targetLength、structure、supportingCharacters、relationships、worldRules、',
  'mustInclude、mustAvoid、contentBoundaries、unresolvedQuestions。信息未知时直接省略整个可选字段，禁止输出 null。',
  'structure 必须是一个字符串，不得写成对象；例如“长篇连载，每章约3000字”。',
  'themes、worldRules、mustInclude、mustAvoid、unresolvedQuestions 都必须是字符串数组；即使只有一项也写成 ["..."]，不得写成对象。',
  'targetLength 只能是 {"unit":"words"或"chapters","value":正整数}，表示全书总字数或总章节数；每章字数只写入 structure。',
  'protagonist.traits 必须是字符串数组。supportingCharacters 必须是对象数组，每项只允许 characterKey、name、role、relationship、traits；',
  '其中 traits 也必须是字符串数组，characterKey 同样使用稳定英文键。',
  'relationships 必须是对象数组，每项只允许 relationshipKey、fromCharacterKey、toCharacterKey、type、dynamic；',
  'relationshipKey 与角色键使用相同的稳定英文格式，且引用的角色键必须已存在。',
  'contentBoundaries 必须是对象，只允许 rating、allowedContent、prohibitedContent、notes；',
  '其中 allowedContent 与 prohibitedContent 必须是字符串数组，其余字段是字符串。',
  '最小合法形状示例（只示字段形状，内容必须依据用户输入改写）：',
  '{"premise":"故事前提","genre":["奇幻"],"tone":["冷峻"],"targetAudience":"中文成人网文读者","narrativePov":"THIRD_LIMITED","tense":"PAST","protagonist":{"characterKey":"protagonist","name":"老板娘"}}',
].join('\n');

export const SPEC_EXTRACT_SYSTEM_PROMPT = [
  '你是小说创作要求的抽取助手。用户给出一段模糊的创作想法，可能附带此前的问答补充。',
  '你的职责：把已表达的信息整理为结构化创作要求；只在信息确实缺失且值得追问时提出下一批问题。',
  '输出必须是单个 JSON 对象，不加任何解释文字或代码围栏，顶层结构精确为：',
  '{"schemaVersion":1,"decision":"ask_more"或"spec_complete","sections":{...},"nextQuestions":[...]}',
  'sections 的结构与字段约束必须逐项遵循用户消息中的完整字段表；未知的可选信息直接省略，禁止输出 null 或自造字段。',
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
    SECTIONS_SCHEMA_INSTRUCTIONS,
    '完整性硬约束：initialIdea 与 qa.answer 中用户明确说过的每一项要求都必须保留到 sections，',
    '不能因为当前追问只问一个主题就忽略同一条回答里的其他信息。',
    '字段映射：长篇/短篇、连载形式、每章字数、分卷方式等统一写入 structure；',
    '“每章三千字左右”应规范为“每章约3000字”。明确的禁忌写入 mustAvoid，明确的结局选择写入 protagonist.arc 或 mustInclude。',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSingleOrArray(value: unknown): unknown {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (!isRecord(value) && !Array.isArray(value)) return value;

  const flattened: string[] = [];
  const collectStrings = (nested: unknown, depth: number): void => {
    if (typeof nested === 'string') {
      const trimmed = nested.trim();
      if (trimmed.length > 0) flattened.push(trimmed);
      return;
    }
    if (depth >= 3) return;
    if (Array.isArray(nested)) {
      for (const item of nested) collectStrings(item, depth + 1);
      return;
    }
    if (isRecord(nested)) {
      for (const item of Object.values(nested)) collectStrings(item, depth + 1);
    }
  };
  collectStrings(value, 0);

  // 布尔映射等没有字符串值，无法无歧义还原，继续交给域校验器拒绝。
  return flattened.length > 0 ? [...new Set(flattened)] : value;
}

function stringifyRuleValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('；');
  }
  return JSON.stringify(value);
}

function normalizeStructure(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('；');
  }
  if (!isRecord(value)) return value;

  return Object.entries(value)
    .map(([key, raw]) => {
      const rendered = stringifyRuleValue(raw);
      const normalizedKey = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
      const isPerChapter =
        key.includes('每章') ||
        key.includes('单章') ||
        (/chapter/.test(normalizedKey) && /word|char|length|size/.test(normalizedKey));
      if (!isPerChapter) return `${key}：${rendered}`;
      if (typeof raw === 'number' && Number.isFinite(raw)) return `每章约${raw}字`;
      return /每章|单章/.test(rendered) ? rendered : `每章${rendered}`;
    })
    .join('；');
}

/**
 * 只规范化可无歧义还原的兼容模型常见偏差；未知字段、缺字段和任意坏类型仍交给域校验器拒绝。
 * FUTURE 是模型把故事年代误当成语法时态的常见结果，按提示词声明的未指定默认值 PAST 归一。
 */
function normalizeSectionsForValidation(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sections: Record<string, unknown> = { ...value };

  for (const field of [
    'genre',
    'tone',
    'themes',
    'mustInclude',
    'mustAvoid',
    'unresolvedQuestions',
  ]) {
    if (field in sections) sections[field] = normalizeSingleOrArray(sections[field]);
  }

  if ('structure' in sections) sections.structure = normalizeStructure(sections.structure);

  if (isRecord(sections.worldRules)) {
    sections.worldRules = Object.entries(sections.worldRules).map(
      ([key, rule]) => `${key}：${stringifyRuleValue(rule)}`,
    );
  } else if ('worldRules' in sections) {
    sections.worldRules = normalizeSingleOrArray(sections.worldRules);
  }

  if (isRecord(sections.protagonist) && 'traits' in sections.protagonist) {
    sections.protagonist = {
      ...sections.protagonist,
      traits: normalizeSingleOrArray(sections.protagonist.traits),
    };
  }
  if (Array.isArray(sections.supportingCharacters)) {
    sections.supportingCharacters = sections.supportingCharacters.map((character) =>
      isRecord(character) && 'traits' in character
        ? { ...character, traits: normalizeSingleOrArray(character.traits) }
        : character,
    );
  }
  if (isRecord(sections.contentBoundaries)) {
    const boundaries: Record<string, unknown> = { ...sections.contentBoundaries };
    for (const field of ['allowedContent', 'prohibitedContent']) {
      if (field in boundaries) boundaries[field] = normalizeSingleOrArray(boundaries[field]);
    }
    sections.contentBoundaries = boundaries;
  }

  if (typeof sections.narrativePov === 'string') {
    const pov = sections.narrativePov
      .trim()
      .toUpperCase()
      .replaceAll('-', '_')
      .replaceAll(' ', '_');
    const povAliases: Readonly<Record<string, string>> = {
      FIRST_PERSON: 'FIRST',
      THIRD_PERSON_LIMITED: 'THIRD_LIMITED',
      THIRD_PERSON_OMNISCIENT: 'THIRD_OMNISCIENT',
      SECOND_PERSON: 'SECOND',
      第三人称限制视角: 'THIRD_LIMITED',
      第三人称限知: 'THIRD_LIMITED',
      第三人称全知: 'THIRD_OMNISCIENT',
      第一人称: 'FIRST',
      第二人称: 'SECOND',
    };
    sections.narrativePov = povAliases[pov] ?? pov;
  }
  if (typeof sections.tense === 'string') {
    const tense = sections.tense.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
    const tenseAliases: Readonly<Record<string, string>> = {
      PAST_TENSE: 'PAST',
      PRESENT_TENSE: 'PRESENT',
      MIXED_TENSE: 'MIXED',
      FUTURE: 'PAST',
      FUTURE_TENSE: 'PAST',
      过去时: 'PAST',
      现在时: 'PRESENT',
      混合时态: 'MIXED',
      将来时: 'PAST',
    };
    sections.tense = tenseAliases[tense] ?? tense;
  }

  return sections;
}

/** 容忍常见的代码围栏或简短前后说明，但提取出的 JSON 仍须通过后续全部严格校验。 */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of new Set(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个受限候选
    }
  }
  throw new TaskExecutionError('MODEL_RESPONSE_INVALID', '创作要求抽取结果不是合法 JSON');
}

/** 严格解析模型输出：exact top-level keys；sections 走域校验器；问题数量/形状/边界受限 */
export function parseSpecExtractV1(text: string): ParsedSpecExtract {
  const parsed = parseModelJson(text);
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
    sections = validateCreationContractSections(normalizeSectionsForValidation(obj.sections));
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知原因';
    throw new TaskExecutionError(
      'MODEL_RESPONSE_INVALID',
      `抽取结果 sections 未通过域校验：${detail}`,
    );
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
    throw new TaskAlreadyClaimedError(`任务状态不是 PENDING: ${task.status}`);
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
    throw new TaskAlreadyClaimedError('任务已被其他进程领取');
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
    maxTokens: SPEC_EXTRACT_MAX_TOKENS,
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
    const baseMessage = err instanceof TaskExecutionError ? err.message : '模型输出解析失败';
    const outputTokens = result.usage.outputTokens;
    const reachedOutputLimit =
      result.finishReason === 'max_tokens' || result.finishReason === 'length';
    const message = reachedOutputLimit
      ? `${baseMessage}（模型输出达到${outputTokens === null ? '' : ` ${outputTokens} token`}上限，内容可能被截断）`
      : baseMessage;
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

      // 追问问题（ask_more 时；由 ASK_QUESTION 同步 executor 逐个 markAsked）。
      // TD-024（D-B4-7）：写入前重读会话，非 ACTIVE 不再注入问题；结算语义不变，
      // envelope 照常落库。注意（B4 复查修正）：唯一可达的非 ACTIVE 时序是"另一
      // 非终态 run 的 IDEA_CAPTURE 弃用了本会话"（跨 run），此时本 run 的 settlement
      // 仍会推进、ASK_QUESTION 因无问题而 fail-closed——被替换的旧 run 走向终态，
      // 恰好收敛"双活 run"歧义；产品 UI 不会主动制造该并发（见 D-B4-2）。
      const sessionAtFinalize = deps.sessionRepo.getById(payload.sessionId);
      if (sessionAtFinalize?.status === 'ACTIVE') {
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
