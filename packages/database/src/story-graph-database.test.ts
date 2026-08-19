/**
 * 故事图谱仓库测试（D14 / B22，migration v22）。
 *
 * 关键路径逐个方法覆盖之外，三条纪律各有独立断言：
 * - append-only（D-B22-1）：关闭旧边只改 valid_until_chapter / superseded_by_id，
 *   事实列一字不动；
 * - 档案截断（D-B22-5）：超 2000 字符丢最旧段落、最新描述必留；
 * - 清空保留 user 层（D-B22-4 / D-B22-6）：定向失效与全项目重建都不碰 origin='user'。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';
import {
  appendProfileSummaryText,
  STORY_ENTITY_PROFILE_SUMMARY_LIMIT,
} from './story-graph-repositories.js';
import type { CreateStoryStateData } from './types.js';

const NOW = '2026-08-19T00:00:00.000Z';
const LATER = '2026-08-19T01:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

interface Ctx {
  dir: string;
  db: ProjectDatabase;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'story-graph-repo-'));
  const db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { dir, db };
}

function seedEntity(ctx: Ctx, id: string, canonicalName: string, firstChapter = 1): void {
  ctx.db.getStoryEntityRepository().create({
    id,
    projectId: 'p1',
    kind: 'character',
    canonicalName,
    profileSummary: `${canonicalName}首次出场`,
    firstChapter,
    origin: 'extracted',
    createdAt: NOW,
  });
}

function stateInput(
  overrides: Partial<CreateStoryStateData> & { id: string },
): CreateStoryStateData {
  return {
    projectId: 'p1',
    subjectEntityId: 'e-lin',
    predicate: '身份',
    objectEntityId: null,
    objectText: '外门弟子',
    validFromChapter: 1,
    sourceChapterId: 'c1',
    sourceContentHash: HASH_A,
    evidenceSpan: '他还只是外门弟子。',
    confidence: 0.9,
    origin: 'extracted',
    createdAt: NOW,
    ...overrides,
  };
}

describe('故事图谱仓库', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      // 测试内已关闭时忽略
    }
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  // ── 实体 ────────────────────────────────────────────────────────

  it('实体：canonical_name 与别名都能精确命中，未命中返回 null', () => {
    const repo = ctx.db.getStoryEntityRepository();
    seedEntity(ctx, 'e-lin', '林三');
    expect(
      repo.addAlias({
        id: 'a1',
        projectId: 'p1',
        entityId: 'e-lin',
        alias: '林师兄',
        origin: 'extracted',
        createdAt: NOW,
      }),
    ).toBe(true);

    expect(repo.findByCanonicalName('p1', '林三')?.id).toBe('e-lin');
    expect(repo.findByAlias('p1', '林师兄')?.id).toBe('e-lin');
    expect(repo.findByNameOrAlias('p1', '林师兄')?.id).toBe('e-lin');
    expect(repo.findByNameOrAlias('p1', '陌生人')).toBeNull();
    expect(repo.listAliases('p1', 'e-lin')).toEqual(['林师兄']);
  });

  it('实体：同 (别名, 实体) 重复登记幂等，不产生第二行', () => {
    const repo = ctx.db.getStoryEntityRepository();
    seedEntity(ctx, 'e-lin', '林三');
    const alias = {
      id: 'a1',
      projectId: 'p1',
      entityId: 'e-lin',
      alias: '林师兄',
      origin: 'extracted' as const,
      createdAt: NOW,
    };
    expect(repo.addAlias(alias)).toBe(true);
    expect(repo.addAlias({ ...alias, id: 'a2' })).toBe(false);
    expect(repo.listAliases('p1', 'e-lin')).toEqual(['林师兄']);
  });

  it('纪律：档案追加超 2000 字符丢最旧段落，最新描述必留', () => {
    const repo = ctx.db.getStoryEntityRepository();
    seedEntity(ctx, 'e-lin', '林三');
    const oldest = '旧'.repeat(900);
    const middle = '中'.repeat(900);
    const newest = '新'.repeat(900);

    expect(repo.appendProfileSummary('p1', 'e-lin', oldest, LATER)).toBe(true);
    repo.appendProfileSummary('p1', 'e-lin', middle, LATER);
    repo.appendProfileSummary('p1', 'e-lin', newest, LATER);

    const summary = repo.getById('p1', 'e-lin')?.profileSummary ?? '';
    expect(summary.length).toBeLessThanOrEqual(STORY_ENTITY_PROFILE_SUMMARY_LIMIT);
    expect(summary.endsWith(newest)).toBe(true);
    expect(summary).toContain(middle);
    expect(summary).not.toContain(oldest);
    // 首次出场那段（最旧）也已被挤出
    expect(summary).not.toContain('林三首次出场');
  });

  it('档案追加：单段自身超限时整段保留，不做句中切断', () => {
    const huge = '长'.repeat(STORY_ENTITY_PROFILE_SUMMARY_LIMIT + 500);
    const merged = appendProfileSummaryText('旧段落', huge);
    expect(merged).toBe(huge);
  });

  // ── 状态边 ──────────────────────────────────────────────────────

  it('状态边：插入后即为当前有效边，按 subject+predicate 查得到', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(stateInput({ id: 's1' }));

    const current = states.listCurrentBySubjectPredicate('p1', 'e-lin', '身份');
    expect(current.map((s) => s.id)).toEqual(['s1']);
    expect(current[0]?.validUntilChapter).toBeNull();
    expect(current[0]?.supersededById).toBeNull();
    expect(current[0]?.confidence).toBe(0.9);
  });

  it('纪律：append-only —— 关闭旧边只动两列，事实列一字不动', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(stateInput({ id: 's1' }));
    const before = states.getById('p1', 's1');

    states.insert(
      stateInput({
        id: 's2',
        objectText: '内门弟子',
        validFromChapter: 5,
        sourceChapterId: 'c5',
        sourceContentHash: HASH_B,
      }),
    );
    expect(states.supersede('p1', 's1', 5, 's2')).toBe(true);

    const after = states.getById('p1', 's1');
    expect(after?.validUntilChapter).toBe(5);
    expect(after?.supersededById).toBe('s2');
    // 事实列逐个比对：关闭动作不许改写历史
    expect(after?.predicate).toBe(before?.predicate);
    expect(after?.objectText).toBe(before?.objectText);
    expect(after?.validFromChapter).toBe(before?.validFromChapter);
    expect(after?.sourceChapterId).toBe(before?.sourceChapterId);
    expect(after?.sourceContentHash).toBe(before?.sourceContentHash);
    expect(after?.evidenceSpan).toBe(before?.evidenceSpan);
    expect(after?.confidence).toBe(before?.confidence);
    expect(after?.createdAt).toBe(before?.createdAt);

    // 关闭后不再是当前有效边，新边是
    expect(states.listCurrentBySubjectPredicate('p1', 'e-lin', '身份').map((s) => s.id)).toEqual([
      's2',
    ]);
    // 重复关闭无效（幂等守卫）
    expect(states.supersede('p1', 's1', 6, 's2')).toBe(false);
  });

  it('纪律：user 覆盖层的边不会被自动抽取关闭，也不进 extracted 当前边清单', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(
      stateInput({
        id: 's-user',
        origin: 'user',
        sourceChapterId: null,
        sourceContentHash: null,
        objectText: '真身是掌门',
      }),
    );
    states.insert(stateInput({ id: 's-auto' }));

    expect(states.listCurrentBySubjectPredicate('p1', 'e-lin', '身份').map((s) => s.id)).toEqual([
      's-auto',
    ]);
    expect(states.supersede('p1', 's-user', 9, 's-auto')).toBe(false);
    expect(states.getById('p1', 's-user')?.validUntilChapter).toBeNull();
  });

  it('纪律：失效清理只删本章边，下游边留存、前驱边拼接到它（D-B22-7）', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    // c1 开边 → c5 关闭它并开新边 → c9 再关闭 c5 的边并开新边
    states.insert(stateInput({ id: 's1' }));
    states.insert(
      stateInput({ id: 's5', validFromChapter: 5, sourceChapterId: 'c5', objectText: '内门弟子' }),
    );
    states.supersede('p1', 's1', 5, 's5');
    states.insert(
      stateInput({ id: 's9', validFromChapter: 9, sourceChapterId: 'c9', objectText: '真传弟子' }),
    );
    states.supersede('p1', 's5', 9, 's9');

    // 重抽 c5：只删 s5；s9 锚定在未改动的第 9 章正文上，必须留着
    expect(states.deleteExtractedBySourceChapter('p1', 'c5')).toBe(1);
    expect(states.getById('p1', 's5')).toBeNull();
    expect(states.getById('p1', 's9')).not.toBeNull();

    // s1 越过被删的 s5 直接接到 s9
    const s1 = states.getById('p1', 's1');
    expect(s1?.supersededById).toBe('s9');
    expect(s1?.validUntilChapter).toBe(9);
    expect(states.listCurrentBySubjectPredicate('p1', 'e-lin', '身份').map((s) => s.id)).toEqual([
      's9',
    ]);
  });

  it('失效清理：同章连环改动（A→B1→B2→C）拼接后 A 指向 C，valid_until 取 C 的 valid_from', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(stateInput({ id: 'a', validFromChapter: 1, sourceChapterId: 'c1' }));
    // 第 5 章内状态变了两次：b1、b2 同属待删集合
    states.insert(
      stateInput({ id: 'b1', validFromChapter: 5, sourceChapterId: 'c5', objectText: '内门弟子' }),
    );
    states.supersede('p1', 'a', 5, 'b1');
    states.insert(
      stateInput({ id: 'b2', validFromChapter: 5, sourceChapterId: 'c5', objectText: '记名弟子' }),
    );
    states.supersede('p1', 'b1', 5, 'b2');
    states.insert(
      stateInput({ id: 'c', validFromChapter: 9, sourceChapterId: 'c9', objectText: '真传弟子' }),
    );
    states.supersede('p1', 'b2', 9, 'c');

    expect(states.deleteExtractedBySourceChapter('p1', 'c5')).toBe(2);
    expect(states.getById('p1', 'b1')).toBeNull();
    expect(states.getById('p1', 'b2')).toBeNull();

    const a = states.getById('p1', 'a');
    expect(a?.supersededById).toBe('c');
    expect(a?.validUntilChapter).toBe(states.getById('p1', 'c')?.validFromChapter);
    expect(a?.validUntilChapter).toBe(9);
  });

  it('失效清理：被删边仍开着时，前驱边就此重开', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(stateInput({ id: 'a', validFromChapter: 1, sourceChapterId: 'c1' }));
    states.insert(
      stateInput({ id: 'b', validFromChapter: 5, sourceChapterId: 'c5', objectText: '内门弟子' }),
    );
    states.supersede('p1', 'a', 5, 'b');
    expect(states.getById('p1', 'b')?.validUntilChapter).toBeNull();

    expect(states.deleteExtractedBySourceChapter('p1', 'c5')).toBe(1);
    const a = states.getById('p1', 'a');
    expect(a?.supersededById).toBeNull();
    expect(a?.validUntilChapter).toBeNull();
    expect(states.listCurrentBySubjectPredicate('p1', 'e-lin', '身份').map((s) => s.id)).toEqual([
      'a',
    ]);
  });

  it('失效清理：同章的 user 边不被删除', () => {
    const states = ctx.db.getStoryStateRepository();
    seedEntity(ctx, 'e-lin', '林三');
    states.insert(stateInput({ id: 's-auto' }));
    states.insert(
      stateInput({
        id: 's-user',
        origin: 'user',
        predicate: '外貌',
        objectText: '左眉有疤',
        sourceChapterId: 'c1',
        sourceContentHash: null,
      }),
    );

    expect(states.deleteExtractedBySourceChapter('p1', 'c1')).toBe(1);
    expect(states.getById('p1', 's-auto')).toBeNull();
    expect(states.getById('p1', 's-user')).not.toBeNull();
  });

  // ── 线程 ────────────────────────────────────────────────────────

  it('线程：开启、按 id/描述查 open、核销、重开', () => {
    const threads = ctx.db.getStoryThreadRepository();
    threads.open({
      id: 't1',
      projectId: 'p1',
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promisedPayoff: '揭示玉佩是掌门信物',
      openedChapter: 2,
      sourceChapterId: 'c2',
      sourceContentHash: HASH_A,
      evidenceSpan: '他摸了摸怀里的玉佩。',
      origin: 'extracted',
      createdAt: NOW,
    });

    expect(threads.getById('p1', 't1')?.status).toBe('open');
    expect(threads.findOpenByDescription('p1', '玉佩来历不明')?.id).toBe('t1');
    expect(threads.listOpen('p1').map((t) => t.id)).toEqual(['t1']);

    expect(threads.close('p1', 't1', 7, LATER)).toBe(true);
    const closed = threads.getById('p1', 't1');
    expect(closed?.status).toBe('closed');
    expect(closed?.closedChapter).toBe(7);
    expect(threads.listOpen('p1')).toEqual([]);
    expect(threads.findOpenByDescription('p1', '玉佩来历不明')).toBeNull();
    // 重复核销无效
    expect(threads.close('p1', 't1', 8, LATER)).toBe(false);

    // 重抽第 7 章：该章的核销被撤回
    expect(threads.reopenClosedAtChapter('p1', 7, LATER)).toBe(1);
    expect(threads.getById('p1', 't1')?.status).toBe('open');
    expect(threads.getById('p1', 't1')?.closedChapter).toBeNull();
  });

  it('线程失效清理：删除该章开启的抽取线程，user 线程保留', () => {
    const threads = ctx.db.getStoryThreadRepository();
    threads.open({
      id: 't-auto',
      projectId: 'p1',
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promisedPayoff: null,
      openedChapter: 2,
      sourceChapterId: 'c2',
      sourceContentHash: HASH_A,
      evidenceSpan: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    threads.open({
      id: 't-user',
      projectId: 'p1',
      kind: 'promise',
      description: '师父的承诺',
      promisedPayoff: null,
      openedChapter: 2,
      sourceChapterId: 'c2',
      sourceContentHash: null,
      evidenceSpan: null,
      origin: 'user',
      createdAt: NOW,
    });

    expect(threads.deleteExtractedBySourceChapter('p1', 'c2')).toBe(1);
    expect(threads.getById('p1', 't-auto')).toBeNull();
    expect(threads.getById('p1', 't-user')).not.toBeNull();
  });

  // ── 抽取账本 ────────────────────────────────────────────────────

  it('抽取账本：登记、按章取最新、按章删除', () => {
    const ledger = ctx.db.getStoryExtractionRepository();
    ledger.register({
      id: 'x1',
      projectId: 'p1',
      chapterId: 'c1',
      sourceVersionId: 'v1',
      sourceContentHash: HASH_A,
      taskId: 't-graph-1',
      status: 'succeeded',
      extractedAt: NOW,
    });
    ledger.register({
      id: 'x2',
      projectId: 'p1',
      chapterId: 'c1',
      sourceVersionId: 'v2',
      sourceContentHash: HASH_B,
      taskId: 't-graph-2',
      status: 'succeeded',
      extractedAt: LATER,
    });
    ledger.register({
      id: 'x3',
      projectId: 'p1',
      chapterId: 'c2',
      sourceVersionId: 'v3',
      sourceContentHash: HASH_A,
      taskId: null,
      status: 'failed',
      extractedAt: LATER,
    });

    const latest = ledger.getLatestByChapter('p1', 'c1');
    expect(latest?.id).toBe('x2');
    expect(latest?.sourceContentHash).toBe(HASH_B);
    expect(ledger.getLatestByChapter('p1', '不存在的章')).toBeNull();

    expect(ledger.deleteByChapter('p1', 'c1')).toBe(2);
    expect(ledger.getLatestByChapter('p1', 'c1')).toBeNull();
    expect(ledger.getLatestByChapter('p1', 'c2')?.id).toBe('x3');
  });

  // ── 待审队列 ────────────────────────────────────────────────────

  it('待审队列：插入 pending，同一对实体重复怀疑幂等', () => {
    const reviews = ctx.db.getStoryMergeReviewRepository();
    seedEntity(ctx, 'e-lin', '林三');
    seedEntity(ctx, 'e-shadow', '黑衣人');

    expect(
      reviews.insertPending({
        id: 'r1',
        projectId: 'p1',
        entityAId: 'e-lin',
        entityBId: 'e-shadow',
        suggestedReason: '第 9 章暗示两者同一人',
        createdAt: NOW,
      }),
    ).toBe(true);
    expect(
      reviews.insertPending({
        id: 'r2',
        projectId: 'p1',
        entityAId: 'e-lin',
        entityBId: 'e-shadow',
        suggestedReason: '第 11 章再次暗示',
        createdAt: LATER,
      }),
    ).toBe(false);

    const pending = reviews.listPending('p1');
    expect(pending.map((r) => r.id)).toEqual(['r1']);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.decidedAt).toBeNull();
  });

  // ── 前情登记表 + 回填清空 ───────────────────────────────────────

  it('前情登记表：一次拿到全项目实体（含别名）与 open 线程', () => {
    const entities = ctx.db.getStoryEntityRepository();
    const threads = ctx.db.getStoryThreadRepository();
    seedEntity(ctx, 'e-lin', '林三');
    seedEntity(ctx, 'e-mei', '苏梅', 3);
    entities.addAlias({
      id: 'a1',
      projectId: 'p1',
      entityId: 'e-lin',
      alias: '林师兄',
      origin: 'extracted',
      createdAt: NOW,
    });
    entities.addAlias({
      id: 'a2',
      projectId: 'p1',
      entityId: 'e-lin',
      alias: '三郎',
      origin: 'user',
      createdAt: LATER,
    });
    threads.open({
      id: 't-open',
      projectId: 'p1',
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promisedPayoff: null,
      openedChapter: 2,
      sourceChapterId: 'c2',
      sourceContentHash: HASH_A,
      evidenceSpan: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    threads.open({
      id: 't-closed',
      projectId: 'p1',
      kind: 'mystery',
      description: '谁在追杀他',
      promisedPayoff: null,
      openedChapter: 1,
      sourceChapterId: 'c1',
      sourceContentHash: HASH_A,
      evidenceSpan: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    threads.close('p1', 't-closed', 4, LATER);

    const context = ctx.db.getStoryGraphRepository().loadPriorContext('p1');
    expect(context.entities.map((e) => e.entity.canonicalName)).toEqual(['林三', '苏梅']);
    expect(context.entities[0]?.aliases).toEqual(['林师兄', '三郎']);
    expect(context.entities[1]?.aliases).toEqual([]);
    expect(context.openThreads.map((t) => t.id)).toEqual(['t-open']);
  });

  it('纪律：回填清空只清 extracted 层，origin=user 记录原样保留', () => {
    const entities = ctx.db.getStoryEntityRepository();
    const states = ctx.db.getStoryStateRepository();
    const threads = ctx.db.getStoryThreadRepository();
    const ledger = ctx.db.getStoryExtractionRepository();
    const reviews = ctx.db.getStoryMergeReviewRepository();
    const graph = ctx.db.getStoryGraphRepository();

    seedEntity(ctx, 'e-lin', '林三');
    seedEntity(ctx, 'e-shadow', '黑衣人');
    entities.create({
      id: 'e-user',
      projectId: 'p1',
      kind: 'location',
      canonicalName: '青云宗',
      profileSummary: '我手写的设定',
      firstChapter: null,
      origin: 'user',
      createdAt: NOW,
    });
    entities.addAlias({
      id: 'a-auto',
      projectId: 'p1',
      entityId: 'e-lin',
      alias: '林师兄',
      origin: 'extracted',
      createdAt: NOW,
    });
    entities.addAlias({
      id: 'a-user',
      projectId: 'p1',
      entityId: 'e-user',
      alias: '宗门',
      origin: 'user',
      createdAt: NOW,
    });
    states.insert(stateInput({ id: 's-auto' }));
    states.insert(
      stateInput({
        id: 's-user',
        subjectEntityId: 'e-user',
        predicate: '所在',
        objectText: '东境',
        origin: 'user',
        sourceChapterId: null,
        sourceContentHash: null,
      }),
    );
    threads.open({
      id: 't-auto',
      projectId: 'p1',
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promisedPayoff: null,
      openedChapter: 2,
      sourceChapterId: 'c2',
      sourceContentHash: HASH_A,
      evidenceSpan: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    threads.open({
      id: 't-user',
      projectId: 'p1',
      kind: 'promise',
      description: '我自己记的线索',
      promisedPayoff: null,
      openedChapter: 1,
      sourceChapterId: null,
      sourceContentHash: null,
      evidenceSpan: null,
      origin: 'user',
      createdAt: NOW,
    });
    ledger.register({
      id: 'x1',
      projectId: 'p1',
      chapterId: 'c1',
      sourceVersionId: 'v1',
      sourceContentHash: HASH_A,
      taskId: 't-graph-1',
      status: 'succeeded',
      extractedAt: NOW,
    });
    reviews.insertPending({
      id: 'r1',
      projectId: 'p1',
      entityAId: 'e-lin',
      entityBId: 'e-shadow',
      suggestedReason: '疑似同一人',
      createdAt: NOW,
    });

    const cleared = graph.clearExtracted('p1');
    expect(cleared).toEqual({
      states: 1,
      threads: 1,
      aliases: 1,
      entities: 2,
      extractions: 1,
      mergeReviews: 1,
    });

    // extracted 层清空
    expect(states.getById('p1', 's-auto')).toBeNull();
    expect(threads.getById('p1', 't-auto')).toBeNull();
    expect(entities.getById('p1', 'e-lin')).toBeNull();
    expect(entities.getById('p1', 'e-shadow')).toBeNull();
    expect(ledger.getLatestByChapter('p1', 'c1')).toBeNull();
    expect(reviews.listPending('p1')).toEqual([]);

    // user 覆盖层完好
    const userEntity = entities.getById('p1', 'e-user');
    expect(userEntity?.profileSummary).toBe('我手写的设定');
    expect(entities.listAliases('p1', 'e-user')).toEqual(['宗门']);
    expect(states.getById('p1', 's-user')?.objectText).toBe('东境');
    expect(threads.getById('p1', 't-user')?.status).toBe('open');
  });
});
