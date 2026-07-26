/**
 * ListProjects 用例测试。
 */

import { describe, it, expect } from 'vitest';
import { listProjects, type ListProjectsDeps } from './list-projects.js';
import type { ProjectIndexRepository, ProjectFileSystem, ProjectIndexRow } from './types.js';

function createMockProjectIndexRepo(rows: ProjectIndexRow[] = []): ProjectIndexRepository {
  return {
    create() {},
    list() {
      return rows;
    },
    getById() {
      return null;
    },
    updateLastOpened() {},
    delete() {},
  };
}

function createMockFileSystem(existingPaths = new Set<string>()): ProjectFileSystem {
  return {
    getBaseDir() {
      return '/tmp/test';
    },
    createTempDirectory() {
      return '/tmp/test/temp';
    },
    renameToFinal() {},
    ensureSubdirectories() {},
    exists(path: string) {
      return existingPaths.has(path);
    },
    removeDirectory() {},
    cleanupTemp() {},
    isTempDirectory() {
      return false;
    },
  };
}

describe('listProjects', () => {
  it('应该返回空列表', () => {
    const deps: ListProjectsDeps = {
      projectIndexRepo: createMockProjectIndexRepo(),
      fileSystem: createMockFileSystem(),
    };
    expect(listProjects(deps)).toHaveLength(0);
  });

  it('应该返回项目列表', () => {
    const rows: ProjectIndexRow[] = [
      {
        id: 'proj-1',
        name: '项目一',
        initialIdea: '想法',
        status: 'idea',
        projectDirectory: '/tmp/proj-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastOpenedAt: null,
      },
    ];

    const deps: ListProjectsDeps = {
      projectIndexRepo: createMockProjectIndexRepo(rows),
      fileSystem: createMockFileSystem(new Set(['/tmp/proj-1'])),
    };

    const result = listProjects(deps);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('proj-1');
    expect(result[0].isMissing).toBe(false);
  });

  it('应该标记缺失目录的项目', () => {
    const rows: ProjectIndexRow[] = [
      {
        id: 'proj-1',
        name: '项目一',
        initialIdea: '想法',
        status: 'idea',
        projectDirectory: '/tmp/proj-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastOpenedAt: null,
      },
    ];

    // 目录不存在
    const deps: ListProjectsDeps = {
      projectIndexRepo: createMockProjectIndexRepo(rows),
      fileSystem: createMockFileSystem(new Set()),
    };

    const result = listProjects(deps);
    expect(result).toHaveLength(1);
    expect(result[0].isMissing).toBe(true);
  });

  it('应该按 last_opened_at 降序排列（由 repo 保证）', () => {
    const rows: ProjectIndexRow[] = [
      {
        id: 'proj-2',
        name: '最近打开',
        initialIdea: '想法',
        status: 'idea',
        projectDirectory: '/tmp/proj-2',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        lastOpenedAt: '2024-06-15T12:00:00.000Z',
      },
      {
        id: 'proj-1',
        name: '较早创建',
        initialIdea: '想法',
        status: 'idea',
        projectDirectory: '/tmp/proj-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        lastOpenedAt: null,
      },
    ];

    const deps: ListProjectsDeps = {
      projectIndexRepo: createMockProjectIndexRepo(rows),
      fileSystem: createMockFileSystem(new Set(['/tmp/proj-1', '/tmp/proj-2'])),
    };

    const result = listProjects(deps);
    expect(result).toHaveLength(2);
    // repo 已经排好序了
    expect(result[0].id).toBe('proj-2');
    expect(result[1].id).toBe('proj-1');
  });
});
