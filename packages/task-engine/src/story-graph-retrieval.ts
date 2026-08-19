/**
 * 图检索：把故事图谱的相关切片喂给章节生成（D14 / B23 工单二）。
 *
 * 四步（D-B23-1/5/6）：三路召回 → RRF 融合 → 因果截断 + 一跳扩展 → 预算组装。
 *
 * 两条纪律压过一切：
 * - **生成主流程绝不因检索受阻**：主函数吞掉所有异常返回 null，调用方按
 *   "没有图"处理（与开关关闭等价）；向量那一路单独降级，不拖垮主干两路。
 * - **检索本体零 chat 模型调用**：只有向量路会打一次 embeddings，
 *   别名激活与 FTS 都是本地查询。
 *
 * "图为空"与"检索失败"是两回事：前者返回空的结构化对象（prompt 里出现空的
 * storyGraph 段），后者返回 null（prompt 里根本没有这一段、前情目标保持全量）。
 */

import type {
  ManuscriptChapterLinkRepositoryPort,
  ProviderProfileRepository,
  SecretStore,
  StoryEmbeddingRepositoryPort,
  StoryEntityData,
  StoryGraphChapterQueryDeps,
  StoryGraphRepositoryPort,
  StoryGraphSearchPort,
  StoryStateData,
  StoryStateRepositoryPort,
  StoryThreadRepositoryPort,
} from '@ai-novel/application';
import {
  cosineTopK,
  listStoryGraphChapterSlots,
  resolveProviderForTask,
  STORY_GRAPH_EMBED_ROUTE_KEY,
} from '@ai-novel/application';
import { isProviderProtocol, type ProviderProtocol } from '@ai-novel/contracts';
import type { EmbeddingInvocationOutput } from '@ai-novel/model-gateway';

// ── deps / 输出 ───────────────────────────────────────────────────

export interface StoryGraphRetrievalDeps {
  readonly graphRepo: StoryGraphRepositoryPort;
  readonly stateRepo: StoryStateRepositoryPort;
  readonly threadRepo: StoryThreadRepositoryPort;
  readonly searchRepo: StoryGraphSearchPort;
  readonly embeddingRepo: StoryEmbeddingRepositoryPort;
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly invokeEmbedding: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    input: ReadonlyArray<string>;
    protocol?: ProviderProtocol;
  }) => Promise<EmbeddingInvocationOutput>;
}

/** 章节任务侧的完整依赖：检索 + 章号映射 */
export interface StoryGraphContextDeps extends StoryGraphRetrievalDeps {
  readonly chapterQuery: StoryGraphChapterQueryDeps;
  readonly linkRepo: ManuscriptChapterLinkRepositoryPort;
}

export interface StoryGraphEntityCard {
  readonly name: string;
  readonly kind: string;
  readonly profile: string;
}

export interface StoryGraphStateCard {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly sinceChapter: number;
}

export interface StoryGraphThreadCard {
  readonly kind: string;
  readonly description: string;
  readonly promisedPayoff: string | null;
  readonly openedChapter: number;
}

/** 注入 prompt 的图切片（确定性排序，可直接 JSON 序列化） */
export interface StoryGraphContext {
  readonly entities: ReadonlyArray<StoryGraphEntityCard>;
  readonly states: ReadonlyArray<StoryGraphStateCard>;
  readonly openThreads: ReadonlyArray<StoryGraphThreadCard>;
}

// ── 常量 ──────────────────────────────────────────────────────────

/** RRF 的标准常数：压低头部名次的绝对优势，让三路都有发言权 */
const RRF_K = 60;
/** 实体 + 状态包的字符预算（D-B23-6 起步 8k） */
const CONTEXT_CHAR_BUDGET = 8000;
const FTS_LIMIT = 60;
const VECTOR_TOP_K = 40;
/** 实体档案进 prompt 的截断长度：档案本身可以很长，卡片只要开头 */
const PROFILE_CARD_CHARS = 200;

type IndexKind = 'entity' | 'state' | 'thread';

function refKey(kind: IndexKind, refId: string): string {
  return `${kind}:${refId}`;
}

// ── 三路召回 ──────────────────────────────────────────────────────

/**
 * 别名/名称激活：种子文本里出现的正名或别名即命中（D-B23-1 主干之一）。
 *
 * 这一路专治 trigram 的盲区——两字人名（"林三"）在 trigram 下永远搜不到，
 * 而它恰恰是最该被激活的东西。别名表小，全量扫是最省事也最准的做法。
 * 名字越长越具体，排前面。
 */
function activateByName(
  seedText: string,
  entities: ReadonlyArray<{
    readonly entity: StoryEntityData;
    readonly aliases: ReadonlyArray<string>;
  }>,
): ReadonlyArray<string> {
  const hits: Array<{ entityId: string; matchLength: number; position: number }> = [];
  for (const entry of entities) {
    let best: { matchLength: number; position: number } | null = null;
    for (const name of [entry.entity.canonicalName, ...entry.aliases]) {
      if (name.length === 0) continue;
      const position = seedText.indexOf(name);
      if (position < 0) continue;
      if (!best || name.length > best.matchLength) {
        best = { matchLength: name.length, position };
      }
    }
    if (best) hits.push({ entityId: entry.entity.id, ...best });
  }
  hits.sort((a, b) => {
    if (a.matchLength !== b.matchLength) return b.matchLength - a.matchLength;
    if (a.position !== b.position) return a.position - b.position;
    return a.entityId < b.entityId ? -1 : 1;
  });
  return hits.map((hit) => refKey('entity', hit.entityId));
}

/** FTS5 次级召回：searchFts 已按 rank 升序返回，名次即数组下标 */
function activateByFts(
  deps: StoryGraphRetrievalDeps,
  projectId: string,
  seedText: string,
): ReadonlyArray<string> {
  return deps.searchRepo
    .searchFts(projectId, seedText, FTS_LIMIT)
    .map((match) => refKey(match.kind, match.refId));
}

/**
 * 向量召回（增强路）：种子文本嵌一次，对全量嵌入暴力余弦取 topK。
 *
 * 未配路由 / 拿不到 key / 调用失败 / 返回畸形 —— 一律返回空数组静默降级
 * （D-B23-1/3）：向量是增强项，主干两路不该为它陪葬。
 */
async function activateByVector(
  deps: StoryGraphRetrievalDeps,
  projectId: string,
  seedText: string,
): Promise<ReadonlyArray<string>> {
  let profile;
  try {
    profile = resolveProviderForTask(
      { providerRepo: deps.providerRepo },
      STORY_GRAPH_EMBED_ROUTE_KEY,
    );
  } catch {
    return [];
  }

  const candidates = deps.embeddingRepo.listAll(projectId);
  if (candidates.length === 0) return [];

  let apiKey: string | null;
  try {
    apiKey = await deps.secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    return [];
  }
  if (!apiKey) return [];

  let result: EmbeddingInvocationOutput;
  try {
    result = await deps.invokeEmbedding({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      input: [seedText],
      protocol: isProviderProtocol(profile.providerType) ? profile.providerType : undefined,
    });
  } catch {
    return [];
  }
  if (result.errorCode || result.embeddings.length !== 1) return [];

  return cosineTopK(
    result.embeddings[0],
    candidates.map((row) => ({ kind: row.kind, refId: row.refId, vector: row.vector })),
    VECTOR_TOP_K,
  ).map((match) => refKey(match.kind as IndexKind, match.refId));
}

/**
 * RRF 融合：score = Σ 1/(k + 名次)。
 *
 * 用名次而不是各路的原始分——余弦相似度、fts5 rank、子串长度三者量纲完全不同，
 * 直接加权是伪科学；名次融合正是 RRF 存在的理由。
 */
function fuseRrf(rankings: ReadonlyArray<ReadonlyArray<string>>): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((key, index) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return scores;
}

// ── 组装 ──────────────────────────────────────────────────────────

/**
 * user 覆盖层优先（D14 §2）：同一 (subject, predicate) 上只要有 user 记录，
 * 同键的 extracted 记录一律不进 prompt——人写的就是对的。
 */
function applyUserOverride(states: ReadonlyArray<StoryStateData>): ReadonlyArray<StoryStateData> {
  const userKeys = new Set<string>();
  for (const state of states) {
    if (state.origin === 'user') userKeys.add(`${state.subjectEntityId} ${state.predicate}`);
  }
  return states.filter(
    (state) =>
      state.origin === 'user' || !userKeys.has(`${state.subjectEntityId} ${state.predicate}`),
  );
}

function truncateProfile(profile: string): string {
  const flat = profile.replace(/\s+/g, ' ').trim();
  return flat.length <= PROFILE_CARD_CHARS ? flat : `${flat.slice(0, PROFILE_CARD_CHARS)}…`;
}

function entityCardLength(card: StoryGraphEntityCard): number {
  return card.name.length + card.kind.length + card.profile.length;
}

function stateCardLength(card: StoryGraphStateCard): number {
  return card.subject.length + card.predicate.length + card.object.length + 8;
}

export interface RetrieveStoryGraphInput {
  readonly projectId: string;
  /** 正在生成的章号（图的章节戳口径：稿件 slot 序） */
  readonly chapterNumber: number;
  readonly seedText: string;
}

/**
 * 检索主入口。任何异常都返回 null（调用方按"没有图"处理）。
 * 图确实为空时返回三个空数组的结构化对象——这与失败不是一回事。
 */
export async function retrieveStoryGraphContext(
  deps: StoryGraphRetrievalDeps,
  input: RetrieveStoryGraphInput,
): Promise<StoryGraphContext | null> {
  try {
    const prior = deps.graphRepo.loadPriorContext(input.projectId);

    // ── 因果截断：这一章开篇时刻的事实与未核销线程（D-B23-5）──
    const validStates = applyUserOverride(
      deps.stateRepo.listValidAtChapter(input.projectId, input.chapterNumber),
    );
    const openThreads = deps.threadRepo.listOpenAtChapter(input.projectId, input.chapterNumber);
    const statesById = new Map(validStates.map((state) => [state.id, state]));

    // ── 三路召回 + RRF ──
    const [nameRanking, ftsRanking, vectorRanking] = [
      activateByName(input.seedText, prior.entities),
      activateByFts(deps, input.projectId, input.seedText),
      await activateByVector(deps, input.projectId, input.seedText),
    ];
    const scores = fuseRrf([nameRanking, ftsRanking, vectorRanking]);

    // ── 命中的状态边反查所属实体，一并进实体集（一跳扩展的起点）──
    const entityScores = new Map<string, number>();
    const bumpEntity = (entityId: string | null, score: number): void => {
      if (!entityId) return;
      entityScores.set(entityId, Math.max(entityScores.get(entityId) ?? 0, score));
    };
    for (const [key, score] of scores) {
      const [kind, refId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (kind === 'entity') bumpEntity(refId, score);
      else if (kind === 'state') {
        const state = statesById.get(refId);
        if (state) {
          bumpEntity(state.subjectEntityId, score);
          bumpEntity(state.objectEntityId, score);
        }
      }
      // thread 命中只抬线程自己的名次：线程表没有实体关联（B22 数据模型）
    }

    // ── 一跳扩展：命中实体的有效边 + 对端实体卡（D-B23-6）──
    const pickedStates: Array<{ state: StoryStateData; score: number }> = [];
    for (const state of validStates) {
      const subjectScore = entityScores.get(state.subjectEntityId);
      const objectScore = state.objectEntityId ? entityScores.get(state.objectEntityId) : undefined;
      const stateScore = scores.get(refKey('state', state.id)) ?? 0;
      const best = Math.max(subjectScore ?? 0, objectScore ?? 0, stateScore);
      if (best > 0) {
        pickedStates.push({ state, score: best });
        // 对端实体被级联拉进来（novelcrafter 同款），分数继承这条边
        bumpEntity(state.objectEntityId, best);
      }
    }

    const entityById = new Map<string, StoryEntityData>();
    for (const entry of prior.entities) entityById.set(entry.entity.id, entry.entity);
    const nameOf = (entityId: string | null): string | null =>
      entityId ? (entityById.get(entityId)?.canonicalName ?? null) : null;

    // ── 确定性排序：RRF 分 → 章节新近度 → id（D-B23-6）──
    const sortedEntities = [...entityScores.entries()]
      .map(([entityId, score]) => ({ entity: entityById.get(entityId), score, entityId }))
      .filter((row): row is { entity: StoryEntityData; score: number; entityId: string } =>
        Boolean(row.entity),
      )
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        const chapterA = a.entity.firstChapter ?? 0;
        const chapterB = b.entity.firstChapter ?? 0;
        if (chapterA !== chapterB) return chapterB - chapterA;
        return a.entityId < b.entityId ? -1 : 1;
      });

    const sortedStates = pickedStates
      .filter((row) => nameOf(row.state.subjectEntityId) !== null)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.state.validFromChapter !== b.state.validFromChapter) {
          return b.state.validFromChapter - a.state.validFromChapter;
        }
        return a.state.id < b.state.id ? -1 : 1;
      });

    // ── 预算：线程包全量优先，实体 + 状态按 8k 字符截断 ──
    const threadCards: StoryGraphThreadCard[] = openThreads.map((thread) => ({
      kind: thread.kind,
      description: thread.description,
      promisedPayoff: thread.promisedPayoff,
      openedChapter: thread.openedChapter,
    }));

    let budget = CONTEXT_CHAR_BUDGET;
    const entityCards: StoryGraphEntityCard[] = [];
    for (const row of sortedEntities) {
      const card: StoryGraphEntityCard = {
        name: row.entity.canonicalName,
        kind: row.entity.kind,
        profile: truncateProfile(row.entity.profileSummary),
      };
      const cost = entityCardLength(card);
      if (cost > budget) break;
      budget -= cost;
      entityCards.push(card);
    }

    const stateCards: StoryGraphStateCard[] = [];
    for (const row of sortedStates) {
      const subject = nameOf(row.state.subjectEntityId);
      if (subject === null) continue;
      const object = row.state.objectEntityId
        ? (nameOf(row.state.objectEntityId) ?? row.state.objectText ?? '')
        : (row.state.objectText ?? '');
      if (object.length === 0) continue;
      const card: StoryGraphStateCard = {
        subject,
        predicate: row.state.predicate,
        object,
        sinceChapter: row.state.validFromChapter,
      };
      const cost = stateCardLength(card);
      if (cost > budget) break;
      budget -= cost;
      stateCards.push(card);
    }

    return { entities: entityCards, states: stateCards, openThreads: threadCards };
  } catch (err) {
    // 派生层纪律：检索塌了也只是"这次没有图"，绝不阻断章节生成（D-B23-1）
    console.error('[task-engine] 故事图谱检索失败，本次按无图处理', err);
    return null;
  }
}

// ── 章号映射（D-B23-5）────────────────────────────────────────────

/**
 * 正在生成的章在图上的章号 N。
 *
 * 已提交过 → manuscript_chapter_links 绑定的稿件 slot 号（重生成同一章）；
 * 没绑定 → 它还没进稿件，排在现有全部章节之后，即 max slot + 1。
 */
export function resolveGraphChapterNumber(
  deps: {
    readonly chapterQuery: StoryGraphChapterQueryDeps;
    readonly linkRepo: ManuscriptChapterLinkRepositoryPort;
  },
  projectId: string,
  blueprintChapterId: string,
): number {
  const slots = listStoryGraphChapterSlots(deps.chapterQuery, projectId);
  const link = deps.linkRepo.get(projectId, blueprintChapterId);
  if (link) {
    const slot = slots.find((s) => s.chapterId === link.chapterId);
    if (slot) return slot.chapterNumber;
  }
  return slots.length + 1;
}

/** 章节任务的检索入口：章号映射 + 检索，任何异常都吞成 null */
export async function retrieveStoryGraphForChapter(
  deps: StoryGraphContextDeps,
  input: {
    readonly projectId: string;
    readonly blueprintChapterId: string;
    readonly seedText: string;
  },
): Promise<StoryGraphContext | null> {
  let chapterNumber: number;
  try {
    chapterNumber = resolveGraphChapterNumber(deps, input.projectId, input.blueprintChapterId);
  } catch (err) {
    console.error('[task-engine] 章号映射失败，本次按无图处理', err);
    return null;
  }
  return retrieveStoryGraphContext(deps, {
    projectId: input.projectId,
    chapterNumber,
    seedText: input.seedText,
  });
}
