/**
 * 图检索地基测试（D14 / B23 工单一）。
 *
 * - FTS 显式同步（D-B23-8）：插边/删边/线程开关/实体档案与别名变更各自维护索引行；
 * - MATCH 注入防线：任何模型/用户文本都不许把 fts5 查询语法带进来（会抛异常）；
 * - 嵌入存取：upsert 幂等、content_hash 判断重算、行删了嵌入随行清理。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cosineTopK, deserializeEmbedding, serializeEmbedding } from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { buildFtsMatchQuery } from './story-graph-repositories.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

const NOW = '2026-08-19T00:00:00.000Z';
const HASH = 'a'.repeat(64);

let dir: string;
let db: ProjectDatabase;

function seedEntity(id: string, canonicalName: string, profile = '外门弟子出身'): void {
  db.getStoryEntityRepository().create({
    id,
    projectId: 'p1',
    kind: 'character',
    canonicalName,
    profileSummary: profile,
    firstChapter: 1,
    origin: 'extracted',
    createdAt: NOW,
  });
}

function insertState(id: string, overrides: Record<string, unknown> = {}): void {
  db.getStoryStateRepository().insert({
    id,
    projectId: 'p1',
    subjectEntityId: 'e-lin',
    predicate: '身份',
    objectEntityId: null,
    objectText: '青云宗外门弟子',
    validFromChapter: 1,
    sourceChapterId: 'c1',
    sourceContentHash: HASH,
    evidenceSpan: '他还只是外门弟子。',
    confidence: null,
    origin: 'extracted',
    createdAt: NOW,
    ...overrides,
  } as Parameters<ReturnType<ProjectDatabase['getStoryStateRepository']>['insert']>[0]);
}

function search(text: string, limit = 20) {
  return db.getStoryGraphSearch().searchFts('p1', text, limit);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-graph-index-'));
  db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // 已关闭
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('FTS MATCH 表达式构造（注入防线）', () => {
  it('普通文本切成短语字面量，短于 3 字符的词被丢掉', () => {
    expect(buildFtsMatchQuery('外门弟子')).toBe('"外门弟子"');
    // 两字词在 trigram 下永远命中不了，提前丢掉而不是发一次注定为空的查询
    expect(buildFtsMatchQuery('林三 玉佩')).toBeNull();
    expect(buildFtsMatchQuery('')).toBeNull();
    expect(buildFtsMatchQuery('，。、')).toBeNull();
  });

  it('每个词都是引号短语，裸算子进不去表达式', () => {
    const query = buildFtsMatchQuery('外门弟子 AND NOT 掌门信物');
    expect(query).not.toBeNull();
    // 双引号本身是切词分隔符，先一步被剥掉；即便如此转义仍保留为第二道防线
    for (const term of query!.split(' OR ')) {
      expect(term.startsWith('"') && term.endsWith('"')).toBe(true);
    }
    expect(query).not.toMatch(/(^| )AND( |$)/);
    expect(query).not.toMatch(/(^| )NOT( |$)/);
    // 引号在切词阶段就被当分隔符处理掉，不会残留成未闭合引号
    expect(buildFtsMatchQuery('a"bc')).toBeNull();
    expect(buildFtsMatchQuery('外门弟子"掌门信物')).toBe('"外门弟子" OR "掌门信物"');
  });

  it('长句切成滑动窗口（整句逐字命中的概率太低）', () => {
    const query = buildFtsMatchQuery('青云宗的钟声在雨夜里响起');
    expect(query).not.toBeNull();
    expect(query!.split(' OR ').length).toBeGreaterThan(1);
  });

  it('恶意/畸形文本进 MATCH 不抛异常（真打到 SQLite 上验证）', () => {
    seedEntity('e-lin', '林三');
    insertState('s1');
    for (const hostile of [
      '外门弟子 AND',
      '(((',
      'NEAR/',
      '"未闭合引号',
      '林三* OR *',
      '{}[]^$',
      '外门弟子" OR "1',
    ]) {
      expect(() => search(hostile)).not.toThrow();
    }
  });
});

describe('FTS 写路径同步（D-B23-8）', () => {
  it('状态边插入即可检索，删除后检索不到（嵌入也随行清理）', () => {
    seedEntity('e-lin', '林三');
    insertState('s1');
    expect(search('青云宗外门弟子').map((m) => m.refId)).toContain('s1');
    expect(search('青云宗外门弟子')[0].kind).toBe('state');

    db.getStoryEmbeddingRepository().upsert({
      id: 'emb-1',
      projectId: 'p1',
      kind: 'state',
      refId: 's1',
      model: 'embed-model',
      vector: [1, 0, 0],
      contentHash: HASH,
      createdAt: NOW,
    });

    expect(db.getStoryStateRepository().deleteExtractedBySourceChapter('p1', 'c1')).toBe(1);
    // 实体行自己的档案里也有"外门弟子"，所以只断言状态那一行没了
    expect(search('青云宗外门弟子').map((m) => m.refId)).not.toContain('s1');
    expect(search('青云宗外门弟子').every((m) => m.kind !== 'state')).toBe(true);
    expect(db.getStoryEmbeddingRepository().listAll('p1')).toEqual([]);
  });

  it('状态边客体是实体时，索引文本用对端正名', () => {
    seedEntity('e-lin', '林三');
    seedEntity('e-sect', '青云宗', '主角所在宗门');
    insertState('s1', { objectEntityId: 'e-sect', objectText: null, predicate: '所在' });
    expect(search('青云宗').map((m) => m.refId)).toContain('s1');
  });

  it('线程开启可检索，核销后仍在索引里（历史回放要能查到），删除才消失', () => {
    const threadRepo = db.getStoryThreadRepository();
    threadRepo.open({
      id: 't1',
      projectId: 'p1',
      kind: 'foreshadow',
      description: '玉佩来历不明',
      promisedPayoff: '揭示玉佩是掌门信物',
      openedChapter: 1,
      sourceChapterId: 'c1',
      sourceContentHash: HASH,
      evidenceSpan: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    expect(search('玉佩来历不明').map((m) => m.refId)).toEqual(['t1']);
    expect(search('掌门信物').map((m) => m.refId)).toEqual(['t1']);

    expect(threadRepo.close('p1', 't1', 3, NOW)).toBe(true);
    expect(search('玉佩来历不明').map((m) => m.refId)).toEqual(['t1']);

    expect(threadRepo.deleteExtractedBySourceChapter('p1', 'c1')).toBe(1);
    expect(search('玉佩来历不明')).toEqual([]);
  });

  it('实体档案与别名变更都重写索引行', () => {
    const entityRepo = db.getStoryEntityRepository();
    seedEntity('e-lin', '林三', '起初是外门弟子');
    expect(search('外门弟子').map((m) => m.refId)).toEqual(['e-lin']);

    entityRepo.appendProfileSummary('p1', 'e-lin', '后来拜入内门传承', NOW);
    expect(search('内门传承').map((m) => m.refId)).toEqual(['e-lin']);
    expect(search('外门弟子').map((m) => m.refId)).toEqual(['e-lin']);

    entityRepo.addAlias({
      id: 'a1',
      projectId: 'p1',
      entityId: 'e-lin',
      alias: '青云林师兄',
      origin: 'extracted',
      createdAt: NOW,
    });
    expect(search('青云林师兄').map((m) => m.refId)).toEqual(['e-lin']);
  });

  it('回填清空：extracted 索引行清掉，user 覆盖层的索引行保留', () => {
    const entityRepo = db.getStoryEntityRepository();
    seedEntity('e-auto', '林三', '自动抽出来的档案');
    entityRepo.create({
      id: 'e-user',
      projectId: 'p1',
      kind: 'location',
      canonicalName: '青云宗',
      profileSummary: '我手写的宗门设定',
      firstChapter: null,
      origin: 'user',
      createdAt: NOW,
    });
    db.getStoryEmbeddingRepository().upsert({
      id: 'emb-auto',
      projectId: 'p1',
      kind: 'entity',
      refId: 'e-auto',
      model: 'embed-model',
      vector: [1, 0],
      contentHash: HASH,
      createdAt: NOW,
    });

    db.getStoryGraphRepository().clearExtracted('p1');

    expect(search('自动抽出来的档案')).toEqual([]);
    expect(search('我手写的宗门设定').map((m) => m.refId)).toEqual(['e-user']);
    expect(db.getStoryEmbeddingRepository().listAll('p1')).toEqual([]);
  });

  it('rank 越小越靠前，limit 生效', () => {
    seedEntity('e-lin', '林三');
    insertState('s1');
    insertState('s2', { id: 's2', predicate: '所在', objectText: '青云宗外门弟子居所' });
    const hits = search('青云宗外门弟子', 1);
    expect(hits).toHaveLength(1);
    const all = search('青云宗外门弟子', 10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].rank).toBeLessThanOrEqual(all[1].rank);
  });
});

describe('嵌入存取', () => {
  it('upsert 幂等（同一行重复写只留一条，向量与指纹被替换）', () => {
    seedEntity('e-lin', '林三');
    const repo = db.getStoryEmbeddingRepository();
    repo.upsert({
      id: 'emb-1',
      projectId: 'p1',
      kind: 'entity',
      refId: 'e-lin',
      model: 'm1',
      vector: [1, 0, 0],
      contentHash: 'a'.repeat(64),
      createdAt: NOW,
    });
    repo.upsert({
      id: 'emb-2',
      projectId: 'p1',
      kind: 'entity',
      refId: 'e-lin',
      model: 'm2',
      vector: [0, 1, 0, 0],
      contentHash: 'b'.repeat(64),
      createdAt: NOW,
    });

    const all = repo.listAll('p1');
    expect(all).toHaveLength(1);
    expect(all[0].model).toBe('m2');
    expect(all[0].dims).toBe(4);
    expect([...all[0].vector]).toEqual([0, 1, 0, 0]);
    expect(repo.getContentHash('p1', 'entity', 'e-lin')).toBe('b'.repeat(64));
  });

  it('content_hash 是判断要不要重算的唯一依据', () => {
    seedEntity('e-lin', '林三');
    const repo = db.getStoryEmbeddingRepository();
    const text = db
      .getStoryGraphSearch()
      .listIndexSources('p1', [{ kind: 'entity', refId: 'e-lin' }])[0];
    expect(text.contentHash).toBe(sha256Utf8(text.text));
    expect(repo.getContentHash('p1', 'entity', 'e-lin')).toBeNull();

    repo.upsert({
      id: 'emb-1',
      projectId: 'p1',
      kind: 'entity',
      refId: 'e-lin',
      model: 'm',
      vector: [1, 2, 3],
      contentHash: text.contentHash,
      createdAt: NOW,
    });
    expect(repo.getContentHash('p1', 'entity', 'e-lin')).toBe(text.contentHash);

    // 档案变了 → 文本变了 → 指纹变了 → 该重算
    db.getStoryEntityRepository().appendProfileSummary('p1', 'e-lin', '新的一段档案', NOW);
    const updated = db
      .getStoryGraphSearch()
      .listIndexSources('p1', [{ kind: 'entity', refId: 'e-lin' }])[0];
    expect(updated.contentHash).not.toBe(text.contentHash);
  });

  it('listIndexSources 跳过已不存在的行，去重', () => {
    seedEntity('e-lin', '林三');
    const sources = db.getStoryGraphSearch().listIndexSources('p1', [
      { kind: 'entity', refId: 'e-lin' },
      { kind: 'entity', refId: 'e-lin' },
      { kind: 'state', refId: '不存在' },
    ]);
    expect(sources).toHaveLength(1);
    expect(sources[0].refId).toBe('e-lin');
  });

  it('向量序列化往返保真（float32 小端）', () => {
    const original = [0.5, -0.25, 1, 0];
    const round = deserializeEmbedding(serializeEmbedding(original));
    expect([...round]).toEqual(original);
    expect(serializeEmbedding(original).byteLength).toBe(16);
  });

  it('余弦 topK：维度不符的候选被跳过，排序确定', () => {
    const matches = cosineTopK(
      [1, 0],
      [
        { kind: 'state', refId: 'a', vector: new Float32Array([1, 0]) },
        { kind: 'state', refId: 'b', vector: new Float32Array([0, 1]) },
        { kind: 'state', refId: 'c', vector: new Float32Array([1, 0, 0]) },
      ],
      5,
    );
    expect(matches.map((m) => m.refId)).toEqual(['a', 'b']);
    expect(matches[0].score).toBeCloseTo(1);
    expect(matches[1].score).toBeCloseTo(0);
  });
});
