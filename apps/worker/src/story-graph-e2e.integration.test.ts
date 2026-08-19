/**
 * 故事图谱抽取端到端集成测试（D14 / B22 工单二）。
 *
 * 真实 SQLite + 真实仓库 + 脚本化 invokeModel，覆盖：
 * 1. 全链：一章正文 → 六表写入正确（实体/别名/状态边/线程/账本/待审）；
 * 2. 结构非法：整体判失败，图上一行不写（可重试）；
 * 3. 语义无效：逐条丢弃并计数，其余照常落库；
 * 4. 改章重抽：删本章旧边 + 撤回本章核销 + 账本换锚点；
 * 5. 串行序（D-B22-2）：两章 PENDING 只跑章节序最小的那条，结算后接力；
 * 6. 触发点（D-B22-3）：用户显式保存出新版本后自动排队，且防抖不重复排。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase, sha256Utf8 } from '@ai-novel/database';
import {
  createChapter,
  createChapterVersion,
  enqueueStoryGraphExtract,
  getOrCreateManuscript,
  type EnqueueStoryGraphExtractDeps,
  type ProviderProfileRepository,
  type SecretStore,
} from '@ai-novel/application';
import { executeStoryGraphExtract, type StoryGraphExtractEngineDeps } from '@ai-novel/task-engine';
import { TaskRepositoryAdapter, ModelInvocationRepositoryAdapter } from './index.js';
import { dispatchManuscriptCommand, type ManuscriptHandlerContext } from './manuscript-handlers.js';
import { pumpStoryGraphExtract, type StoryGraphPumpDeps } from './story-graph-runner.js';

const NOW = '2026-08-19T00:00:00.000Z';

let tempDir: string;
let dbPath: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

const FAKE_PROFILE = {
  id: 'default-provider',
  providerType: 'anthropic-messages',
  displayName: 'fake',
  baseUrl: 'https://fake.invalid',
  model: 'fake-model',
  keychainService: 'svc',
  keychainAccount: 'acc',
  enabled: true,
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
} as const;

const fakeProviderRepo = {
  getById: () => FAKE_PROFILE,
  list: () => [FAKE_PROFILE],
  getDefault: () => FAKE_PROFILE,
  getRoute: () => null,
  create: () => {},
  update: () => {},
  delete: () => {},
  setDefault: () => {},
  setRoute: () => {},
  deleteRoute: () => {},
  updateTestResult: () => {},
} as unknown as ProviderProfileRepository;

/** 配了 STORY_GRAPH_EMBED 路由的 provider 仓库（openai-chat 协议才有 /embeddings） */
const EMBED_PROFILE = {
  ...FAKE_PROFILE,
  id: 'embed-provider',
  providerType: 'openai-chat',
  model: 'text-embedding-3-small',
} as const;

const embedRoutedProviderRepo = {
  getById: (id: string) => (id === EMBED_PROFILE.id ? EMBED_PROFILE : FAKE_PROFILE),
  list: () => [FAKE_PROFILE, EMBED_PROFILE],
  getDefault: () => FAKE_PROFILE,
  getRoute: (taskType: string) => (taskType === 'STORY_GRAPH_EMBED' ? EMBED_PROFILE.id : null),
  create: () => {},
  update: () => {},
  delete: () => {},
  setDefault: () => {},
  setRoute: () => {},
  deleteRoute: () => {},
  updateTestResult: () => {},
} as unknown as ProviderProfileRepository;

const fakeSecretStore: SecretStore = {
  hasSecret: async () => true,
  setSecret: async () => {},
  getSecret: async () => 'test-key',
  deleteSecret: async () => {},
};

/** 脚本化网关：按调用顺序吐预置的模型输出 */
function fakeInvokeModel(script: string[], capturedPrompts?: string[]) {
  return async (input: { readonly prompt: string }) => {
    capturedPrompts?.push(input.prompt);
    return {
      text: script.shift() ?? '',
      providerRequestId: 'req-1',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 30,
      },
      latencyMs: 5,
      errorCode: null,
      errorMessage: null,
    };
  };
}

/** 可控网关：调用时挂起，测试显式放行——串行断言必须停在"正在跑"的那一刻 */
function gatedInvokeModel(script: string[], gates: Array<{ promise: Promise<void> }>) {
  let call = 0;
  return async () => {
    const gate = gates[call++];
    if (gate) await gate.promise;
    return {
      text: script.shift() ?? '',
      providerRequestId: 'req-1',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 30,
      },
      latencyMs: 5,
      errorCode: null,
      errorMessage: null,
    };
  };
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function openDb(): ProjectDatabase {
  return new ProjectDatabase(dbPath);
}

function mutationDeps(db: ProjectDatabase) {
  return {
    transactionPort: db.getManuscriptTransaction(),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

function chapterQueryDeps(db: ProjectDatabase) {
  return {
    manuscriptRepo: db.getManuscriptRepository(),
    chapterRepo: db.getChapterRepository(),
    chapterVersionRepo: db.getChapterVersionRepository(),
  };
}

function enqueueDeps(db: ProjectDatabase): EnqueueStoryGraphExtractDeps {
  return {
    ...chapterQueryDeps(db),
    taskRepo: new TaskRepositoryAdapter(db),
    extractionRepo: db.getStoryExtractionRepository(),
    idGenerator,
    clock,
    transaction: <T>(fn: () => T) => db.transaction(fn),
  };
}

function engineDeps(db: ProjectDatabase, script: string[]): StoryGraphExtractEngineDeps {
  return {
    taskRepo: new TaskRepositoryAdapter(db),
    invocationRepo: new ModelInvocationRepositoryAdapter(db),
    secretStore: fakeSecretStore,
    providerRepo: fakeProviderRepo,
    idGenerator,
    clock,
    ...chapterQueryDeps(db),
    storyGraph: {
      entityRepo: db.getStoryEntityRepository(),
      stateRepo: db.getStoryStateRepository(),
      threadRepo: db.getStoryThreadRepository(),
      extractionRepo: db.getStoryExtractionRepository(),
      mergeReviewRepo: db.getStoryMergeReviewRepository(),
      graphRepo: db.getStoryGraphRepository(),
      embeddingRepo: db.getStoryEmbeddingRepository(),
      searchRepo: db.getStoryGraphSearch(),
    },
    invokeModel: fakeInvokeModel(script),
    // 默认无嵌入路由：向量层整体关闭（D-B23-3），本文件覆盖的是抽取主链
    invokeEmbedding: async () => ({
      embeddings: [],
      usage: { inputTokens: null, totalTokens: null },
      latencyMs: 0,
      errorCode: 'PROVIDER_NOT_CONFIGURED' as const,
      errorMessage: '测试未接嵌入',
    }),
    transaction: <T>(fn: () => T) => db.transaction(fn),
  };
}

/** 建项目 + 稿件 + 一章正文，返回章节 id */
function seedChapter(db: ProjectDatabase, content: string, chapterId: string): string {
  const deps = mutationDeps(db);
  getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
  createChapter(deps, {
    projectId: 'p1',
    manuscriptId: 'm1',
    insertBeforeChapterId: null,
    now: NOW,
    newChapterId: chapterId,
  });
  createChapterVersion(deps, {
    projectId: 'p1',
    chapterId,
    title: `第 ${chapterId} 章`,
    content,
    expectedCurrentVersionId: null,
    now: NOW,
    newVersionId: `v-${chapterId}-1`,
  });
  return chapterId;
}

const CHAPTER_ONE_TEXT = '青云宗的钟声响起。他还只是外门弟子。他摸了摸怀里的玉佩。';

function extractionJson(input: {
  entities?: unknown[];
  states?: unknown[];
  threadsOpen?: unknown[];
  threadsClose?: unknown[];
  mergeSuspects?: unknown[];
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    entities: input.entities ?? [],
    states: input.states ?? [],
    threads_open: input.threadsOpen ?? [],
    threads_close: input.threadsClose ?? [],
    merge_suspects: input.mergeSuspects ?? [],
  });
}

const CHAPTER_ONE_JSON = extractionJson({
  entities: [
    {
      name: '林三',
      kind: 'character',
      aliases: ['林师兄'],
      profile: '外门弟子，性子谨慎',
      evidence: '他还只是外门弟子。',
    },
    {
      name: '青云宗',
      kind: 'location',
      aliases: [],
      profile: '主角所在的宗门',
      evidence: '青云宗的钟声响起。',
    },
  ],
  states: [
    {
      subject: '林三',
      predicate: '身份',
      object_entity: null,
      object_text: '外门弟子',
      evidence: '他还只是外门弟子。',
      confidence: 0.9,
    },
    {
      subject: '林三',
      predicate: '所在',
      object_entity: '青云宗',
      object_text: null,
      evidence: '青云宗的钟声响起。',
      confidence: null,
    },
  ],
  threadsOpen: [
    {
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promised_payoff: '揭示玉佩是掌门信物',
      evidence: '他摸了摸怀里的玉佩。',
    },
  ],
});

async function runExtraction(script: string[], chapterId: string): Promise<string> {
  const db = openDb();
  let taskId: string;
  try {
    const result = enqueueStoryGraphExtract(enqueueDeps(db), { projectId: 'p1', chapterId });
    if (!result.enqueued) throw new Error(`入队失败: ${result.reason}`);
    taskId = result.taskId;
    await executeStoryGraphExtract(engineDeps(db, script), taskId);
  } finally {
    db.close();
  }
  return taskId;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'story-graph-e2e-'));
  dbPath = join(tempDir, 'project.sqlite');
  idCounter = 0;
  const db = openDb();
  try {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '测试项目',
      initialIdea: '一个修真故事',
      status: 'drafting',
      createdAt: NOW,
      updatedAt: NOW,
    });
  } finally {
    db.close();
  }
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('故事图谱抽取全链（真实 SQLite + 脚本化网关）', () => {
  it('全链：一章正文抽出的实体/别名/状态边/线程/账本全部落库', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const taskId = await runExtraction([CHAPTER_ONE_JSON], 'c1');

    db = openDb();
    try {
      const task = db.getTaskRepository().getById(taskId);
      expect(task?.status).toBe('SUCCEEDED');
      expect(task?.taskType).toBe('STORY_GRAPH_EXTRACT');

      // 模型调用进账本
      const invocations = db.getModelInvocationRepository().listByTask(taskId);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].status).toBe('SUCCEEDED');
      expect(invocations[0].requestKind).toBe('story_graph_extract');

      // 实体 + 别名
      const entityRepo = db.getStoryEntityRepository();
      const lin = entityRepo.findByCanonicalName('p1', '林三');
      expect(lin).not.toBeNull();
      expect(lin?.kind).toBe('character');
      expect(lin?.origin).toBe('extracted');
      expect(lin?.firstChapter).toBe(1);
      expect(entityRepo.listAliases('p1', lin!.id)).toEqual(['林师兄']);
      expect(entityRepo.findByAlias('p1', '林师兄')?.id).toBe(lin!.id);
      const sect = entityRepo.findByCanonicalName('p1', '青云宗');
      expect(sect?.kind).toBe('location');

      // 状态边：文本客体 + 实体客体各一条，都以"仍有效"落库
      const stateRepo = db.getStoryStateRepository();
      const identity = stateRepo.listCurrentBySubjectPredicate('p1', lin!.id, '身份');
      expect(identity).toHaveLength(1);
      expect(identity[0].objectText).toBe('外门弟子');
      expect(identity[0].objectEntityId).toBeNull();
      expect(identity[0].validFromChapter).toBe(1);
      expect(identity[0].validUntilChapter).toBeNull();
      expect(identity[0].sourceChapterId).toBe('c1');
      expect(identity[0].confidence).toBe(0.9);
      expect(identity[0].evidenceSpan).toBe('他还只是外门弟子。');
      const location = stateRepo.listCurrentBySubjectPredicate('p1', lin!.id, '所在');
      expect(location[0].objectEntityId).toBe(sect!.id);
      expect(location[0].objectText).toBeNull();

      // 线程
      const threads = db.getStoryThreadRepository().listOpen('p1');
      expect(threads).toHaveLength(1);
      expect(threads[0].description).toBe('玉佩来历不明');
      expect(threads[0].openedChapter).toBe(1);
      expect(threads[0].promisedPayoff).toBe('揭示玉佩是掌门信物');

      // 账本：锚在真正抽到的那一版
      const ledger = db.getStoryExtractionRepository().getLatestByChapter('p1', 'c1');
      expect(ledger?.status).toBe('succeeded');
      expect(ledger?.sourceVersionId).toBe('v-c1-1');
      expect(ledger?.sourceContentHash).toBe(sha256Utf8(CHAPTER_ONE_TEXT));
      expect(ledger?.taskId).toBe(taskId);

      // 待审队列：本章没有疑似同实体
      expect(db.getStoryMergeReviewRepository().listPending('p1')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('前情登记表进 prompt：已知实体与 open 线程（带 id）都递给模型', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();
    await runExtraction([CHAPTER_ONE_JSON], 'c1');

    // 第二章：prompt 里必须能看到第一章建立的实体与未核销线程
    db = openDb();
    createChapter(mutationDeps(db), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
      title: '第二章',
      content: '林师兄终于踏入内门。',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v-c2-1',
    });
    const threadId = db.getStoryThreadRepository().listOpen('p1')[0].id;
    const prompts: string[] = [];
    const enqueued = enqueueStoryGraphExtract(enqueueDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
    });
    expect(enqueued.enqueued).toBe(true);
    const deps = {
      ...engineDeps(db, []),
      invokeModel: fakeInvokeModel([extractionJson({})], prompts),
    };
    await executeStoryGraphExtract(deps, (enqueued as { taskId: string }).taskId);
    db.close();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('林三');
    expect(prompts[0]).toContain('林师兄');
    expect(prompts[0]).toContain('玉佩来历不明');
    expect(prompts[0]).toContain(threadId);
    expect(prompts[0]).toContain('第 2 章');
  });

  it('结构非法：整体判失败，图上一行不写', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    // states 条目缺 confidence 字段 → 顶层结构合法但条目字段不符
    const broken = JSON.stringify({
      schemaVersion: 1,
      entities: [],
      states: [
        {
          subject: '林三',
          predicate: '身份',
          object_entity: null,
          object_text: '外门弟子',
          evidence: '他还只是外门弟子。',
        },
      ],
      threads_open: [],
      threads_close: [],
      merge_suspects: [],
    });
    const taskId = await runExtraction([broken], 'c1');

    db = openDb();
    try {
      const task = db.getTaskRepository().getById(taskId);
      expect(task?.status).toBe('FAILED');
      expect(task?.errorCode).toBe('MODEL_RESPONSE_INVALID');
      expect(db.getStoryGraphRepository().loadPriorContext('p1').entities).toEqual([]);
      expect(db.getStoryThreadRepository().listOpen('p1')).toEqual([]);
      // 账本不登记失败的抽取（写入事务整体没跑）
      expect(db.getStoryExtractionRepository().getLatestByChapter('p1', 'c1')).toBeNull();
      const invocations = db.getModelInvocationRepository().listByTask(taskId);
      expect(invocations[0].status).toBe('FAILED');
    } finally {
      db.close();
    }
  });

  it('语义无效：核销不存在的线程 / 主体不认识的状态边被丢弃并计数，其余照写', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const mixed = extractionJson({
      entities: [
        {
          name: '林三',
          kind: 'character',
          aliases: [],
          profile: '外门弟子',
          evidence: '他还只是外门弟子。',
        },
      ],
      states: [
        {
          subject: '林三',
          predicate: '身份',
          object_entity: null,
          object_text: '外门弟子',
          evidence: '他还只是外门弟子。',
          confidence: null,
        },
        {
          // 主体既不在前情登记表也不在本次实体清单里 → 丢弃
          subject: '查无此人',
          predicate: '身份',
          object_entity: null,
          object_text: '掌门',
          evidence: '……',
          confidence: null,
        },
        {
          // 客体实体解析不到 → 丢弃
          subject: '林三',
          predicate: '所在',
          object_entity: '不存在的地方',
          object_text: null,
          evidence: '……',
          confidence: null,
        },
      ],
      threadsClose: [{ thread_id: 'thread-does-not-exist', evidence: '……' }],
      mergeSuspects: [{ entity_a: '林三', entity_b: '查无此人', reason: '瞎猜' }],
    });
    const taskId = await runExtraction([mixed], 'c1');

    db = openDb();
    try {
      const task = db.getTaskRepository().getById(taskId);
      expect(task?.status).toBe('SUCCEEDED');
      const summary = JSON.parse(task!.resultJson!) as Record<string, number>;
      expect(summary.droppedStates).toBe(2);
      expect(summary.droppedThreadCloses).toBe(1);
      expect(summary.droppedMergeSuspects).toBe(1);
      expect(summary.statesInserted).toBe(1);

      const lin = db.getStoryEntityRepository().findByCanonicalName('p1', '林三')!;
      expect(
        db.getStoryStateRepository().listCurrentBySubjectPredicate('p1', lin.id, '身份'),
      ).toHaveLength(1);
      expect(
        db.getStoryStateRepository().listCurrentBySubjectPredicate('p1', lin.id, '所在'),
      ).toEqual([]);
      expect(db.getStoryMergeReviewRepository().listPending('p1')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('改章重抽：删本章旧边、账本换锚点，且本章做过的线程核销被撤回', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();
    await runExtraction([CHAPTER_ONE_JSON], 'c1');

    // 第二章：核销第一章开的线程（线程本身来源是 c1，重抽 c2 不该把它删掉）
    db = openDb();
    createChapter(mutationDeps(db), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
      title: '第二章',
      content: '玉佩原来是掌门信物。',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v-c2-1',
    });
    const threadId = db.getStoryThreadRepository().listOpen('p1')[0].id;
    db.close();

    await runExtraction(
      [
        extractionJson({
          states: [
            {
              subject: '林三',
              predicate: '身份',
              object_entity: null,
              object_text: '内门弟子',
              evidence: '他已经是内门弟子。',
              confidence: null,
            },
          ],
          threadsClose: [{ thread_id: threadId, evidence: '玉佩原来是掌门信物。' }],
        }),
      ],
      'c2',
    );

    db = openDb();
    const closed = db.getStoryThreadRepository().getById('p1', threadId);
    expect(closed?.status).toBe('closed');
    expect(closed?.closedChapter).toBe(2);
    const oldC2StateIds = db
      .getStoryStateRepository()
      .listBySourceChapter('p1', 'c2')
      .map((state) => state.id);
    expect(oldC2StateIds.length).toBeGreaterThan(0);
    const lin = db.getStoryEntityRepository().findByCanonicalName('p1', '林三')!;
    // 第一章的"外门弟子"被第二章关闭
    const identityBefore = db
      .getStoryStateRepository()
      .listCurrentBySubjectPredicate('p1', lin.id, '身份');
    expect(identityBefore).toHaveLength(1);
    expect(identityBefore[0].objectText).toBe('内门弟子');

    // 改第二章正文：重抽
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
      title: '第二章（改）',
      content: '玉佩的来历依旧成谜。',
      expectedCurrentVersionId: 'v-c2-1',
      now: NOW,
      newVersionId: 'v-c2-2',
    });
    db.close();

    const taskId = await runExtraction([extractionJson({})], 'c2');

    db = openDb();
    try {
      expect(db.getTaskRepository().getById(taskId)?.status).toBe('SUCCEEDED');

      // 本章来源的旧边被删；第一章的边重新变回当前有效（链接拼接，D-B22-7）
      for (const oldId of oldC2StateIds) {
        expect(db.getStoryStateRepository().getById('p1', oldId)).toBeNull();
      }
      const identityAfter = db
        .getStoryStateRepository()
        .listCurrentBySubjectPredicate('p1', lin.id, '身份');
      expect(identityAfter).toHaveLength(1);
      expect(identityAfter[0].objectText).toBe('外门弟子');
      expect(identityAfter[0].sourceChapterId).toBe('c1');

      // 本章做过的核销被撤回：线程回到 open，且线程本体（来源 c1）没被删
      const reopened = db.getStoryThreadRepository().getById('p1', threadId);
      expect(reopened?.status).toBe('open');
      expect(reopened?.closedChapter).toBeNull();

      // 账本换到新版本
      const ledger = db.getStoryExtractionRepository().getLatestByChapter('p1', 'c2');
      expect(ledger?.sourceVersionId).toBe('v-c2-2');
      expect(ledger?.sourceContentHash).toBe(sha256Utf8('玉佩的来历依旧成谜。'));
    } finally {
      db.close();
    }
  });

  it('实体归并：canonical/别名命中既有实体则追加档案，不新建第二个', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();
    await runExtraction([CHAPTER_ONE_JSON], 'c1');

    db = openDb();
    createChapter(mutationDeps(db), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
      title: '第二章',
      content: '林师兄踏入内门。',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v-c2-1',
    });
    db.close();

    // 第二章只提到别名「林师兄」：必须归并到既有实体
    const secondJson = extractionJson({
      entities: [
        {
          name: '林师兄',
          kind: 'character',
          aliases: [],
          profile: '第二章升入内门',
          evidence: '林师兄踏入内门。',
        },
      ],
    });
    const taskId = await runExtraction([secondJson], 'c2');

    db = openDb();
    try {
      const summary = JSON.parse(db.getTaskRepository().getById(taskId)!.resultJson!) as Record<
        string,
        number
      >;
      expect(summary.entitiesCreated).toBe(0);
      expect(summary.entitiesMerged).toBe(1);
      const registry = db.getStoryGraphRepository().loadPriorContext('p1');
      expect(registry.entities.filter((e) => e.entity.kind === 'character')).toHaveLength(1);
      const lin = db.getStoryEntityRepository().findByCanonicalName('p1', '林三')!;
      expect(lin.profileSummary).toContain('第二章升入内门');
      expect(lin.profileSummary).toContain('外门弟子，性子谨慎');
    } finally {
      db.close();
    }
  });

  it('串行序（D-B22-2）：两章都 PENDING 时只跑章节序最小的，结算后接力跑第二章', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    createChapter(mutationDeps(db), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c2',
      title: '第二章',
      content: '林师兄踏入内门。',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v-c2-1',
    });
    // 故意先排第二章再排第一章：调度必须按章节序而不是入队序
    const second = enqueueStoryGraphExtract(enqueueDeps(db), { projectId: 'p1', chapterId: 'c2' });
    const first = enqueueStoryGraphExtract(enqueueDeps(db), { projectId: 'p1', chapterId: 'c1' });
    expect(second.enqueued && first.enqueued).toBe(true);
    db.close();

    const script = [CHAPTER_ONE_JSON, extractionJson({})];
    const gates = [createGate(), createGate()];
    const invoke = gatedInvokeModel(script, gates);
    const pumpDeps: StoryGraphPumpDeps = {
      openDb: () => openDb(),
      buildEngineDeps: (projDb: ProjectDatabase) => ({
        ...engineDeps(projDb, script),
        invokeModel: invoke,
      }),
      getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
      getInvocationRepo: (projDb: ProjectDatabase) => new ModelInvocationRepositoryAdapter(projDb),
      getChapterQueryDeps: (projDb: ProjectDatabase) => chapterQueryDeps(projDb),
    };

    const firstTaskId = (first as { taskId: string }).taskId;
    const secondTaskId = (second as { taskId: string }).taskId;

    // 先泵一次：必须挑章节序最小的第一章（入队序是反的）
    const pumped = pumpStoryGraphExtract(pumpDeps, 'p1');
    expect(pumped).toEqual({ started: true, taskId: firstTaskId });

    // 等它真正 claim 成 RUNNING，再泵：此时必须 BUSY，第二章一步都不能开始
    await waitForTaskStatus(firstTaskId, 'RUNNING');
    expect(pumpStoryGraphExtract(pumpDeps, 'p1')).toEqual({ started: false, reason: 'BUSY' });
    expect(await taskStatus(secondTaskId)).toBe('PENDING');

    // 放行第一章 → 结算后自动接力第二章
    gates[0].release();
    await waitForTaskStatus(secondTaskId, 'RUNNING');
    expect(await taskStatus(firstTaskId)).toBe('SUCCEEDED');
    gates[1].release();
    await waitForTaskTerminal(secondTaskId);

    db = openDb();
    try {
      expect(db.getTaskRepository().getById(firstTaskId)?.status).toBe('SUCCEEDED');
      // 接力：第一条结算后第二条自动开跑并跑完
      expect(db.getTaskRepository().getById(secondTaskId)?.status).toBe('SUCCEEDED');
      const ledgerOne = db.getStoryExtractionRepository().getLatestByChapter('p1', 'c1');
      const ledgerTwo = db.getStoryExtractionRepository().getLatestByChapter('p1', 'c2');
      expect(ledgerOne?.status).toBe('succeeded');
      expect(ledgerTwo?.status).toBe('succeeded');
    } finally {
      db.close();
    }
  });

  it('触发点（D-B22-3）：显式保存出新版本后自动排队，同 hash 不重复排', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const enqueuedChapters: string[] = [];
    const ctx: ManuscriptHandlerContext = {
      getProjectDb: () => openDb(),
      idGenerator,
      clock,
      onChapterVersionCommitted: (projectId: string, chapterId: string) => {
        const hookDb = openDb();
        try {
          const result = enqueueStoryGraphExtract(enqueueDeps(hookDb), { projectId, chapterId });
          if (result.enqueued) enqueuedChapters.push(chapterId);
        } finally {
          hookDb.close();
        }
      },
    };

    dispatchManuscriptCommand(
      'manuscript.saveChapter',
      {
        projectId: 'p1',
        chapterId: 'c1',
        title: '第一章',
        content: '林三握紧了那枚玉佩。',
        expectedCurrentVersionId: 'v-c1-1',
      },
      ctx,
    );
    expect(enqueuedChapters).toEqual(['c1']);

    db = openDb();
    try {
      const pending = db
        .getTaskRepository()
        .listByStatus('PENDING')
        .filter((t) => t.taskType === 'STORY_GRAPH_EXTRACT');
      expect(pending).toHaveLength(1);
      // 同 hash 再排一次：防抖跳过
      const again = enqueueStoryGraphExtract(enqueueDeps(db), {
        projectId: 'p1',
        chapterId: 'c1',
      });
      expect(again).toEqual({ enqueued: false, reason: 'ALREADY_QUEUED' });
    } finally {
      db.close();
    }
  });
});

async function taskStatus(taskId: string): Promise<string | undefined> {
  const db = openDb();
  try {
    return db.getTaskRepository().getById(taskId)?.status;
  } finally {
    db.close();
  }
}

/** 轮询等待任务到达指定状态 */
async function waitForTaskStatus(
  taskId: string,
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await taskStatus(taskId);
    if (status === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 未在超时前到达 ${expected}（当前 ${status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 轮询等待任务进入终态（后台 runner 是异步的） */
async function waitForTaskTerminal(taskId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const db = openDb();
    let status: string | undefined;
    try {
      status = db.getTaskRepository().getById(taskId)?.status;
    } finally {
      db.close();
    }
    if (status && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'].includes(status)) return;
    if (Date.now() > deadline)
      throw new Error(`任务 ${taskId} 未在超时前进入终态（当前 ${status}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('抽取后置嵌入（D-B23-4：best-effort，永不失败任务）', () => {
  async function runWithEmbedding(
    overrides: Partial<StoryGraphExtractEngineDeps>,
    chapterId = 'c1',
  ): Promise<{ taskId: string; summary: Record<string, unknown> }> {
    const db = openDb();
    let taskId: string;
    try {
      const enqueued = enqueueStoryGraphExtract(enqueueDeps(db), { projectId: 'p1', chapterId });
      if (!enqueued.enqueued) throw new Error(`入队失败: ${enqueued.reason}`);
      taskId = enqueued.taskId;
      await executeStoryGraphExtract(
        { ...engineDeps(db, [CHAPTER_ONE_JSON]), ...overrides },
        taskId,
      );
      const task = db.getTaskRepository().getById(taskId)!;
      expect(task.status).toBe('SUCCEEDED');
      return { taskId, summary: JSON.parse(task.resultJson!) as Record<string, unknown> };
    } finally {
      db.close();
    }
  }

  /** 固定维度的假嵌入：向量内容不重要，重要的是条数与写入路径 */
  function fakeEmbedGateway(calls: string[][] = []) {
    return async (input: { input: ReadonlyArray<string> }) => {
      calls.push([...input.input]);
      return {
        embeddings: input.input.map((_text, index) => [index + 1, 0.5]),
        usage: { inputTokens: 10, totalTokens: 10 },
        latencyMs: 3,
        errorCode: null,
        errorMessage: null,
      };
    };
  }

  it('没配 STORY_GRAPH_EMBED 路由 → 整层跳过，图照常写入', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const { summary } = await runWithEmbedding({});

    expect(summary.embeddingSkipped).toBe('NO_ROUTE');
    expect(summary.embeddedRows).toBe(0);
    db = openDb();
    try {
      // 主干不受影响：实体/状态/FTS 都在
      expect(db.getStoryEntityRepository().findByCanonicalName('p1', '林三')).not.toBeNull();
      expect(db.getStoryEmbeddingRepository().listAll('p1')).toEqual([]);
      expect(db.getStoryGraphSearch().searchFts('p1', '外门弟子').length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('配了路由 → 本次新增行全部落嵌入，且记进 model_invocations', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const batches: string[][] = [];
    const { taskId, summary } = await runWithEmbedding({
      providerRepo: embedRoutedProviderRepo,
      invokeEmbedding: fakeEmbedGateway(batches),
    });

    expect(summary.embeddingSkipped).toBeNull();
    // 2 实体 + 2 状态边 + 1 线程
    expect(summary.embeddedRows).toBe(5);
    expect(summary.embedFailed).toBe(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);

    db = openDb();
    try {
      const embeddings = db.getStoryEmbeddingRepository().listAll('p1');
      expect(embeddings).toHaveLength(5);
      expect(embeddings.every((e) => e.model === 'text-embedding-3-small')).toBe(true);
      expect(embeddings.every((e) => e.dims === 2)).toBe(true);
      expect(new Set(embeddings.map((e) => e.kind))).toEqual(
        new Set(['entity', 'state', 'thread']),
      );

      // 嵌入调用挂在同一个 task 下，attempt_number 不与抽取调用撞车
      const invocations = db.getModelInvocationRepository().listByTask(taskId);
      expect(invocations.map((i) => i.requestKind).sort()).toEqual([
        'story_graph_embed',
        'story_graph_extract',
      ]);
      const embedInvocation = invocations.find((i) => i.requestKind === 'story_graph_embed')!;
      expect(embedInvocation.status).toBe('SUCCEEDED');
      expect(embedInvocation.model).toBe('text-embedding-3-small');
      expect(new Set(invocations.map((i) => i.attemptNumber)).size).toBe(invocations.length);
    } finally {
      db.close();
    }
  });

  it('改章重抽：旧行的嵌入随行清掉，新行重新嵌入（不留孤儿）', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();
    await runWithEmbedding({
      providerRepo: embedRoutedProviderRepo,
      invokeEmbedding: fakeEmbedGateway(),
    });

    db = openDb();
    const firstRoundRefs = new Set(
      db
        .getStoryEmbeddingRepository()
        .listAll('p1')
        .map((e) => e.refId),
    );
    expect(firstRoundRefs.size).toBe(5);
    createChapterVersion(mutationDeps(db), {
      projectId: 'p1',
      chapterId: 'c1',
      title: '第一章（改）',
      content: '青云宗的钟声响起。他已经是内门弟子。',
      expectedCurrentVersionId: 'v-c1-1',
      now: NOW,
      newVersionId: 'v-c1-2',
    });
    db.close();

    const batches: string[][] = [];
    const { summary } = await runWithEmbedding({
      providerRepo: embedRoutedProviderRepo,
      invokeEmbedding: fakeEmbedGateway(batches),
    });

    db = openDb();
    try {
      const embeddings = db.getStoryEmbeddingRepository().listAll('p1');
      // 本次实际发出的嵌入条数 = 指纹变化的行数，账要对得上
      expect(batches.reduce((n, b) => n + b.length, 0)).toBe(summary.embeddedRows);
      expect(summary.embedFailed).toBe(0);

      // 旧状态边/线程行已被删除，它们的嵌入不许留下来变孤儿
      const liveStateIds = new Set(
        db
          .getStoryStateRepository()
          .listBySourceChapter('p1', 'c1')
          .map((state) => state.id),
      );
      for (const embedding of embeddings) {
        if (embedding.kind === 'state') expect(liveStateIds.has(embedding.refId)).toBe(true);
      }
      const liveThreadIds = new Set(
        db
          .getStoryThreadRepository()
          .listOpen('p1')
          .map((t) => t.id),
      );
      for (const embedding of embeddings) {
        if (embedding.kind === 'thread') expect(liveThreadIds.has(embedding.refId)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('嵌入调用失败 → 只计数，任务照样 SUCCEEDED，图不回滚', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const { taskId, summary } = await runWithEmbedding({
      providerRepo: embedRoutedProviderRepo,
      invokeEmbedding: async () => ({
        embeddings: [],
        usage: { inputTokens: null, totalTokens: null },
        latencyMs: 7,
        errorCode: 'PROVIDER_RATE_LIMITED' as const,
        errorMessage: '请求频率超限',
      }),
    });

    expect(summary.embedFailed).toBe(5);
    expect(summary.embeddedRows).toBe(0);
    expect(summary.embeddingSkipped).toBeNull();

    db = openDb();
    try {
      expect(db.getTaskRepository().getById(taskId)?.status).toBe('SUCCEEDED');
      expect(db.getStoryEmbeddingRepository().listAll('p1')).toEqual([]);
      // 图与 FTS 主干完好
      expect(db.getStoryEntityRepository().findByCanonicalName('p1', '林三')).not.toBeNull();
      expect(db.getStoryGraphSearch().searchFts('p1', '外门弟子').length).toBeGreaterThan(0);
      const embedInvocation = db
        .getModelInvocationRepository()
        .listByTask(taskId)
        .find((i) => i.requestKind === 'story_graph_embed')!;
      expect(embedInvocation.status).toBe('FAILED');
      expect(embedInvocation.errorCode).toBe('PROVIDER_RATE_LIMITED');
    } finally {
      db.close();
    }
  });

  it('嵌入网关抛异常也只计数（best-effort 的边界是"不传播"）', async () => {
    let db = openDb();
    seedChapter(db, CHAPTER_ONE_TEXT, 'c1');
    db.close();

    const { taskId, summary } = await runWithEmbedding({
      providerRepo: embedRoutedProviderRepo,
      invokeEmbedding: async () => {
        throw new Error('网关炸了');
      },
    });

    expect(summary.embedFailed).toBe(5);
    db = openDb();
    try {
      expect(db.getTaskRepository().getById(taskId)?.status).toBe('SUCCEEDED');
    } finally {
      db.close();
    }
  });
});
