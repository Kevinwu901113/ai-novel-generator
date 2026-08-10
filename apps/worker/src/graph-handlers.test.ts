/**
 * Graph Run Worker 命令分发测试（GE-1）。
 *
 * 覆盖：createProjectRun / getRunProgress / advanceNode 分发与 DTO 映射、
 * payload 严格验证（VALIDATION_ERROR）、run 不存在（GRAPH_RUN_NOT_FOUND）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { AppError } from '@ai-novel/application';
import { dispatchGraphCommand, type GraphHandlerContext } from './graph-handlers.js';

const NOW = '2026-08-04T00:00:00.000Z';

let tempDir: string;
let dbPath: string;

function openFreshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'proj-1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

function buildCtx(): GraphHandlerContext {
  return {
    getProjectDb: () => openFreshDb(),
    idGenerator: { generate: () => 'id-1' },
    clock: { now: () => NOW },
  };
}

describe('dispatchGraphCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'graph-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('graph.createProjectRun → 进度投影（IDEA_CAPTURE active + possibleNextNodes）', () => {
    const ctx = buildCtx();
    const dto = dispatchGraphCommand(
      'graph.createProjectRun',
      { projectId: 'proj-1', idempotencyKey: 'c1' },
      ctx,
    ) as { activeNodes: Array<{ nodeId: string; status: string }>; possibleNextNodes: string[] };

    expect(dto.activeNodes).toHaveLength(1);
    expect(dto.activeNodes[0].nodeId).toBe('IDEA_CAPTURE');
    expect(dto.activeNodes[0].status).toBe('active');
    expect(dto.possibleNextNodes.length).toBeGreaterThan(0);
  });

  it('graph.createProjectRun 非法 payload → VALIDATION_ERROR', () => {
    const ctx = buildCtx();
    expect(() =>
      dispatchGraphCommand('graph.createProjectRun', { projectId: '' }, ctx),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }) as AppError);
  });

  it('RW-1 公共安全边界：advanceNode / failNode / requestHumanDecision 不在 RPC 面', () => {
    const ctx = buildCtx();
    dispatchGraphCommand(
      'graph.createProjectRun',
      { projectId: 'proj-1', idempotencyKey: 'c2' },
      ctx,
    );
    const runs = dispatchGraphCommand(
      'graph.listRuns',
      { projectId: 'proj-1' },
      ctx,
    ) as ReadonlyArray<{ runId: string }>;
    const runId = runs[0].runId;

    // 伪造节点完成通道已关闭：advanceNode 不应被 RPC 分发
    expect(() =>
      dispatchGraphCommand(
        'graph.advanceNode',
        {
          projectId: 'proj-1',
          runId,
          nodeId: 'IDEA_CAPTURE',
          artifactRef: { kind: 'idea', artifactId: 'idea-1' },
          idempotencyKey: 'a1',
        },
        ctx,
      ),
    ).toThrow();
  });

  it('graph.getRunProgress 不存在的 run → GRAPH_RUN_NOT_FOUND', () => {
    const ctx = buildCtx();
    expect(() =>
      dispatchGraphCommand(
        'graph.getRunProgress',
        { projectId: 'proj-1', runId: 'missing-run' },
        ctx,
      ),
    ).toThrowError(expect.objectContaining({ code: 'GRAPH_RUN_NOT_FOUND' }) as AppError);
  });

  it('TD-023：每条 graph.* 命令结束后 ProjectDatabase 连接关闭（含抛错路径）', () => {
    const opened: Array<{ closed: boolean }> = [];
    const ctx: GraphHandlerContext = {
      ...buildCtx(),
      getProjectDb: () => {
        const db = openFreshDb();
        const record = { closed: false };
        const originalClose = db.close.bind(db);
        db.close = () => {
          record.closed = true;
          originalClose();
        };
        opened.push(record);
        return db;
      },
    };

    dispatchGraphCommand(
      'graph.createProjectRun',
      { projectId: 'proj-1', idempotencyKey: 'c1' },
      ctx,
    );
    const runs = dispatchGraphCommand(
      'graph.listRuns',
      { projectId: 'proj-1' },
      ctx,
    ) as ReadonlyArray<{
      runId: string;
    }>;
    dispatchGraphCommand(
      'graph.getRunProgress',
      { projectId: 'proj-1', runId: runs[0].runId },
      ctx,
    );
    // 抛错路径也必须 finally close
    expect(() =>
      dispatchGraphCommand(
        'graph.getRunProgress',
        { projectId: 'proj-1', runId: 'missing-run' },
        ctx,
      ),
    ).toThrow();

    expect(opened.length).toBeGreaterThanOrEqual(4);
    expect(opened.every((r) => r.closed)).toBe(true);
  });
});
