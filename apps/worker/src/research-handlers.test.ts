/**
 * Web Research Worker 命令分发测试（GE-4，真实 SQLite + fake provider）。
 *
 * - research.execute：编排 + 持久化 ResearchBundle；
 * - 非法深度 / 缺失字段 → VALIDATION_ERROR。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import type { ResearchBundle } from '@ai-novel/research-engine';
import {
  createFakeResearchProvider,
  dispatchResearchCommand,
  type ResearchHandlerContext,
} from './research-handlers.js';

const NOW = '2026-08-04T00:00:00.000Z';

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

function ctx(): ResearchHandlerContext {
  const provider = createFakeResearchProvider();
  return {
    getProjectDb: () => freshDb(),
    search: provider.search,
    fetch: provider.fetch,
  };
}

describe('dispatchResearchCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('research.execute 生成并持久化 ResearchBundle', async () => {
    const db = freshDb();
    try {
      const bundle = (await dispatchResearchCommand(
        'research.execute',
        {
          projectId: 'p1',
          idea: '晚清上海滩的谍战故事',
          depth: 'deep',
          questions: ['当时的租界格局'],
        },
        ctx(),
      )) as ResearchBundle;
      expect(bundle.depth).toBe('deep');
      expect(bundle.projectId).toBe('p1');
      expect(bundle.questions.length).toBeGreaterThan(0);

      // 已持久化
      const saved = db.getResearchBundleRepository().getById('p1', bundle.id);
      expect(saved).not.toBeNull();
      expect(saved!.factNotes.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('非法深度 → VALIDATION_ERROR', async () => {
    await expect(
      dispatchResearchCommand(
        'research.execute',
        { projectId: 'p1', idea: 'x', depth: 'ultra', questions: [] },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it('缺失 idea → VALIDATION_ERROR', async () => {
    await expect(
      dispatchResearchCommand(
        'research.execute',
        { projectId: 'p1', depth: 'light', questions: [] },
        ctx(),
      ),
    ).rejects.toThrow();
  });
});
