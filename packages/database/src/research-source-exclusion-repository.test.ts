/**
 * 来源排除仓库持久化测试（GE-4/B6，migration v15，D-B6-2）。
 *
 * 覆盖：
 * - setExclusion(true) 写入、幂等（重复调用不炸，不产生重复行）；
 * - setExclusion(false) 取消排除（含对不存在行调用不炸）；
 * - listByProject 按 created_at 升序；
 * - 跨项目隔离（PK 含 project_id）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';

const NOW = '2026-08-11T00:00:00.000Z';

describe('research_source_exclusions persistence (v15)', () => {
  let dir: string;
  let db: ProjectDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'research-source-exclusion-db-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getProjectMetadataRepository().create({
      id: 'p2',
      name: '项目二',
      initialIdea: '另一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migration 升到 v15：schema_migrations 最高版本为 15', () => {
    const version = db.database
      .prepare('SELECT MAX(version) as v FROM schema_migrations')
      .get() as { v: number };
    expect(version.v).toBe(18);
  });

  it('setExclusion(true) 写入，listByProject 可见', () => {
    const repo = db.getResearchSourceExclusionRepository();
    expect(repo.listByProject('p1')).toEqual([]);

    repo.setExclusion('p1', 'https://example.com/a', true);
    expect(repo.listByProject('p1')).toEqual(['https://example.com/a']);
  });

  it('重复 setExclusion(true) 幂等：不炸、不产生重复行', () => {
    const repo = db.getResearchSourceExclusionRepository();
    repo.setExclusion('p1', 'https://example.com/a', true);
    expect(() => repo.setExclusion('p1', 'https://example.com/a', true)).not.toThrow();
    expect(() => repo.setExclusion('p1', 'https://example.com/a', true)).not.toThrow();
    expect(repo.listByProject('p1')).toEqual(['https://example.com/a']);
  });

  it('setExclusion(false) 取消排除', () => {
    const repo = db.getResearchSourceExclusionRepository();
    repo.setExclusion('p1', 'https://example.com/a', true);
    repo.setExclusion('p1', 'https://example.com/a', false);
    expect(repo.listByProject('p1')).toEqual([]);
  });

  it('setExclusion(false) 对不存在的行调用不炸', () => {
    const repo = db.getResearchSourceExclusionRepository();
    expect(() =>
      repo.setExclusion('p1', 'https://example.com/never-excluded', false),
    ).not.toThrow();
    expect(repo.listByProject('p1')).toEqual([]);
  });

  it('listByProject 按 created_at 升序返回', () => {
    const raw = db.database;
    raw
      .prepare(
        'INSERT INTO research_source_exclusions (project_id, url, created_at) VALUES (?, ?, ?)',
      )
      .run('p1', 'https://b.example/', '2026-08-10T00:00:02.000Z');
    raw
      .prepare(
        'INSERT INTO research_source_exclusions (project_id, url, created_at) VALUES (?, ?, ?)',
      )
      .run('p1', 'https://a.example/', '2026-08-10T00:00:01.000Z');
    raw
      .prepare(
        'INSERT INTO research_source_exclusions (project_id, url, created_at) VALUES (?, ?, ?)',
      )
      .run('p1', 'https://c.example/', '2026-08-10T00:00:03.000Z');

    const repo = db.getResearchSourceExclusionRepository();
    expect(repo.listByProject('p1')).toEqual([
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
    ]);
  });

  it('跨项目隔离：p1 的排除不影响 p2', () => {
    const repo = db.getResearchSourceExclusionRepository();
    repo.setExclusion('p1', 'https://example.com/shared-url', true);
    expect(repo.listByProject('p1')).toEqual(['https://example.com/shared-url']);
    expect(repo.listByProject('p2')).toEqual([]);

    // 同一 URL 在两个项目都可各自排除（PK 含 project_id，互不干扰）
    repo.setExclusion('p2', 'https://example.com/shared-url', true);
    expect(repo.listByProject('p2')).toEqual(['https://example.com/shared-url']);

    // 取消 p1 的排除不影响 p2
    repo.setExclusion('p1', 'https://example.com/shared-url', false);
    expect(repo.listByProject('p1')).toEqual([]);
    expect(repo.listByProject('p2')).toEqual(['https://example.com/shared-url']);
  });
});
