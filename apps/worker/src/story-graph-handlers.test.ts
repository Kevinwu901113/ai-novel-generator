/**
 * storyGraph.rebuild 命令处理器测试（D14 / B22，D-B22-6）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase, sha256Utf8 } from '@ai-novel/database';
import {
  AppError,
  createChapter,
  createChapterVersion,
  getOrCreateManuscript,
} from '@ai-novel/application';
import { TaskRepositoryAdapter } from './index.js';
import {
  dispatchStoryGraphCommand,
  type StoryGraphHandlerContext,
} from './story-graph-handlers.js';

const NOW = '2026-08-19T00:00:00.000Z';

let dir: string;
let dbPath: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function openDb(): ProjectDatabase {
  return new ProjectDatabase(dbPath);
}

function ctx(pumped?: string[]): StoryGraphHandlerContext {
  return {
    getProjectDb: () => openDb(),
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    idGenerator,
    clock,
    pumpExtract: (projectId: string) => {
      pumped?.push(projectId);
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-graph-handlers-'));
  dbPath = join(dir, 'project.sqlite');
  idCounter = 0;
  const db = openDb();
  try {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'drafting',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const deps = {
      transactionPort: db.getManuscriptTransaction(),
      sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
    };
    getOrCreateManuscript(deps, { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
    for (const [chapterId, content] of [
      ['c1', '第一章正文'],
      ['c2', '第二章正文'],
    ]) {
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
        title: chapterId,
        content,
        expectedCurrentVersionId: null,
        now: NOW,
        newVersionId: `v-${chapterId}`,
      });
    }
  } finally {
    db.close();
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('storyGraph.rebuild', () => {
  it('清空 extracted 层、逐章入队，并触发一次串行泵', () => {
    let db = openDb();
    db.getStoryEntityRepository().create({
      id: 'e-auto',
      projectId: 'p1',
      kind: 'character',
      canonicalName: '林三',
      profileSummary: '自动抽的',
      firstChapter: 1,
      origin: 'extracted',
      createdAt: NOW,
    });
    db.close();

    const pumped: string[] = [];
    const result = dispatchStoryGraphCommand(
      'storyGraph.rebuild',
      { projectId: 'p1' },
      ctx(pumped),
    ) as Record<string, number>;

    expect(result.clearedEntities).toBe(1);
    expect(result.enqueuedChapters).toBe(2);
    expect(result.skippedChapters).toBe(0);
    expect(pumped).toEqual(['p1']);

    db = openDb();
    try {
      expect(db.getStoryEntityRepository().getById('p1', 'e-auto')).toBeNull();
      const pending = db
        .getTaskRepository()
        .listByStatus('PENDING')
        .filter((t) => t.taskType === 'STORY_GRAPH_EXTRACT');
      expect(pending).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('非法输入与未知命令都被拒', () => {
    expect(() => dispatchStoryGraphCommand('storyGraph.rebuild', {}, ctx())).toThrow(AppError);
    expect(() =>
      dispatchStoryGraphCommand('storyGraph.rebuild', { projectId: 'p1', extra: 1 }, ctx()),
    ).toThrow(AppError);
    expect(() => dispatchStoryGraphCommand('storyGraph.nope', { projectId: 'p1' }, ctx())).toThrow(
      AppError,
    );
  });
});
