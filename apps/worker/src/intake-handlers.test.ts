/**
 * Idea Intake Worker 命令分发测试（GE-3，真实 SQLite）。
 *
 * - intake.createIntakeSession：initial_idea 播种进会话目标；
 * - intake.getActiveIntakeSession：读取当前 ACTIVE 会话；
 * - intake.propagateSpecInvalidation：CreationSpec 更新 → 项目 run 的 researchBundle/
 *   storyBlueprint 失效。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  createProjectRun,
  runFakeUntilHumanOrTerminal,
  type GraphRunDeps,
} from '@ai-novel/application';
import type { GrillHandlerContext } from './grill-handlers.js';
import { dispatchIntakeCommand } from './intake-handlers.js';
import {
  BLUEPRINT_USER_GATE,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
  RESEARCH_DECISION,
} from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';

const NOW = '2026-08-04T00:00:00.000Z';

let tempDir: string;
let dbPath: string;
let counter = 0;

function freshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个侦探在雨夜调查悬案',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

function graphDeps(db: ProjectDatabase): GraphRunDeps {
  return {
    idGenerator: {
      generate: () => {
        counter += 1;
        return `id-${counter}`;
      },
    },
    clock: { now: () => NOW },
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

function ctx(): GrillHandlerContext {
  return {
    getProjectDb: () => freshDb(),
    idGenerator: { generate: () => `gid-${counter}` },
    clock: { now: () => NOW },
  };
}

describe('dispatchIntakeCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'intake-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('intake.createIntakeSession 播种 initial_idea；getActiveIntakeSession 读取', () => {
    const session = dispatchIntakeCommand(
      'intake.createIntakeSession',
      { projectId: 'p1', initialIdea: '一个侦探在雨夜调查悬案' },
      ctx(),
    ) as { goal: string; status: string };
    expect(session.goal).toBe('一个侦探在雨夜调查悬案');
    expect(session.status).toBe('ACTIVE');

    const active = dispatchIntakeCommand(
      'intake.getActiveIntakeSession',
      { projectId: 'p1' },
      ctx(),
    ) as { goal: string } | null;
    expect(active?.goal).toBe('一个侦探在雨夜调查悬案');
  });

  it('intake.propagateSpecInvalidation：researchBundle/storyBlueprint 失效', () => {
    const db = freshDb();
    try {
      const deps = graphDeps(db);
      const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
      const stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {
        [RESEARCH_DECISION]: { outcome: 'light' },
      });
      expect(stop.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      const results = dispatchIntakeCommand(
        'intake.propagateSpecInvalidation',
        { projectId: 'p1', creationSpecVersionId: 'spec-v2' },
        ctx(),
      ) as ReadonlyArray<{ runId: string; invalidatedKinds: string[] }>;
      expect(results).toHaveLength(1);
      expect(results[0].invalidatedKinds).toEqual(
        expect.arrayContaining(['researchBundle', 'storyBlueprint']),
      );
    } finally {
      db.close();
    }
  });

  it('非法输入 → VALIDATION_ERROR', () => {
    expect(() =>
      dispatchIntakeCommand('intake.createIntakeSession', { projectId: '' }, ctx()),
    ).toThrow();
  });
});
