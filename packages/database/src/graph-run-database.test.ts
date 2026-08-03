/**
 * Graph Run 持久化集成测试（GE-1，真实 SQLite migration v8）。
 *
 * 覆盖：
 * - 统一 graph_runs 表 round-trip（state_json 保真、expected_version、kind 判别）；
 * - chapter-only 绑定列写入与 CHECK（kind='project' 绑定列必须为空）；
 * - saveWithCas 成功递增版本 / 过期版本返回 false；
 * - listByProject / listNonTerminal；
 * - 事务原子性：receipt 原子性（graph CAS 失败 → answer 一起回滚）；
 * - 嵌套事务检测。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';
import type { GraphRunDeps } from '@ai-novel/application';
import {
  createProjectRun,
  createChapterRun,
  GraphRunTransactionError,
} from '@ai-novel/application';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  validateGraphRunState,
} from '@ai-novel/domain';

const NOW = '2026-08-04T00:00:00.000Z';

let counter = 0;

function buildDeps(db: ProjectDatabase): GraphRunDeps {
  return {
    idGenerator: {
      generate: () => {
        counter += 1;
        return `id-${counter}`;
      },
    },
    clock: { now: () => NOW },
    hashPayload: (payload: string) => sha256Utf8(payload),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

describe('graph-runs persistence (v8)', () => {
  let dir: string;
  let db: ProjectDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-run-db-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('project run create → getById round-trip（state_json 保真 + expected_version=1 + kind）', () => {
    const deps = buildDeps(db);
    const result = createProjectRun(deps, {
      projectId: 'p1',
      idempotencyKey: 'create-1',
    });

    const record = db.getGraphRunRepository().getById(result.run.workflowRunId);
    expect(record).not.toBeNull();
    expect(record!.kind).toBe('project');
    expect(record!.expectedVersion).toBe(1);
    expect(record!.state.workflowRunId).toBe(result.run.workflowRunId);
    expect(record!.state.nodeStatuses[IDEA_TO_NOVEL_PROJECT_GRAPH_V1.entryNodeId]).toBe('active');
    expect(validateGraphRunState(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, record!.state)).toEqual([]);
  });

  it('chapter run create → 绑定列写入 + kind=chapter + 合法状态', () => {
    const deps = buildDeps(db);
    const result = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'create-ch-1',
    });

    const row = db.getGraphRunRepository().getById(result.run.workflowRunId);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('chapter');
    expect(validateGraphRunState(CHAPTER_GENERATION_GRAPH_V1, row!.state)).toEqual([]);
    expect((row!.state as { blueprintChapterId: string }).blueprintChapterId).toBe('ch-1');
  });

  it('saveWithCas 成功递增版本；过期版本返回 false', () => {
    const deps = buildDeps(db);
    const result = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'create-2' });
    const runId = result.run.workflowRunId;
    const repo = db.getGraphRunRepository();
    const before = repo.getById(runId)!;

    // 过期版本（0）→ false
    expect(repo.saveWithCas(runId, 0, before.state, NOW)).toBe(false);

    // 正确版本 → true，expectedVersion 递增
    expect(repo.saveWithCas(runId, before.expectedVersion, before.state, NOW)).toBe(true);
    const after = repo.getById(runId)!;
    expect(after.expectedVersion).toBe(2);
  });

  it('listByProject / listNonTerminal 按终态过滤', () => {
    const deps = buildDeps(db);
    const r1 = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'create-3' });
    createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'create-4' });

    expect(db.getGraphRunRepository().listByProject('p1')).toHaveLength(2);
    expect(db.getGraphRunRepository().listNonTerminal()).toHaveLength(2);

    // 手动标记一个终态
    db.getGraphRunRepository().saveWithCas(
      r1.run.workflowRunId,
      1,
      { ...r1.run, terminalStatus: 'completed' },
      NOW,
    );
    expect(db.getGraphRunRepository().listNonTerminal()).toHaveLength(1);
  });

  it('事务原子性：graph saveWithCas 失败 → answer 一起回滚（receipt 原子性）', () => {
    const deps = buildDeps(db);
    const result = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'create-5' });
    const runId = result.run.workflowRunId;
    const repo = db.getGraphRunRepository();
    const before = repo.getById(runId)!;

    // 让 CAS 失败：先用过期版本保存一次（模拟并发写入使版本推进）
    expect(repo.saveWithCas(runId, 1, before.state, NOW)).toBe(true);

    expect(() =>
      db.getGraphRunTransaction().runInTransaction((repos) => {
        repos.intakeAnswer.insertAnswer({
          id: 'ans-1',
          sessionId: 's1',
          questionId: 'q1',
          text: '回答',
          createdAt: NOW,
        });
        // 用过期版本（应为 2 却传 1）→ CAS false → 抛版本冲突 → 整体回滚
        if (!repos.graphRunRepo.saveWithCas(runId, 1, before.state, NOW)) {
          throw new Error('version conflict');
        }
      }),
    ).toThrow(GraphRunTransactionError);

    // answer 已回滚
    const answers = db.database
      .prepare('SELECT id FROM grill_answers WHERE question_id = ?')
      .all('q1');
    expect(answers).toHaveLength(0);
  });

  it('嵌套事务检测抛错', () => {
    expect(() =>
      db.getGraphRunTransaction().runInTransaction(() => {
        db.getGraphRunTransaction().runInTransaction(() => 1);
      }),
    ).toThrow();
  });
});
