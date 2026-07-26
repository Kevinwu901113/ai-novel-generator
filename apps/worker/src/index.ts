/**
 * @ai-novel/worker
 *
 * Utility Process 入口。
 *
 * 职责：
 * - 初始化 app.sqlite
 * - 接收来自 Main Process 的 RPC 请求
 * - 分发到 application 层用例
 * - 返回结果
 *
 * 通信协议：
 * - 启动后发送 { type: 'ready' }
 * - 接收 { requestId, command, payload }
 * - 返回 { requestId, success, data?, error? }
 * - 关闭时接收 { type: 'shutdown' }
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, renameSync } from 'node:fs';
import {
  isValidCreateProjectInput,
  isValidOpenProjectInput,
  type AppError as AppErrorType,
  type ErrorCode,
} from '@ai-novel/contracts';
import {
  createProject,
  listProjects,
  openProject,
  AppError,
  type CreateProjectDeps,
  type ListProjectsDeps,
  type OpenProjectDeps,
  type ProjectFileSystem,
  type IdGenerator,
  type Clock,
  type ProjectIndexRepository,
  type ProjectCreationRepository,
  type ProjectCreationRow,
  type ProjectMetadataStore,
  type CreationPhase,
} from '@ai-novel/application';
import { AppDatabase, ProjectDatabase, checkProjectDatabaseVersion } from '@ai-novel/database';
import type {
  ProjectIndexRow,
  ProjectMetadataRow,
  CreateProjectIndexData,
  CreateProjectMetadataData,
} from '@ai-novel/database';

// ── RPC 类型 ──────────────────────────────────────────────────────

interface RPCRequest {
  readonly requestId: string;
  readonly command: string;
  readonly payload: unknown;
}

interface RPCResponse {
  readonly requestId: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: AppErrorType;
}

interface ReadyMessage {
  readonly type: 'ready';
}

// Electron Utility Process 的 process.parentPort 类型声明
declare const process: NodeJS.Process & {
  parentPort?: {
    on(event: 'message', listener: (event: { data: unknown }) => void): void;
    postMessage(message: unknown): void;
  };
};

// ── 全局状态 ──────────────────────────────────────────────────────

let appDb: AppDatabase | null = null;
let projectsDir: string;

/** 获取数据根目录。允许通过环境变量覆盖（仅限测试/开发）。 */
function getDataRoot(): string {
  const override = process.env.AI_NOVEL_DATA_ROOT;
  if (override) return override;

  // 默认使用当前工作目录下的 data 目录
  // 实际生产环境由 Main Process 通过 app.getPath("userData") 设置
  return join(process.cwd(), 'data');
}

// ── 基础设施适配器 ────────────────────────────────────────────────

function createIdGenerator(): IdGenerator {
  return {
    generate: () => randomUUID(),
  };
}

function createClock(): Clock {
  return {
    now: () => new Date().toISOString(),
  };
}

class ProjectIndexRepositoryImpl implements ProjectIndexRepository {
  constructor(private readonly appDb: AppDatabase) {}

  create(data: CreateProjectIndexData): void {
    this.appDb.getProjectIndexRepository().create(data);
  }

  list(): ReadonlyArray<ProjectIndexRow> {
    return this.appDb.getProjectIndexRepository().list();
  }

  getById(id: string): ProjectIndexRow | null {
    return this.appDb.getProjectIndexRepository().getById(id);
  }

  updateLastOpened(id: string, timestamp: string): void {
    this.appDb.getProjectIndexRepository().updateLastOpened(id, timestamp);
  }

  delete(id: string): void {
    this.appDb.getProjectIndexRepository().delete(id);
  }
}

class ProjectCreationRepositoryImpl implements ProjectCreationRepository {
  constructor(private readonly appDb: AppDatabase) {}

  create(data: ProjectCreationRow): void {
    this.appDb.getProjectCreationRepository().create({
      projectId: data.projectId,
      tempDirectoryName: data.tempDirectoryName,
      finalDirectoryName: data.finalDirectoryName,
      phase: data.phase,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }

  getByProjectId(projectId: string): ProjectCreationRow | null {
    return this.appDb.getProjectCreationRepository().getByProjectId(projectId);
  }

  list(): ReadonlyArray<ProjectCreationRow> {
    return this.appDb.getProjectCreationRepository().list();
  }

  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void {
    this.appDb.getProjectCreationRepository().updatePhase(projectId, phase, updatedAt);
  }

  delete(projectId: string): void {
    this.appDb.getProjectCreationRepository().delete(projectId);
  }
}

class ProjectMetadataStoreImpl implements ProjectMetadataStore {
  init(projectDir: string, data: CreateProjectMetadataData): void {
    const dbPath = join(projectDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);
    try {
      projDb.getProjectMetadataRepository().create(data);
    } finally {
      projDb.close();
    }
  }

  read(projectDir: string): ProjectMetadataRow | null {
    const dbPath = join(projectDir, 'project.sqlite');
    if (!existsSync(dbPath)) return null;
    const projDb = new ProjectDatabase(dbPath);
    try {
      return projDb.getProjectMetadataRepository().get();
    } finally {
      projDb.close();
    }
  }

  checkVersion(projectDir: string): void {
    const dbPath = join(projectDir, 'project.sqlite');
    checkProjectDatabaseVersion(dbPath);
  }
}

class ProjectFileSystemImpl implements ProjectFileSystem {
  getBaseDir(): string {
    return getDataRoot();
  }

  createTempDirectory(_baseDir: string, projectId: string): string {
    const projectsPath = join(getDataRoot(), 'projects');
    if (!existsSync(projectsPath)) {
      mkdirSync(projectsPath, { recursive: true });
    }
    const tempDir = join(projectsPath, `${projectId}.tmp`);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }

  renameToFinal(tempDir: string, finalDir: string): void {
    renameSync(tempDir, finalDir);
  }

  ensureSubdirectories(projectDir: string): void {
    const subdirs = ['assets', 'sources', 'snapshots', 'exports', 'temp'];
    for (const dir of subdirs) {
      const dirPath = join(projectDir, dir);
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    }
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  removeDirectory(dirPath: string): void {
    rmSync(dirPath, { recursive: true, force: true });
  }

  cleanupTemp(baseDir: string, maxAgeMs: number): void {
    const projectsPath = join(baseDir, 'projects');
    if (!existsSync(projectsPath)) return;

    const now = Date.now();
    for (const entry of readdirSync(projectsPath)) {
      if (!this.isTempDirectory(entry)) continue;
      const fullPath = join(projectsPath, entry);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // 忽略无法访问的目录
      }
    }
  }

  isTempDirectory(name: string): boolean {
    return name.endsWith('.tmp');
  }
}

// ── 初始化 ────────────────────────────────────────────────────────

/**
 * 启动时数据一致性恢复。
 *
 * 处理上次启动中断留下的不一致状态：
 * 1. 处理 project_creations 中的 pending 记录
 * 2. 清理过期临时目录（无 pending 记录的）
 *
 * 正式 projects 索引指向的目录缺失时，不删除索引。
 * ListProjects 会将这些项目标记为 missing。
 */
function reconcile(dataRoot: string): void {
  if (!appDb) return;

  const indexRepo = appDb.getProjectIndexRepository();
  const creationRepo = appDb.getProjectCreationRepository();
  const metadataStore = new ProjectMetadataStoreImpl();
  const fileSystem = new ProjectFileSystemImpl();
  const projectsPath = join(dataRoot, 'projects');

  // 1. 处理 pending 创建事务
  const pending = creationRepo.list();
  let recoveredCount = 0;
  let cleanedCount = 0;

  for (const record of pending) {
    const tempPath = join(projectsPath, record.tempDirectoryName);
    const finalPath = join(projectsPath, record.finalDirectoryName);
    const tempExists = existsSync(tempPath);
    const finalExists = existsSync(finalPath);

    if (tempExists && !finalExists) {
      // temp 存在、final 不存在：根据 phase 继续或清理
      if (record.phase === 'prepared') {
        // 验证 temp 是受控目录（名称匹配 projectId.tmp）
        if (record.tempDirectoryName !== `${record.projectId}.tmp`) {
          console.error(`[worker] 恢复失败：临时目录名不匹配 ${record.projectId}`);
          creationRepo.delete(record.projectId);
          cleanedCount++;
          continue;
        }

        try {
          // 验证 project.sqlite 有效
          metadataStore.checkVersion(tempPath);
          const metadata = metadataStore.read(tempPath);
          if (!metadata) {
            console.error(`[worker] 恢复失败：project.sqlite 无元数据 ${record.projectId}`);
            fileSystem.removeDirectory(tempPath);
            creationRepo.delete(record.projectId);
            cleanedCount++;
            continue;
          }

          // 继续创建：rename + 写入正式索引
          fileSystem.renameToFinal(tempPath, finalPath);
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
          recoveredCount++;
        } catch (err) {
          console.error(
            `[worker] 恢复失败 ${record.projectId}:`,
            err instanceof Error ? err.message : err,
          );
          // 清理损坏数据
          try {
            fileSystem.removeDirectory(tempPath);
          } catch {
            /* 忽略 */
          }
          creationRepo.delete(record.projectId);
          cleanedCount++;
        }
      } else {
        // preparing 或 promoted 阶段的残留，清理
        try {
          fileSystem.removeDirectory(tempPath);
        } catch {
          /* 忽略 */
        }
        creationRepo.delete(record.projectId);
        cleanedCount++;
      }
    } else if (finalExists) {
      // final 存在：rename 已完成，验证并创建正式索引
      try {
        metadataStore.checkVersion(finalPath);
        const metadata = metadataStore.read(finalPath);
        if (!metadata) {
          console.error(`[worker] 恢复失败：正式目录无元数据 ${record.projectId}`);
          creationRepo.delete(record.projectId);
          cleanedCount++;
          continue;
        }

        // 检查是否已有正式索引
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
        recoveredCount++;
      } catch (err) {
        console.error(
          `[worker] 恢复失败（正式目录损坏）${record.projectId}:`,
          err instanceof Error ? err.message : err,
        );
        creationRepo.delete(record.projectId);
        cleanedCount++;
      }
    } else {
      // temp 和 final 都不存在：清理 pending 记录
      creationRepo.delete(record.projectId);
      cleanedCount++;
    }
  }

  if (recoveredCount > 0 || cleanedCount > 0) {
    console.log(`[worker] 恢复了 ${recoveredCount} 个创建事务，清理了 ${cleanedCount} 条`);
  }

  // 2. 清理超过 1 小时的无 pending 记录的临时目录
  fileSystem.cleanupTemp(dataRoot, 60 * 60 * 1000);
}

function initialize(): void {
  const dataRoot = getDataRoot();
  projectsDir = join(dataRoot, 'projects');

  // 确保目录存在
  if (!existsSync(dataRoot)) {
    mkdirSync(dataRoot, { recursive: true });
  }
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true });
  }

  // 初始化 app.sqlite
  const dbPath = join(dataRoot, 'app.sqlite');
  appDb = new AppDatabase(dbPath);

  // 启动时恢复一致性
  reconcile(dataRoot);
}

// ── 命令处理 ──────────────────────────────────────────────────────

function handleCreateProject(payload: unknown): unknown {
  if (!isValidCreateProjectInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的创建项目输入');
  }

  if (!appDb) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: CreateProjectDeps = {
    idGenerator: createIdGenerator(),
    clock: createClock(),
    projectIndexRepo: new ProjectIndexRepositoryImpl(appDb),
    projectCreationRepo: new ProjectCreationRepositoryImpl(appDb),
    projectMetadataStore: new ProjectMetadataStoreImpl(),
    fileSystem: new ProjectFileSystemImpl(),
  };

  const project = createProject(deps, payload);
  return {
    id: project.id,
    name: project.name,
    initialIdea: project.initialIdea,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function handleListProjects(): unknown {
  if (!appDb) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: ListProjectsDeps = {
    projectIndexRepo: new ProjectIndexRepositoryImpl(appDb),
    fileSystem: new ProjectFileSystemImpl(),
  };

  const projects = listProjects(deps);
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastOpenedAt: p.lastOpenedAt,
    isMissing: p.isMissing,
  }));
}

function handleOpenProject(payload: unknown): unknown {
  if (!isValidOpenProjectInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的打开项目输入');
  }

  if (!appDb) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: OpenProjectDeps = {
    clock: createClock(),
    projectIndexRepo: new ProjectIndexRepositoryImpl(appDb),
    projectMetadataStore: new ProjectMetadataStoreImpl(),
    fileSystem: new ProjectFileSystemImpl(),
  };

  const project = openProject(deps, payload);
  return {
    id: project.id,
    name: project.name,
    initialIdea: project.initialIdea,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

function dispatchCommand(request: RPCRequest): RPCResponse {
  try {
    let data: unknown;

    switch (request.command) {
      case 'project.create':
        data = handleCreateProject(request.payload);
        break;
      case 'project.list':
        data = handleListProjects();
        break;
      case 'project.open':
        data = handleOpenProject(request.payload);
        break;
      default:
        throw new AppError('VALIDATION_ERROR', `未知命令: ${request.command}`);
    }

    return { requestId: request.requestId, success: true, data };
  } catch (err) {
    if (err instanceof AppError) {
      return {
        requestId: request.requestId,
        success: false,
        error: { code: err.code, message: err.message },
      };
    }

    // 不泄露内部错误细节
    return {
      requestId: request.requestId,
      success: false,
      error: { code: 'PROJECT_CREATE_FAILED' as ErrorCode, message: '操作失败' },
    };
  }
}

// ── 通信 ──────────────────────────────────────────────────────────

function sendToParent(message: unknown): void {
  // Electron Utility Process 使用 process.parentPort
  // Node.js Worker 使用 parentPort
  if (typeof process.parentPort !== 'undefined') {
    process.parentPort.postMessage(message);
  }
}

function handleMessage(data: unknown): void {
  // 检查关闭消息
  if (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as { type: string }).type === 'shutdown'
  ) {
    shutdown();
    return;
  }

  // 处理 RPC 请求
  const request = data as RPCRequest;
  if (!request.requestId || !request.command) {
    return; // 忽略无效消息
  }

  const response = dispatchCommand(request);
  sendToParent(response);
}

// ── 生命周期 ──────────────────────────────────────────────────────

function shutdown(): void {
  if (appDb) {
    appDb.close();
    appDb = null;
  }
  process.exit(0);
}

// ── 启动 ──────────────────────────────────────────────────────────

try {
  initialize();

  // 监听来自 Main Process 的消息
  if (typeof process.parentPort !== 'undefined') {
    process.parentPort.on('message', (event: { data: unknown }) => {
      handleMessage(event.data);
    });
  }

  // 发送就绪信号
  sendToParent({ type: 'ready' } satisfies ReadyMessage);
} catch (err) {
  // 初始化失败，发送错误信号
  const message = err instanceof Error ? err.message : 'Worker 初始化失败';
  sendToParent({ type: 'error', message });
  process.exit(1);
}

// 处理进程退出
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
