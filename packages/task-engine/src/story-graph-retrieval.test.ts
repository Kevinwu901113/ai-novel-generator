/**
 * 图检索模块单测（D14 / B23 工单二）。
 *
 * 用 fake 仓库驱动，覆盖组装与降级语义：
 * - 三路 RRF 融合的命中序；
 * - user 覆盖层优先（D14 §2）；
 * - 预算截断的确定性；
 * - 向量路降级三态（无路由 / 无 key / 调用抛错）不影响主干两路；
 * - 「图为空」返回空结构化对象，「检索失败」返回 null——两者语义不同。
 *
 * 因果截断的边界（valid_from < N / 线程时点）在 SQL 里，测试在
 * packages/database/src/story-graph-retrieval-query.test.ts。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ProviderProfileRepository,
  SecretStore,
  StoryEntityData,
  StoryStateData,
  StoryThreadData,
} from '@ai-novel/application';
import {
  retrieveStoryGraphContext,
  resolveGraphChapterNumber,
  type StoryGraphRetrievalDeps,
} from './story-graph-retrieval.js';

const NOW = '2026-08-19T00:00:00.000Z';

function entity(
  id: string,
  name: string,
  overrides: Partial<StoryEntityData> = {},
): StoryEntityData {
  return {
    id,
    projectId: 'p1',
    kind: 'character',
    canonicalName: name,
    profileSummary: `${name}的档案`,
    firstChapter: 1,
    origin: 'extracted',
    mergedIntoId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function state(id: string, overrides: Partial<StoryStateData> = {}): StoryStateData {
  return {
    id,
    projectId: 'p1',
    subjectEntityId: 'e-lin',
    predicate: '身份',
    objectEntityId: null,
    objectText: '外门弟子',
    validFromChapter: 1,
    validUntilChapter: null,
    sourceChapterId: 'c1',
    sourceContentHash: null,
    evidenceSpan: null,
    confidence: null,
    origin: 'extracted',
    supersededById: null,
    createdAt: NOW,
    ...overrides,
  };
}

function thread(id: string, overrides: Partial<StoryThreadData> = {}): StoryThreadData {
  return {
    id,
    projectId: 'p1',
    kind: 'foreshadow',
    description: '玉佩来历不明',
    status: 'open',
    promisedPayoff: '揭示玉佩是掌门信物',
    openedChapter: 1,
    closedChapter: null,
    sourceChapterId: 'c1',
    sourceContentHash: null,
    evidenceSpan: null,
    origin: 'extracted',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const EMBED_PROFILE = {
  id: 'embed',
  providerType: 'openai-chat',
  displayName: 'embed',
  baseUrl: 'https://api.example.com/v1',
  model: 'text-embedding-3-small',
  keychainService: 'svc',
  keychainAccount: 'acc',
  enabled: true,
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

function providerRepo(routed: boolean): ProviderProfileRepository {
  return {
    getById: () => EMBED_PROFILE,
    list: () => [EMBED_PROFILE],
    getDefault: () => EMBED_PROFILE,
    getRoute: (taskType: string) =>
      routed && taskType === 'STORY_GRAPH_EMBED' ? EMBED_PROFILE.id : null,
    create: () => {},
    update: () => {},
    delete: () => true,
    setDefault: () => true,
    setRoute: () => {},
    deleteRoute: () => {},
    updateTestResult: () => {},
  } as unknown as ProviderProfileRepository;
}

const secretStore: SecretStore = {
  hasSecret: async () => true,
  setSecret: async () => {},
  getSecret: async () => 'key',
  deleteSecret: async () => {},
};

interface FakeGraph {
  entities?: Array<{ entity: StoryEntityData; aliases: string[] }>;
  states?: StoryStateData[];
  threads?: StoryThreadData[];
  fts?: Array<{ kind: 'entity' | 'state' | 'thread'; refId: string; rank: number }>;
  embeddings?: Array<{ kind: 'entity' | 'state' | 'thread'; refId: string; vector: number[] }>;
  routed?: boolean;
  invokeEmbedding?: StoryGraphRetrievalDeps['invokeEmbedding'];
}

function buildDeps(graph: FakeGraph): StoryGraphRetrievalDeps {
  return {
    graphRepo: {
      loadPriorContext: () => ({
        entities: graph.entities ?? [],
        openThreads: graph.threads ?? [],
      }),
      clearExtracted: () => {
        throw new Error('检索不该写');
      },
    },
    stateRepo: {
      listValidAtChapter: () => graph.states ?? [],
    } as unknown as StoryGraphRetrievalDeps['stateRepo'],
    threadRepo: {
      listOpenAtChapter: () => graph.threads ?? [],
    } as unknown as StoryGraphRetrievalDeps['threadRepo'],
    searchRepo: {
      searchFts: () => graph.fts ?? [],
      listIndexSources: () => [],
    },
    embeddingRepo: {
      listAll: () =>
        (graph.embeddings ?? []).map((row) => ({
          id: `emb-${row.refId}`,
          projectId: 'p1',
          kind: row.kind,
          refId: row.refId,
          model: 'm',
          dims: row.vector.length,
          vector: new Float32Array(row.vector),
          contentHash: 'h',
          createdAt: NOW,
        })),
    } as unknown as StoryGraphRetrievalDeps['embeddingRepo'],
    providerRepo: providerRepo(graph.routed ?? false),
    secretStore,
    invokeEmbedding:
      graph.invokeEmbedding ??
      (async () => ({
        embeddings: [[1, 0]],
        usage: { inputTokens: 1, totalTokens: 1 },
        latencyMs: 1,
        errorCode: null,
        errorMessage: null,
      })),
  };
}

const LIN = { entity: entity('e-lin', '林三'), aliases: ['林师兄'] };
const SECT = { entity: entity('e-sect', '青云宗', { kind: 'location' }), aliases: [] };

describe('三路召回与 RRF 融合', () => {
  it('别名激活：种子文本里出现别名即命中，两字名也能中（trigram 的盲区）', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({ entities: [LIN, SECT], states: [state('s1')] }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三在雨夜赶路' },
    );
    expect(result).not.toBeNull();
    expect(result!.entities.map((e) => e.name)).toEqual(['林三']);
    expect(result!.states).toEqual([
      { subject: '林三', predicate: '身份', object: '外门弟子', sinceChapter: 1 },
    ]);
  });

  it('FTS 命中的状态边反查出所属实体，一并进实体集', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN, SECT],
        states: [state('s1', { subjectEntityId: 'e-lin' })],
        fts: [{ kind: 'state', refId: 's1', rank: -1 }],
      }),
      // 种子文本里没有任何名字：只有 FTS 这一路有输出
      { projectId: 'p1', chapterNumber: 5, seedText: '外门弟子的日常' },
    );
    expect(result!.entities.map((e) => e.name)).toEqual(['林三']);
    expect(result!.states.map((s) => s.subject)).toEqual(['林三']);
  });

  it('一跳扩展：命中实体的边把对端实体也拉进来', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN, SECT],
        states: [state('s1', { predicate: '所在', objectEntityId: 'e-sect', objectText: null })],
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三推开门' },
    );
    expect(result!.entities.map((e) => e.name).sort()).toEqual(['林三', '青云宗']);
    expect(result!.states[0].object).toBe('青云宗');
  });

  it('三路都命中时按 RRF 分排序（多路共识的排前面）', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN, SECT],
        states: [],
        // 青云宗只有名称激活一路；林三名称 + FTS + 向量三路
        fts: [{ kind: 'entity', refId: 'e-lin', rank: -1 }],
        embeddings: [
          { kind: 'entity', refId: 'e-lin', vector: [1, 0] },
          { kind: 'entity', refId: 'e-sect', vector: [0, 1] },
        ],
        routed: true,
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '青云宗里，林三独自站着' },
    );
    expect(result!.entities.map((e) => e.name)).toEqual(['林三', '青云宗']);
  });
});

describe('组装语义', () => {
  it('user 覆盖层优先：同 subject+predicate 的 extracted 记录不进 prompt', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN],
        states: [
          state('s-auto', { objectText: '外门弟子', origin: 'extracted' }),
          state('s-user', { objectText: '掌门亲传', origin: 'user', validFromChapter: 2 }),
        ],
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(result!.states.map((s) => s.object)).toEqual(['掌门亲传']);
  });

  it('线程包全量给出（优先级最高），不参与实体预算', async () => {
    const threads = Array.from({ length: 12 }, (_v, i) =>
      thread(`t${i}`, { description: `线索 ${i}`, openedChapter: i + 1 }),
    );
    const result = await retrieveStoryGraphContext(buildDeps({ entities: [LIN], threads }), {
      projectId: 'p1',
      chapterNumber: 20,
      seedText: '林三',
    });
    expect(result!.openThreads).toHaveLength(12);
    expect(result!.openThreads[0]).toEqual({
      kind: 'foreshadow',
      description: '线索 0',
      promisedPayoff: '揭示玉佩是掌门信物',
      openedChapter: 1,
    });
  });

  it('预算截断：超预算的状态被丢掉，且结果确定（同输入同输出）', async () => {
    const bigEntities = Array.from({ length: 60 }, (_v, i) => ({
      entity: entity(`e${i}`, `人物${i}`, { profileSummary: '档'.repeat(300) }),
      aliases: [] as string[],
    }));
    const states = bigEntities.map((row, i) =>
      state(`s${i}`, { subjectEntityId: row.entity.id, objectText: '状'.repeat(50) }),
    );
    const seedText = bigEntities.map((row) => row.entity.canonicalName).join('，');
    const deps = buildDeps({ entities: bigEntities, states });

    const first = await retrieveStoryGraphContext(deps, {
      projectId: 'p1',
      chapterNumber: 5,
      seedText,
    });
    const second = await retrieveStoryGraphContext(deps, {
      projectId: 'p1',
      chapterNumber: 5,
      seedText,
    });

    expect(first!.entities.length).toBeLessThan(bigEntities.length);
    const charCount =
      first!.entities.reduce((n, e) => n + e.name.length + e.kind.length + e.profile.length, 0) +
      first!.states.reduce(
        (n, s) => n + s.subject.length + s.predicate.length + s.object.length + 8,
        0,
      );
    expect(charCount).toBeLessThanOrEqual(8000);
    expect(second).toEqual(first);
  });

  it('实体档案过长时卡片截断，不把整份档案灌进 prompt', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [
          { entity: entity('e-lin', '林三', { profileSummary: '档'.repeat(500) }), aliases: [] },
        ],
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(result!.entities[0].profile.length).toBeLessThanOrEqual(201);
    expect(result!.entities[0].profile.endsWith('…')).toBe(true);
  });

  it('图为空 → 返回空的结构化对象（不是 null）', async () => {
    const result = await retrieveStoryGraphContext(buildDeps({}), {
      projectId: 'p1',
      chapterNumber: 1,
      seedText: '任意种子',
    });
    expect(result).toEqual({ entities: [], states: [], openThreads: [] });
  });

  it('仓库抛异常 → 返回 null（生成主流程不受阻）', async () => {
    const deps = buildDeps({ entities: [LIN] });
    const broken: StoryGraphRetrievalDeps = {
      ...deps,
      stateRepo: {
        listValidAtChapter: () => {
          throw new Error('DB 炸了');
        },
      } as unknown as StoryGraphRetrievalDeps['stateRepo'],
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await retrieveStoryGraphContext(broken, {
      projectId: 'p1',
      chapterNumber: 5,
      seedText: '林三',
    });
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('向量路降级（D-B23-1/3）', () => {
  it('没配 STORY_GRAPH_EMBED 路由 → 不发嵌入请求，主干两路照常出结果', async () => {
    const invokeEmbedding = vi.fn();
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN],
        states: [state('s1')],
        routed: false,
        invokeEmbedding: invokeEmbedding as unknown as StoryGraphRetrievalDeps['invokeEmbedding'],
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(invokeEmbedding).not.toHaveBeenCalled();
    expect(result!.entities.map((e) => e.name)).toEqual(['林三']);
  });

  it('配了路由但图里没有嵌入行 → 不发请求（没有候选可比）', async () => {
    const invokeEmbedding = vi.fn();
    await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN],
        routed: true,
        embeddings: [],
        invokeEmbedding: invokeEmbedding as unknown as StoryGraphRetrievalDeps['invokeEmbedding'],
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(invokeEmbedding).not.toHaveBeenCalled();
  });

  it('嵌入调用抛异常 → 静默降级为主干两路', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN],
        states: [state('s1')],
        routed: true,
        embeddings: [{ kind: 'entity', refId: 'e-lin', vector: [1, 0] }],
        invokeEmbedding: async () => {
          throw new Error('网关炸了');
        },
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(result).not.toBeNull();
    expect(result!.entities.map((e) => e.name)).toEqual(['林三']);
  });

  it('嵌入返回错误码 → 同样降级，不污染结果', async () => {
    const result = await retrieveStoryGraphContext(
      buildDeps({
        entities: [LIN],
        routed: true,
        embeddings: [{ kind: 'entity', refId: 'e-lin', vector: [1, 0] }],
        invokeEmbedding: async () => ({
          embeddings: [],
          usage: { inputTokens: null, totalTokens: null },
          latencyMs: 1,
          errorCode: 'PROVIDER_RATE_LIMITED' as const,
          errorMessage: '限流',
        }),
      }),
      { projectId: 'p1', chapterNumber: 5, seedText: '林三' },
    );
    expect(result!.entities.map((e) => e.name)).toEqual(['林三']);
  });
});

describe('章号映射（D-B23-5）', () => {
  const slots = [
    { chapterId: 'ch-a', chapterNumber: 1, status: 'active' as const, currentVersionId: 'v1' },
    { chapterId: 'ch-b', chapterNumber: 2, status: 'active' as const, currentVersionId: 'v2' },
  ];
  const chapterQuery = {
    manuscriptRepo: { getActiveByProject: () => ({ id: 'm1' }) },
    chapterRepo: {
      listByManuscript: () =>
        slots.map((slot, index) => ({
          id: slot.chapterId,
          projectId: 'p1',
          manuscriptId: 'm1',
          position: (index + 1) * 1024,
          currentVersionId: slot.currentVersionId,
          status: slot.status,
          createdAt: NOW,
          updatedAt: NOW,
        })),
    },
    chapterVersionRepo: {},
  } as unknown as Parameters<typeof resolveGraphChapterNumber>[0]['chapterQuery'];

  it('已绑定稿件章节 → 取该章 slot 号（重生成同一章）', () => {
    const n = resolveGraphChapterNumber(
      {
        chapterQuery,
        linkRepo: {
          get: () => ({
            projectId: 'p1',
            blueprintChapterId: 'bp-2',
            manuscriptId: 'm1',
            chapterId: 'ch-b',
            createdAt: NOW,
          }),
        } as unknown as Parameters<typeof resolveGraphChapterNumber>[0]['linkRepo'],
      },
      'p1',
      'bp-2',
    );
    expect(n).toBe(2);
  });

  it('未绑定（首次生成）→ max slot + 1', () => {
    const n = resolveGraphChapterNumber(
      {
        chapterQuery,
        linkRepo: { get: () => null } as unknown as Parameters<
          typeof resolveGraphChapterNumber
        >[0]['linkRepo'],
      },
      'p1',
      'bp-new',
    );
    expect(n).toBe(3);
  });
});
