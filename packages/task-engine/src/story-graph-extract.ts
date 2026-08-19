/**
 * 故事图谱抽取引擎（D14 / B22，task_type = STORY_GRAPH_EXTRACT）。
 *
 * 图是正文的派生层，不是图节点任务（D-B22-2 独立 runner），失败不阻塞任何主流程。
 *
 * 关键约束：
 * - **抽取源永远是执行当下的权威版本**（chapter_versions current），payload 里的
 *   sourceVersionId/hash 只是入队时的防抖锚点；账本记的是真正抽到的那一版；
 * - 输入 = 正文 + 前情登记表（已知实体 canonical + 别名 + open 线程带 id），
 *   这是指代消解与线程核销的锚（D-B22-4）；
 * - 解析纪律分两级（D-B22-4 细化）：**结构非法整体判失败**（可重试），
 *   **语义无效逐条丢弃并计数**（模型指了一个不存在的线程 id，不该让整章白抽）；
 * - 写入单事务：先做改章失效（删本章 extracted 记录 + 撤回本章核销），再写新内容；
 * - 自动抽取永不合并两个既有实体，疑似同实体只进待审队列（D-B22-5 / D14 铁律）；
 * - prompt 不持久化（仅 hash），task.result 只存安全计数摘要。
 */

import type {
  ChapterRepositoryPort,
  ChapterVersionRepositoryPort,
  ManuscriptRepositoryPort,
  ModelInvocationData,
  StoryGraphRepositories,
  StoryGraphPriorContext,
  TaskData,
} from '@ai-novel/application';
import {
  parseStoryGraphExtractPayload,
  resolveProviderForTask,
  resolveStoryGraphChapterTarget,
  ProviderNotConfiguredError,
  type StoryGraphChapterTarget,
} from '@ai-novel/application';
import type { ErrorCode } from '@ai-novel/contracts';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import {
  sha256Hex,
  TaskAlreadyClaimedError,
  TaskExecutionError,
  type TaskEngineDeps,
} from './index.js';

// ── deps / 结果 ───────────────────────────────────────────────────

export interface StoryGraphExtractEngineDeps extends TaskEngineDeps {
  readonly manuscriptRepo: ManuscriptRepositoryPort;
  readonly chapterRepo: ChapterRepositoryPort;
  readonly chapterVersionRepo: ChapterVersionRepositoryPort;
  readonly storyGraph: StoryGraphRepositories;
}

/** 写入计数摘要（进 task.result_json；不含正文、prompt 或模型原文） */
export interface StoryGraphExtractSummary {
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly sourceVersionId: string;
  readonly entitiesCreated: number;
  readonly entitiesMerged: number;
  readonly aliasesAdded: number;
  readonly statesInserted: number;
  readonly statesSuperseded: number;
  readonly statesUnchanged: number;
  readonly threadsOpened: number;
  readonly threadsClosed: number;
  readonly mergeSuspectsQueued: number;
  /** 语义无效被丢弃的条数（结构非法是整体失败，不会走到这里） */
  readonly droppedStates: number;
  readonly droppedThreadCloses: number;
  readonly droppedMergeSuspects: number;
}

export interface StoryGraphExtractExecutionResult {
  readonly task: TaskData;
  readonly invocation: ModelInvocationData | null;
  readonly extractionId: string | null;
  readonly summary: StoryGraphExtractSummary | null;
}

// ── 常量 ──────────────────────────────────────────────────────────

const EXTRACT_SCHEMA_VERSION = 1;
const EXTRACT_MAX_TOKENS = 8192;
/** 正文超长时只截前段：抽取质量的边际收益远低于超预算的代价 */
const MAX_CHAPTER_CHARS = 20000;
const MAX_ENTITIES = 40;
const MAX_STATES = 80;
const MAX_THREADS = 20;
const MAX_MERGE_SUSPECTS = 10;
const MAX_ALIASES_PER_ENTITY = 10;
const MAX_NAME_CHARS = 60;
const MAX_PREDICATE_CHARS = 40;
const MAX_OBJECT_TEXT_CHARS = 200;
const MAX_PROFILE_CHARS = 600;
const MAX_EVIDENCE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 300;

const ENTITY_KINDS = ['character', 'location', 'item', 'setting'] as const;
type ParsedEntityKind = (typeof ENTITY_KINDS)[number];

// ── 解析结果类型 ──────────────────────────────────────────────────

export interface ParsedStoryEntity {
  readonly name: string;
  readonly kind: ParsedEntityKind;
  readonly aliases: ReadonlyArray<string>;
  readonly profile: string;
  readonly evidence: string;
}

export interface ParsedStoryState {
  readonly subject: string;
  readonly predicate: string;
  readonly objectEntity: string | null;
  readonly objectText: string | null;
  readonly evidence: string;
  readonly confidence: number | null;
}

export interface ParsedStoryThreadOpen {
  readonly kind: string;
  readonly description: string;
  readonly promisedPayoff: string | null;
  readonly evidence: string;
}

export interface ParsedStoryThreadClose {
  readonly threadId: string;
  readonly evidence: string;
}

export interface ParsedStoryMergeSuspect {
  readonly entityA: string;
  readonly entityB: string;
  readonly reason: string;
}

export interface ParsedStoryGraphExtraction {
  readonly entities: ReadonlyArray<ParsedStoryEntity>;
  readonly states: ReadonlyArray<ParsedStoryState>;
  readonly threadsOpen: ReadonlyArray<ParsedStoryThreadOpen>;
  readonly threadsClose: ReadonlyArray<ParsedStoryThreadClose>;
  readonly mergeSuspects: ReadonlyArray<ParsedStoryMergeSuspect>;
}

// ── 严格解析（结构非法 = 整体判失败，可重试）────────────────────

function invalid(message: string): never {
  throw new TaskExecutionError('MODEL_RESPONSE_INVALID', message);
}

/** 容忍代码围栏或前后短说明，提取出的 JSON 仍须通过后续全部严格校验 */
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
  return invalid('故事图谱抽取结果不是合法 JSON');
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${what} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(obj: Record<string, unknown>, keys: ReadonlyArray<string>, what: string) {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    invalid(`${what} 字段不符`);
  }
}

function requireArray(value: unknown, max: number, what: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) invalid(`${what} 不是数组`);
  if (value.length > max) invalid(`${what} 条数超限`);
  return value;
}

function requireText(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') invalid(`${what} 不是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) invalid(`${what} 为空`);
  if (trimmed.length > max) invalid(`${what} 超长`);
  return trimmed;
}

function optionalText(value: unknown, max: number, what: string): string | null {
  if (value === null) return null;
  return requireText(value, max, what);
}

/**
 * 严格解析模型输出。
 *
 * 任何结构问题（顶层字段不符、条目缺字段/多字段、类型错、越界、客体二选一违规）
 * 都整体判失败——静默丢弃半个结构会让图里长出说不清来源的记录。
 */
export function parseStoryGraphExtractionV1(text: string): ParsedStoryGraphExtraction {
  const root = asObject(parseModelJson(text), '抽取结果');
  requireExactKeys(
    root,
    ['schemaVersion', 'entities', 'states', 'threads_open', 'threads_close', 'merge_suspects'],
    '抽取结果顶层',
  );
  if (root.schemaVersion !== EXTRACT_SCHEMA_VERSION) invalid('抽取结果 schemaVersion 不符');

  const entities = requireArray(root.entities, MAX_ENTITIES, 'entities').map((raw) => {
    const item = asObject(raw, 'entities 条目');
    requireExactKeys(item, ['name', 'kind', 'aliases', 'profile', 'evidence'], 'entities 条目');
    const kind = item.kind;
    if (typeof kind !== 'string' || !(ENTITY_KINDS as ReadonlyArray<string>).includes(kind)) {
      invalid('entities 条目 kind 非法');
    }
    const aliases = requireArray(item.aliases, MAX_ALIASES_PER_ENTITY, 'entities 条目 aliases').map(
      (alias) => requireText(alias, MAX_NAME_CHARS, 'entities 条目 alias'),
    );
    return {
      name: requireText(item.name, MAX_NAME_CHARS, 'entities 条目 name'),
      kind: kind as ParsedEntityKind,
      aliases,
      profile: requireText(item.profile, MAX_PROFILE_CHARS, 'entities 条目 profile'),
      evidence: requireText(item.evidence, MAX_EVIDENCE_CHARS, 'entities 条目 evidence'),
    };
  });

  const states = requireArray(root.states, MAX_STATES, 'states').map((raw) => {
    const item = asObject(raw, 'states 条目');
    requireExactKeys(
      item,
      ['subject', 'predicate', 'object_entity', 'object_text', 'evidence', 'confidence'],
      'states 条目',
    );
    const objectEntity = optionalText(
      item.object_entity,
      MAX_NAME_CHARS,
      'states 条目 object_entity',
    );
    const objectText = optionalText(
      item.object_text,
      MAX_OBJECT_TEXT_CHARS,
      'states 条目 object_text',
    );
    // 客体二选一：与 story_states 的 CHECK 同一条规则，越界的整体判失败
    if ((objectEntity === null) === (objectText === null)) {
      invalid('states 条目 object_entity / object_text 必须恰好一个非空');
    }
    let confidence: number | null = null;
    if (item.confidence !== null) {
      if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)) {
        invalid('states 条目 confidence 不是数字');
      }
      if (item.confidence < 0 || item.confidence > 1) invalid('states 条目 confidence 越界');
      confidence = item.confidence;
    }
    return {
      subject: requireText(item.subject, MAX_NAME_CHARS, 'states 条目 subject'),
      predicate: requireText(item.predicate, MAX_PREDICATE_CHARS, 'states 条目 predicate'),
      objectEntity,
      objectText,
      evidence: requireText(item.evidence, MAX_EVIDENCE_CHARS, 'states 条目 evidence'),
      confidence,
    };
  });

  const threadsOpen = requireArray(root.threads_open, MAX_THREADS, 'threads_open').map((raw) => {
    const item = asObject(raw, 'threads_open 条目');
    requireExactKeys(
      item,
      ['kind', 'description', 'promised_payoff', 'evidence'],
      'threads_open 条目',
    );
    return {
      kind: requireText(item.kind, MAX_PREDICATE_CHARS, 'threads_open 条目 kind'),
      description: requireText(
        item.description,
        MAX_DESCRIPTION_CHARS,
        'threads_open 条目 description',
      ),
      promisedPayoff: optionalText(
        item.promised_payoff,
        MAX_DESCRIPTION_CHARS,
        'threads_open 条目 promised_payoff',
      ),
      evidence: requireText(item.evidence, MAX_EVIDENCE_CHARS, 'threads_open 条目 evidence'),
    };
  });

  const threadsClose = requireArray(root.threads_close, MAX_THREADS, 'threads_close').map((raw) => {
    const item = asObject(raw, 'threads_close 条目');
    requireExactKeys(item, ['thread_id', 'evidence'], 'threads_close 条目');
    return {
      threadId: requireText(item.thread_id, MAX_NAME_CHARS, 'threads_close 条目 thread_id'),
      evidence: requireText(item.evidence, MAX_EVIDENCE_CHARS, 'threads_close 条目 evidence'),
    };
  });

  const mergeSuspects = requireArray(root.merge_suspects, MAX_MERGE_SUSPECTS, 'merge_suspects').map(
    (raw) => {
      const item = asObject(raw, 'merge_suspects 条目');
      requireExactKeys(item, ['entity_a', 'entity_b', 'reason'], 'merge_suspects 条目');
      return {
        entityA: requireText(item.entity_a, MAX_NAME_CHARS, 'merge_suspects 条目 entity_a'),
        entityB: requireText(item.entity_b, MAX_NAME_CHARS, 'merge_suspects 条目 entity_b'),
        reason: requireText(item.reason, MAX_DESCRIPTION_CHARS, 'merge_suspects 条目 reason'),
      };
    },
  );

  return { entities, states, threadsOpen, threadsClose, mergeSuspects };
}

// ── Prompt（不持久化）────────────────────────────────────────────

export const STORY_GRAPH_EXTRACT_SYSTEM_PROMPT = [
  '你是长篇小说的故事图谱抽取器。读一章正文，抽出这一章**明确写到**的实体、状态变化与伏笔线程。',
  '严格输出单个 JSON 对象，不要 markdown 代码块，不要在 JSON 前后写任何解释。',
  '顶层结构必须精确为：',
  '{"schemaVersion":1,"entities":[],"states":[],"threads_open":[],"threads_close":[],"merge_suspects":[]}',
  '',
  'entities 每项精确包含：name、kind、aliases、profile、evidence。',
  'kind 取值只能是 character（人物）、location（地点）、item（物品）、setting（设定）之一；',
  'aliases 是本章出现的其他称呼（数组，可为空）；profile 是这一章新增的简短描述；',
  'evidence 是支撑该条的原文短引（一句以内）。',
  '',
  'states 每项精确包含：subject、predicate、object_entity、object_text、evidence、confidence。',
  'subject 是主体实体名；predicate 是关系或状态名（如"身份""所在""关系""生死"）；',
  'object_entity 与 object_text 必须**恰好一个非空**：客体是实体时填 object_entity（实体名），',
  '否则把值写进 object_text，另一个填 null；confidence 是 0 到 1 的小数或 null。',
  '只写本章确立或改变的状态，不要重复抄写前情登记表里已有且未变的状态。',
  '',
  'threads_open 每项精确包含：kind、description、promised_payoff、evidence。',
  'kind 如 foreshadow（伏笔）、promise（承诺）、mystery（悬念）；description 一句话说清这条线索；',
  'promised_payoff 是许诺的回收方式，没有就填 null。',
  '',
  'threads_close 每项精确包含：thread_id、evidence——thread_id **必须**是前情登记表',
  '"未核销线程"里给出的 id 原样照抄，不要自己编 id，本章没有回收任何线程就给空数组。',
  '',
  'merge_suspects 每项精确包含：entity_a、entity_b、reason——只在本章暗示"两个已知名字其实是',
  '同一个人/物"时才写（如秘密身份揭示）。你不能自行合并实体，只能提出怀疑。',
  '',
  '所有名字尽量沿用前情登记表里的 canonical 名称；不要输出任何额外字段。',
].join('\n');

/** 前情登记表：已知实体（canonical + 别名）与未核销线程（带 id，核销要按 id 引用） */
function renderPriorContext(prior: StoryGraphPriorContext): string {
  const entities = prior.entities.map((entry) => ({
    name: entry.entity.canonicalName,
    kind: entry.entity.kind,
    aliases: entry.aliases,
  }));
  const threads = prior.openThreads.map((t) => ({
    id: t.id,
    kind: t.kind,
    description: t.description,
    openedChapter: t.openedChapter,
  }));
  return JSON.stringify({ knownEntities: entities, openThreads: threads });
}

export function buildStoryGraphExtractPrompt(input: {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly prior: StoryGraphPriorContext;
}): string {
  const content =
    input.content.length > MAX_CHAPTER_CHARS
      ? input.content.slice(0, MAX_CHAPTER_CHARS)
      : input.content;
  return [
    `当前章节：第 ${input.chapterNumber} 章《${input.title}》`,
    '',
    '前情登记表（该项目已知实体与未核销线程，JSON）：',
    renderPriorContext(input.prior),
    '',
    '本章正文：',
    content,
    '',
    '请按系统要求的 JSON 结构输出本章的抽取结果。',
  ].join('\n');
}

// ── 写入（单事务，语义无效逐条丢弃）──────────────────────────────

interface ApplyContext {
  readonly projectId: string;
  readonly target: StoryGraphChapterTarget;
  readonly now: string;
}

/** 待审对归一化：同一对实体无论谁先谁后都只留一条 pending（部分唯一索引才拦得住） */
function orderedPair(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

function applyExtraction(
  deps: StoryGraphExtractEngineDeps,
  ctx: ApplyContext,
  parsed: ParsedStoryGraphExtraction,
): StoryGraphExtractSummary {
  const { entityRepo, stateRepo, threadRepo, mergeReviewRepo } = deps.storyGraph;
  const { projectId, now, target } = ctx;
  const chapterNumber = target.chapterNumber;

  let entitiesCreated = 0;
  let entitiesMerged = 0;
  let aliasesAdded = 0;
  let statesInserted = 0;
  let statesSuperseded = 0;
  let statesUnchanged = 0;
  let threadsOpened = 0;
  let threadsClosed = 0;
  let mergeSuspectsQueued = 0;
  let droppedStates = 0;
  let droppedThreadCloses = 0;
  let droppedMergeSuspects = 0;

  // 本批新建/命中的名字 → 实体 id（跨条目复用，省掉重复查库）
  const resolvedByName = new Map<string, string>();
  const queueSuspect = (aId: string, bId: string, reason: string): void => {
    if (aId === bId) return;
    const [entityAId, entityBId] = orderedPair(aId, bId);
    const inserted = mergeReviewRepo.insertPending({
      id: deps.idGenerator.generate(),
      projectId,
      entityAId,
      entityBId,
      suggestedReason: reason,
      createdAt: now,
    });
    if (inserted) mergeSuspectsQueued += 1;
  };
  const resolveEntity = (name: string): string | null =>
    resolvedByName.get(name) ?? entityRepo.findByNameOrAlias(projectId, name)?.id ?? null;

  // 1. 实体：精确命中即归并（追加档案），未命中新建（D-B22-5）
  for (const entity of parsed.entities) {
    const existing = entityRepo.findByNameOrAlias(projectId, entity.name);
    let entityId: string;
    if (existing) {
      entityId = existing.id;
      entityRepo.appendProfileSummary(projectId, entityId, entity.profile, now);
      entitiesMerged += 1;
    } else {
      entityId = deps.idGenerator.generate();
      entityRepo.create({
        id: entityId,
        projectId,
        kind: entity.kind,
        canonicalName: entity.name,
        profileSummary: entity.profile,
        firstChapter: chapterNumber,
        origin: 'extracted',
        createdAt: now,
      });
      entitiesCreated += 1;
    }
    resolvedByName.set(entity.name, entityId);

    for (const alias of entity.aliases) {
      if (alias === entity.name) continue;
      const owner = entityRepo.findByNameOrAlias(projectId, alias);
      if (owner && owner.id !== entityId) {
        // 这个别名已经属于另一个实体：登记别名等于把两个实体并成一个，
        // 而自动抽取永不合并既有实体（D14 铁律）——只提怀疑。
        queueSuspect(entityId, owner.id, `别名「${alias}」同时指向两个实体`);
        continue;
      }
      if (
        entityRepo.addAlias({
          id: deps.idGenerator.generate(),
          projectId,
          entityId,
          alias,
          origin: 'extracted',
          createdAt: now,
        })
      ) {
        aliasesAdded += 1;
      }
      resolvedByName.set(alias, entityId);
    }
  }

  // 2. 状态边：append-only，旧边关闭而不是改写（D-B22-1）
  for (const state of parsed.states) {
    const subjectId = resolveEntity(state.subject);
    if (!subjectId) {
      droppedStates += 1; // 语义无效：主体既不在前情登记表也不在本次实体清单里
      continue;
    }
    let objectEntityId: string | null = null;
    if (state.objectEntity !== null) {
      objectEntityId = resolveEntity(state.objectEntity);
      if (!objectEntityId) {
        droppedStates += 1;
        continue;
      }
    }

    const currents = stateRepo.listCurrentBySubjectPredicate(projectId, subjectId, state.predicate);
    const unchanged = currents.some(
      (edge) => edge.objectEntityId === objectEntityId && edge.objectText === state.objectText,
    );
    if (unchanged) {
      statesUnchanged += 1; // 状态没变：不重复记一条同义边
      continue;
    }

    const stateId = deps.idGenerator.generate();
    stateRepo.insert({
      id: stateId,
      projectId,
      subjectEntityId: subjectId,
      predicate: state.predicate,
      objectEntityId,
      objectText: state.objectText,
      validFromChapter: chapterNumber,
      sourceChapterId: target.chapterId,
      sourceContentHash: target.contentHash,
      evidenceSpan: state.evidence,
      confidence: state.confidence,
      origin: 'extracted',
      createdAt: now,
    });
    statesInserted += 1;

    // 本章之前（含本章）确立的旧边被这条取代
    for (const edge of currents) {
      if (edge.validFromChapter > chapterNumber) continue;
      if (stateRepo.supersede(projectId, edge.id, chapterNumber, stateId)) statesSuperseded += 1;
    }
    // 乱序重抽（先抽了后面的章）时已经存在更晚的边：新边一落地就被它接管，
    // 保持"同一 subject+predicate 至多一条有效边"的不变量。
    const later = currents
      .filter((edge) => edge.validFromChapter > chapterNumber)
      .sort((a, b) => a.validFromChapter - b.validFromChapter)[0];
    if (later) stateRepo.supersede(projectId, stateId, later.validFromChapter, later.id);
  }

  // 3. 线程开启：描述精确重复视为同一条，不重复开
  for (const thread of parsed.threadsOpen) {
    if (threadRepo.findOpenByDescription(projectId, thread.description)) continue;
    threadRepo.open({
      id: deps.idGenerator.generate(),
      projectId,
      kind: thread.kind,
      description: thread.description,
      promisedPayoff: thread.promisedPayoff,
      openedChapter: chapterNumber,
      sourceChapterId: target.chapterId,
      sourceContentHash: target.contentHash,
      evidenceSpan: thread.evidence,
      origin: 'extracted',
      createdAt: now,
    });
    threadsOpened += 1;
  }

  // 4. 线程核销：id 必须真实存在且仍 open，且不能"在开启之前就被回收"
  for (const close of parsed.threadsClose) {
    const thread = threadRepo.getById(projectId, close.threadId);
    if (!thread || thread.status !== 'open' || thread.openedChapter > chapterNumber) {
      droppedThreadCloses += 1;
      continue;
    }
    if (threadRepo.close(projectId, close.threadId, chapterNumber, now)) threadsClosed += 1;
    else droppedThreadCloses += 1; // user 线程或并发已核销
  }

  // 5. 疑似同实体：只进待审队列
  for (const suspect of parsed.mergeSuspects) {
    const aId = resolveEntity(suspect.entityA);
    const bId = resolveEntity(suspect.entityB);
    if (!aId || !bId || aId === bId) {
      droppedMergeSuspects += 1;
      continue;
    }
    const before = mergeSuspectsQueued;
    queueSuspect(aId, bId, suspect.reason);
    if (mergeSuspectsQueued === before) droppedMergeSuspects += 1; // 已有同一对 pending
  }

  return {
    chapterId: target.chapterId,
    chapterNumber,
    sourceVersionId: target.versionId,
    entitiesCreated,
    entitiesMerged,
    aliasesAdded,
    statesInserted,
    statesSuperseded,
    statesUnchanged,
    threadsOpened,
    threadsClosed,
    mergeSuspectsQueued,
    droppedStates,
    droppedThreadCloses,
    droppedMergeSuspects,
  };
}

// ── 任务执行 ──────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
}

export async function executeStoryGraphExtract(
  deps: StoryGraphExtractEngineDeps,
  taskId: string,
): Promise<StoryGraphExtractExecutionResult> {
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
  if (task.taskType !== 'STORY_GRAPH_EXTRACT') {
    throw new TaskExecutionError('TASK_STATE_CONFLICT', `任务类型不符: ${task.taskType}`);
  }
  if (task.status !== 'PENDING') {
    throw new TaskAlreadyClaimedError(`任务状态不是 PENDING: ${task.status}`);
  }

  const failBeforeClaim = (code: ErrorCode, message: string): StoryGraphExtractExecutionResult => {
    requireCas(taskRepo.failPending(taskId, code, message), '任务状态冲突，无法终结为 FAILED');
    return { task: taskRepo.getById(taskId)!, invocation: null, extractionId: null, summary: null };
  };

  const payload = parseStoryGraphExtractPayload(task.payloadJson);
  if (!payload) return failBeforeClaim('TASK_EXECUTION_FAILED', '抽取任务 payload 无效');

  // claim 前解析 provider + API Key（缺配置不增 attempt_count）
  let profile;
  try {
    profile = resolveProviderForTask({ providerRepo }, task.taskType);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return failBeforeClaim('PROVIDER_NOT_CONFIGURED', '模型提供商未配置');
    }
    throw err;
  }
  if (!isProviderProtocol(profile.providerType)) {
    return failBeforeClaim('PROVIDER_NOT_CONFIGURED', '模型提供商协议不合法');
  }
  const protocol: ProviderProtocol = profile.providerType;

  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    return failBeforeClaim('API_KEY_READ_FAILED', '无法读取 API Key');
  }
  if (!apiKey) return failBeforeClaim('API_KEY_REQUIRED', '请先配置 API Key');

  // 抽取源 = 执行当下的权威版本；payload 里的版本只是入队时的防抖锚点
  const target = resolveStoryGraphChapterTarget(deps, task.projectId, payload.chapterId);
  if (!target) {
    return failBeforeClaim('CHAPTER_VERSION_NOT_FOUND', '章节没有可抽取的权威版本');
  }

  if (!taskRepo.claimPending(taskId)) {
    throw new TaskAlreadyClaimedError('任务已被其他进程领取');
  }
  const claimedTask = taskRepo.getById(taskId)!;

  const prior = deps.storyGraph.graphRepo.loadPriorContext(task.projectId);
  const prompt = buildStoryGraphExtractPrompt({
    chapterNumber: target.chapterNumber,
    title: target.title,
    content: target.content,
    prior,
  });

  const invocationId = idGenerator.generate();
  invocationRepo.create({
    id: invocationId,
    projectId: task.projectId,
    taskId: task.id,
    providerProfileId: profile.id,
    model: profile.model,
    attemptNumber: claimedTask.attemptCount,
    requestKind: 'story_graph_extract',
    promptHash: sha256Hex(prompt),
    requestMetadataJson: JSON.stringify({
      promptLength: prompt.length,
      chapterNumber: target.chapterNumber,
      knownEntityCount: prior.entities.length,
      openThreadCount: prior.openThreads.length,
      schemaVersion: EXTRACT_SCHEMA_VERSION,
    }),
  });
  transaction(() => {
    requireCas(invocationRepo.markRunning(invocationId, 'PENDING'), '无法标记调用为 RUNNING');
  });

  const failAfterInvocation = (
    code: ErrorCode,
    message: string,
    latencyMs: number | null,
  ): StoryGraphExtractExecutionResult => {
    transaction(() => {
      requireCas(
        invocationRepo.markFailed(invocationId, ['RUNNING'], code, message, latencyMs),
        '无法标记调用失败',
      );
      requireCas(taskRepo.failRunning(taskId, code, message), '无法标记任务失败');
    });
    return {
      task: taskRepo.getById(taskId)!,
      invocation: invocationRepo.getById(invocationId),
      extractionId: null,
      summary: null,
    };
  };

  let result: ModelInvocationOutput;
  try {
    result = await invokeModel({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      prompt,
      systemPrompt: STORY_GRAPH_EXTRACT_SYSTEM_PROMPT,
      maxTokens: EXTRACT_MAX_TOKENS,
      protocol,
    });
  } catch {
    return failAfterInvocation('PROVIDER_CONNECTION_FAILED', '模型调用异常', null);
  }
  if (result.errorCode) {
    return failAfterInvocation(
      result.errorCode,
      result.errorMessage ?? '模型调用失败',
      result.latencyMs,
    );
  }

  // 结构非法 = 整体判失败（可重试）；语义无效在写入阶段逐条丢弃
  let parsed: ParsedStoryGraphExtraction;
  try {
    parsed = parseStoryGraphExtractionV1(result.text);
  } catch (err) {
    const code: ErrorCode = err instanceof TaskExecutionError ? err.code : 'MODEL_RESPONSE_INVALID';
    return failAfterInvocation(code, '模型返回的故事图谱抽取结果无效', result.latencyMs);
  }

  const now = deps.clock.now();
  const extractionId = idGenerator.generate();
  let summary: StoryGraphExtractSummary;

  transaction(() => {
    // 改章重抽：先失效本章旧记录（只动 extracted 层），再写新内容（D-B22-4）
    deps.storyGraph.stateRepo.deleteExtractedBySourceChapter(task.projectId, target.chapterId);
    deps.storyGraph.threadRepo.reopenClosedAtChapter(task.projectId, target.chapterNumber, now);
    deps.storyGraph.threadRepo.deleteExtractedBySourceChapter(task.projectId, target.chapterId);
    deps.storyGraph.extractionRepo.deleteByChapter(task.projectId, target.chapterId);

    summary = applyExtraction(deps, { projectId: task.projectId, target, now }, parsed);

    // 账本记的是**真正抽到**的那一版，不是 payload 里入队时的那一版
    deps.storyGraph.extractionRepo.register({
      id: extractionId,
      projectId: task.projectId,
      chapterId: target.chapterId,
      sourceVersionId: target.versionId,
      sourceContentHash: target.contentHash,
      taskId,
      status: 'succeeded',
      extractedAt: now,
    });

    requireCas(
      invocationRepo.markSucceeded(invocationId, 'RUNNING', {
        responseMetadataJson: JSON.stringify({ textLength: result.text.length }),
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
    requireCas(
      taskRepo.completeRunning(taskId, JSON.stringify({ extractionId, ...summary })),
      '无法标记任务成功',
    );
  });

  return {
    task: taskRepo.getById(taskId)!,
    invocation: invocationRepo.getById(invocationId),
    extractionId,
    summary: summary!,
  };
}
