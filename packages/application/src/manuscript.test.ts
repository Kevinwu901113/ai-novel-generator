/**
 * 稿件 / 章节 / 章节版本应用层用例测试（内存 fake repos）。
 *
 * 覆盖 §7 用例编排：CAS、版本号 MAX+1、血缘、归档语义、
 * 稀疏排序（append/prepend/insert-before/move/rebalance）、
 * 确定性 active 子序列与 typed 错误映射。
 *
 * DB 约束（FK / unique / trigger / rollback）由
 * packages/database 集成测试覆盖（manuscript-database.test.ts）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getOrCreateManuscript,
  createChapter,
  createChapterVersion,
  promoteChapterVersion,
  updateChapterOrder,
  archiveChapter,
  restoreChapter,
  updateManuscriptTitle,
  type ManuscriptMutationDeps,
} from './manuscript-mutations.js';
import {
  getManuscript,
  listChapters,
  getChapter,
  getCurrentChapterVersion,
  listChapterVersions,
  getChapterVersion,
  type ManuscriptQueryDeps,
} from './manuscript.js';
import type {
  ManuscriptRepositoryPort,
  ChapterRepositoryPort,
  ChapterVersionRepositoryPort,
  ChapterDraftRepositoryPort,
  ChapterDraftData,
  ManuscriptTransactionPort,
  ManuscriptData,
  ChapterData,
  ChapterVersionData,
} from './manuscript-types.js';
import {
  ManuscriptNotFoundError,
  ManuscriptStateConflictError,
  ManuscriptVersionConflictError,
  ManuscriptPositionOverflowError,
  ChapterNotFoundError,
  ChapterVersionNotFoundError,
} from './errors.js';

const NOW = '2026-01-01T00:00:00.000Z';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── 内存 fake 仓库 ─────────────────────────────────────────

class FakeStore {
  readonly projects = new Set<string>();
  readonly manuscripts = new Map<string, ManuscriptData>();
  readonly chapters = new Map<string, ChapterData>();
  readonly versions = new Map<string, ChapterVersionData>();
  readonly drafts = new Map<string, ChapterDraftData>();

  key(parts: readonly string[]): string {
    return parts.join(':');
  }
}

class FakeManuscriptRepo implements ManuscriptRepositoryPort {
  constructor(private readonly store: FakeStore) {}

  create(data: ManuscriptData): void {
    // DB 层 status 默认 'active'
    this.store.manuscripts.set(this.store.key(['m', data.projectId, data.id]), {
      ...data,
      status: 'active',
    });
  }
  getById(projectId: string, id: string): ManuscriptData | null {
    return this.store.manuscripts.get(this.store.key(['m', projectId, id])) ?? null;
  }
  getActiveByProject(projectId: string): ManuscriptData | null {
    for (const m of this.store.manuscripts.values()) {
      if (m.projectId === projectId && m.status === 'active') return m;
    }
    return null;
  }
  updateTitle(
    projectId: string,
    id: string,
    title: string,
    expectedUpdatedAt: string,
    now: string,
  ): boolean {
    const m = this.getById(projectId, id);
    if (!m || m.updatedAt !== expectedUpdatedAt) return false;
    this.store.manuscripts.set(this.store.key(['m', projectId, id]), {
      ...m,
      title,
      updatedAt: now,
    });
    return true;
  }
  touch(projectId: string, id: string, now: string): void {
    const m = this.getById(projectId, id);
    if (m) {
      this.store.manuscripts.set(this.store.key(['m', projectId, id]), { ...m, updatedAt: now });
    }
  }
}

class FakeChapterRepo implements ChapterRepositoryPort {
  constructor(private readonly store: FakeStore) {}

  create(data: ChapterData): void {
    // DB 层 status 默认 'active'、current_version_id 默认 NULL
    this.store.chapters.set(this.store.key(['c', data.projectId, data.id]), {
      ...data,
      status: 'active',
      currentVersionId: null,
    });
  }
  getById(projectId: string, id: string): ChapterData | null {
    return this.store.chapters.get(this.store.key(['c', projectId, id])) ?? null;
  }
  listByManuscript(projectId: string, manuscriptId: string): ReadonlyArray<ChapterData> {
    return [...this.store.chapters.values()]
      .filter((c) => c.projectId === projectId && c.manuscriptId === manuscriptId)
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  getMaxPosition(projectId: string, manuscriptId: string): number | null {
    const list = this.listByManuscript(projectId, manuscriptId);
    return list.length === 0 ? null : list[list.length - 1].position;
  }
  casUpdateCurrentVersionId(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    newVersionId: string,
    now: string,
  ): boolean {
    const c = this.getById(projectId, chapterId);
    if (!c || c.currentVersionId !== expectedCurrentVersionId) return false;
    this.store.chapters.set(this.store.key(['c', projectId, chapterId]), {
      ...c,
      currentVersionId: newVersionId,
      updatedAt: now,
    });
    return true;
  }
  casUpdateStatus(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    expectedStatus: 'active' | 'archived',
    newStatus: 'active' | 'archived',
    now: string,
  ): boolean {
    const c = this.getById(projectId, chapterId);
    if (!c || c.currentVersionId !== expectedCurrentVersionId || c.status !== expectedStatus) {
      return false;
    }
    this.store.chapters.set(this.store.key(['c', projectId, chapterId]), {
      ...c,
      status: newStatus,
      updatedAt: now,
    });
    return true;
  }
  updatePosition(projectId: string, chapterId: string, position: number, now: string): void {
    const c = this.getById(projectId, chapterId);
    if (c) {
      this.store.chapters.set(this.store.key(['c', projectId, chapterId]), {
        ...c,
        position,
        updatedAt: now,
      });
    }
  }
}

class FakeChapterVersionRepo implements ChapterVersionRepositoryPort {
  constructor(private readonly store: FakeStore) {}

  create(data: ChapterVersionData): void {
    this.store.versions.set(this.store.key(['v', data.projectId, data.id]), data);
  }
  getById(projectId: string, chapterId: string, id: string): ChapterVersionData | null {
    const v = this.store.versions.get(this.store.key(['v', projectId, id]));
    return v && v.chapterId === chapterId ? v : null;
  }
  private summary(v: ChapterVersionData) {
    return {
      id: v.id,
      chapterId: v.chapterId,
      versionNumber: v.versionNumber,
      title: v.title,
      sourceType: v.sourceType,
      createdAt: v.createdAt,
      parentVersionId: v.parentVersionId,
      creationContractVersionId: v.creationContractVersionId,
      contentHash: v.contentHash,
    };
  }
  getSummaryById(projectId: string, chapterId: string, id: string) {
    const v = this.getById(projectId, chapterId, id);
    return v ? this.summary(v) : null;
  }
  listSummariesByChapter(projectId: string, chapterId: string) {
    return [...this.store.versions.values()]
      .filter((v) => v.projectId === projectId && v.chapterId === chapterId)
      .sort((a, b) => b.versionNumber - a.versionNumber || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((v) => this.summary(v));
  }
  getMaxVersionNumber(projectId: string, chapterId: string): number | null {
    let max: number | null = null;
    for (const v of this.store.versions.values()) {
      if (v.projectId === projectId && v.chapterId === chapterId) {
        max = max === null ? v.versionNumber : Math.max(max, v.versionNumber);
      }
    }
    return max;
  }
  countByChapter(projectId: string, chapterId: string): number {
    let n = 0;
    for (const v of this.store.versions.values()) {
      if (v.projectId === projectId && v.chapterId === chapterId) n++;
    }
    return n;
  }
}

class FakeChapterDraftRepo implements ChapterDraftRepositoryPort {
  constructor(private readonly store: FakeStore) {}

  upsert(data: ChapterDraftData): void {
    this.store.drafts.set(this.store.key(['d', data.projectId, data.chapterId]), data);
  }
  getByChapter(projectId: string, chapterId: string): ChapterDraftData | null {
    return this.store.drafts.get(this.store.key(['d', projectId, chapterId])) ?? null;
  }
  deleteByChapter(projectId: string, chapterId: string): boolean {
    const key = this.store.key(['d', projectId, chapterId]);
    const existed = this.store.drafts.has(key);
    this.store.drafts.delete(key);
    return existed;
  }
}

interface FakeRepos {
  manuscriptRepo: ManuscriptRepositoryPort;
  chapterRepo: ChapterRepositoryPort;
  chapterVersionRepo: ChapterVersionRepositoryPort;
  chapterDraftRepo: ChapterDraftRepositoryPort;
  projectExistsReadPort: { exists(projectId: string): boolean };
}

class FakeTransactionPort implements ManuscriptTransactionPort {
  constructor(private readonly store: FakeStore) {}
  runInTransaction<T>(operation: (repos: FakeRepos) => T): T {
    return operation({
      manuscriptRepo: new FakeManuscriptRepo(this.store),
      chapterRepo: new FakeChapterRepo(this.store),
      chapterVersionRepo: new FakeChapterVersionRepo(this.store),
      chapterDraftRepo: new FakeChapterDraftRepo(this.store),
      projectExistsReadPort: { exists: (p) => this.store.projects.has(p) },
    });
  }
}

type Deps = ManuscriptMutationDeps & ManuscriptQueryDeps;

function makeDeps(store = new FakeStore()): Deps {
  return {
    transactionPort: new FakeTransactionPort(store),
    sha256Port: { digestUtf8: (s) => sha256(s) },
    manuscriptRepo: new FakeManuscriptRepo(store),
    chapterRepo: new FakeChapterRepo(store),
    chapterVersionRepo: new FakeChapterVersionRepo(store),
  };
}

function seedManuscript(deps: Deps, projectId = 'p1', manuscriptId = 'm1'): void {
  const store = (deps.transactionPort as unknown as { store: FakeStore }).store;
  store.projects.add(projectId);
  getOrCreateManuscript(deps, { projectId, newManuscriptId: manuscriptId, now: NOW });
}

function seedChapter(deps: Deps, chapterId: string, projectId = 'p1', manuscriptId = 'm1'): void {
  createChapter(deps, {
    projectId,
    manuscriptId,
    insertBeforeChapterId: null,
    now: NOW,
    newChapterId: chapterId,
  });
}

describe('getOrCreateManuscript', () => {
  it('创建 active manuscript（默认标题）', () => {
    const deps = makeDeps();
    const store = (deps.transactionPort as unknown as { store: FakeStore }).store;
    store.projects.add('p1');
    const m = getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
    expect(m.id).toBe('m1');
    expect(m.title).toBe('未命名稿件');
    expect(m.status).toBe('active');
    expect(m.creationContractVersionId).toBeNull();
  });

  it('已有 active 稿件时返回既有（忽略 title）', () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    store.projects.add('p1');
    getOrCreateManuscript(deps, {
      projectId: 'p1',
      newManuscriptId: 'm1',
      now: NOW,
      title: '第一版',
    });
    const again = getOrCreateManuscript(deps, {
      projectId: 'p1',
      newManuscriptId: 'm2',
      now: NOW,
      title: '第二版',
    });
    expect(again.id).toBe('m1');
    expect(again.title).toBe('第一版');
  });

  it('project 不存在 → MANUSCRIPT_NOT_FOUND', () => {
    const deps = makeDeps();
    expect(() =>
      getOrCreateManuscript(deps, { projectId: 'nope', newManuscriptId: 'm1', now: NOW }),
    ).toThrow(ManuscriptNotFoundError);
  });

  it('title 非法 → VALIDATION_ERROR', () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    store.projects.add('p1');
    expect(() =>
      getOrCreateManuscript(deps, {
        projectId: 'p1',
        newManuscriptId: 'm1',
        now: NOW,
        title: '   ',
      }),
    ).toThrow();
  });
});

describe('getManuscript', () => {
  it('跨 project → MANUSCRIPT_NOT_FOUND', () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    store.projects.add('p1');
    getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
    expect(() => getManuscript(deps, { projectId: 'p2', manuscriptId: 'm1' })).toThrow(
      ManuscriptNotFoundError,
    );
  });
});

describe('createChapter 稀疏排序（§6.1）', () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps();
    seedManuscript(deps);
  });

  it('首章 position = 2048', () => {
    const c = createChapter(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c1',
    });
    expect(c.position).toBe(2048);
    expect(c.currentVersionId).toBeNull();
    expect(c.versionCount).toBe(0);
  });

  it('append：M + GAP', () => {
    seedChapter(deps, 'c1');
    const c2 = createChapter(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    expect(c2.position).toBe(2048 + 1024);
  });

  it('连续 prepend：2048 → 1024 → … → 1（场景 5）', () => {
    seedChapter(deps, 'first');
    const positions = [2048];
    let before = 'first';
    for (let i = 1; i <= 11; i++) {
      const id = `pre-${i}`;
      const c = createChapter(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: before,
        now: NOW,
        newChapterId: id,
      });
      positions.push(c.position);
      before = id;
    }
    expect(positions[0]).toBe(2048);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBe(Math.floor(positions[i - 1] / 2));
    }
    expect(positions[positions.length - 1]).toBe(1);
  });

  it('insert-before 中间：安全 midpoint', () => {
    seedChapter(deps, 'c1'); // 2048
    const c2 = seedChapter(deps, 'c2'); // 3072
    const mid = createChapter(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: 'c2',
      now: NOW,
      newChapterId: 'mid',
    });
    expect(mid.position).toBe(2048 + Math.floor((3072 - 2048) / 2));
    void c2;
  });

  it('insert-before 目标为 archived → MANUSCRIPT_STATE_CONFLICT（场景 18）', () => {
    seedChapter(deps, 'c1');
    seedChapter(deps, 'c2');
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c2',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(() =>
      createChapter(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'c2',
        now: NOW,
        newChapterId: 'c3',
      }),
    ).toThrow(ManuscriptStateConflictError);
  });

  it('insert-before 目标不存在 → CHAPTER_NOT_FOUND', () => {
    expect(() =>
      createChapter(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'ghost',
        now: NOW,
        newChapterId: 'c1',
      }),
    ).toThrow(ChapterNotFoundError);
  });
});

describe('createChapterVersion（§7.2 / §11.1）', () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps();
    seedManuscript(deps);
    seedChapter(deps, 'c1');
  });

  it('首个版本：versionNumber=1, parent=null, current=该版本', () => {
    const v = createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '第一章',
      content: '正文',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    expect(v.versionNumber).toBe(1);
    expect(v.parentVersionId).toBeNull();
    expect(v.sourceType).toBe('USER');
    expect(v.contentHash).toBe(sha256('正文'));
    expect(getCurrentChapterVersion(deps, { projectId: 'p1', chapterId: 'c1' })?.id).toBe('v1');
  });

  it('promote v2 后保存得到 v6 且 parent=v2（场景 3）', () => {
    for (let i = 1; i <= 5; i++) {
      createChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: `第${i}版`,
        content: `content-${i}`,
        expectedCurrentVersionId: i === 1 ? null : `v${i - 1}`,
        now: NOW,
        newVersionId: `v${i}`,
      });
    }
    promoteChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      versionId: 'v2',
      expectedCurrentVersionId: 'v5',
      now: NOW,
    });
    const v6 = createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '第六版',
      content: 'content-6',
      expectedCurrentVersionId: 'v2',
      now: NOW,
      newVersionId: 'v6',
    });
    expect(v6.versionNumber).toBe(6);
    expect(v6.parentVersionId).toBe('v2');
    expect(getCurrentChapterVersion(deps, { projectId: 'p1', chapterId: 'c1' })?.id).toBe('v6');
    const versions = listChapterVersions(deps, { projectId: 'p1', chapterId: 'c1' });
    expect(versions.map((v) => v.versionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('CAS 冲突：expected 与当前不匹配 → 冲突，无行残留（场景 4）', () => {
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v1',
      content: 'a',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v2',
      content: 'b',
      expectedCurrentVersionId: 'v1',
      now: NOW,
      newVersionId: 'v2',
    });
    expect(() =>
      createChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: 'stale',
        content: 'c',
        expectedCurrentVersionId: 'v1',
        now: NOW,
        newVersionId: 'v3',
      }),
    ).toThrow(ManuscriptVersionConflictError);
    expect(listChapterVersions(deps, { projectId: 'p1', chapterId: 'c1' })).toHaveLength(2);
  });

  it('归档章节不能接收新版本（场景 16 相关）', () => {
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v1',
      content: 'a',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: 'v1',
      now: NOW,
    });
    expect(() =>
      createChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: 'v2',
        content: 'b',
        expectedCurrentVersionId: 'v1',
        now: NOW,
        newVersionId: 'v2',
      }),
    ).toThrow(ManuscriptStateConflictError);
  });

  it('章节不存在 → CHAPTER_NOT_FOUND', () => {
    expect(() =>
      createChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'ghost',
        title: 't',
        content: 'c',
        expectedCurrentVersionId: null,
        now: NOW,
        newVersionId: 'v1',
      }),
    ).toThrow(ChapterNotFoundError);
  });

  it('AI sourceType 缺 provenance → VALIDATION_ERROR', () => {
    expect(() =>
      createChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: 't',
        content: 'c',
        expectedCurrentVersionId: null,
        now: NOW,
        newVersionId: 'v1',
        sourceType: 'AI_GENERATION',
      }),
    ).toThrow();
  });
});

describe('promoteChapterVersion', () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps();
    seedManuscript(deps);
    seedChapter(deps, 'c1');
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v1',
      content: 'a',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v2',
      content: 'b',
      expectedCurrentVersionId: 'v1',
      now: NOW,
      newVersionId: 'v2',
    });
  });

  it('promote 历史版本为 current，不创建新版本', () => {
    const promoted = promoteChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      versionId: 'v1',
      expectedCurrentVersionId: 'v2',
      now: NOW,
    });
    expect(promoted.id).toBe('v1');
    expect(getCurrentChapterVersion(deps, { projectId: 'p1', chapterId: 'c1' })?.id).toBe('v1');
    expect(listChapterVersions(deps, { projectId: 'p1', chapterId: 'c1' })).toHaveLength(2);
  });

  it('重复 promote 已 current 版本为成功 no-op（幂等）', () => {
    const again = promoteChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      versionId: 'v2',
      expectedCurrentVersionId: 'v2',
      now: NOW,
    });
    expect(again.id).toBe('v2');
    expect(getCurrentChapterVersion(deps, { projectId: 'p1', chapterId: 'c1' })?.id).toBe('v2');
  });

  it('跨章版本 → CHAPTER_VERSION_NOT_FOUND', () => {
    seedChapter(deps, 'c2');
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c2',
      title: 'other',
      content: 'x',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v-other',
    });
    expect(() =>
      promoteChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v-other',
        expectedCurrentVersionId: 'v2',
        now: NOW,
      }),
    ).toThrow(ChapterVersionNotFoundError);
  });

  it('CAS 冲突 → MANUSCRIPT_VERSION_CONFLICT', () => {
    expect(() =>
      promoteChapterVersion(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v1',
        expectedCurrentVersionId: 'v9',
        now: NOW,
      }),
    ).toThrow(ManuscriptVersionConflictError);
  });
});

describe('updateChapterOrder（§7.2）', () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps();
    seedManuscript(deps);
    for (const id of ['c1', 'c2', 'c3']) {
      seedChapter(deps, id);
    }
  });

  it('M 已是 T 紧邻前驱 → no-op', () => {
    const before = listChapters(deps, { projectId: 'p1', manuscriptId: 'm1' });
    const after = updateChapterOrder(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      chapterId: 'c2',
      insertBeforeChapterId: 'c3',
      now: NOW,
    });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it('move c1 before c3', () => {
    const after = updateChapterOrder(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      chapterId: 'c1',
      insertBeforeChapterId: 'c3',
      now: NOW,
    });
    expect(after.map((c) => c.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('move c1 到末尾（append）', () => {
    const after = updateChapterOrder(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      chapterId: 'c1',
      insertBeforeChapterId: null,
      now: NOW,
    });
    expect(after.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
  });

  it('archived M 不能作为移动章节（场景 16）', () => {
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(() =>
      updateChapterOrder(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
        insertBeforeChapterId: 'c3',
        now: NOW,
      }),
    ).toThrow(ManuscriptStateConflictError);
  });

  it('active M 不能以 archived T 为目标（场景 17）', () => {
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c3',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(() =>
      updateChapterOrder(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
        insertBeforeChapterId: 'c3',
        now: NOW,
      }),
    ).toThrow(ManuscriptStateConflictError);
  });
});

describe('archiveChapter / restoreChapter（不变量 8/10）', () => {
  let deps: Deps;
  beforeEach(() => {
    deps = makeDeps();
    seedManuscript(deps);
    seedChapter(deps, 'c1');
    seedChapter(deps, 'c2');
  });

  it('archive 不改 position；restore 保留 position（场景 8）', () => {
    const posBefore = getChapter(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      chapterId: 'c1',
    }).position;
    const archived = archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(archived.status).toBe('archived');
    expect(archived.position).toBe(posBefore);
    const restored = restoreChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(restored.status).toBe('active');
    expect(restored.position).toBe(posBefore);
  });

  it('重复 archive no-op（幂等）', () => {
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    const again = archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    expect(again.status).toBe('archived');
  });

  it('active 可见顺序是全部序列的 active 子序列（场景 21）', () => {
    archiveChapter(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      expectedCurrentVersionId: null,
      now: NOW,
    });
    const active = listChapters(deps, { projectId: 'p1', manuscriptId: 'm1' });
    const all = listChapters(deps, { projectId: 'p1', manuscriptId: 'm1', includeArchived: true });
    expect(active.map((c) => c.id)).toEqual(['c2']);
    expect(all.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('archive CAS 冲突 → MANUSCRIPT_VERSION_CONFLICT', () => {
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v1',
      content: 'a',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    expect(() =>
      archiveChapter(deps, {
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: 'v9',
        now: NOW,
      }),
    ).toThrow(ManuscriptVersionConflictError);
  });
});

describe('updateManuscriptTitle', () => {
  it('CAS 成功 / expectedUpdatedAt 不匹配 → 冲突', () => {
    const deps = makeDeps();
    seedManuscript(deps);
    const m = getManuscript(deps, { projectId: 'p1', manuscriptId: 'm1' });
    const updated = updateManuscriptTitle(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      title: '新标题',
      expectedUpdatedAt: m.updatedAt,
      now: '2026-01-01T00:00:01.000Z',
    });
    expect(updated.title).toBe('新标题');
    expect(() =>
      updateManuscriptTitle(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        title: '再次',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
        now: NOW,
      }),
    ).toThrow(ManuscriptVersionConflictError);
  });
});

describe('position overflow（§6.1 / 场景 12/13/15）', () => {
  it('append 逼近 LIMIT：rebalance temporary-domain 溢出 → MANUSCRIPT_POSITION_OVERFLOW（无部分写入）', () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    store.projects.add('p1');
    getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
    // n=6、M=LIMIT-5 → B=LIMIT-5 > LIMIT-n=LIMIT-6 → rebalance temporary-domain 溢出
    const positions = [100, 200, 300, 400, 500, 9007199254740986];
    for (let i = 0; i < positions.length; i++) {
      deps.chapterRepo.create({
        id: `c${i + 1}`,
        projectId: 'p1',
        manuscriptId: 'm1',
        position: positions[i],
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    expect(() =>
      createChapter(deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: null,
        now: NOW,
        newChapterId: 'c7',
      }),
    ).toThrow(ManuscriptPositionOverflowError);
    // 无部分写入：6 章位置保持原值
    const all = deps.chapterRepo.listByManuscript('p1', 'm1');
    expect(all).toHaveLength(6);
    expect(all.map((c) => c.position).sort((a, b) => a - b)).toEqual(positions);
  });

  it('单个大 position 章节 append 会 rebalance 压缩后成功（不误报 overflow）', () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    store.projects.add('p1');
    getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
    deps.chapterRepo.create({
      id: 'huge',
      projectId: 'p1',
      manuscriptId: 'm1',
      position: 9007199254740990,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const c = createChapter(deps, {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c2',
    });
    // rebalance 后首章回 3072，append → 4096
    expect(c.position).toBeGreaterThan(0);
    expect(c.position).toBe(4096);
    const positions = deps.chapterRepo
      .listByManuscript('p1', 'm1')
      .map((ch) => ch.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual([3072, 4096]);
  });
});

describe('listChapterVersions 不含 content（§7.3）', () => {
  it('list 不含 content，get 含 content', () => {
    const deps = makeDeps();
    seedManuscript(deps);
    seedChapter(deps, 'c1');
    createChapterVersion(deps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'v1',
      content: 'LONG',
      expectedCurrentVersionId: null,
      now: NOW,
      newVersionId: 'v1',
    });
    const versions = listChapterVersions(deps, { projectId: 'p1', chapterId: 'c1' });
    expect(versions[0]).not.toHaveProperty('content');
    expect(
      getChapterVersion(deps, { projectId: 'p1', chapterId: 'c1', versionId: 'v1' }).content,
    ).toBe('LONG');
  });
});
