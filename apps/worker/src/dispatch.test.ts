/**
 * Worker RPC 调度逻辑测试。
 *
 * 测试命令分发和错误处理，不测试进程通信。
 * 使用临时目录创建真实数据库。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '@ai-novel/database';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'worker-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('RPC payload validation', () => {
  it('应该拒绝无效的创建项目输入', async () => {
    const { isValidCreateProjectInput } = await import('@ai-novel/contracts');
    expect(isValidCreateProjectInput(null)).toBe(false);
    expect(isValidCreateProjectInput({})).toBe(false);
    expect(isValidCreateProjectInput({ name: 'test' })).toBe(false);
    expect(isValidCreateProjectInput({ initialIdea: 'test' })).toBe(false);
    expect(isValidCreateProjectInput({ name: 123, initialIdea: 'test' })).toBe(false);
  });

  it('应该接受有效的创建项目输入', async () => {
    const { isValidCreateProjectInput } = await import('@ai-novel/contracts');
    expect(isValidCreateProjectInput({ name: '测试', initialIdea: '想法' })).toBe(true);
  });

  it('应该拒绝无效的打开项目输入', async () => {
    const { isValidOpenProjectInput } = await import('@ai-novel/contracts');
    expect(isValidOpenProjectInput(null)).toBe(false);
    expect(isValidOpenProjectInput({})).toBe(false);
    expect(isValidOpenProjectInput({ projectId: 123 })).toBe(false);
  });

  it('应该接受有效的打开项目输入', async () => {
    const { isValidOpenProjectInput } = await import('@ai-novel/contracts');
    expect(isValidOpenProjectInput({ projectId: 'abc-123' })).toBe(true);
  });
});

describe('AppDatabase integration', () => {
  it('应该初始化并创建项目索引', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProjectIndexRepository();

    repo.create({
      id: 'test-001',
      name: '测试项目',
      initialIdea: '测试想法',
      status: 'idea',
      projectDirectory: join(tempDir, 'projects', 'test-001'),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('测试项目');

    appDb.close();
  });

  it('应该支持完整的 create → list → open 流程', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProjectIndexRepository();

    // Create
    const now = '2024-06-15T12:00:00.000Z';
    repo.create({
      id: 'proj-001',
      name: '同乐者测试',
      initialIdea: '我想写美剧同乐者的同人文',
      status: 'idea',
      projectDirectory: join(tempDir, 'projects', 'proj-001'),
      createdAt: now,
      updatedAt: now,
    });

    // List
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('proj-001');

    // Open (get by id)
    const project = repo.getById('proj-001');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('同乐者测试');

    // Update last opened
    repo.updateLastOpened('proj-001', now);
    const updated = repo.getById('proj-001');
    expect(updated!.lastOpenedAt).toBe(now);

    appDb.close();
  });

  it('应该在重新打开后保持数据', () => {
    const dbPath = join(tempDir, 'app.sqlite');

    // 第一次打开
    const db1 = new AppDatabase(dbPath);
    db1.getProjectIndexRepository().create({
      id: 'persistent',
      name: '持久化',
      initialIdea: '想法',
      status: 'idea',
      projectDirectory: join(tempDir, 'projects', 'persistent'),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    db1.close();

    // 第二次打开
    const db2 = new AppDatabase(dbPath);
    const list = db2.getProjectIndexRepository().list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('persistent');
    db2.close();
  });
});
