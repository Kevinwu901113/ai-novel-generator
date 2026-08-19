/**
 * 稿件 / 章节 / 章节版本数据库集成测试。
 *
 * 覆盖设计 §14 MV1-A 后端矩阵 + 阻断项修复后的全部 21 个必测场景：
 * - current pointer 复合 FK（同章允许 / 跨章拒绝）；
 * - 版本号 MAX+1、promote 历史版本后保存、CAS 冲突整笔回滚；
 * - 稀疏排序：连续 prepend、prepend→rebalance→prepend、安全 midpoint、
 *   rebalance temporary-domain 上边界、append 逼近 LIMIT、overflow 无部分写入；
 * - 运行时零 DDL、rebalance 中途失败整笔 rollback；
 * - manuscript archive/restore reserved、archived 排序语义（16-21）；
 * - project isolation、one active manuscript、immutable trigger、
 *   source/provenance CHECK、跨 project provenance FK、确定性排序、
 *   listChapterVersions 不含 content、大 Unicode round-trip、长度边界、
 *   restart persistence、v6→v7 migration、重复打开幂等、transaction rollback、
 *   typed 错误映射。
 *
 * 所有断言基于真实 SQLite 约束（FK / unique / trigger / CHECK），不降低或绕过。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDatabase, PROJECT_MIGRATIONS } from './project-database.js';
import { SQLiteMigrator } from './migrator.js';
import { ManuscriptTransactionPortImpl } from './manuscript-transaction.js';
import { sha256Utf8 } from './creation-contract-repositories.js';
import {
  getOrCreateManuscript,
  createChapter,
  createChapterVersion,
  promoteChapterVersion,
  updateChapterOrder,
  archiveChapter,
  restoreChapter,
  getManuscript,
  listChapters,
  getChapter,
  getCurrentChapterVersion,
  listChapterVersions,
  getChapterVersion,
  ManuscriptNotFoundError,
  ManuscriptStateConflictError,
  ManuscriptVersionConflictError,
  ManuscriptPositionOverflowError,
  ManuscriptTransactionError,
  ChapterNotFoundError,
  ChapterVersionNotFoundError,
} from '@ai-novel/application';

const NOW = '2026-01-01T00:00:00.000Z';
const LIMIT = Number.MAX_SAFE_INTEGER;

interface Ctx {
  dir: string;
  db: ProjectDatabase;
  deps: {
    transactionPort: ManuscriptTransactionPortImpl;
    sha256Port: { digestUtf8(s: string): string };
    manuscriptRepo: ReturnType<ProjectDatabase['getManuscriptRepository']>;
    chapterRepo: ReturnType<ProjectDatabase['getChapterRepository']>;
    chapterVersionRepo: ReturnType<ProjectDatabase['getChapterVersionRepository']>;
  };
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'manuscript-integ-'));
  const db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'contract',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const deps = {
    transactionPort: new ManuscriptTransactionPortImpl(db.database),
    sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
    manuscriptRepo: db.getManuscriptRepository(),
    chapterRepo: db.getChapterRepository(),
    chapterVersionRepo: db.getChapterVersionRepository(),
  };
  return { dir, db, deps };
}

function seedManuscript(ctx: Ctx, manuscriptId = 'm1'): void {
  getOrCreateManuscript(ctx.deps, { projectId: 'p1', newManuscriptId: manuscriptId, now: NOW });
}

function seedChapter(ctx: Ctx, chapterId: string, manuscriptId = 'm1'): void {
  createChapter(ctx.deps, {
    projectId: 'p1',
    manuscriptId,
    insertBeforeChapterId: null,
    now: NOW,
    newChapterId: chapterId,
  });
}

function seedVersion(
  ctx: Ctx,
  chapterId: string,
  versionId: string,
  expected: string | null,
  content = '正文',
  title = '章',
): void {
  createChapterVersion(ctx.deps, {
    projectId: 'p1',
    chapterId,
    title,
    content,
    expectedCurrentVersionId: expected,
    now: NOW,
    newVersionId: versionId,
  });
}

describe('MV1-A manuscript database integration', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      // 测试内已关闭（restart 场景）时忽略
    }
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  function insertVersionRaw(
    ctx: Ctx,
    chapterId: string,
    versionId: string,
    versionNumber: number,
  ): void {
    ctx.deps.chapterVersionRepo.create({
      id: versionId,
      projectId: 'p1',
      chapterId,
      versionNumber,
      title: 't',
      content: 'c',
      contentHash: sha256Utf8('c'),
      parentVersionId: null,
      sourceType: 'USER',
      createdByTaskId: null,
      invocationId: null,
      creationContractVersionId: null,
      createdAt: NOW,
    });
  }

  describe('current pointer 复合 FK（场景 1/2）', () => {
    it('允许指向同章版本', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      insertVersionRaw(ctx, 'c1', 'v1', 1);
      const ok = ctx.deps.chapterRepo.casUpdateCurrentVersionId('p1', 'c1', null, 'v1', NOW);
      expect(ok).toBe(true);
      const c = ctx.deps.chapterRepo.getById('p1', 'c1');
      expect(c?.currentVersionId).toBe('v1');
    });

    it('拒绝指向其他 chapter 的版本（FK 约束违反）', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      insertVersionRaw(ctx, 'c1', 'v1', 1);
      insertVersionRaw(ctx, 'c2', 'v2', 1);
      // c1 的 (project_id, id) = (p1, c1)；v2.chapter_id = c2 ≠ c1 → FK 违反
      expect(() =>
        ctx.deps.chapterRepo.casUpdateCurrentVersionId('p1', 'c1', null, 'v2', NOW),
      ).toThrow();
    });
  });

  describe('版本号 / 血缘 / CAS（场景 3/4）', () => {
    it('v1..v5 → promote v2 → 保存得到 v6 且 parent=v2', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      for (let i = 1; i <= 5; i++) {
        seedVersion(ctx, 'c1', `v${i}`, i === 1 ? null : `v${i - 1}`, `c${i}`);
      }
      promoteChapterVersion(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v2',
        expectedCurrentVersionId: 'v5',
        now: NOW,
      });
      const v6 = createChapterVersion(ctx.deps, {
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
      expect(getCurrentChapterVersion(ctx.deps, { projectId: 'p1', chapterId: 'c1' })?.id).toBe(
        'v6',
      );
    });

    it('两个保存都从 v2 出发，仅一个成功；失败方无行残留', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      seedVersion(ctx, 'c1', 'v2', 'v1');
      // 成功方基于 v2 保存 → v3
      const ok = createChapterVersion(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: 't3',
        content: 'c3',
        expectedCurrentVersionId: 'v2',
        now: NOW,
        newVersionId: 'v3',
      });
      expect(ok.versionNumber).toBe(3);
      // 失败方同样从 v2 出发（current 已推进到 v3）→ CAS 冲突
      expect(() =>
        createChapterVersion(ctx.deps, {
          projectId: 'p1',
          chapterId: 'c1',
          title: 't4',
          content: 'c4',
          expectedCurrentVersionId: 'v2',
          now: NOW,
          newVersionId: 'v4',
        }),
      ).toThrow(ManuscriptVersionConflictError);
      const versions = listChapterVersions(ctx.deps, { projectId: 'p1', chapterId: 'c1' });
      expect(versions.map((v) => v.versionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });
  });

  describe('连续 prepend 与 rebalance（场景 5/6）', () => {
    it('连续 prepend 到 position 1', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c0');
      const positions = [2048];
      let before = 'c0';
      for (let i = 1; i <= 11; i++) {
        const id = `pre-${i}`;
        const c = createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: before,
          now: NOW,
          newChapterId: id,
        });
        positions.push(c.position);
        before = id;
      }
      expect(positions[positions.length - 1]).toBe(1);
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBe(Math.floor(positions[i - 1] / 2));
      }
    });

    it('prepend 触发 rebalance 后仍可继续 prepend', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c0');
      // 直接推进首章到 position 1（模拟已连续 prepend 11 次）
      ctx.deps.chapterRepo.updatePosition('p1', 'c0', 1, NOW);
      // 再次 prepend → 撞 0 → rebalance。
      // 冻结算法 finalPosition(r) = (r + 2) * GAP → 唯一章节 rank1 = 3072；
      // 新首章 = floor(3072 / 2) = 1536。
      const c1 = createChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'c0',
        now: NOW,
        newChapterId: 'c1',
      });
      expect(c1.position).toBe(1536);
      const all = listChapters(ctx.deps, { projectId: 'p1', manuscriptId: 'm1' });
      expect(all.map((c) => c.id)).toEqual(['c1', 'c0']);
      // 继续 prepend 仍成功
      const c2 = createChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'c1',
        now: NOW,
        newChapterId: 'c2',
      });
      expect(c2.position).toBe(768);
    });
  });

  describe('archived 参与 rebalance（场景 7/19）', () => {
    it('归档章节后 rebalance 无 position 冲突，archived 保留合法 position', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      seedChapter(ctx, 'c3');
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c2',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      // 制造 gap==1 触发 rebalance：把 c1 与 c2 之间压到相邻
      const all = listChapters(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        includeArchived: true,
      });
      const c1 = all.find((c) => c.id === 'c1')!;
      const c2 = all.find((c) => c.id === 'c2')!;
      expect(c1.status).toBe('active');
      expect(c2.status).toBe('archived');
      // 触发 rebalance（move c3 before c1 到 gap==1）——直接构造相邻
      ctx.deps.chapterRepo.updatePosition('p1', 'c3', c1.position + 1, NOW); // c1 与 c3 相邻
      // move c1 到 c3 前 → gap==1 → rebalance（覆盖全部含 archived）
      updateChapterOrder(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
        insertBeforeChapterId: 'c3',
        now: NOW,
      });
      const after = listChapters(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        includeArchived: true,
      });
      // rebalance 后 positions 互异（唯一索引无冲突），archived 保留合法 position
      const positions = after.map((c) => c.position);
      expect(new Set(positions).size).toBe(positions.length);
      expect(after.find((c) => c.id === 'c2')?.status).toBe('archived');
    });
  });

  describe('restore 保持唯一确定 position（场景 8/20）', () => {
    it('restore 保留原 position 且无冲突；可重新作为重排目标', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      const pos1 = getChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
      }).position;
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      restoreChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      const restored = getChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
      });
      expect(restored.position).toBe(pos1);
      // restore 后可作为 updateChapterOrder 的 T
      updateChapterOrder(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c2',
        insertBeforeChapterId: 'c1',
        now: NOW,
      });
      // restore 后可作为 createChapter 的 insertBefore 目标
      const c3 = createChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'c1',
        now: NOW,
        newChapterId: 'c3',
      });
      expect(c3.position).toBeGreaterThan(0);
    });
  });

  describe('rebalance 中途失败整笔 rollback + 唯一索引存在（场景 9）', () => {
    it('第二阶段写入失败 → 全量回滚，位置不变，唯一索引全程存在', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c0');
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      ctx.deps.chapterRepo.updatePosition('p1', 'c0', 1, NOW); // 制造 prepend 撞 0 → rebalance
      // 注入失败触发器：任何 UPDATE position 到 3072（= final(1)）即 ABORT
      ctx.db.database.exec(
        `CREATE TRIGGER trg_fail_on_3072 BEFORE UPDATE OF position ON chapters
         WHEN NEW.position = 3072
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`,
      );
      expect(() =>
        createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: 'c0',
          now: NOW,
          newChapterId: 'c3',
        }),
      ).toThrow();
      // 整笔回滚：所有 position 与事务前一致
      const all = listChapters(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        includeArchived: true,
      });
      expect(all).toHaveLength(3);
      expect(all.find((c) => c.id === 'c0')?.position).toBe(1);
      // 唯一索引全程存在，无 DDL 删除
      const idx = ctx.db.database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_chapters_project_manuscript_position'`,
        )
        .get() as { name: string } | undefined;
      expect(idx).toBeDefined();
    });
  });

  describe('运行时零 DDL（场景 10）', () => {
    it('排序/重排/rebalance 代码路径无 DROP/CREATE INDEX', () => {
      // 去除注释后检查实际语句（注释中允许讨论"不执行 DDL"）
      const stripComments = (src: string): string =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const files = [
        'packages/application/src/manuscript-position.ts',
        'packages/application/src/manuscript-mutations.ts',
        'packages/database/src/manuscript-repositories.ts',
      ];
      for (const f of files) {
        const src = stripComments(readFileSync(join(process.cwd(), f), 'utf8'));
        expect(src).not.toMatch(/DROP\s+INDEX/i);
        expect(src).not.toMatch(/CREATE\s+INDEX/i);
      }
    });
  });

  describe('manuscript archive/restore reserved（场景 11）', () => {
    it('无 archiveManuscript/restoreManuscript 用例，manuscript.status 恒为 active', () => {
      const index = readFileSync(join(process.cwd(), 'packages/application/src/index.ts'), 'utf8');
      expect(index).not.toMatch(/archiveManuscript/);
      expect(index).not.toMatch(/restoreManuscript/);
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      const m = getManuscript(ctx.deps, { projectId: 'p1', manuscriptId: 'm1' });
      expect(m.status).toBe('active');
      // V1 每 project 至多一个 active manuscript；无 archive/restore 稿件路径。
      // 第二个 active manuscript 违反部分唯一索引。
      expect(() =>
        ctx.deps.manuscriptRepo.create({
          id: 'm-other',
          projectId: 'p1',
          title: '另一本',
          creationContractVersionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
    });
  });

  describe('position overflow（场景 12/13/15）', () => {
    function seedExtreme(ctx: Ctx): void {
      seedManuscript(ctx);
      const positions = [100, 200, 300, 400, 500, LIMIT - 5];
      for (let i = 0; i < positions.length; i++) {
        ctx.deps.chapterRepo.create({
          id: `c${i + 1}`,
          projectId: 'p1',
          manuscriptId: 'm1',
          position: positions[i],
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    }

    it('rebalance temporary-domain 上边界：B > LIMIT - n → overflow 整笔 rollback', () => {
      seedExtreme(ctx);
      expect(() =>
        createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: null,
          now: NOW,
          newChapterId: 'c7',
        }),
      ).toThrow(ManuscriptPositionOverflowError);
      // 无部分写入：位置全部保持
      const all = ctx.deps.chapterRepo.listByManuscript('p1', 'm1');
      expect(all).toHaveLength(6);
      expect(all.map((c) => c.position).sort((a, b) => a - b)).toEqual([
        100,
        200,
        300,
        400,
        500,
        LIMIT - 5,
      ]);
    });

    it('append 逼近 LIMIT 触发 rebalance 后仍 M > LIMIT - GAP → 确定性 overflow', () => {
      seedExtreme(ctx);
      expect(() =>
        createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: null,
          now: NOW,
          newChapterId: 'c7',
        }),
      ).toThrow(ManuscriptPositionOverflowError);
      // 同一错误的语义：不修改任何 position、整笔回滚、无 DDL
      const idx = ctx.db.database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='uq_chapters_project_manuscript_position'`,
        )
        .get() as { name: string } | undefined;
      expect(idx).toBeDefined();
    });

    it('大整数安全 midpoint：P + floor((X-P)/2) 严格介于两者（场景 14）', () => {
      seedManuscript(ctx);
      ctx.deps.chapterRepo.create({
        id: 'p',
        projectId: 'p1',
        manuscriptId: 'm1',
        position: LIMIT - 200,
        createdAt: NOW,
        updatedAt: NOW,
      });
      ctx.deps.chapterRepo.create({
        id: 'x',
        projectId: 'p1',
        manuscriptId: 'm1',
        position: LIMIT - 100,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const mid = createChapter(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'x',
        now: NOW,
        newChapterId: 'mid',
      });
      expect(mid.position).toBe(LIMIT - 200 + Math.floor((LIMIT - 100 - (LIMIT - 200)) / 2));
      expect(mid.position).toBeGreaterThan(LIMIT - 200);
      expect(mid.position).toBeLessThan(LIMIT - 100);
    });
  });

  describe('archived 排序语义（场景 16/17/18/20/21）', () => {
    it('archived 章节不能被移动（updateChapterOrder M=archived）', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      expect(() =>
        updateChapterOrder(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          chapterId: 'c1',
          insertBeforeChapterId: 'c2',
          now: NOW,
        }),
      ).toThrow(ManuscriptStateConflictError);
    });

    it('active 章节不能以 archived 为 move 目标', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c2',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      expect(() =>
        updateChapterOrder(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          chapterId: 'c1',
          insertBeforeChapterId: 'c2',
          now: NOW,
        }),
      ).toThrow(ManuscriptStateConflictError);
    });

    it('createChapter 不能以 archived 为目标（场景 18）', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c2',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      expect(() =>
        createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: 'c2',
          now: NOW,
          newChapterId: 'c3',
        }),
      ).toThrow(ManuscriptStateConflictError);
      // insert-before 指向不存在/跨稿件 → CHAPTER_NOT_FOUND（不泄露存在性）
      expect(() =>
        createChapter(ctx.deps, {
          projectId: 'p1',
          manuscriptId: 'm1',
          insertBeforeChapterId: 'ghost',
          now: NOW,
          newChapterId: 'c4',
        }),
      ).toThrow(ChapterNotFoundError);
    });

    it('active 可见顺序 = 全部 position 序列的 active 子序列（场景 21）', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      seedChapter(ctx, 'c3');
      archiveChapter(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c2',
        expectedCurrentVersionId: null,
        now: NOW,
      });
      const active = listChapters(ctx.deps, { projectId: 'p1', manuscriptId: 'm1' });
      const all = listChapters(ctx.deps, {
        projectId: 'p1',
        manuscriptId: 'm1',
        includeArchived: true,
      });
      expect(active.map((c) => c.id)).toEqual(['c1', 'c3']);
      expect(all.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
      // active 是全序列的 active 子序列（相对顺序一致）
      const allIds = all.map((c) => c.id);
      const activeIds = active.map((c) => c.id);
      let ai = 0;
      for (const id of allIds) {
        if (ai < activeIds.length && id === activeIds[ai]) ai++;
      }
      expect(ai).toBe(activeIds.length);
    });
  });

  describe('project isolation / one active manuscript', () => {
    it('跨 project 读写返回 NOT_FOUND，不泄露存在性', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      expect(() => getManuscript(ctx.deps, { projectId: 'p2', manuscriptId: 'm1' })).toThrow(
        ManuscriptNotFoundError,
      );
      expect(() => listChapters(ctx.deps, { projectId: 'p2', manuscriptId: 'm1' })).toThrow(
        ManuscriptNotFoundError,
      );
    });

    it('每 project 至多一个 active manuscript（部分唯一索引强制）', () => {
      seedManuscript(ctx, 'm1');
      expect(() =>
        ctx.deps.manuscriptRepo.create({
          id: 'm2',
          projectId: 'p1',
          title: '第二本',
          creationContractVersionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
      // getOrCreate 并发只会返回/创建一个 active
      const again = getOrCreateManuscript(ctx.deps, {
        projectId: 'p1',
        newManuscriptId: 'm-other',
        now: NOW,
      });
      expect(again.id).toBe('m1');
    });
  });

  describe('不可变版本 / provenance CHECK / 跨 project FK', () => {
    it('ChapterVersion 创建后 UPDATE/DELETE 被 trigger 拒绝', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      expect(() =>
        ctx.db.database.prepare(`UPDATE chapter_versions SET title = '改' WHERE id = 'v1'`).run(),
      ).toThrow();
      expect(() =>
        ctx.db.database.prepare(`DELETE FROM chapter_versions WHERE id = 'v1'`).run(),
      ).toThrow();
    });

    it('sourceType/provenance CHECK：USER 不得携带 task/invocation；AI 必须三件套', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedChapter(ctx, 'c2');
      // USER + taskId → CHECK 违反
      expect(() =>
        ctx.deps.chapterVersionRepo.create({
          id: 'bad-user',
          projectId: 'p1',
          chapterId: 'c1',
          versionNumber: 1,
          title: 't',
          content: 'c',
          contentHash: sha256Utf8('c'),
          parentVersionId: null,
          sourceType: 'USER',
          createdByTaskId: 't1',
          invocationId: null,
          creationContractVersionId: null,
          createdAt: NOW,
        }),
      ).toThrow();
      // AI 缺 contract version → CHECK 违反
      expect(() =>
        ctx.deps.chapterVersionRepo.create({
          id: 'bad-ai',
          projectId: 'p1',
          chapterId: 'c2',
          versionNumber: 1,
          title: 't',
          content: 'c',
          contentHash: sha256Utf8('c'),
          parentVersionId: null,
          sourceType: 'AI_GENERATION',
          createdByTaskId: 't1',
          invocationId: 'i1',
          creationContractVersionId: null,
          createdAt: NOW,
        }),
      ).toThrow();
    });

    it('跨 project provenance FK：p2 版本不能引用 p1 的 task/invocation/contract', () => {
      ctx.db.getProjectMetadataRepository().create({
        id: 'p2',
        name: '项目二',
        initialIdea: '另一个',
        status: 'contract',
        createdAt: NOW,
        updatedAt: NOW,
      });
      // p1 的 task + invocation + contract version
      ctx.db.getTaskRepository().create({
        id: 't1',
        projectId: 'p1',
        taskType: 'GRILL_QUESTION_PLAN',
        status: 'SUCCEEDED',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: NOW,
        updatedAt: NOW,
      });
      ctx.db.getModelInvocationRepository().create({
        id: 'i1',
        projectId: 'p1',
        taskId: 't1',
        providerProfileId: 'pp',
        model: 'm',
        status: 'SUCCEEDED',
        attemptNumber: 1,
        requestKind: 'k',
        promptHash: 'a'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: NOW,
      });
      // p2 的 manuscript + chapter
      getOrCreateManuscript(ctx.deps, { projectId: 'p2', newManuscriptId: 'm2', now: NOW });
      createChapter(ctx.deps, {
        projectId: 'p2',
        manuscriptId: 'm2',
        insertBeforeChapterId: null,
        now: NOW,
        newChapterId: 'c-p2',
      });
      // 在 p2 创建 AI 版本，taskId 指向 p1 的 t1 → 复合 FK 拒绝
      expect(() =>
        ctx.deps.chapterVersionRepo.create({
          id: 'v-cross',
          projectId: 'p2',
          chapterId: 'c-p2',
          versionNumber: 1,
          title: 't',
          content: 'c',
          contentHash: sha256Utf8('c'),
          parentVersionId: null,
          sourceType: 'AI_GENERATION',
          createdByTaskId: 't1',
          invocationId: 'i1',
          creationContractVersionId: null,
          createdAt: NOW,
        }),
      ).toThrow();
    });
  });

  describe('确定性排序 / list 不含 content / 大 Unicode / 长度边界', () => {
    it('listChapterVersions 按 version_number DESC, id ASC；listChapters 按 position ASC, id ASC', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      for (let i = 1; i <= 3; i++) {
        seedVersion(ctx, 'c1', `v${i}`, i === 1 ? null : `v${i - 1}`, `content-${i}`);
      }
      const versions = listChapterVersions(ctx.deps, { projectId: 'p1', chapterId: 'c1' });
      expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      const chapters = listChapters(ctx.deps, { projectId: 'p1', manuscriptId: 'm1' });
      expect(chapters.map((c) => c.position)).toEqual([2048]);
    });

    it('listChapterVersions 不含 content', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null, 'LONG-BODY');
      const versions = listChapterVersions(ctx.deps, { projectId: 'p1', chapterId: 'c1' });
      expect(versions[0]).not.toHaveProperty('content');
      expect(
        getChapterVersion(ctx.deps, { projectId: 'p1', chapterId: 'c1', versionId: 'v1' }).content,
      ).toBe('LONG-BODY');
    });

    it('大 Unicode / astral / 组合字符 round-trip 保真，hash 精确字节', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      const content = '𠮷野家 𝄞 音符 🎵 emoji é 组合字符 \n 换行\r\n \t空格保留';
      const v = createChapterVersion(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: 'Unicode 章',
        content,
        expectedCurrentVersionId: null,
        now: NOW,
        newVersionId: 'v1',
      });
      expect(v.contentHash).toBe(sha256Utf8(content));
      const readBack = getChapterVersion(ctx.deps, {
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v1',
      });
      expect(readBack.content).toBe(content);
      expect(readBack.title).toBe('Unicode 章');
    });

    it('title/content 长度边界', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      // title 200 允许、201 拒绝
      expect(() =>
        createChapterVersion(ctx.deps, {
          projectId: 'p1',
          chapterId: 'c1',
          title: '章'.repeat(200),
          content: 'x',
          expectedCurrentVersionId: null,
          now: NOW,
          newVersionId: 'v1',
        }),
      ).not.toThrow();
      expect(() =>
        createChapterVersion(ctx.deps, {
          projectId: 'p1',
          chapterId: 'c1',
          title: '章'.repeat(201),
          content: 'x',
          expectedCurrentVersionId: 'v1',
          now: NOW,
          newVersionId: 'v2',
        }),
      ).toThrow();
      // content 1,000,000 允许
      expect(() =>
        createChapterVersion(ctx.deps, {
          projectId: 'p1',
          chapterId: 'c1',
          title: '大正文',
          content: 'a'.repeat(1_000_000),
          expectedCurrentVersionId: 'v1',
          now: NOW,
          newVersionId: 'v3',
        }),
      ).not.toThrow();
      // 超过上限（1,000,001）被拒
      expect(() =>
        createChapterVersion(ctx.deps, {
          projectId: 'p1',
          chapterId: 'c1',
          title: '超大',
          content: 'a'.repeat(1_000_001),
          expectedCurrentVersionId: 'v3',
          now: NOW,
          newVersionId: 'v4',
        }),
      ).toThrow();
    });
  });

  describe('restart persistence', () => {
    it('关闭重开后 manuscript/chapter/version 完整', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      ctx.db.close();
      // 重新打开同一路径
      const db2 = new ProjectDatabase(join(ctx.dir, 'project.sqlite'));
      try {
        const deps2 = {
          transactionPort: new ManuscriptTransactionPortImpl(db2.database),
          sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
          manuscriptRepo: db2.getManuscriptRepository(),
          chapterRepo: db2.getChapterRepository(),
          chapterVersionRepo: db2.getChapterVersionRepository(),
        };
        const m = getManuscript(deps2, { projectId: 'p1', manuscriptId: 'm1' });
        expect(m.title).toBe('未命名稿件');
        const chapters = listChapters(deps2, { projectId: 'p1', manuscriptId: 'm1' });
        expect(chapters).toHaveLength(1);
        const v = getChapterVersion(deps2, { projectId: 'p1', chapterId: 'c1', versionId: 'v1' });
        expect(v.contentHash).toBe(sha256Utf8('正文'));
      } finally {
        db2.close();
      }
    });
  });

  describe('transaction rollback（适配器级）', () => {
    it('事务内抛错整笔回滚（无版本行、无指针变化）', () => {
      seedManuscript(ctx);
      seedChapter(ctx, 'c1');
      seedVersion(ctx, 'c1', 'v1', null);
      expect(() =>
        ctx.deps.transactionPort.runInTransaction((repos) => {
          // 先插入一个新版本（尚未推进指针），随后抛错
          repos.chapterVersionRepo.create({
            id: 'orphan',
            projectId: 'p1',
            chapterId: 'c1',
            versionNumber: 2,
            title: 't',
            content: 'c',
            contentHash: sha256Utf8('c'),
            parentVersionId: 'v1',
            sourceType: 'USER',
            createdByTaskId: null,
            invocationId: null,
            creationContractVersionId: null,
            createdAt: NOW,
          });
          repos.chapterRepo.updatePosition('p1', 'c1', 9999, NOW);
          throw new Error('boom');
        }),
      ).toThrow(ManuscriptTransactionError);
      // 整笔回滚：无 orphan 版本、position 未变
      const versions = listChapterVersions(ctx.deps, { projectId: 'p1', chapterId: 'c1' });
      expect(versions.map((v) => v.versionNumber)).toEqual([1]);
      const c = ctx.deps.chapterRepo.getById('p1', 'c1');
      expect(c?.position).toBe(2048);
    });
  });

  describe('typed 错误映射', () => {
    it('getManuscript 不存在 → ManuscriptNotFoundError；章节不存在 → ChapterNotFoundError', () => {
      expect(() => getManuscript(ctx.deps, { projectId: 'p1', manuscriptId: 'nope' })).toThrow(
        ManuscriptNotFoundError,
      );
      seedManuscript(ctx);
      expect(() =>
        getCurrentChapterVersion(ctx.deps, { projectId: 'p1', chapterId: 'nope' }),
      ).toThrow(ChapterNotFoundError);
      seedChapter(ctx, 'c1');
      expect(() =>
        getChapterVersion(ctx.deps, { projectId: 'p1', chapterId: 'c1', versionId: 'nope' }),
      ).toThrow(ChapterVersionNotFoundError);
    });
  });
});

describe('migration v7', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mv7-mig-'));
    dbPath = join(tempDir, 'project.sqlite');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildV6(): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      const migrator = new SQLiteMigrator(db);
      migrator.migrate(0, PROJECT_MIGRATIONS.slice(0, 6)); // v1..v6
      expect(migrator.getCurrentVersion()).toBe(6);
      db.prepare(
        `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('p1', '项目一', '一个故事', 'contract', NOW, NOW);
      db.prepare(
        `INSERT INTO tasks
           (id, project_id, task_type, status, input_version_json, payload_json,
            result_json, error_code, error_message, attempt_count, dedupe_key,
            created_at, updated_at, started_at, finished_at, stale_at, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        't1',
        'p1',
        'CREATION_CONTRACT_DRAFT',
        'SUCCEEDED',
        '{}',
        '{}',
        '{"ok":true}',
        null,
        null,
        1,
        null,
        NOW,
        NOW,
        NOW,
        NOW,
        null,
        null,
      );
    } finally {
      db.close();
    }
  }

  it('v6 → 最新（含稿件与 Graph run）：既有数据保留，新表可用', () => {
    buildV6();
    const db = new ProjectDatabase(dbPath);
    try {
      const version = (
        db.database.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {
          v: number;
        }
      ).v;
      expect(version).toBe(23);
      // 既有 v6 数据保留
      const task = db.getTaskRepository().getById('t1');
      expect(task?.taskType).toBe('CREATION_CONTRACT_DRAFT');
      expect(task?.resultJson).toBe('{"ok":true}');
      // 新表可用
      const deps = {
        transactionPort: new ManuscriptTransactionPortImpl(db.database),
        sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
      };
      const m = getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
      expect(m.status).toBe('active');
    } finally {
      db.close();
    }
  });

  it('空新项目直接升到最新版本', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      const version = (
        db.database.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {
          v: number;
        }
      ).v;
      expect(version).toBe(23);
    } finally {
      db.close();
    }
  });

  it('重复打开幂等：不重复迁移', () => {
    const db = new ProjectDatabase(dbPath);
    db.close();
    const db2 = new ProjectDatabase(dbPath);
    try {
      const version = (
        db2.database.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as {
          v: number;
        }
      ).v;
      expect(version).toBe(23);
      const triggers = (
        db2.database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_chapter_versions_%'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(triggers).toContain('trg_chapter_versions_no_update');
      expect(triggers).toContain('trg_chapter_versions_no_delete');
    } finally {
      db2.close();
    }
  });

  it('foreign_keys 保持启用；FK 约束生效', () => {
    buildV6();
    const db = new ProjectDatabase(dbPath);
    try {
      const fk = (db.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
        .foreign_keys;
      expect(fk).toBe(1);
      // manuscript 引用不存在的 creation_contract_version → FK 拒绝
      const deps = {
        transactionPort: new ManuscriptTransactionPortImpl(db.database),
        sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
      };
      expect(() =>
        getOrCreateManuscript(deps, {
          projectId: 'p1',
          newManuscriptId: 'm1',
          now: NOW,
          creationContractVersionId: 'missing-ccv',
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
