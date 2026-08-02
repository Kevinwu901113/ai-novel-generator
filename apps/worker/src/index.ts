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
  isValidSaveApiKeyInput,
  isValidCreateModelInvocationTestInput,
  isValidGrillRequestQuestionPlanInput,
  type AppError as AppErrorType,
  type ErrorCode,
  type ProviderPublicState,
  type ConnectionTestResult,
  type TaskPublicData,
  type TaskStatsPublicData,
  type GrillRequestQuestionPlanResult,
} from '@ai-novel/contracts';
import {
  createProject,
  listProjects,
  openProject,
  getProviderState,
  saveProviderApiKey,
  deleteProviderApiKey,
  testProviderConnection,
  requestGrillQuestionPlan,
  AppError,
  TaskDedupeConflictError,
  type CreateProjectDeps,
  type ListProjectsDeps,
  type OpenProjectDeps,
  type GetProviderStateDeps,
  type SaveProviderApiKeyDeps,
  type DeleteProviderApiKeyDeps,
  type TestProviderConnectionDeps,
  type ProjectFileSystem,
  type IdGenerator,
  type Clock,
  type ProjectIndexRepository,
  type ProjectCreationRepository,
  type ProjectCreationRow,
  type ProjectMetadataStore,
  type CreationPhase,
  type SecretStore,
  type ProviderProfileData,
  type ProviderProfileRepository as AppProviderProfileRepository,
  type TaskRepositoryPort,
  type TaskData,
  type CreateTaskInput,
  type ModelInvocationRepositoryPort,
  type ModelInvocationData,
  type CreateInvocationInput,
  type InvocationSuccessResult,
  type InvocationStatsData,
} from '@ai-novel/application';
import type { TaskStatus, ModelInvocationStatus } from '@ai-novel/domain';
import { AppDatabase, ProjectDatabase, checkProjectDatabaseVersion } from '@ai-novel/database';
import type {
  ProjectIndexRow,
  ProjectMetadataRow,
  CreateProjectIndexData,
  CreateProjectMetadataData,
  ProviderProfileRow,
  TaskRow,
  ModelInvocationRow,
} from '@ai-novel/database';
import { testConnection as modelGatewayTestConnection, invokeModel } from '@ai-novel/model-gateway';
import {
  executeModelInvocationTest,
  sha256Hex,
  type ContractDraftEngineDeps,
} from '@ai-novel/task-engine';
import { createMacOSKeychainSecretStore } from './secret-store.js';
import {
  dispatchGrillCommand,
  type GrillHandlerContext,
  GrillSessionRepositoryAdapter,
  GrillQuestionRepositoryAdapter,
  GrillAnswerRepositoryAdapter,
  GrillQuestionPlanProposalRepositoryAdapter,
  GrillProposalRepositoryAdapter,
} from './grill-handlers.js';
import {
  scheduleGrillPlanRun,
  settleGrillPlanRunnerFailure,
  recoverPendingGrillPlans as recoverPendingGrillPlansModule,
  type GrillPlanRunnerDeps,
  type GrillPlanScheduleResult,
} from './grill-plan-runner.js';
import { dispatchContractCommand, type ContractHandlerContext } from './contract-handlers.js';
import { dispatchManuscriptCommand, type ManuscriptHandlerContext } from './manuscript-handlers.js';
import {
  scheduleContractDraftRun,
  settleContractDraftRunnerFailure,
  recoverPendingContractDrafts as recoverPendingContractDraftsModule,
  type ContractDraftRunnerDeps,
  type ContractDraftScheduleResult,
} from './contract-draft-runner.js';

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
let secretStore: SecretStore | null = null;

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

// ── 提供商配置仓库适配器 ────────────────────────────────────────────

class ProviderProfileRepositoryAdapter implements AppProviderProfileRepository {
  constructor(private readonly appDb: AppDatabase) {}

  getById(id: string): ProviderProfileData | null {
    const row = this.appDb.getProviderProfileRepository().getById(id);
    if (!row) return null;
    return this.toAppData(row);
  }

  updateTestResult(
    id: string,
    result: {
      lastTestedAt: string;
      lastTestStatus: string;
      lastTestErrorCode: string | null;
      lastTestLatencyMs: number | null;
    },
  ): void {
    this.appDb.getProviderProfileRepository().updateTestResult(id, result);
  }

  private toAppData(row: ProviderProfileRow): ProviderProfileData {
    return {
      id: row.id,
      providerType: row.providerType,
      displayName: row.displayName,
      baseUrl: row.baseUrl,
      model: row.model,
      keychainService: row.keychainService,
      keychainAccount: row.keychainAccount,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastTestedAt: row.lastTestedAt,
      lastTestStatus: row.lastTestStatus,
      lastTestErrorCode: row.lastTestErrorCode,
      lastTestLatencyMs: row.lastTestLatencyMs,
    };
  }
}

// ── 任务仓库适配器 ────────────────────────────────────────────────

/**
 * 精确判定 dedupe 冲突：只有明确命中 tasks.dedupe_key 或
 * idx_tasks_dedupe_active 的唯一约束冲突才映射为 TaskDedupeConflictError。
 *
 * duplicate task primary key 与其他 UNIQUE violation（uq_tasks_project_id、
 * uq_cc_proposals_task 等）必须保持为 infra/internal error，不得变成
 * CONTRACT_DRAFT_ALREADY_RUNNING / GRILL_PLAN_ALREADY_RUNNING。
 *
 * node:sqlite 对约束错误抛出 code='ERR_SQLITE_ERROR' + 稳定 errcode
 * （SQLITE_CONSTRAINT_UNIQUE=2067，SQLITE_CONSTRAINT_PRIMARYKEY=1555）。
 * errcode 仅作候选预过滤；最终判定以 message 中是否引用
 * tasks.dedupe_key / idx_tasks_dedupe_active 为准。
 */
function isDedupeUniqueConstraintError(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'errcode' in err) {
    const code = (err as { errcode?: unknown }).errcode;
    if (typeof code === 'number' && Number.isInteger(code) && code !== 2067 && code !== 1555) {
      return false;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('tasks.dedupe_key') || msg.includes('idx_tasks_dedupe_active');
}

class TaskRepositoryAdapter implements TaskRepositoryPort {
  constructor(private readonly projDb: ProjectDatabase) {}

  create(data: CreateTaskInput): void {
    const now = createClock().now();
    try {
      this.projDb.getTaskRepository().create({
        id: data.id,
        projectId: data.projectId,
        taskType: data.taskType,
        status: 'PENDING',
        inputVersionJson: data.inputVersionJson,
        payloadJson: data.payloadJson,
        dedupeKey: data.dedupeKey ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isDedupeUniqueConstraintError(err) && data.dedupeKey !== undefined) {
        throw new TaskDedupeConflictError('已存在相同 dedupe key 的活跃任务');
      }
      throw err;
    }
  }

  getById(id: string): TaskData | null {
    const row = this.projDb.getTaskRepository().getById(id);
    if (!row) return null;
    return this.toTaskData(row);
  }

  listByProject(projectId: string, limit?: number): ReadonlyArray<TaskData> {
    return this.projDb.getTaskRepository().listByProject(projectId, limit).map(this.toTaskData);
  }

  listByStatus(status: TaskStatus): ReadonlyArray<TaskData> {
    return this.projDb.getTaskRepository().listByStatus(status).map(this.toTaskData);
  }

  claimPending(id: string): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().claimPending(id, now);
  }

  completeRunning(id: string, resultJson: string): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().completeRunning(id, resultJson, now);
  }

  failRunning(id: string, errorCode: string, errorMessage: string): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().failRunning(id, errorCode, errorMessage, now);
  }

  failPending(id: string, errorCode: string, errorMessage: string): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().failPending(id, errorCode, errorMessage, now);
  }

  markStale(id: string, expectedStatuses: ReadonlyArray<TaskStatus>): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().markStale(id, expectedStatuses, now);
  }

  resetToPending(id: string, expectedStatus: TaskStatus): boolean {
    const now = createClock().now();
    return this.projDb.getTaskRepository().resetToPending(id, expectedStatus, now);
  }

  listRunning(): ReadonlyArray<TaskData> {
    return this.projDb.getTaskRepository().listRunning().map(this.toTaskData);
  }

  private toTaskData(row: TaskRow): TaskData {
    return {
      id: row.id,
      projectId: row.projectId,
      taskType: row.taskType,
      status: row.status,
      inputVersionJson: row.inputVersionJson,
      payloadJson: row.payloadJson,
      resultJson: row.resultJson,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      dedupeKey: row.dedupeKey,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      staleAt: row.staleAt,
      cancelledAt: row.cancelledAt,
    };
  }
}

// ── 模型调用仓库适配器 ────────────────────────────────────────────

class ModelInvocationRepositoryAdapter implements ModelInvocationRepositoryPort {
  constructor(private readonly projDb: ProjectDatabase) {}

  create(data: CreateInvocationInput): void {
    const now = createClock().now();
    this.projDb.getModelInvocationRepository().create({
      id: data.id,
      projectId: data.projectId,
      taskId: data.taskId,
      providerProfileId: data.providerProfileId,
      model: data.model,
      status: 'PENDING',
      attemptNumber: data.attemptNumber,
      requestKind: data.requestKind,
      promptHash: data.promptHash,
      requestMetadataJson: data.requestMetadataJson,
      createdAt: now,
    });
  }

  getById(id: string): ModelInvocationData | null {
    const row = this.projDb.getModelInvocationRepository().getById(id);
    if (!row) return null;
    return this.toInvocationData(row);
  }

  listByTask(taskId: string): ReadonlyArray<ModelInvocationData> {
    return this.projDb.getModelInvocationRepository().listByTask(taskId).map(this.toInvocationData);
  }

  markRunning(id: string, expectedStatus: 'PENDING'): boolean {
    const now = createClock().now();
    return this.projDb.getModelInvocationRepository().markRunning(id, expectedStatus, now);
  }

  markSucceeded(id: string, expectedStatus: 'RUNNING', result: InvocationSuccessResult): boolean {
    const now = createClock().now();
    return this.projDb.getModelInvocationRepository().markSucceeded(id, expectedStatus, {
      responseMetadataJson: result.responseMetadataJson,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
      providerRequestId: result.providerRequestId,
      finishedAt: now,
    });
  }

  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<ModelInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
  ): boolean {
    const now = createClock().now();
    return this.projDb
      .getModelInvocationRepository()
      .markFailed(id, expectedStatuses, errorCode, errorMessage, latencyMs, now);
  }

  getStatsByProject(projectId: string): InvocationStatsData {
    return this.projDb.getModelInvocationRepository().getStatsByProject(projectId);
  }

  listRunning(): ReadonlyArray<ModelInvocationData> {
    return this.projDb.getModelInvocationRepository().listRunning().map(this.toInvocationData);
  }

  private toInvocationData(row: ModelInvocationRow): ModelInvocationData {
    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      providerProfileId: row.providerProfileId,
      model: row.model,
      status: row.status,
      attemptNumber: row.attemptNumber,
      requestKind: row.requestKind,
      promptHash: row.promptHash,
      requestMetadataJson: row.requestMetadataJson,
      responseMetadataJson: row.responseMetadataJson,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      latencyMs: row.latencyMs,
      finishReason: row.finishReason,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      providerRequestId: row.providerRequestId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
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

  // 初始化 SecretStore
  secretStore = createMacOSKeychainSecretStore();

  // 启动时恢复一致性
  reconcile(dataRoot);

  // 恢复中断的任务
  reconcileTasks(dataRoot);

  // 恢复 PENDING 的 Grill 规划任务（异步调度）
  recoverPendingGrillPlans(dataRoot);

  // 恢复 PENDING 的创作契约草案任务（异步调度）
  recoverPendingContractDrafts(dataRoot);
}

/**
 * 任务恢复：将 RUNNING 任务和调用标记为 FAILED。
 *
 * 应用崩溃后，数据库中可能遗留 RUNNING 状态的记录。
 * 启动时将这些记录恢复为 FAILED，并记录 TASK_INTERRUPTED。
 *
 * 每个 task 的恢复在同一事务中完成：
 * - 该 task 下所有 RUNNING invocation → FAILED（CAS 检查）
 * - 该 task → FAILED（CAS 检查）
 * - 任一 CAS false 整组回滚
 * - 重复执行幂等（已 FAILED 的不修改）
 * - attempt_count 不变
 */
function reconcileTasks(dataRoot: string): void {
  const projectsPath = join(dataRoot, 'projects');
  if (!existsSync(projectsPath)) return;

  const now = createClock().now();

  // 遍历所有项目目录
  for (const entry of readdirSync(projectsPath)) {
    const projectDir = join(projectsPath, entry);
    const dbPath = join(projectDir, 'project.sqlite');
    if (!existsSync(dbPath)) continue;

    try {
      const projDb = new ProjectDatabase(dbPath);
      try {
        const taskRepo = projDb.getTaskRepository();
        const invocationRepo = projDb.getModelInvocationRepository();

        // 恢复 RUNNING tasks
        const runningTasks = taskRepo.listRunning();
        for (const task of runningTasks) {
          projDb.transaction(() => {
            // 恢复该 task 下的 RUNNING invocations
            const invocations = invocationRepo.listByTask(task.id);
            for (const inv of invocations) {
              if (inv.status === 'RUNNING') {
                const ok = invocationRepo.markFailed(
                  inv.id,
                  ['RUNNING'],
                  'INVOCATION_INTERRUPTED',
                  '模型调用因应用中断而未完成',
                  null,
                  now,
                );
                if (!ok) {
                  throw new Error(`恢复调用 ${inv.id} 失败：CAS 冲突`);
                }
              }
              // 已 FAILED/其他状态的 invocation 不修改
            }

            // 恢复 task（CAS：RUNNING → FAILED）
            const taskOk = taskRepo.failRunning(
              task.id,
              'TASK_INTERRUPTED',
              '任务因应用中断而未完成',
              now,
            );
            if (!taskOk) {
              throw new Error(`恢复任务 ${task.id} 失败：CAS 冲突`);
            }
          });
        }
      } finally {
        projDb.close();
      }
    } catch {
      // 忽略无法打开的项目数据库
    }
  }
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

// ── 提供商命令处理 ─────────────────────────────────────────────────

async function handleGetProviderState(): Promise<ProviderPublicState> {
  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: GetProviderStateDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
  };

  return getProviderState(deps);
}

async function handleSaveProviderApiKey(payload: unknown): Promise<ProviderPublicState> {
  if (!isValidSaveApiKeyInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的 API Key 输入');
  }

  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: SaveProviderApiKeyDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    clock: createClock(),
  };

  return saveProviderApiKey(deps, { apiKey: payload.apiKey });
}

async function handleDeleteProviderApiKey(): Promise<ProviderPublicState> {
  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: DeleteProviderApiKeyDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    clock: createClock(),
  };

  return deleteProviderApiKey(deps);
}

async function handleTestProviderConnection(): Promise<ConnectionTestResult> {
  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: TestProviderConnectionDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    clock: createClock(),
    testConnection: async (input: { baseUrl: string; model: string; apiKey: string }) => {
      return modelGatewayTestConnection({ fetch: globalThis.fetch, clock: createClock() }, input);
    },
  };

  return testProviderConnection(deps);
}

// ── 任务命令处理 ─────────────────────────────────────────────────

/**
 * 获取项目的 ProjectDatabase。
 * 从 app.sqlite 查找项目目录，打开 project.sqlite。
 */
function getProjectDb(projectId: string): ProjectDatabase {
  if (!appDb) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const indexRepo = appDb.getProjectIndexRepository();
  const project = indexRepo.getById(projectId);
  if (!project) {
    throw new AppError('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
  }

  const dbPath = join(project.projectDirectory, 'project.sqlite');
  if (!existsSync(dbPath)) {
    throw new AppError('PROJECT_DATABASE_INVALID', '项目数据库不存在');
  }

  return new ProjectDatabase(dbPath);
}

/** 将 TaskData 转换为 TaskPublicData（清理敏感数据） */
function toTaskPublicData(task: TaskData): TaskPublicData {
  return {
    id: task.id,
    projectId: task.projectId,
    taskType: task.taskType,
    status: task.status,
    attemptCount: task.attemptCount,
    result: task.resultJson ? JSON.parse(task.resultJson) : null,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

async function handleCreateModelInvocationTest(payload: unknown): Promise<TaskPublicData> {
  if (!isValidCreateModelInvocationTestInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的创建任务输入');
  }

  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const projDb = getProjectDb(payload.projectId);
  try {
    const taskRepo = new TaskRepositoryAdapter(projDb);
    const invocationRepo = new ModelInvocationRepositoryAdapter(projDb);
    const providerRepo = new ProviderProfileRepositoryAdapter(appDb);
    const idGen = createIdGenerator();
    const clock = createClock();

    // 创建任务
    const taskId = idGen.generate();
    const promptHash = sha256Hex(payload.prompt);

    taskRepo.create({
      id: taskId,
      projectId: payload.projectId,
      taskType: 'MODEL_INVOCATION_TEST',
      inputVersionJson: '{}',
      payloadJson: JSON.stringify({
        promptHash,
        promptLength: payload.prompt.length,
      }),
    });

    // 执行任务
    const result = await executeModelInvocationTest(
      {
        taskRepo,
        invocationRepo,
        secretStore,
        providerRepo,
        idGenerator: idGen,
        clock,
        invokeModel: async (input: {
          baseUrl: string;
          model: string;
          apiKey: string;
          prompt: string;
        }) => {
          return invokeModel({ fetch: globalThis.fetch, clock }, input);
        },
        transaction: <T>(fn: () => T) => projDb.transaction(fn),
      },
      taskId,
      payload.prompt,
    );

    return toTaskPublicData(result.task);
  } finally {
    projDb.close();
  }
}

/**
 * 构建 Grill planner runner 依赖。
 */
function buildGrillPlanRunnerDeps(): GrillPlanRunnerDeps {
  return {
    openDb: (projectId: string) => getProjectDb(projectId),
    buildEngineDeps: (projDb: ProjectDatabase) => {
      const clock = createClock();
      return {
        taskRepo: new TaskRepositoryAdapter(projDb),
        invocationRepo: new ModelInvocationRepositoryAdapter(projDb),
        secretStore: secretStore!,
        providerRepo: new ProviderProfileRepositoryAdapter(appDb!),
        idGenerator: createIdGenerator(),
        clock,
        sessionRepo: new GrillSessionRepositoryAdapter(projDb, clock),
        questionRepo: new GrillQuestionRepositoryAdapter(projDb, clock),
        answerRepo: new GrillAnswerRepositoryAdapter(projDb, clock),
        planProposalRepo: new GrillQuestionPlanProposalRepositoryAdapter(projDb, clock),
        invokeModel: async (input: {
          baseUrl: string;
          model: string;
          apiKey: string;
          prompt: string;
          systemPrompt?: string;
          maxTokens?: number;
          temperature?: number;
        }) => {
          return invokeModel({ fetch: globalThis.fetch, clock }, input);
        },
        transaction: <T>(fn: () => T) => projDb.transaction(fn),
      };
    },
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    getInvocationRepo: (projDb: ProjectDatabase) => new ModelInvocationRepositoryAdapter(projDb),
  };
}

/**
 * 后台执行 Grill 问题规划任务（委托给 grill-plan-runner 模块）。
 * 返回调度结果供恢复路径判断是否需要 settlement fallback。
 */
function runGrillQuestionPlan(projectId: string, taskId: string): GrillPlanScheduleResult {
  if (!appDb || !secretStore) return { scheduled: false, reason: 'SETUP_FAILED' };
  return scheduleGrillPlanRun(buildGrillPlanRunnerDeps(), projectId, taskId);
}

/**
 * 启动时恢复：扫描所有项目中 PENDING 的 GRILL_QUESTION_PLAN 任务并调度执行。
 * schedule 失败时安全终结任务，避免永久 PENDING。
 */
function recoverPendingGrillPlans(dataRoot: string): void {
  const projectsPath = join(dataRoot, 'projects');
  if (!existsSync(projectsPath)) return;

  recoverPendingGrillPlansModule({
    listProjectDbs: () => {
      const result: Array<{ projectId: string; projDb: ProjectDatabase }> = [];
      for (const entry of readdirSync(projectsPath)) {
        const projectDir = join(projectsPath, entry);
        const dbPath = join(projectDir, 'project.sqlite');
        if (!existsSync(dbPath)) continue;
        try {
          const projDb = new ProjectDatabase(dbPath);
          // 从 DB 元数据获取 projectId 不可靠，使用目录名作为 hint
          // 实际 projectId 由 task.projectId 字段决定
          result.push({ projectId: entry, projDb });
        } catch {
          // 无法打开的数据库留待下次恢复
        }
      }
      return result;
    },
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    schedule: (projectId: string, taskId: string) => runGrillQuestionPlan(projectId, taskId),
    settle: (projDb: ProjectDatabase, taskId: string) =>
      settleGrillPlanRunnerFailure(buildGrillPlanRunnerDeps(), projDb, taskId),
  });
}

/**
 * 构建创作契约草案 runner 依赖（engine deps 使用 BEGIN IMMEDIATE 最终事务）。
 */
function buildContractDraftRunnerDeps(): ContractDraftRunnerDeps {
  return {
    openDb: (projectId: string) => getProjectDb(projectId),
    buildEngineDeps: (projDb: ProjectDatabase) => {
      const clock = createClock();
      const engineDeps: ContractDraftEngineDeps = {
        taskRepo: new TaskRepositoryAdapter(projDb),
        invocationRepo: new ModelInvocationRepositoryAdapter(projDb),
        secretStore: secretStore!,
        providerRepo: new ProviderProfileRepositoryAdapter(appDb!),
        idGenerator: createIdGenerator(),
        clock,
        sessionRepo: new GrillSessionRepositoryAdapter(projDb, clock),
        questionRepo: new GrillQuestionRepositoryAdapter(projDb, clock),
        answerRepo: new GrillAnswerRepositoryAdapter(projDb, clock),
        grillProposalRepo: new GrillProposalRepositoryAdapter(projDb, clock),
        ccProposalRepo: projDb.getCreationContractProposalRepository(),
        ccVersionRepo: projDb.getCreationContractVersionRepository(),
        ccCurrentRepo: projDb.getCreationContractCurrentRepository(),
        sha256Port: { digestUtf8: (input: string) => sha256Hex(input) },
        invokeModel: async (input: {
          baseUrl: string;
          model: string;
          apiKey: string;
          prompt: string;
          systemPrompt?: string;
          maxTokens?: number;
          temperature?: number;
        }) => {
          return invokeModel({ fetch: globalThis.fetch, clock }, input);
        },
        transaction: <T>(fn: () => T) => projDb.transactionImmediate(fn),
      };
      return engineDeps;
    },
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    getInvocationRepo: (projDb: ProjectDatabase) => new ModelInvocationRepositoryAdapter(projDb),
  };
}

/**
 * 后台执行创作契约草案任务（委托给 contract-draft-runner 模块）。
 * 返回调度结果供请求路径判断是否需要 failPending fallback。
 */
function runContractDraft(projectId: string, taskId: string): ContractDraftScheduleResult {
  if (!appDb || !secretStore) {
    return { scheduled: false, reason: 'SETUP_FAILED' };
  }
  return scheduleContractDraftRun(buildContractDraftRunnerDeps(), projectId, taskId);
}

/**
 * 启动时恢复：扫描所有项目中 PENDING 的 CREATION_CONTRACT_DRAFT 任务并调度执行。
 * 不重复 claim（引擎 CAS）；每个 project DB close exactly once；异常不阻塞其他项目。
 */
function recoverPendingContractDrafts(dataRoot: string): void {
  const projectsPath = join(dataRoot, 'projects');
  if (!existsSync(projectsPath)) return;

  recoverPendingContractDraftsModule({
    listProjectDbs: () => {
      const result: Array<{ projectId: string; projDb: ProjectDatabase }> = [];
      for (const entry of readdirSync(projectsPath)) {
        const projectDir = join(projectsPath, entry);
        const dbPath = join(projectDir, 'project.sqlite');
        if (!existsSync(dbPath)) continue;
        try {
          const projDb = new ProjectDatabase(dbPath);
          result.push({ projectId: entry, projDb });
        } catch {
          // 无法打开的数据库留待下次恢复
        }
      }
      return result;
    },
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    schedule: (projectId: string, taskId: string) => runContractDraft(projectId, taskId),
    settle: (projDb: ProjectDatabase, taskId: string) =>
      settleContractDraftRunnerFailure(buildContractDraftRunnerDeps(), projDb, taskId),
  });
}

async function handleRequestQuestionPlan(
  payload: unknown,
): Promise<GrillRequestQuestionPlanResult> {
  if (!isValidGrillRequestQuestionPlanInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的请求问题规划输入');
  }

  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  // 从当前启用的产品提供商配置解析 providerProfileId（Renderer 不传递）
  const enabledProfile = appDb
    .getProviderProfileRepository()
    .list()
    .find((p) => p.enabled);
  if (!enabledProfile) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', '请先配置模型提供商');
  }

  const projDb = getProjectDb(payload.projectId);
  try {
    const taskRepo = new TaskRepositoryAdapter(projDb);
    const sessionRepo = new GrillSessionRepositoryAdapter(projDb, createClock());
    const questionRepo = new GrillQuestionRepositoryAdapter(projDb, createClock());
    const planProposalRepo = new GrillQuestionPlanProposalRepositoryAdapter(projDb, createClock());
    const idGen = createIdGenerator();
    const clock = createClock();

    // 仅验证 + 原子创建任务 + 返回 taskId（不等待模型调用）
    const requested = requestGrillQuestionPlan(
      {
        idGenerator: idGen,
        clock,
        sessionRepo,
        questionRepo,
        planProposalRepo,
        taskRepo,
        transaction: <T>(fn: () => T) => projDb.transaction(fn),
      },
      {
        projectId: payload.projectId,
        sessionId: payload.sessionId,
        expectedSessionVersion: payload.expectedSessionVersion,
        providerProfileId: enabledProfile.id,
      },
    );

    // 异步调度后台执行（独立 DB，不阻塞 IPC 响应）
    const scheduleResult = scheduleGrillPlanRun(
      buildGrillPlanRunnerDeps(),
      payload.projectId,
      requested.taskId,
    );
    if (!scheduleResult.scheduled) {
      // 调度失败：使用请求 DB 立即终结任务，释放 dedupe
      taskRepo.failPending(requested.taskId, 'TASK_EXECUTION_FAILED', '问题规划任务调度失败');
    }

    return {
      taskId: requested.taskId,
      sessionId: requested.sessionId,
      baseSessionVersion: requested.baseSessionVersion,
    };
  } finally {
    projDb.close();
  }
}

function handleGetTask(payload: unknown): TaskPublicData {
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError('VALIDATION_ERROR', '无效的任务查询输入');
  }
  const { projectId, taskId } = payload as { projectId?: string; taskId?: string };
  if (typeof projectId !== 'string' || typeof taskId !== 'string') {
    throw new AppError('VALIDATION_ERROR', '缺少 projectId 或 taskId');
  }

  const projDb = getProjectDb(projectId);
  try {
    const taskRepo = new TaskRepositoryAdapter(projDb);
    const task = taskRepo.getById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
    }
    return toTaskPublicData(task);
  } finally {
    projDb.close();
  }
}

function handleListTasks(payload: unknown): ReadonlyArray<TaskPublicData> {
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError('VALIDATION_ERROR', '无效的任务列表输入');
  }
  const { projectId } = payload as { projectId?: string };
  if (typeof projectId !== 'string') {
    throw new AppError('VALIDATION_ERROR', '缺少 projectId');
  }

  const projDb = getProjectDb(projectId);
  try {
    const taskRepo = new TaskRepositoryAdapter(projDb);
    return taskRepo.listByProject(projectId).map(toTaskPublicData);
  } finally {
    projDb.close();
  }
}

function handleGetTaskStats(payload: unknown): TaskStatsPublicData {
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError('VALIDATION_ERROR', '无效的统计查询输入');
  }
  const { projectId } = payload as { projectId?: string };
  if (typeof projectId !== 'string') {
    throw new AppError('VALIDATION_ERROR', '缺少 projectId');
  }

  const projDb = getProjectDb(projectId);
  try {
    const invocationRepo = new ModelInvocationRepositoryAdapter(projDb);
    return invocationRepo.getStatsByProject(projectId);
  } finally {
    projDb.close();
  }
}

// ── 命令分发 ──────────────────────────────────────────────────────

async function dispatchCommand(request: RPCRequest): Promise<RPCResponse> {
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
      case 'provider.getState':
        data = await handleGetProviderState();
        break;
      case 'provider.saveApiKey':
        data = await handleSaveProviderApiKey(request.payload);
        break;
      case 'provider.deleteApiKey':
        data = await handleDeleteProviderApiKey();
        break;
      case 'provider.testConnection':
        data = await handleTestProviderConnection();
        break;
      case 'task.createModelInvocationTest':
        data = await handleCreateModelInvocationTest(request.payload);
        break;
      case 'task.get':
        data = handleGetTask(request.payload);
        break;
      case 'task.list':
        data = handleListTasks(request.payload);
        break;
      case 'task.getStats':
        data = handleGetTaskStats(request.payload);
        break;
      case 'grill.requestQuestionPlan':
        data = await handleRequestQuestionPlan(request.payload);
        break;
      case 'grill.createSession':
      case 'grill.getSession':
      case 'grill.listSessions':
      case 'grill.startSession':
      case 'grill.pauseSession':
      case 'grill.resumeSession':
      case 'grill.completeSession':
      case 'grill.abandonSession':
      case 'grill.addQuestions':
      case 'grill.answerQuestion':
      case 'grill.skipQuestion':
      case 'grill.supersedeQuestion':
      case 'grill.getCurrentAnswers':
      case 'grill.listAnswerHistory':
      case 'grill.createProposal':
      case 'grill.reviewProposal':
      case 'grill.listProposals':
      case 'grill.acceptQuestionPlanProposal':
      case 'grill.listQuestionPlanProposals':
      case 'grill.getQuestionPlanProposal': {
        const grillCtx: GrillHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
        };
        data = dispatchGrillCommand(request.command, request.payload, grillCtx);
        break;
      }
      case 'contract.getCurrent':
      case 'contract.listVersions':
      case 'contract.getProposal':
      case 'contract.listProposals':
      case 'contract.requestDraft':
      case 'contract.acceptProposal':
      case 'contract.rejectProposal':
      case 'contract.updateByUser':
      case 'contract.lockField':
      case 'contract.unlockField': {
        if (!appDb) {
          throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
        }
        const contractCtx: ContractHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
          resolveEnabledProvider: () => {
            const enabled = appDb!
              .getProviderProfileRepository()
              .list()
              .find((p) => p.enabled);
            if (!enabled) return null;
            return {
              id: enabled.id,
              providerType: enabled.providerType,
              displayName: enabled.displayName,
              baseUrl: enabled.baseUrl,
              model: enabled.model,
              keychainService: enabled.keychainService,
              keychainAccount: enabled.keychainAccount,
              enabled: enabled.enabled,
              createdAt: enabled.createdAt,
              updatedAt: enabled.updatedAt,
              lastTestedAt: enabled.lastTestedAt,
              lastTestStatus: enabled.lastTestStatus,
              lastTestErrorCode: enabled.lastTestErrorCode,
              lastTestLatencyMs: enabled.lastTestLatencyMs,
            };
          },
          getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
          scheduleContractDraft: (projectId: string, taskId: string) =>
            runContractDraft(projectId, taskId),
        };
        data = dispatchContractCommand(request.command, request.payload, contractCtx);
        break;
      }
      case 'manuscript.getOrCreateManuscript':
      case 'manuscript.getManuscript':
      case 'manuscript.listChapters':
      case 'manuscript.getChapter':
      case 'manuscript.getCurrentChapterVersion':
      case 'manuscript.listChapterVersions':
      case 'manuscript.getChapterVersion':
      case 'manuscript.createChapter':
      case 'manuscript.createChapterVersion':
      case 'manuscript.promoteChapterVersion':
      case 'manuscript.updateChapterOrder':
      case 'manuscript.archiveChapter':
      case 'manuscript.restoreChapter':
      case 'manuscript.updateManuscriptTitle': {
        if (!appDb) {
          throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
        }
        const manuscriptCtx: ManuscriptHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
        };
        data = dispatchManuscriptCommand(request.command, request.payload, manuscriptCtx);
        break;
      }
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

    // 不泄露内部错误细节，使用 INTERNAL_ERROR 而非 PROJECT_CREATE_FAILED
    return {
      requestId: request.requestId,
      success: false,
      error: { code: 'INTERNAL_ERROR' as ErrorCode, message: '操作失败' },
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

  // dispatchCommand 可能是 async 的（如 provider.testConnection）
  void dispatchCommand(request).then(
    (response) => sendToParent(response),
    (_err) => {
      // 不泄露内部错误细节
      sendToParent({
        requestId: request.requestId,
        success: false,
        error: { code: 'INTERNAL_ERROR' as ErrorCode, message: '操作失败' },
      });
    },
  );
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
