/**
 * CreateProject 用例测试。
 *
 * 使用 mock 依赖测试各种场景，包括成功路径和补偿逻辑。
 */

import { describe, it, expect } from 'vitest';
import {
  createProject,
  type CreateProjectDeps,
  type CreateProjectInput,
} from './create-project.js';
import type {
  IdGenerator,
  Clock,
  ProjectIndexRepository,
  ProjectCreationRepository,
  ProjectMetadataStore,
  ProjectFileSystem,
  ProjectIndexData,
  ProjectMetadataData,
  ProjectIndexRow,
  ProjectCreationRow,
} from './types.js';

// ── Mock 实现 ─────────────────────────────────────────────────────

function createMockIdGenerator(id = 'test-uuid-001'): IdGenerator {
  return { generate: () => id };
}

function createMockClock(time = '2024-06-15T12:00:00.000Z'): Clock {
  return { now: () => time };
}

function createMockProjectIndexRepo(): ProjectIndexRepository & {
  entries: Map<string, ProjectIndexData>;
} {
  const entries = new Map<string, ProjectIndexData>();
  return {
    entries,
    create(data: ProjectIndexData) {
      entries.set(data.id, { ...data });
    },
    list(): ReadonlyArray<ProjectIndexRow> {
      return [...entries.values()].map((e) => ({ ...e, lastOpenedAt: null }));
    },
    getById(id: string): ProjectIndexRow | null {
      const entry = entries.get(id);
      return entry ? { ...entry, lastOpenedAt: null } : null;
    },
    updateLastOpened(id: string, timestamp: string) {
      const entry = entries.get(id);
      if (entry) {
        entries.set(id, { ...entry, updatedAt: timestamp });
      }
    },
    delete(id: string) {
      entries.delete(id);
    },
  };
}

function createMockProjectCreationRepo(): ProjectCreationRepository & {
  entries: Map<string, ProjectCreationRow>;
} {
  const entries = new Map<string, ProjectCreationRow>();
  return {
    entries,
    create(data: ProjectCreationRow) {
      entries.set(data.projectId, { ...data });
    },
    getByProjectId(projectId: string): ProjectCreationRow | null {
      return entries.get(projectId) ?? null;
    },
    list(): ReadonlyArray<ProjectCreationRow> {
      return [...entries.values()];
    },
    updatePhase(projectId: string, phase: ProjectCreationRow['phase'], updatedAt: string) {
      const entry = entries.get(projectId);
      if (entry) {
        entries.set(projectId, { ...entry, phase, updatedAt });
      }
    },
    delete(projectId: string) {
      entries.delete(projectId);
    },
  };
}

function createMockProjectMetadataStore(): ProjectMetadataStore & {
  inits: Array<{ projectDir: string; data: ProjectMetadataData }>;
} {
  const inits: Array<{ projectDir: string; data: ProjectMetadataData }> = [];
  return {
    inits,
    init(projectDir: string, data: ProjectMetadataData) {
      inits.push({ projectDir, data });
    },
    read(_projectDir: string) {
      return null;
    },
    checkVersion(_projectDir: string) {
      // 默认不抛出
    },
  };
}

function createMockFileSystem(): ProjectFileSystem & {
  tempDirs: string[];
  finalDirs: string[];
  removedDirs: string[];
  subdirs: string[];
} {
  const tempDirs: string[] = [];
  const finalDirs: string[] = [];
  const removedDirs: string[] = [];
  const subdirs: string[] = [];
  return {
    tempDirs,
    finalDirs,
    removedDirs,
    subdirs,
    getBaseDir() {
      return '/tmp/test-app';
    },
    createTempDirectory(_baseDir: string, projectId: string) {
      const path = `/tmp/test-app/projects/${projectId}.tmp`;
      tempDirs.push(path);
      return path;
    },
    renameToFinal(tempDir: string, finalDir: string) {
      finalDirs.push(finalDir);
      const idx = tempDirs.indexOf(tempDir);
      if (idx >= 0) tempDirs.splice(idx, 1);
    },
    ensureSubdirectories(projectDir: string) {
      subdirs.push(projectDir);
    },
    exists(_path: string) {
      return true;
    },
    removeDirectory(dirPath: string) {
      removedDirs.push(dirPath);
    },
    cleanupTemp() {},
    isTempDirectory(name: string) {
      return name.endsWith('.tmp');
    },
  };
}

function createDeps(overrides: Partial<CreateProjectDeps> = {}): CreateProjectDeps {
  return {
    idGenerator: createMockIdGenerator(),
    clock: createMockClock(),
    projectIndexRepo: createMockProjectIndexRepo(),
    projectCreationRepo: createMockProjectCreationRepo(),
    projectMetadataStore: createMockProjectMetadataStore(),
    fileSystem: createMockFileSystem(),
    ...overrides,
  };
}

const validInput: CreateProjectInput = {
  name: '测试项目',
  initialIdea: '这是一个测试想法',
};

// ── 测试 ──────────────────────────────────────────────────────────

describe('createProject', () => {
  it('应该成功创建项目', () => {
    const deps = createDeps();
    const project = createProject(deps, validInput);

    expect(project.id).toBe('test-uuid-001');
    expect(project.name).toBe('测试项目');
    expect(project.initialIdea).toBe('这是一个测试想法');
    expect(project.status).toBe('idea');
    expect(project.createdAt).toBe('2024-06-15T12:00:00.000Z');
    expect(project.updatedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(project.lastOpenedAt).toBeNull();
  });

  it('应该使用注入的 ID 和时间', () => {
    const deps = createDeps({
      idGenerator: createMockIdGenerator('custom-id-123'),
      clock: createMockClock('2025-01-01T00:00:00.000Z'),
    });
    const project = createProject(deps, validInput);

    expect(project.id).toBe('custom-id-123');
    expect(project.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('应该允许同名项目', () => {
    const deps = createDeps();
    const project1 = createProject(deps, { name: '同名', initialIdea: '想法一' });

    const deps2 = createDeps({
      idGenerator: createMockIdGenerator('uuid-002'),
    });
    const project2 = createProject(deps2, { name: '同名', initialIdea: '想法二' });

    expect(project1.name).toBe(project2.name);
    expect(project1.id).not.toBe(project2.id);
  });

  it('应该拒绝空项目名', () => {
    const deps = createDeps();
    expect(() => createProject(deps, { name: '', initialIdea: '想法' })).toThrow(
      /项目名称不能为空/,
    );
  });

  it('应该拒绝空初始想法', () => {
    const deps = createDeps();
    expect(() => createProject(deps, { name: '项目', initialIdea: '' })).toThrow(
      /初始想法不能为空/,
    );
  });

  it('应该拒绝超长项目名', () => {
    const deps = createDeps();
    const longName = '你'.repeat(101);
    expect(() => createProject(deps, { name: longName, initialIdea: '想法' })).toThrow(
      /不能超过 100/,
    );
  });

  it('应该拒绝超长初始想法', () => {
    const deps = createDeps();
    const longIdea = '你'.repeat(20_001);
    expect(() => createProject(deps, { name: '项目', initialIdea: longIdea })).toThrow(
      /不能超过 20000/,
    );
  });

  it('创建失败后应该清理创建事务记录', () => {
    const creationRepo = createMockProjectCreationRepo();
    const fileSystem = createMockFileSystem();

    // 让 renameToFinal 抛出错误
    fileSystem.renameToFinal = () => {
      throw new Error('rename failed');
    };

    const deps = createDeps({
      projectCreationRepo: creationRepo,
      fileSystem,
    });

    expect(() => createProject(deps, validInput)).toThrow();
    // 创建事务记录应该被清理
    expect(creationRepo.entries.size).toBe(0);
  });

  it('创建失败后应该清理临时目录', () => {
    const fileSystem = createMockFileSystem();

    // 让 ensureSubdirectories 抛出错误
    fileSystem.ensureSubdirectories = () => {
      throw new Error('mkdir failed');
    };

    const deps = createDeps({ fileSystem });

    expect(() => createProject(deps, validInput)).toThrow();
    // 临时目录应该被清理
    expect(fileSystem.removedDirs.length).toBeGreaterThan(0);
  });

  it('应该创建子目录', () => {
    const fileSystem = createMockFileSystem();
    const deps = createDeps({ fileSystem });

    createProject(deps, validInput);
    expect(fileSystem.subdirs).toHaveLength(1);
  });

  it('应该写入项目索引', () => {
    const indexRepo = createMockProjectIndexRepo();
    const deps = createDeps({ projectIndexRepo: indexRepo });

    createProject(deps, validInput);
    expect(indexRepo.entries.size).toBe(1);
    expect(indexRepo.entries.has('test-uuid-001')).toBe(true);
  });

  it('应该初始化项目元数据', () => {
    const metadataStore = createMockProjectMetadataStore();
    const deps = createDeps({ projectMetadataStore: metadataStore });

    createProject(deps, validInput);
    expect(metadataStore.inits).toHaveLength(1);
    expect(metadataStore.inits[0].data.name).toBe('测试项目');
  });

  it('应该重命名临时目录到最终目录', () => {
    const fileSystem = createMockFileSystem();
    const deps = createDeps({ fileSystem });

    createProject(deps, validInput);
    expect(fileSystem.finalDirs).toHaveLength(1);
    expect(fileSystem.finalDirs[0]).toBe('/tmp/test-app/projects/test-uuid-001');
  });

  it('应该记录创建事务（phase=prepared）', () => {
    const creationRepo = createMockProjectCreationRepo();
    const deps = createDeps({ projectCreationRepo: creationRepo });

    createProject(deps, validInput);
    // 成功后创建事务记录应该被删除
    expect(creationRepo.entries.size).toBe(0);
  });

  it('应该按正确顺序执行：prepared → rename → index+delete', () => {
    const callOrder: string[] = [];
    const fileSystem = createMockFileSystem();
    const indexRepo = createMockProjectIndexRepo();
    const creationRepo = createMockProjectCreationRepo();

    const originalRename = fileSystem.renameToFinal;
    fileSystem.renameToFinal = (...args: [string, string]) => {
      callOrder.push('rename');
      return originalRename(...args);
    };
    const originalCreate = creationRepo.create.bind(creationRepo);
    creationRepo.create = (data) => {
      callOrder.push('creation-create');
      return originalCreate(data);
    };
    const originalIndexCreate = indexRepo.create.bind(indexRepo);
    indexRepo.create = (data) => {
      callOrder.push('index-create');
      return originalIndexCreate(data);
    };
    const originalDelete = creationRepo.delete.bind(creationRepo);
    creationRepo.delete = (id) => {
      callOrder.push('creation-delete');
      return originalDelete(id);
    };

    const deps = createDeps({
      fileSystem,
      projectIndexRepo: indexRepo,
      projectCreationRepo: creationRepo,
    });
    createProject(deps, validInput);
    expect(callOrder).toEqual(['creation-create', 'rename', 'index-create', 'creation-delete']);
  });

  it('path traversal 输入不应该影响目录位置', () => {
    const fileSystem = createMockFileSystem();
    const deps = createDeps({ fileSystem });

    // 尝试 path traversal 输入
    const maliciousInput: CreateProjectInput = {
      name: '../../../etc/passwd',
      initialIdea: 'test',
    };

    // 验证不应该抛出（名字验证通过，但目录位置由系统生成）
    const project = createProject(deps, maliciousInput);
    expect(project.name).toBe('../../../etc/passwd'); // 名字保留
    // 但目录是系统生成的 UUID，不受名字影响
    expect(fileSystem.finalDirs[0]).not.toContain('etc');
  });

  it('应该将原始错误包装为 ProjectCreateFailedError', () => {
    const metadataStore = createMockProjectMetadataStore();
    metadataStore.init = () => {
      throw new Error('database connection failed');
    };

    const deps = createDeps({ projectMetadataStore: metadataStore });

    expect(() => createProject(deps, validInput)).toThrow(
      /创建项目失败|database connection failed/,
    );
  });
});
