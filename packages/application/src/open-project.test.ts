/**
 * OpenProject 用例测试。
 */

import { describe, it, expect } from 'vitest';
import { openProject, type OpenProjectDeps, type OpenProjectInput } from './open-project.js';
import type { ProjectIndexRow, ProjectMetadataRow } from './types.js';
import {
  ProjectNotFoundError,
  ProjectDirectoryMissingError,
  ProjectDatabaseInvalidError,
} from './errors.js';

const FIXED_TIME = '2024-06-15T12:00:00.000Z';

const mockIndexRow: ProjectIndexRow = {
  id: 'proj-1',
  name: '测试项目',
  initialIdea: '测试想法',
  status: 'idea',
  projectDirectory: '/tmp/projects/proj-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  lastOpenedAt: null,
};

const mockMetadata: ProjectMetadataRow = {
  id: 'proj-1',
  name: '测试项目',
  initialIdea: '测试想法',
  status: 'idea',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function createDeps(overrides: Partial<OpenProjectDeps> = {}): OpenProjectDeps {
  return {
    clock: { now: () => FIXED_TIME },
    projectIndexRepo: {
      create() {},
      list() {
        return [];
      },
      getById(id: string) {
        return id === 'proj-1' ? mockIndexRow : null;
      },
      updateLastOpened() {},
      delete() {},
    },
    projectMetadataStore: {
      init() {},
      read() {
        return mockMetadata;
      },
      checkVersion() {},
    },
    fileSystem: {
      getBaseDir() {
        return '/tmp';
      },
      createTempDirectory() {
        return '/tmp/temp';
      },
      renameToFinal() {},
      ensureSubdirectories() {},
      exists() {
        return true;
      },
      removeDirectory() {},
      cleanupTemp() {},
      isTempDirectory() {
        return false;
      },
    },
    ...overrides,
  };
}

const validInput: OpenProjectInput = { projectId: 'proj-1' };

describe('openProject', () => {
  it('应该成功打开项目', () => {
    const deps = createDeps();
    const project = openProject(deps, validInput);

    expect(project.id).toBe('proj-1');
    expect(project.name).toBe('测试项目');
    expect(project.initialIdea).toBe('测试想法');
    expect(project.status).toBe('idea');
    expect(project.lastOpenedAt).toBe(FIXED_TIME);
  });

  it('应该更新 last_opened_at', () => {
    let updatedId: string | null = null;
    let updatedTime: string | null = null;

    const deps = createDeps({
      projectIndexRepo: {
        create() {},
        list() {
          return [];
        },
        getById(id: string) {
          return id === 'proj-1' ? mockIndexRow : null;
        },
        updateLastOpened(id: string, timestamp: string) {
          updatedId = id;
          updatedTime = timestamp;
        },
        delete() {},
      },
    });

    openProject(deps, validInput);
    expect(updatedId).toBe('proj-1');
    expect(updatedTime).toBe(FIXED_TIME);
  });

  it('应该从 project.sqlite 读取正式元数据', () => {
    let readDir: string | null = null;

    const deps = createDeps({
      projectMetadataStore: {
        init() {},
        read(dir: string) {
          readDir = dir;
          return mockMetadata;
        },
        checkVersion() {},
      },
    });

    openProject(deps, validInput);
    expect(readDir).toBe('/tmp/projects/proj-1');
  });

  it('应该抛出 PROJECT_NOT_FOUND 当项目不存在', () => {
    const deps = createDeps();
    expect(() => openProject(deps, { projectId: 'nonexistent' })).toThrow(ProjectNotFoundError);
  });

  it('应该抛出 PROJECT_DIRECTORY_MISSING 当目录不存在', () => {
    const deps = createDeps({
      fileSystem: {
        getBaseDir() {
          return '/tmp';
        },
        createTempDirectory() {
          return '/tmp/temp';
        },
        renameToFinal() {},
        ensureSubdirectories() {},
        exists() {
          return false;
        },
        removeDirectory() {},
        cleanupTemp() {},
        isTempDirectory() {
          return false;
        },
      },
    });

    expect(() => openProject(deps, validInput)).toThrow(ProjectDirectoryMissingError);
  });

  it('应该抛出 PROJECT_DATABASE_INVALID 当 project.sqlite 不存在', () => {
    const deps = createDeps({
      projectMetadataStore: {
        init() {},
        read() {
          return null;
        },
        checkVersion() {
          throw new Error('project.sqlite 不存在');
        },
      },
    });

    expect(() => openProject(deps, validInput)).toThrow(ProjectDatabaseInvalidError);
  });

  it('应该检查数据库版本兼容性', () => {
    let versionChecked = false;

    const deps = createDeps({
      projectMetadataStore: {
        init() {},
        read() {
          return mockMetadata;
        },
        checkVersion() {
          versionChecked = true;
        },
      },
    });

    openProject(deps, validInput);
    expect(versionChecked).toBe(true);
  });
});
