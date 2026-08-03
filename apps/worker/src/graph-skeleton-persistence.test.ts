/**
 * 双 Graph Walking Skeleton 真实持久化测试（GE-2，真实 SQLite）。
 *
 * 证明骨架在持久化内核上跑通全路径，且跨重启可恢复：
 * - Project happy path → PROJECT_READY（真实 DB）；
 * - Chapter happy path → CHAPTER_READY（真实 DB）；
 * - 重启恢复：active 节点（执行器中断）→ failed，run 终态；waiting_for_human 不触碰。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  advanceNode,
  applyHumanDecision,
  createProjectRun,
  createChapterRun,
  recoverInFlightRuns,
  runFakeUntilHumanOrTerminal,
  type GraphRunDeps,
} from '@ai-novel/application';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  BLUEPRINT_USER_GATE,
  CANDIDATE_GATE,
  IDEA_CAPTURE,
  PROJECT_READY,
  SPEC_EXTRACT,
  MANUSCRIPT_COMMIT,
  CHAPTER_READY,
  COLLECT_ANSWER,
  ASK_QUESTION,
} from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';

const NOW = '2026-08-04T00:00:00.000Z';

let tempDir: string;
let dbPath: string;
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
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

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

describe('Graph walking skeleton (real SQLite)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'graph-skeleton-real-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Project happy path 在真实 DB 上跑到 PROJECT_READY', () => {
    const db = freshDb();
    try {
      const deps = buildDeps(db);
      const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });

      const atGate = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
      expect(atGate.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

      applyHumanDecision(deps, {
        kind: 'gate',
        runId: run.workflowRunId,
        nodeId: BLUEPRINT_USER_GATE,
        outcome: 'accept',
        idempotencyKey: 'gate1',
      });
      const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
      expect(done.state.terminalStatus).toBe('completed');
      expect(done.state.nodeStatuses[PROJECT_READY]).toBe('succeeded');
    } finally {
      db.close();
    }
  });

  it('Chapter happy path 在真实 DB 上跑到 CHAPTER_READY', () => {
    const db = freshDb();
    try {
      const deps = buildDeps(db);
      const { run } = createChapterRun(deps, {
        projectId: 'p1',
        creationSpecVersionId: 'spec-1',
        researchBundleId: null,
        storyBlueprintId: 'bp-1',
        blueprintChapterId: 'ch-1',
        idempotencyKey: 'cch1',
      });

      const atGate = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
      expect(atGate.state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);

      applyHumanDecision(deps, {
        kind: 'gate',
        runId: run.workflowRunId,
        nodeId: CANDIDATE_GATE,
        outcome: 'accept',
        idempotencyKey: 'cand1',
      });
      const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
      expect(done.state.terminalStatus).toBe('completed');
      expect(done.state.nodeStatuses[MANUSCRIPT_COMMIT]).toBe('succeeded');
      expect(done.state.nodeStatuses[CHAPTER_READY]).toBe('succeeded');
    } finally {
      db.close();
    }
  });

  it('重启恢复：active 节点 → failed；waiting_for_human 不触碰', () => {
    let db = freshDb();
    let deps = buildDeps(db);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    // 推进到 SPEC_EXTRACT active（模拟执行器已开始但未提交完成 → 中断）
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'a1',
    });
    db.close(); // 模拟应用退出

    // 重启：重新打开，recoverInFlightRuns 应把 active 的 SPEC_EXTRACT 标为 failed
    db = freshDb();
    deps = buildDeps(db);
    try {
      recoverInFlightRuns(deps);
      const record = deps.tx.runInTransaction((repos) =>
        repos.graphRunRepo.getById(run.workflowRunId),
      );
      expect(record!.state.terminalStatus).toBe('failed');
      expect(record!.state.nodeStatuses[SPEC_EXTRACT]).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('重启恢复：waiting_for_human（人工 Gate）不触碰，保持非终态', () => {
    let db = freshDb();
    let deps = buildDeps(db);
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: IDEA_CAPTURE,
      artifactRef: { kind: 'idea', artifactId: 'idea-1' },
      idempotencyKey: 'a1',
    });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: SPEC_EXTRACT,
      outcome: { condition: 'clarification_remaining', value: 'ask_more' },
      artifactRef: { kind: 'creationSpec', artifactId: 'spec-1' },
      idempotencyKey: 'a2',
    });
    advanceNode(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      nodeId: ASK_QUESTION,
      idempotencyKey: 'a3',
    });
    // 现在应停在 COLLECT_ANSWER（waiting_for_human）
    db.close();

    db = freshDb();
    deps = buildDeps(db);
    try {
      recoverInFlightRuns(deps);
      const record = deps.tx.runInTransaction((repos) =>
        repos.graphRunRepo.getById(run.workflowRunId),
      );
      expect(record!.state.terminalStatus).toBeNull();
      expect(record!.state.nodeStatuses[COLLECT_ANSWER]).toBe('waiting_for_human');
    } finally {
      db.close();
    }
  });
});
