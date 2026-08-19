/**
 * 因果截断查询的边界测试（D14 / B23，D-B23-5）。
 *
 * 这两个查询是"第 N 章开篇时刻的世界长什么样"的唯一判据，边界错一格就会
 * 剧透未来或丢掉当时成立的事实，所以边界逐个钉死在这里。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';

const NOW = '2026-08-19T00:00:00.000Z';
const HASH = 'a'.repeat(64);

let dir: string;
let db: ProjectDatabase;

function insertState(
  id: string,
  validFrom: number,
  validUntil: number | null,
  origin: 'extracted' | 'user' = 'extracted',
): void {
  db.getStoryStateRepository().insert({
    id,
    projectId: 'p1',
    subjectEntityId: 'e-lin',
    predicate: `谓词-${id}`,
    objectEntityId: null,
    objectText: `客体-${id}`,
    validFromChapter: validFrom,
    sourceChapterId: origin === 'user' ? null : 'c1',
    sourceContentHash: origin === 'user' ? null : HASH,
    evidenceSpan: null,
    confidence: null,
    origin,
    createdAt: NOW,
  });
  if (validUntil !== null) {
    // 关闭只能走 supersede（append-only）：造一条哨兵新边当接手方
    const successorId = `${id}-successor`;
    db.getStoryStateRepository().insert({
      id: successorId,
      projectId: 'p1',
      subjectEntityId: 'e-lin',
      predicate: `谓词-${id}`,
      objectEntityId: null,
      objectText: `后继-${id}`,
      validFromChapter: validUntil,
      sourceChapterId: 'c9',
      sourceContentHash: HASH,
      evidenceSpan: null,
      confidence: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    expect(db.getStoryStateRepository().supersede('p1', id, validUntil, successorId)).toBe(true);
  }
}

function openThread(id: string, opened: number, closed: number | null): void {
  db.getStoryThreadRepository().open({
    id,
    projectId: 'p1',
    kind: 'foreshadow',
    description: `线索-${id}`,
    promisedPayoff: null,
    openedChapter: opened,
    sourceChapterId: 'c1',
    sourceContentHash: HASH,
    evidenceSpan: null,
    origin: 'extracted',
    createdAt: NOW,
  });
  if (closed !== null) {
    expect(db.getStoryThreadRepository().close('p1', id, closed, NOW)).toBe(true);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-graph-query-'));
  db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.getStoryEntityRepository().create({
    id: 'e-lin',
    projectId: 'p1',
    kind: 'character',
    canonicalName: '林三',
    profileSummary: '外门弟子',
    firstChapter: 1,
    origin: 'extracted',
    createdAt: NOW,
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

describe('listValidAtChapter：状态边的因果截断', () => {
  it('valid_from < N 纳入，= N 排除（不把本章自己的产物喂回给它）', () => {
    insertState('s-before', 3, null);
    insertState('s-same', 5, null);
    const ids = db
      .getStoryStateRepository()
      .listValidAtChapter('p1', 5)
      .map((row) => row.id);
    expect(ids).toContain('s-before');
    expect(ids).not.toContain('s-same');
  });

  it('未来章的边一律排除（防剧透）', () => {
    insertState('s-future', 9, null);
    expect(db.getStoryStateRepository().listValidAtChapter('p1', 5)).toEqual([]);
  });

  it('valid_until = N 的边仍纳入：它正是第 N 章开篇时的事实', () => {
    // 第 1 章确立、第 5 章被改写：生成第 5 章时"当时"仍是旧状态
    insertState('s-old', 1, 5);
    const ids = db
      .getStoryStateRepository()
      .listValidAtChapter('p1', 5)
      .map((row) => row.id);
    expect(ids).toContain('s-old');
    // 第 6 章视角下它已经过期
    expect(
      db
        .getStoryStateRepository()
        .listValidAtChapter('p1', 6)
        .map((row) => row.id),
    ).not.toContain('s-old');
  });

  it('已关闭且关闭点早于 N 的边被排除', () => {
    insertState('s-closed', 1, 3);
    expect(
      db
        .getStoryStateRepository()
        .listValidAtChapter('p1', 5)
        .map((row) => row.id),
    ).not.toContain('s-closed');
  });

  it('user 覆盖层一并返回（取舍交给检索层）', () => {
    insertState('s-user', 1, null, 'user');
    const rows = db.getStoryStateRepository().listValidAtChapter('p1', 5);
    expect(rows.map((row) => row.id)).toContain('s-user');
    expect(rows.find((row) => row.id === 's-user')?.origin).toBe('user');
  });
});

describe('listOpenAtChapter：线程的时点语义', () => {
  it('opened < N 且未核销 → 纳入；opened = N 排除', () => {
    openThread('t-before', 3, null);
    openThread('t-same', 5, null);
    const ids = db
      .getStoryThreadRepository()
      .listOpenAtChapter('p1', 5)
      .map((row) => row.id);
    expect(ids).toEqual(['t-before']);
  });

  it('closed >= N 的线程在 N 时点仍算未核销', () => {
    openThread('t-closed-later', 1, 7);
    openThread('t-closed-at-n', 1, 5);
    openThread('t-closed-earlier', 1, 3);
    const ids = db
      .getStoryThreadRepository()
      .listOpenAtChapter('p1', 5)
      .map((row) => row.id);
    expect(ids).toContain('t-closed-later');
    expect(ids).toContain('t-closed-at-n');
    expect(ids).not.toContain('t-closed-earlier');
  });

  it('listOpen 回答"现在"，listOpenAtChapter 回答"当时"', () => {
    openThread('t1', 1, 7);
    // 现在（已核销）看不到
    expect(db.getStoryThreadRepository().listOpen('p1')).toEqual([]);
    // 第 5 章当时还没核销
    expect(
      db
        .getStoryThreadRepository()
        .listOpenAtChapter('p1', 5)
        .map((row) => row.id),
    ).toEqual(['t1']);
  });
});
