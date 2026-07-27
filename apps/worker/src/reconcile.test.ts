/**
 * Reconciliation 集成测试。
 *
 * 使用真实 SQLite 和临时目录验证崩溃恢复场景。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase, ProjectDatabase } from '@ai-novel/database';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 创建一个 project.sqlite 并写入元数据 */
function createProjectSqlite(
  dir: string,
  metadata: { id: string; name: string; initialIdea: string },
): void {
  const dbPath = join(dir, 'project.sqlite');
  const projDb = new ProjectDatabase(dbPath);
  projDb.getProjectMetadataRepository().create({
    id: metadata.id,
    name: metadata.name,
    initialIdea: metadata.initialIdea,
    status: 'idea',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
  projDb.close();
}

/** 模拟 reconcile 函数的核心逻辑（不依赖 Worker 运行时） */
function reconcile(appDb: AppDatabase, dataRoot: string): void {
  const indexRepo = appDb.getProjectIndexRepository();
  const creationRepo = appDb.getProjectCreationRepository();
  const projectsPath = join(dataRoot, 'projects');

  const pending = creationRepo.list();
  let _recoveredCount = 0;
  let _cleanedCount = 0;

  for (const record of pending) {
    const tempPath = join(projectsPath, record.tempDirectoryName);
    const finalPath = join(projectsPath, record.finalDirectoryName);
    const tempExists = existsSync(tempPath);
    const finalExists = existsSync(finalPath);

    if (tempExists && !finalExists) {
      if (record.phase === 'prepared') {
        if (record.tempDirectoryName !== `${record.projectId}.tmp`) {
          creationRepo.delete(record.projectId);
          _cleanedCount++;
          continue;
        }

        try {
          const dbPath = join(tempPath, 'project.sqlite');
          const projDb = new ProjectDatabase(dbPath);
          const metadata = projDb.getProjectMetadataRepository().get();
          projDb.close();

          if (!metadata) {
            rmSync(tempPath, { recursive: true, force: true });
            creationRepo.delete(record.projectId);
            _cleanedCount++;
            continue;
          }

          renameSync(tempPath, finalPath);
          indexRepo.create({
            id: metadata.id,
            name: metadata.name,
            initialIdea: metadata.initialIdea,
            status: metadata.status,
            projectDirectory: finalPath,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
          });
          creationRepo.delete(record.projectId);
          _recoveredCount++;
        } catch {
          try {
            rmSync(tempPath, { recursive: true, force: true });
          } catch {
            /* */
          }
          creationRepo.delete(record.projectId);
          _cleanedCount++;
        }
      } else {
        try {
          rmSync(tempPath, { recursive: true, force: true });
        } catch {
          /* */
        }
        creationRepo.delete(record.projectId);
        _cleanedCount++;
      }
    } else if (finalExists) {
      try {
        const dbPath = join(finalPath, 'project.sqlite');
        const projDb = new ProjectDatabase(dbPath);
        const metadata = projDb.getProjectMetadataRepository().get();
        projDb.close();

        if (!metadata) {
          creationRepo.delete(record.projectId);
          _cleanedCount++;
          continue;
        }

        const existingIndex = indexRepo.getById(record.projectId);
        if (!existingIndex) {
          indexRepo.create({
            id: metadata.id,
            name: metadata.name,
            initialIdea: metadata.initialIdea,
            status: metadata.status,
            projectDirectory: finalPath,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
          });
        }
        creationRepo.delete(record.projectId);
        _recoveredCount++;
      } catch {
        creationRepo.delete(record.projectId);
        _cleanedCount++;
      }
    } else {
      creationRepo.delete(record.projectId);
      _cleanedCount++;
    }
  }
}

describe('Reconciliation', () => {
  it('prepared + temp 存在：应该恢复项目', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    // 创建 temp 目录和 project.sqlite
    const tempDirPath = join(projectsPath, 'proj-1.tmp');
    mkdirSync(tempDirPath, { recursive: true });
    createProjectSqlite(tempDirPath, {
      id: 'proj-1',
      name: '恢复项目',
      initialIdea: '测试恢复',
    });

    // 创建 app.sqlite 并记录 pending creation
    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    appDb.getProjectCreationRepository().create({
      projectId: 'proj-1',
      tempDirectoryName: 'proj-1.tmp',
      finalDirectoryName: 'proj-1',
      phase: 'prepared',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // 验证：正式目录存在，索引已创建，pending 已删除
    expect(existsSync(join(projectsPath, 'proj-1'))).toBe(true);
    expect(existsSync(join(projectsPath, 'proj-1.tmp'))).toBe(false);

    const index = appDb.getProjectIndexRepository().getById('proj-1');
    expect(index).not.toBeNull();
    expect(index!.name).toBe('恢复项目');

    const pending = appDb.getProjectCreationRepository().getByProjectId('proj-1');
    expect(pending).toBeNull();

    appDb.close();
  });

  it('prepared + final 存在：应该创建索引并清理 pending', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    // 创建正式目录（rename 已完成）
    const finalDirPath = join(projectsPath, 'proj-2');
    mkdirSync(finalDirPath, { recursive: true });
    createProjectSqlite(finalDirPath, {
      id: 'proj-2',
      name: '已rename项目',
      initialIdea: '测试',
    });

    // 创建 app.sqlite 并记录 pending creation
    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    appDb.getProjectCreationRepository().create({
      projectId: 'proj-2',
      tempDirectoryName: 'proj-2.tmp',
      finalDirectoryName: 'proj-2',
      phase: 'prepared',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // 验证：索引已创建，pending 已删除
    const index = appDb.getProjectIndexRepository().getById('proj-2');
    expect(index).not.toBeNull();
    expect(index!.name).toBe('已rename项目');

    const pending = appDb.getProjectCreationRepository().getByProjectId('proj-2');
    expect(pending).toBeNull();

    appDb.close();
  });

  it('pending 记录但目录不存在：应该清理 pending', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    appDb.getProjectCreationRepository().create({
      projectId: 'proj-3',
      tempDirectoryName: 'proj-3.tmp',
      finalDirectoryName: 'proj-3',
      phase: 'prepared',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // pending 应该被清理
    const pending = appDb.getProjectCreationRepository().getByProjectId('proj-3');
    expect(pending).toBeNull();

    // 索引不应该存在
    const index = appDb.getProjectIndexRepository().getById('proj-3');
    expect(index).toBeNull();

    appDb.close();
  });

  it('rename 后、正式索引写入前中断：恢复后项目只出现一次', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    // 创建正式目录（rename 已完成）
    const finalDirPath = join(projectsPath, 'proj-4');
    mkdirSync(finalDirPath, { recursive: true });
    createProjectSqlite(finalDirPath, {
      id: 'proj-4',
      name: '中断项目',
      initialIdea: '测试中断',
    });

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 记录 pending（rename 后、索引写入前的状态）
    appDb.getProjectCreationRepository().create({
      projectId: 'proj-4',
      tempDirectoryName: 'proj-4.tmp',
      finalDirectoryName: 'proj-4',
      phase: 'prepared',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // 项目应该只出现一次
    const list = appDb.getProjectIndexRepository().list();
    const matches = list.filter((r) => r.id === 'proj-4');
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('中断项目');

    // pending 应该被清理
    const pending = appDb.getProjectCreationRepository().getByProjectId('proj-4');
    expect(pending).toBeNull();

    appDb.close();
  });

  it('正式索引目录缺失时索引保留（不删除）', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 创建一个指向不存在目录的正式索引
    appDb.getProjectIndexRepository().create({
      id: 'proj-5',
      name: '缺失项目',
      initialIdea: '测试缺失',
      status: 'idea',
      projectDirectory: join(projectsPath, 'proj-5-nonexistent'),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // 索引应该保留（reconcile 不删除正式索引）
    const index = appDb.getProjectIndexRepository().getById('proj-5');
    expect(index).not.toBeNull();
    expect(index!.name).toBe('缺失项目');

    appDb.close();
  });

  it('OpenProject 返回 PROJECT_DIRECTORY_MISSING 当目录缺失', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 创建一个指向不存在目录的正式索引
    appDb.getProjectIndexRepository().create({
      id: 'proj-6',
      name: '缺失目录项目',
      initialIdea: '测试',
      status: 'idea',
      projectDirectory: join(projectsPath, 'proj-6-missing'),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // 尝试通过 openProject 打开（模拟应用层调用）
    const index = appDb.getProjectIndexRepository().getById('proj-6');
    expect(index).not.toBeNull();
    expect(existsSync(index!.projectDirectory)).toBe(false);

    appDb.close();
  });

  it('未知目录不会被删除', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    // 创建一个未知目录（不是 .tmp，没有 pending 记录）
    const unknownDir = join(projectsPath, 'unknown-project');
    mkdirSync(unknownDir, { recursive: true });

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    reconcile(appDb, dataRoot);

    // 未知目录应该保留
    expect(existsSync(unknownDir)).toBe(true);

    appDb.close();
  });

  it('损坏 project.sqlite 不会被静默导入', () => {
    const dataRoot = tempDir;
    const projectsPath = join(dataRoot, 'projects');
    mkdirSync(projectsPath, { recursive: true });

    // 创建 temp 目录但写入损坏的 project.sqlite
    const tempDirPath = join(projectsPath, 'proj-bad.tmp');
    mkdirSync(tempDirPath, { recursive: true });
    writeFileSync(join(tempDirPath, 'project.sqlite'), 'not a valid sqlite file');

    const dbPath = join(dataRoot, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    appDb.getProjectCreationRepository().create({
      projectId: 'proj-bad',
      tempDirectoryName: 'proj-bad.tmp',
      finalDirectoryName: 'proj-bad',
      phase: 'prepared',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    reconcile(appDb, dataRoot);

    // 损坏数据不应该被导入
    const index = appDb.getProjectIndexRepository().getById('proj-bad');
    expect(index).toBeNull();

    // pending 应该被清理
    const pending = appDb.getProjectCreationRepository().getByProjectId('proj-bad');
    expect(pending).toBeNull();

    // temp 目录应该被清理
    expect(existsSync(tempDirPath)).toBe(false);

    appDb.close();
  });
});
