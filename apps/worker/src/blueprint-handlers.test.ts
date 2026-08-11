/**
 * StoryBlueprint Worker 命令分发测试（GE-5/B7，真实 SQLite）。
 *
 * - blueprint.getState：无 run / 有蓝图未接受 / 已接受 / 失效 / gate·escalation 激活五态
 *   （D-B7-10，镜像 research.getResearchState 的测试纪律）；
 * - blueprint.listChapters：列出蓝图章节（读通道，蓝图行直接经真实 repo 写入种子数据）；
 * - 未知命令 → VALIDATION_ERROR。
 *
 * B7（D-B7-3）：blueprint.generate / blueprint.accept 已从 RPC 面移除——蓝图生成走
 * BLUEPRINT_GENERATE task-backed executor，接受走 graph.applyHumanDecision 的同事务
 * accept（graph-run.ts）。全链证据见 blueprint-e2e.integration.test.ts。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  createProjectId,
  createProjectInitialRunState,
  createWorkflowRunId,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  BLUEPRINT_ESCALATION,
  BLUEPRINT_USER_GATE,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState, StoryBlueprint } from '@ai-novel/domain';
import type { BlueprintStateDto, StoryBlueprintDto } from '@ai-novel/contracts';
import { isValidStoryBlueprintDto } from '@ai-novel/contracts';
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

function makeBlueprint(
  id: string,
  chapters: ReadonlyArray<{ id: string; title: string; goal: string }>,
): StoryBlueprint {
  return {
    id,
    projectId: 'p1',
    version: 1,
    premise: '侦探在雨夜调查悬案',
    characters: [{ name: '侦探', role: '主角', description: '冷静' }],
    relationships: ['侦探——委托人'],
    world: '晚清上海滩',
    conflict: '真相被掩盖',
    ending: '真相大白',
    plotlines: [{ name: '主线', summary: '追查真凶' }],
    chapters,
    createdAt: NOW,
  };
}

interface RunOverrides {
  readonly nodeStatuses?: Partial<IdeaToNovelProjectRunState['nodeStatuses']>;
  readonly artifacts?: Partial<IdeaToNovelProjectRunState['artifacts']>;
  readonly attemptBudget?: IdeaToNovelProjectRunState['attemptBudget'];
  readonly invalidatedArtifacts?: IdeaToNovelProjectRunState['invalidatedArtifacts'];
}

/** 直接插入一个 project run 状态（绕过 Graph 运行时，仅用于投影读测试；镜像 research-handlers.test.ts） */
function insertProjectRun(
  db: ProjectDatabase,
  runId: string,
  createdAt: string,
  overrides: RunOverrides,
): void {
  const base = createProjectInitialRunState({
    graph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    projectId: createProjectId('p1'),
    workflowRunId: createWorkflowRunId(runId),
    createdAt,
  });
  const state: IdeaToNovelProjectRunState = {
    ...base,
    nodeStatuses: {
      ...base.nodeStatuses,
      ...overrides.nodeStatuses,
    } as IdeaToNovelProjectRunState['nodeStatuses'],
    artifacts: {
      ...base.artifacts,
      ...overrides.artifacts,
    } as IdeaToNovelProjectRunState['artifacts'],
    attemptBudget: overrides.attemptBudget ?? base.attemptBudget,
    invalidatedArtifacts: overrides.invalidatedArtifacts ?? base.invalidatedArtifacts,
  };
  db.getGraphRunTransaction().runInTransaction((repos) => {
    repos.graphRunRepo.create(state, createdAt);
  });
}

describe('dispatchBlueprintCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'blueprint-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('blueprint.getState 无 project run 时返回全空态', async () => {
    const state = (await dispatchBlueprintCommand(
      'blueprint.getState',
      { projectId: 'p1' },
      ctx(),
    )) as BlueprintStateDto;
    expect(state).toEqual({
      runId: null,
      blueprintRef: null,
      accepted: false,
      blueprintInvalidated: false,
      gateActive: false,
      escalationActive: false,
      rewriteUsed: 0,
    });
  });

  it('blueprint.getState：有蓝图但未接受，gate 激活', async () => {
    const db = freshDb();
    try {
      db.getStoryBlueprintRepository().save(
        makeBlueprint('bp-1', [{ id: 'ch-1', title: 't', goal: 'g' }]),
        false,
      );
      insertProjectRun(db, 'run-1', NOW, {
        nodeStatuses: { [BLUEPRINT_USER_GATE]: 'waiting_for_human' },
        artifacts: { storyBlueprint: { kind: 'storyBlueprint', artifactId: 'bp-1' } as never },
      });

      const state = (await dispatchBlueprintCommand(
        'blueprint.getState',
        { projectId: 'p1' },
        ctx(),
      )) as BlueprintStateDto;
      expect(state.runId).toBe('run-1');
      expect(state.blueprintRef).toBe('bp-1');
      expect(state.accepted).toBe(false);
      expect(state.gateActive).toBe(true);
      expect(state.escalationActive).toBe(false);
      expect(state.blueprintInvalidated).toBe(false);
    } finally {
      db.close();
    }
  });

  it('blueprint.getState：已接受的蓝图 accepted=true', async () => {
    const db = freshDb();
    try {
      db.getStoryBlueprintRepository().save(
        makeBlueprint('bp-2', [{ id: 'ch-1', title: 't', goal: 'g' }]),
        false,
      );
      db.getStoryBlueprintRepository().markAccepted('p1', 'bp-2');
      insertProjectRun(db, 'run-2', NOW, {
        artifacts: { storyBlueprint: { kind: 'storyBlueprint', artifactId: 'bp-2' } as never },
      });

      const state = (await dispatchBlueprintCommand(
        'blueprint.getState',
        { projectId: 'p1' },
        ctx(),
      )) as BlueprintStateDto;
      expect(state.blueprintRef).toBe('bp-2');
      expect(state.accepted).toBe(true);
    } finally {
      db.close();
    }
  });

  it('blueprint.getState：失效蓝图 blueprintInvalidated=true；escalation 激活；rewriteUsed 反映预算', async () => {
    const db = freshDb();
    try {
      db.getStoryBlueprintRepository().save(
        makeBlueprint('bp-3', [{ id: 'ch-1', title: 't', goal: 'g' }]),
        false,
      );
      insertProjectRun(db, 'run-3', NOW, {
        nodeStatuses: { [BLUEPRINT_ESCALATION]: 'waiting_for_human' },
        artifacts: { storyBlueprint: { kind: 'storyBlueprint', artifactId: 'bp-3' } as never },
        invalidatedArtifacts: [{ kind: 'storyBlueprint', artifactId: 'bp-3' } as never],
        attemptBudget: {
          clarification: 0,
          intakeRevision: 0,
          researchRetry: 0,
          blueprintRewrite: 3,
          specRevision: 0,
        },
      });

      const state = (await dispatchBlueprintCommand(
        'blueprint.getState',
        { projectId: 'p1' },
        ctx(),
      )) as BlueprintStateDto;
      expect(state.blueprintInvalidated).toBe(true);
      expect(state.escalationActive).toBe(true);
      expect(state.gateActive).toBe(false);
      expect(state.rewriteUsed).toBe(3);
    } finally {
      db.close();
    }
  });

  it('blueprint.listChapters 返回蓝图章节（种子数据直写真实 repo）', () => {
    const db = freshDb();
    try {
      db.getStoryBlueprintRepository().save(
        makeBlueprint('bp-4', [
          { id: 'ch-1', title: '第一章', goal: '引出案件' },
          { id: 'ch-2', title: '第二章', goal: '发现线索' },
        ]),
        false,
      );

      const chapters = dispatchBlueprintCommand(
        'blueprint.listChapters',
        { projectId: 'p1', blueprintId: 'bp-4' },
        ctx(),
      ) as ReadonlyArray<{ id: string; title: string }>;
      expect(chapters.map((c) => c.title)).toEqual(['第一章', '第二章']);
    } finally {
      db.close();
    }
  });

  // B8/D-B8-1：蓝图正文读通道。契约上必须是"投影"而非 domain 对象直传——
  // accepted 属状态（BlueprintStateDto 承载），若混进正文 DTO 就有两个事实源，
  // 且 exact-keys 校验会在 preload 侧整包判否。
  it('blueprint.getBlueprint 返回正文投影，且不含 accepted 等状态字段（D-B8-1）', () => {
    const db = freshDb();
    try {
      db.getStoryBlueprintRepository().save(
        makeBlueprint('bp-5', [{ id: 'ch-1', title: '第一章', goal: '引出案件' }]),
        true,
      );

      const dto = dispatchBlueprintCommand(
        'blueprint.getBlueprint',
        { projectId: 'p1', blueprintId: 'bp-5' },
        ctx(),
      ) as StoryBlueprintDto;

      expect(isValidStoryBlueprintDto(dto)).toBe(true);
      expect(Object.keys(dto).sort()).toEqual(
        [
          'chapters',
          'characters',
          'conflict',
          'createdAt',
          'ending',
          'id',
          'plotlines',
          'premise',
          'projectId',
          'relationships',
          'version',
          'world',
        ].sort(),
      );
      expect(dto.premise).toBe('侦探在雨夜调查悬案');
      expect(dto.chapters).toEqual([{ id: 'ch-1', title: '第一章', goal: '引出案件' }]);
      expect(dto.characters).toEqual([{ name: '侦探', role: '主角', description: '冷静' }]);
    } finally {
      db.close();
    }
  });

  it('blueprint.getBlueprint 蓝图不存在 → null（UI 走"内容暂时不可用"分支）', () => {
    expect(
      dispatchBlueprintCommand(
        'blueprint.getBlueprint',
        { projectId: 'p1', blueprintId: 'bp-missing' },
        ctx(),
      ),
    ).toBe(null);
  });

  it('blueprint.getBlueprint 缺 blueprintId → VALIDATION_ERROR', () => {
    expect(() =>
      dispatchBlueprintCommand('blueprint.getBlueprint', { projectId: 'p1' }, ctx()),
    ).toThrow();
  });

  it('未知命令 → VALIDATION_ERROR', () => {
    expect(() =>
      dispatchBlueprintCommand('blueprint.generate', { projectId: 'p1' }, ctx()),
    ).toThrow(/未知命令/);
  });

  it('缺少 projectId → VALIDATION_ERROR', () => {
    expect(() => dispatchBlueprintCommand('blueprint.getState', {}, ctx())).toThrow();
  });
});
