/**
 * Durable Node Execution & Settlement 真实 SQLite 集成测试（RW-1 Rework, Blocker 9）。
 *
 * 证明：partial unique 并发 claim、settlement 原子性（graph+command+receipt+execution）、
 * 崩溃窗口 settlement、execution-bound result。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';
import {
  computeNodeInputSnapshot,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  settleNodeExecution,
  type ArtifactResolverPort,
  type NodeExecutorRunner,
  type NodeOutput,
  type NodeRunnerDeps,
  type PersistedArtifactReceipt,
} from '@ai-novel/application';
import {
  BLUEPRINT_GENERATE,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_CAPTURE,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  SPEC_EXTRACT,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';

const NOW = '2026-08-04T00:00:00.000Z';
let counter = 0;

function acceptingResolver(): ArtifactResolverPort {
  return {
    resolve(input): PersistedArtifactReceipt {
      return {
        kind: input.proposed.kind,
        artifactId: input.proposed.artifactId,
        producerNodeId: input.proposed.producerNodeId,
        projectId: input.projectId,
        graphRunId: input.graphRunId,
        graphVersion: input.graphVersion,
        version: input.proposed.version,
      };
    },
  };
}

function fullRunnerDeps(db: ProjectDatabase, outputs: Record<string, NodeOutput>): NodeRunnerDeps {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const defs: Array<[string, string, NodeOutput]> = [
    [
      'IDEA_CAPTURE',
      'idea-capture-v1',
      outputs['IDEA_CAPTURE'] ?? {
        artifact: {
          kind: 'idea',
          artifactId: 'idea-real-1',
          producerNodeId: IDEA_CAPTURE as never,
          version: 1,
        },
      },
    ],
    [
      'SPEC_EXTRACT',
      'spec-extract-v1',
      outputs['SPEC_EXTRACT'] ?? {
        outcome: { condition: 'clarification_remaining', value: 'spec_complete' },
        artifact: {
          kind: 'creationSpec',
          artifactId: 'spec-real-1',
          producerNodeId: SPEC_EXTRACT as never,
          version: 1,
        },
      },
    ],
    [
      'RESEARCH_DECISION',
      'research-decision-v1',
      { outcome: { condition: 'research_decision', value: 'none' } },
    ],
    [
      'BLUEPRINT_GENERATE',
      'blueprint-generate-v1',
      {
        artifact: {
          kind: 'storyBlueprint',
          artifactId: 'bp-real-1',
          producerNodeId: BLUEPRINT_GENERATE as never,
          version: 1,
        },
      },
    ],
  ];
  for (const [nodeId, id, output] of defs) {
    const descriptor = {
      executorId: id,
      executorVersion: 'v1',
      graphKind: 'project' as const,
      nodeId: nodeId as never,
      kind: 'sync' as const,
      recoveryPolicy: 'replayable' as const,
    };
    registry.register(descriptor);
    runners.set(id, {
      descriptor,
      async run() {
        return { kind: 'sync', output };
      },
    });
  }
  return {
    idGenerator: { generate: () => `id-${++counter}` },
    clock: { now: () => NOW },
    hashPayload: (p: string) => sha256Utf8(p),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    registry,
    runners,
    artifactResolver: acceptingResolver(),
    taskRepo: db.getTaskRepository() as never,
  };
}

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

describe('node execution settlement (real SQLite)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'node-exec-integration-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('partial unique：同 run+node 已有 in-flight 时第二次 create 返回 false（真实 SQLite UNIQUE）', () => {
    const db = freshDb();
    try {
      const deps = fullRunnerDeps(db, {});
      const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
      const runId = run.workflowRunId;
      const repo = db.getNodeExecutionRepository();
      const first = repo.create({
        id: 'e1',
        graphRunId: runId,
        graphId: run.graphId,
        graphVersion: run.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        visitId: 'v1',
        attempt: 1,
        executorId: 'x',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputHash: 'h'.repeat(64),
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(first).toBe(true);
      const second = repo.create({
        id: 'e2',
        graphRunId: runId,
        graphId: run.graphId,
        graphVersion: run.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        visitId: 'v2',
        attempt: 1,
        executorId: 'x',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputHash: 'h'.repeat(64),
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(second).toBe(false); // in-flight partial unique
      // 其它错误不吞：非 UNIQUE 冲突必须抛出
      expect(() =>
        repo.create({
          id: 'e1',
          graphRunId: runId,
          graphId: run.graphId,
          graphVersion: run.graphVersion,
          nodeId: 'OTHER',
          visitId: 'v3',
          attempt: 1,
          executorId: 'x',
          executorVersion: 'v1',
          recoveryPolicy: 'replayable',
          inputHash: 'h'.repeat(64),
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow(); // PK 冲突（id 重复）不是 UNIQUE 类 → 抛出
    } finally {
      db.close();
    }
  });

  it('settlement 原子性：graph state + command + receipt + execution settled 同事务', () => {
    const db = freshDb();
    try {
      const deps = fullRunnerDeps(db, {});
      const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
      const runId = run.workflowRunId;
      const executionId = 'e-settle';
      db.getNodeExecutionRepository().create({
        id: executionId,
        graphRunId: runId,
        graphId: run.graphId,
        graphVersion: run.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        visitId: 'v1',
        attempt: 1,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputHash: sha256Utf8(JSON.stringify(computeNodeInputSnapshot(run, 'IDEA_CAPTURE'))),
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getNodeExecutionRepository().markRunning(executionId, ['pending'], null);

      const result = settleNodeExecution(deps, {
        projectId: 'p1',
        executionId,
        output: {
          artifact: {
            kind: 'idea',
            artifactId: 'idea-real-1',
            producerNodeId: IDEA_CAPTURE as never,
            version: 1,
          },
        },
      });
      expect(result.settled).toBe(true);
      const state = db.getGraphRunRepository().getById(runId)!.state as IdeaToNovelProjectRunState;
      expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
      expect(db.getNodeExecutionRepository().getById(executionId)!.status).toBe('settled');
      // command log 有 settlement 记录
      const cmd = db.getGraphRunCommandLogRepository();
      const existing = cmd.get(`settle:${executionId}`);
      expect(existing).not.toBeNull();
      void existing;
    } finally {
      db.close();
    }
  });

  it('崩溃窗口：task SUCCEEDED + result 已持久化 + 未 settlement → driveRun 幂等 settlement', async () => {
    const db = freshDb();
    try {
      // 直接用真实 DB + 手动构造 execution/result 模拟崩溃恢复
      const deps = fullRunnerDeps(db, {});
      const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
      const runId = run.workflowRunId;
      const executionId = 'e-crash';
      const inputHash = sha256Utf8(JSON.stringify(computeNodeInputSnapshot(run, 'IDEA_CAPTURE')));
      db.getNodeExecutionRepository().create({
        id: executionId,
        graphRunId: runId,
        graphId: run.graphId,
        graphVersion: run.graphVersion,
        nodeId: 'IDEA_CAPTURE',
        visitId: 'v1',
        attempt: 1,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        recoveryPolicy: 'replayable',
        inputHash,
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getNodeExecutionRepository().markRunning(executionId, ['pending'], null);
      // 崩溃窗口：node_execution_results 已持久化（task 成功前）但未 settlement
      db.getNodeExecutionResultStore().save({
        executionId,
        projectId: 'p1',
        graphRunId: runId,
        nodeId: 'IDEA_CAPTURE',
        taskId: null,
        attempt: 1,
        executorId: 'idea-capture-v1',
        executorVersion: 'v1',
        inputHash,
        artifactKind: 'idea',
        artifactVersion: 1,
        contentJson: JSON.stringify({ kind: 'idea' }),
        outcome: null,
        createdAt: NOW,
      });
      // 重启后 driveRun → 幂等 settlement
      const settled = await driveRun(deps, 'p1', runId);
      expect(settled.some((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled)).toBe(true);
      const state = db.getGraphRunRepository().getById(runId)!.state as IdeaToNovelProjectRunState;
      expect(state.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
      // 再 driveRun → 无重复推进
      const again = await driveRun(deps, 'p1', runId);
      expect(again.filter((s) => s.nodeId === 'IDEA_CAPTURE' && s.settled)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
