/**
 * Worker 启动恢复集成测试（RW-1-R5, Blocker 2）。
 *
 * 证明：
 * - 生产恢复（runProjectRecovery）对 durable PENDING 的 Graph task 真正调度
 *   （scheduleTask 被调用；不是 no-op）；
 * - 单个损坏项目不阻断其他项目恢复（每项目 try 隔离）；
 * - READY 门禁语义：恢复（含调度）完成才进入就绪（这里验证恢复阶段调度发生，
 *   进程级 READY 顺序由 initialize → await recoverGraphRuns → sendToParent 保证）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  createChapterRun,
  createProjectRun,
  driveRun,
  ExecutorRegistry,
  type ArtifactResolverPort,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
  type PersistedArtifactReceipt,
} from '@ai-novel/application';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  DRAFT,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
} from '@ai-novel/domain';
import {
  bootWorkerStartup,
  runProjectRecovery,
  type RecoveryProject,
} from './recovery-bootstrap.js';
import { sha256Hex } from '@ai-novel/task-engine';

const NOW = '2026-08-04T00:00:00.000Z';

let tempDir: string;

function permissiveResolver(): ArtifactResolverPort {
  return {
    resolve(_repos, input): PersistedArtifactReceipt {
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

/** 构造带 DRAFT task-backed executor 的 runner deps（与创建时的注册一致） */
function buildRecoveryRunnerDeps(
  projDb: ProjectDatabase,
  scheduleTask: (taskId: string) => void,
): NodeRunnerDeps {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  const plan = {
    descriptor: {
      executorId: 'chapter-plan-v1',
      executorVersion: 'v1',
      graphKind: 'chapter' as const,
      nodeId: 'CHAPTER_PLAN' as never,
      kind: 'sync' as const,
      recoveryPolicy: 'replayable' as const,
    },
    execute: () => ({}),
  };
  const draft = {
    descriptor: {
      executorId: 'chapter-draft-v1',
      executorVersion: 'v1',
      graphKind: 'chapter' as const,
      nodeId: DRAFT as never,
      kind: 'task_backed' as const,
      recoveryPolicy: 'settle_if_result' as const,
    },
    prepareTask: () => ({ taskType: 'CHAPTER_DRAFT' as const, payloadJson: '{}' }),
  };
  registry.register(plan.descriptor);
  registry.register(draft.descriptor);
  runners.set(plan.descriptor.executorId, plan);
  runners.set(draft.descriptor.executorId, draft);
  const now = () => NOW;
  return {
    idGenerator: { generate: () => `recover-id-${Math.random().toString(36).slice(2)}` },
    clock: { now },
    hashPayload: (p: string) => sha256Hex(p),
    tx: projDb.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    registry,
    runners,
    artifactResolver: permissiveResolver(),
    runnerId: 'test-recovery',
    scheduleTask,
  };
}

/** 在真实 DB 上创建一个 chapter run 并推进到 DRAFT（task PENDING），返回 taskId */
async function seedPendingDraftTask(dbDir: string, projectId: string): Promise<{ taskId: string }> {
  const db = new ProjectDatabase(join(dbDir, 'project.sqlite'));
  try {
    db.getProjectMetadataRepository().create({
      id: projectId,
      name: '项目',
      initialIdea: '故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const deps = buildRecoveryRunnerDeps(db, () => {});
    const { run } = createChapterRun(deps, {
      projectId,
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: `seed-${projectId}`,
    });
    await driveRun(deps, projectId, run.workflowRunId);
    const exec = db.getNodeExecutionRepository().getInFlightByRunNode(run.workflowRunId, 'DRAFT');
    if (!exec || exec.taskId === null) {
      throw new Error('seed 失败：无 DRAFT execution/task');
    }
    return { taskId: exec.taskId };
  } finally {
    db.close();
  }
}

describe('runProjectRecovery（Blocker 2：PENDING 调度 + 项目隔离）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worker-recovery-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('PENDING Graph task 在恢复中被真正调度；损坏项目不阻断其他项目', async () => {
    // 项目 A：正常（DRAFT task PENDING）
    const dirA = join(tempDir, 'projects', 'proj-a');
    const dirB = join(tempDir, 'projects', 'proj-b');
    const fs = await import('node:fs');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const { taskId } = await seedPendingDraftTask(dirA, 'proj-a');
    // 项目 B：损坏（project.sqlite 是垃圾字节）→ openProjectDb 抛错
    writeFileSync(join(dirB, 'project.sqlite'), 'this is not a sqlite database');

    const projects: RecoveryProject[] = [
      { projectId: 'proj-b', projectDirectory: dirB }, // 先坏后好，证明隔离
      { projectId: 'proj-a', projectDirectory: dirA },
    ];
    const scheduled: Array<{ projectId: string; taskId: string }> = [];
    const openAttempted: string[] = [];

    await runProjectRecovery({
      listProjects: () => projects,
      openProjectDb: (dbPath) => {
        // 记录打开尝试（证明两个项目都被处理）
        openAttempted.push(dbPath.includes('proj-b') ? 'proj-b' : 'proj-a');
        return new ProjectDatabase(dbPath);
      },
      buildRunnerDeps: (projDb, projectId) =>
        buildRecoveryRunnerDeps(projDb, (tid) => scheduled.push({ projectId, taskId: tid })),
    });

    // 坏项目不阻断：好项目 A 的 PENDING task 被真正调度
    expect(scheduled.some((s) => s.taskId === taskId && s.projectId === 'proj-a')).toBe(true);
    // 两个项目都被打开尝试（B 打开失败被隔离，A 正常）
    expect(openAttempted).toContain('proj-b');
    expect(openAttempted).toContain('proj-a');
  });

  it('bootWorkerStartup：READY 只在恢复（含 PENDING 调度）完成后发出', async () => {
    const dirA = join(tempDir, 'projects', 'proj-ready');
    const fs = await import('node:fs');
    fs.mkdirSync(dirA, { recursive: true });
    const { taskId } = await seedPendingDraftTask(dirA, 'proj-ready');
    const scheduled: Array<{ projectId: string; taskId: string }> = [];
    const order: string[] = [];
    await bootWorkerStartup(
      {
        listProjects: () => [{ projectId: 'proj-ready', projectDirectory: dirA }],
        openProjectDb: (dbPath) => new ProjectDatabase(dbPath),
        buildRunnerDeps: (projDb, projectId) =>
          buildRecoveryRunnerDeps(projDb, (tid) => {
            scheduled.push({ projectId, taskId: tid });
            order.push(`scheduled:${tid}`);
          }),
      },
      () => order.push('ready'),
    );
    // PENDING task 在 ready 之前被调度
    expect(scheduled.some((s) => s.taskId === taskId)).toBe(true);
    const readyIndex = order.indexOf('ready');
    const scheduleIndex = order.findIndex((o) => o.startsWith('scheduled:'));
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleIndex).toBeLessThan(readyIndex);
  });

  it('无 PENDING 任务时恢复不产生调度（幂等）', async () => {
    const dirA = join(tempDir, 'projects', 'proj-x');
    const fs = await import('node:fs');
    fs.mkdirSync(dirA, { recursive: true });
    // 只建 project 元数据 + project run（无 task-backed execution）
    const db = new ProjectDatabase(join(dirA, 'project.sqlite'));
    try {
      db.getProjectMetadataRepository().create({
        id: 'proj-x',
        name: '项目',
        initialIdea: '故事',
        status: 'contract',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const deps = buildRecoveryRunnerDeps(db, () => {});
      createProjectRun(deps, { projectId: 'proj-x', idempotencyKey: 'seed-x' });
    } finally {
      db.close();
    }
    const scheduled: Array<{ projectId: string; taskId: string }> = [];
    await runProjectRecovery({
      listProjects: () => [{ projectId: 'proj-x', projectDirectory: dirA }],
      openProjectDb: (dbPath) => new ProjectDatabase(dbPath),
      buildRunnerDeps: (projDb, projectId) =>
        buildRecoveryRunnerDeps(projDb, (tid) => scheduled.push({ projectId, taskId: tid })),
    });
    expect(scheduled).toHaveLength(0);
  });
});
