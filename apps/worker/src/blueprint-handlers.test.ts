/**
 * StoryBlueprint Worker 命令分发测试（GE-5，真实 SQLite）。
 *
 * - blueprint.generate：生成并持久化 StoryBlueprint；
 * - blueprint.accept：显式接受 → accepted；
 * - blueprint.listChapters：列出蓝图章节。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import type { StoryBlueprint } from '@ai-novel/domain';
import { dispatchBlueprintCommand, type BlueprintHandlerContext } from './blueprint-handlers.js';

const NOW = '2026-08-04T00:00:00.000Z';
let counter = 0;

let tempDir: string;
let dbPath: string;

function freshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

function ctx(): BlueprintHandlerContext {
  return {
    getProjectDb: () => freshDb(),
    idGenerator: {
      generate: () => {
        counter += 1;
        return `bp-${counter}`;
      },
    },
    clock: { now: () => NOW },
  };
}

describe('dispatchBlueprintCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'blueprint-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('blueprint.generate 生成并持久化 StoryBlueprint', () => {
    const blueprint = dispatchBlueprintCommand(
      'blueprint.generate',
      {
        projectId: 'p1',
        premise: '侦探在雨夜调查悬案',
        world: '晚清上海滩',
        conflict: '真相被掩盖',
        ending: '真相大白',
        characters: [{ name: '侦探', role: '主角', description: '冷静' }],
        relationships: ['侦探——委托人'],
        plotlines: [{ name: '主线', summary: '追查真凶' }],
        chapters: [
          { id: 'ch-1', title: '第一章', goal: '引出案件' },
          { id: 'ch-2', title: '第二章', goal: '发现线索' },
        ],
      },
      ctx(),
    ) as StoryBlueprint;

    expect(blueprint.premise).toBe('侦探在雨夜调查悬案');
    expect(blueprint.chapters).toHaveLength(2);
    expect(blueprint.version).toBe(1);

    const saved = freshDb().getStoryBlueprintRepository().getById('p1', blueprint.id);
    expect(saved?.blueprint.chapters).toHaveLength(2);
    expect(saved?.accepted).toBe(false);
  });

  it('blueprint.accept 显式接受；listChapters 返回章节', () => {
    const blueprint = dispatchBlueprintCommand(
      'blueprint.generate',
      {
        projectId: 'p1',
        premise: 'p',
        world: 'w',
        conflict: '',
        ending: '',
        relationships: [],
        characters: [],
        plotlines: [],
        chapters: [{ id: 'ch-1', title: '第一章', goal: 'g' }],
      },
      ctx(),
    ) as StoryBlueprint;

    const accepted = dispatchBlueprintCommand(
      'blueprint.accept',
      { projectId: 'p1', blueprintId: blueprint.id },
      ctx(),
    );
    expect(accepted).toBe(true);

    const chapters = dispatchBlueprintCommand(
      'blueprint.listChapters',
      { projectId: 'p1', blueprintId: blueprint.id },
      ctx(),
    ) as ReadonlyArray<{ id: string; title: string }>;
    expect(chapters.map((c) => c.title)).toEqual(['第一章']);
  });

  it('缺少 premise → VALIDATION_ERROR', () => {
    expect(() =>
      dispatchBlueprintCommand(
        'blueprint.generate',
        { projectId: 'p1', world: 'w', chapters: [] },
        ctx(),
      ),
    ).toThrow();
  });
});
