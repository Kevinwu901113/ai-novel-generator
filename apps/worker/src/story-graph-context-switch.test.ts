/**
 * 图检索开关的装配测试（D14 / B23，D-B23-7）。
 *
 * 关掉时**依赖里根本没有这个字段**，而不是"有依赖但运行时跳过"——
 * dogfood 双臂对照要的就是这种干净两态。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { buildGraphTaskRunnerDeps, isStoryGraphContextEnabled } from './index.js';

const NOW = '2026-08-19T00:00:00.000Z';

let dir: string;
let projDb: ProjectDatabase;
const original = process.env.AI_NOVEL_STORY_GRAPH_CONTEXT;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-graph-switch-'));
  projDb = new ProjectDatabase(join(dir, 'project.sqlite'));
  projDb.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
});

afterEach(() => {
  if (original === undefined) delete process.env.AI_NOVEL_STORY_GRAPH_CONTEXT;
  else process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = original;
  try {
    projDb.close();
  } catch {
    // 已关闭
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('AI_NOVEL_STORY_GRAPH_CONTEXT 开关', () => {
  it('缺省开；只有 off（大小写与空白不敏感）关', () => {
    delete process.env.AI_NOVEL_STORY_GRAPH_CONTEXT;
    expect(isStoryGraphContextEnabled()).toBe(true);
    process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = 'off';
    expect(isStoryGraphContextEnabled()).toBe(false);
    process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = ' OFF ';
    expect(isStoryGraphContextEnabled()).toBe(false);
    process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = 'on';
    expect(isStoryGraphContextEnabled()).toBe(true);
    process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = '';
    expect(isStoryGraphContextEnabled()).toBe(true);
  });

  it('开关关闭时章节任务依赖里没有 storyGraphContext', () => {
    process.env.AI_NOVEL_STORY_GRAPH_CONTEXT = 'off';
    const deps = buildGraphTaskRunnerDeps().buildEngineDeps(projDb);
    expect('storyGraphContext' in deps ? deps.storyGraphContext : undefined).toBeUndefined();
  });

  it('缺省（开）时依赖装配齐三路召回所需的仓库', () => {
    delete process.env.AI_NOVEL_STORY_GRAPH_CONTEXT;
    const deps = buildGraphTaskRunnerDeps().buildEngineDeps(projDb);
    const storyGraph = deps.storyGraphContext;
    expect(storyGraph).toBeDefined();
    expect(typeof storyGraph!.graphRepo.loadPriorContext).toBe('function');
    expect(typeof storyGraph!.stateRepo.listValidAtChapter).toBe('function');
    expect(typeof storyGraph!.threadRepo.listOpenAtChapter).toBe('function');
    expect(typeof storyGraph!.searchRepo.searchFts).toBe('function');
    expect(typeof storyGraph!.embeddingRepo.listAll).toBe('function');
    expect(typeof storyGraph!.invokeEmbedding).toBe('function');
  });
});
