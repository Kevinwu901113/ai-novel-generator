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
  isValidProviderProfileIdInput,
  isValidCreateProviderProfileInput,
  isValidUpdateProviderProfileInput,
  isValidCreateModelInvocationTestInput,
  isValidGrillRequestQuestionPlanInput,
  type AppError as AppErrorType,
  type ErrorCode,
  type ProviderPublicState,
  type ProviderProtocol,
  type ConnectionTestResult,
  type TaskPublicData,
  type TaskStatsPublicData,
  type GrillRequestQuestionPlanResult,
} from '@ai-novel/contracts';
import {
  createProject,
  listProjects,
  openProject,
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  resolveProviderForTask,
  saveProviderApiKey,
  deleteProviderApiKey,
  testProviderConnection,
  requestGrillQuestionPlan,
  AppError,
  TaskDedupeConflictError,
  type CreateProjectDeps,
  type ListProjectsDeps,
  type OpenProjectDeps,
  type ProviderProfileDeps,
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
import { dispatchGraphCommand, type GraphHandlerContext } from './graph-handlers.js';
import { dispatchIntakeCommand } from './intake-handlers.js';
import {
  createFakeResearchProvider,
  dispatchResearchCommand,
  type ResearchHandlerContext,
} from './research-handlers.js';
import { dispatchBlueprintCommand, type BlueprintHandlerContext } from './blueprint-handlers.js';
import { createLeadingTrailingDebouncer } from './leading-trailing-debounce.js';
import {
  ExecutorRegistry,
  productionArtifactResolver,
  TAVILY_SEARCH_SECRET_REF,
  type ArtifactResolverPort,
  type NodeExecutorRunner,
  type NodeRunnerDeps,
} from '@ai-novel/application';
import { IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1 } from '@ai-novel/domain';
import {
  scheduleContractDraftRun,
  settleContractDraftRunnerFailure,
  recoverPendingContractDrafts as recoverPendingContractDraftsModule,
  type ContractDraftRunnerDeps,
  type ContractDraftScheduleResult,
} from './contract-draft-runner.js';
import { scheduleGraphTask, type GraphTaskRunnerDeps } from './graph-task-runner.js';
import { runProjectRecovery } from './recovery-bootstrap.js';
import { driveRun } from '@ai-novel/application';
import { registerIntakeExecutors } from './intake-executors.js';
import { registerResearchExecutors } from './research-executors.js';
import { registerBlueprintExecutors } from './blueprint-executors.js';
import { registerProjectTerminalExecutors } from './project-terminal-executors.js';
import { registerChapterExecutors } from './chapter-executors.js';
import { registerManuscriptCommitExecutor } from './manuscript-commit-executor.js';
import { dispatchChapterCommand, type ChapterHandlerContext } from './chapter-handlers.js';
import { dispatchManuscriptCommand, type ManuscriptHandlerContext } from './manuscript-handlers.js';
import { createSafeWebFetch, createTavilySearchProvider } from '@ai-novel/research-engine';
import { buildGrillSessionDeps as buildGrillDepsForEngine } from './grill-handlers.js';

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

  list(): ReadonlyArray<ProviderProfileData> {
    return this.appDb
      .getProviderProfileRepository()
      .list()
      .map((row) => this.toAppData(row));
  }

  getDefault(): ProviderProfileData | null {
    const row = this.appDb.getProviderProfileRepository().getDefault();
    if (!row) return null;
    return this.toAppData(row);
  }

  create(data: {
    id: string;
    providerType: string;
    displayName: string;
    baseUrl: string;
    model: string;
    keychainService: string;
    keychainAccount: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.appDb.getProviderProfileRepository().create(data);
  }

  update(data: {
    id: string;
    providerType: string;
    displayName: string;
    baseUrl: string;
    model: string;
    enabled: boolean;
    updatedAt: string;
  }): void {
    this.appDb.getProviderProfileRepository().update(data);
  }

  delete(id: string): boolean {
    return this.appDb.getProviderProfileRepository().delete(id);
  }

  setDefault(id: string): boolean {
    return this.appDb.getProviderProfileRepository().setDefault(id);
  }

  getRoute(taskType: string): string | null {
    return this.appDb.getProviderProfileRepository().getRoute(taskType);
  }

  setRoute(taskType: string, profileId: string, updatedAt: string): void {
    this.appDb.getProviderProfileRepository().setRoute(taskType, profileId, updatedAt);
  }

  deleteRoute(taskType: string): void {
    this.appDb.getProviderProfileRepository().deleteRoute(taskType);
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
      isDefault: row.isDefault,
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

export class TaskRepositoryAdapter implements TaskRepositoryPort {
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

export class ModelInvocationRepositoryAdapter implements ModelInvocationRepositoryPort {
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

/**
 * 异步初始化（RW-1-R5 readiness recovery）：
 * 全部数据一致性恢复 + **await recoverGraphRuns** 完成后才返回 —— 调用方在返回后才
 * 发布 Worker READY / 接受 RPC，保证启动恢复先行。
 */
async function initialize(): Promise<void> {
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

  // 恢复 PENDING 的 Grill 规划任务（幂等重新调度，CAS claim）
  recoverPendingGrillPlans(dataRoot);

  // 恢复 PENDING 的创作契约草案任务（幂等重新调度，CAS claim）
  recoverPendingContractDrafts(dataRoot);

  // 恢复中断的 Graph run（await runner 后关 DB；按 recoveryPolicy reconcile）
  await recoverGraphRuns();
}

/**
 * RW-1 生产 bootstrap（共享，不每项目重建）—— GE-3..6 注册真实 executor 时填充。
 * 当前无具体 executor（GE-3..6 前），active 节点 → fail-closed；但已有 execution 会按
 * 其 stored recoveryPolicy reconcile（TASK_INTERRUPTED → 受控新 attempt）。
 */
const productionRegistry = new ExecutorRegistry();
const productionRunners = new Map<string, NodeExecutorRunner>();

// GE-3（B3）：注册 Idea Intake 三个真实 executor（IDEA_CAPTURE / ASK_QUESTION sync、
// SPEC_EXTRACT task-backed）。COLLECT_ANSWER / INTAKE_ESCALATION 是人工 Gate，无 executor。
registerIntakeExecutors(productionRegistry, productionRunners, {
  getProjectDb: (projectId: string) => getProjectDb(projectId),
  idGenerator: createIdGenerator(),
  clock: createClock(),
});

// GE-4（B5）：注册 Research 四个真实 executor（DECISION/PLAN/VALIDATE sync、
// EXECUTE task-backed）。RESEARCH_ESCALATION 是人工 Gate，无 executor。
registerResearchExecutors(productionRegistry, productionRunners, {
  getProjectDb: (projectId: string) => getProjectDb(projectId),
  idGenerator: createIdGenerator(),
  clock: createClock(),
});

// GE-5（B7）：注册 BLUEPRINT_GENERATE（task-backed）。BLUEPRINT_USER_GATE /
// BLUEPRINT_ESCALATION 是人工 Gate，无 executor；accept 副作用见 graph-run.ts（D-B7-1/2）。
registerBlueprintExecutors(productionRegistry, productionRunners, {
  getProjectDb: (projectId: string) => getProjectDb(projectId),
  idGenerator: createIdGenerator(),
  clock: createClock(),
});

// B7 随行修复：Project Graph 终止节点（PROJECT_READY/CANCELLED/BLOCKED）此前从未被
// 注册 executor——driveRun 对 TERMINAL kind 无特殊豁免，见 project-terminal-executors.ts
// 顶部说明。GE-5"PROJECT_READY 原子闭环"退出条件要求真正到达这些终态，随批次一并补齐。
registerProjectTerminalExecutors(productionRegistry, productionRunners);

// GE-6（B9）：注册章节生成节点（CHAPTER_PLAN / DRAFT / 三 Critic / REWRITE task-backed，
// CRITIQUE_JOIN sync）与 Chapter Graph 三个终止节点（销 TD-029-4）。CANDIDATE_GATE /
// CANDIDATE_ESCALATION 是人工 Gate；MANUSCRIPT_COMMIT 有意不注册（属 GE-7），
// 见 chapter-executors.ts 顶部说明。
registerChapterExecutors(productionRegistry, productionRunners, {
  getProjectDb: (projectId: string) => getProjectDb(projectId),
  idGenerator: createIdGenerator(),
  clock: createClock(),
});

// GE-7：注册 MANUSCRIPT_COMMIT（sync）——用户在候选 Gate 接受后把那一版正文写入
// 权威稿件（锁定不变量第 5 条的唯一入口）。见 manuscript-commit-executor.ts。
registerManuscriptCommitExecutor(productionRegistry, productionRunners, {
  getProjectDb: (projectId: string) => getProjectDb(projectId),
  idGenerator: createIdGenerator(),
  clock: createClock(),
});

/** D-B3-1 live drive 与任务后推进共用的 NodeRunnerDeps 构造（同一 projDb 生命周期内使用） */
function buildLiveNodeRunnerDeps(projDb: ProjectDatabase, projectId: string): NodeRunnerDeps {
  return {
    idGenerator: createIdGenerator(),
    clock: createClock(),
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: projDb.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    registry: productionRegistry,
    runners: productionRunners,
    artifactResolver: productionArtifactResolver,
    runnerId: `worker-live:${process.pid}`,
    scheduleTask: (taskId) => {
      scheduleGraphTask(buildGraphTaskRunnerDeps(), projectId, taskId);
    },
  };
}

/**
 * D-B3-1 live drive：fire-and-forget 驱动 NodeRunner，失败静默（启动恢复兜底）。
 * `getProjectDb` 每次新建连接，必须随驱动结束关闭（TD-023 纪律）。
 * graph.* 与 chapter.* 两处分发共用同一份实现，避免复制漂移。
 */
function driveRunLive(projectId: string, runId: string): void {
  void (async () => {
    const projDb = getProjectDb(projectId);
    try {
      await driveRun(buildLiveNodeRunnerDeps(projDb, projectId), projectId, runId);
    } finally {
      try {
        projDb.close();
      } catch {
        // 关闭失败不产生 unhandled rejection
      }
    }
  })().catch(() => {});
}

/**
 * RW-1-R5 生产 artifact 边界：transaction-scoped resolver。
 * 实现已抽到 @ai-novel/application 的 productionArtifactResolver（TD-019），
 * worker 与 packages/database 集成测试共用同一份实现，禁止再各写一份。
 */

/**
 * RW-1 启动恢复：对每个项目的非终态 run **await** NodeRunner，全部完成后才关闭 ProjectDatabase。
 * 替换旧的无差别 active→failed 行为：有 execution record 时按 recoveryPolicy reconcile
 * （task succeeded+unsettled → 幂等 settlement；TASK_INTERRUPTED → 受控新 attempt；
 *  deterministic failed → applyNodeFailure）；无 execution / 未知 executor / 不可重放 → fail-closed。
 * 每 project / run 错误隔离（ProjectDatabase 构造在每项目 try 内）；只有全部项目 DB 恢复结束
 * 才返回（readiness 门禁）。
 *
 * Blocker 2：接真实 idempotent `scheduleTask` —— PENDING Graph task 在启动恢复中真正重新调度。
 */

/** 启动恢复可注入选项（集成测试覆盖 registry / scheduleTask） */
export interface RecoveryOptions {
  readonly registry?: ExecutorRegistry;
  readonly runners?: Map<string, NodeExecutorRunner>;
  readonly resolver?: ArtifactResolverPort;
  readonly scheduleTask?: (projectId: string, taskId: string) => void;
}

/** 构建真实 Graph task scheduler（幂等；执行 Graph 全部 task-backed 节点的任务） */
function buildGraphTaskRunnerDeps(): GraphTaskRunnerDeps {
  return {
    openDb: (projectId: string) => getProjectDb(projectId),
    buildEngineDeps: (projDb: ProjectDatabase) => {
      const clock = createClock();
      const idGenerator = createIdGenerator();
      const grillDeps = buildGrillDepsForEngine(projDb, {
        getProjectDb: (projectId: string) => getProjectDb(projectId),
        idGenerator,
        clock,
      });
      return {
        taskRepo: new TaskRepositoryAdapter(projDb),
        invocationRepo: new ModelInvocationRepositoryAdapter(projDb),
        secretStore: secretStore!,
        providerRepo: new ProviderProfileRepositoryAdapter(appDb!),
        idGenerator,
        clock,
        invokeModel: async (input: {
          baseUrl: string;
          model: string;
          apiKey: string;
          prompt: string;
          systemPrompt?: string;
          protocol?: ProviderProtocol;
          // B9：章节正文任务显式抬高输出上限（省略时沿用网关默认 4096）
          maxTokens?: number;
        }) => {
          return invokeModel({ fetch: globalThis.fetch, clock }, input);
        },
        transaction: <T>(fn: () => T) => projDb.transactionImmediate(fn),
        nodeExecutionResultStore: projDb.getNodeExecutionResultStore(),
        nodeExecutionRepo: projDb.getNodeExecutionRepository(),
        // SPEC_EXTRACT（B3）：intake 会话上下文 + CreationSpec 版本基座
        sessionRepo: grillDeps.sessionRepo,
        questionRepo: grillDeps.questionRepo,
        answerRepo: grillDeps.answerRepo,
        versionRepo: projDb.getCreationContractVersionRepository(),
        currentRepo: projDb.getCreationContractCurrentRepository(),
        // RESEARCH_RUN（B5）：调研上下文 + Tavily/SafeWebFetch 端口（D-B5-3/5）
        specVersionRepo: projDb.getCreationContractVersionRepository(),
        researchRepo: projDb.getResearchBundleRepository(),
        buildSearchPort: (apiKey: string) => createTavilySearchProvider({ apiKey }),
        webFetch: createSafeWebFetch(),
        // BLUEPRINT_GENERATE（B7）：蓝图版本化持久化端口（D-B7-5 版本号取 MAX+1）
        blueprintRepo: projDb.getStoryBlueprintRepository(),
        // D-B7-13：来源排除读端口（B6 交付，B7 是首个消费方）
        sourceExclusionRepo: projDb.getResearchSourceExclusionRepository(),
        // 章节生成四类任务（B9）：run binding 反查 + 场景计划/候选修订/审查结论持久化
        graphRunRepo: projDb.getGraphRunRepository(),
        scenePlanRepo: projDb.getChapterScenePlanRepository(),
        candidateRepo: projDb.getChapterCandidateRepository(),
        critiqueRepo: projDb.getChapterCritiqueRepository(),
        rewriteFeedbackRepo: projDb.getChapterRewriteFeedbackRepository(),
      };
    },
    getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
    getInvocationRepo: (projDb: ProjectDatabase) => new ModelInvocationRepositoryAdapter(projDb),
    // D-B3-1：任务终结后在同一 projDb 上驱动结算与后续推进
    buildNodeRunnerDeps: (projDb: ProjectDatabase, projectId: string) =>
      buildLiveNodeRunnerDeps(projDb, projectId),
  };
}

/**
 * TD-025-3（D-B4-8）：provider/search key 配置成功后 fire-and-forget 重驱动一次
 * 全部非终态 run。复用启动恢复扫描（含 PENDING Graph task 重调度）——修复
 * "未配 key 时任务保持 PENDING、配置成功后需重启应用才重调度"。
 *
 * TD-026-2（D-B6-8）：leading+trailing 防抖（见 leading-trailing-debounce.ts）——
 * 旧的简单 in-flight 布尔丢弃在扫描在途时会丢掉窗口内的后续触发、无尾随重扫，
 * 极端时序下 PENDING 任务会滞留到下次 provider/search key 操作或应用重启才被
 * 捡起。改为窗口结束后如有尾随触发则补跑一次；失败静默（启动恢复兜底）。
 */
const redriveAfterProviderConfig = createLeadingTrailingDebouncer(() => recoverGraphRuns());

async function recoverGraphRuns(opts: RecoveryOptions = {}): Promise<void> {
  if (!appDb) return;
  await runProjectRecovery({
    listProjects: () =>
      appDb!
        .getProjectIndexRepository()
        .list()
        .map((p) => ({
          projectId: p.id,
          projectDirectory: p.projectDirectory,
        })),
    openProjectDb: (dbPath) => new ProjectDatabase(dbPath),
    buildRunnerDeps: (projDb, projectId) => {
      const runnerDeps: NodeRunnerDeps = {
        idGenerator: createIdGenerator(),
        clock: createClock(),
        hashPayload: (payload: string) => sha256Hex(payload),
        tx: projDb.getGraphRunTransaction(),
        projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
        chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
        registry: opts.registry ?? productionRegistry,
        runners: opts.runners ?? productionRunners,
        artifactResolver: opts.resolver ?? productionArtifactResolver,
        runnerId: `worker-recover:${process.pid}`,
        scheduleTask: (taskId) => {
          if (opts.scheduleTask) {
            opts.scheduleTask(projectId, taskId);
          } else {
            scheduleGraphTask(buildGraphTaskRunnerDeps(), projectId, taskId);
          }
        },
      };
      return runnerDeps;
    },
  });
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

/** 构建 ProviderProfile 用例依赖（list/create/update/delete/setDefault 共用） */
function buildProviderProfileDeps(): ProviderProfileDeps {
  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }
  return {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    idGenerator: createIdGenerator(),
    clock: createClock(),
  };
}

async function handleListProviders(): Promise<ReadonlyArray<ProviderPublicState>> {
  return listProviders(buildProviderProfileDeps());
}

async function handleCreateProvider(payload: unknown): Promise<ProviderPublicState> {
  if (!isValidCreateProviderProfileInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的创建提供商输入');
  }
  return createProvider(buildProviderProfileDeps(), payload);
}

async function handleUpdateProvider(payload: unknown): Promise<ProviderPublicState> {
  if (!isValidUpdateProviderProfileInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的更新提供商输入');
  }
  return updateProvider(buildProviderProfileDeps(), payload);
}

async function handleDeleteProvider(payload: unknown): Promise<ReadonlyArray<ProviderPublicState>> {
  if (!isValidProviderProfileIdInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的提供商 id 输入');
  }
  return deleteProvider(buildProviderProfileDeps(), payload.profileId);
}

async function handleSetDefaultProvider(
  payload: unknown,
): Promise<ReadonlyArray<ProviderPublicState>> {
  if (!isValidProviderProfileIdInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的提供商 id 输入');
  }
  return setDefaultProvider(buildProviderProfileDeps(), payload.profileId);
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

  return saveProviderApiKey(deps, { profileId: payload.profileId, apiKey: payload.apiKey });
}

// ── Search key（B5/D-B5-6：Tavily 槽位；key 永不入库、不回显）────

async function handleSaveSearchApiKey(payload: unknown): Promise<{ hasApiKey: boolean }> {
  const apiKey =
    payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).apiKey
      : undefined;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', '无效的搜索 API Key 输入');
  }
  if (!secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '密钥服务未初始化');
  }
  await secretStore.setSecret(
    TAVILY_SEARCH_SECRET_REF.service,
    TAVILY_SEARCH_SECRET_REF.account,
    apiKey.trim(),
  );
  return { hasApiKey: true };
}

async function handleDeleteSearchApiKey(): Promise<{ hasApiKey: boolean }> {
  if (!secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '密钥服务未初始化');
  }
  await secretStore.deleteSecret(
    TAVILY_SEARCH_SECRET_REF.service,
    TAVILY_SEARCH_SECRET_REF.account,
  );
  return { hasApiKey: false };
}

async function handleHasSearchApiKey(): Promise<{ hasApiKey: boolean }> {
  if (!secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '密钥服务未初始化');
  }
  const has = await secretStore.hasSecret(
    TAVILY_SEARCH_SECRET_REF.service,
    TAVILY_SEARCH_SECRET_REF.account,
  );
  return { hasApiKey: has };
}

async function handleDeleteProviderApiKey(payload: unknown): Promise<ProviderPublicState> {
  if (!isValidProviderProfileIdInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的提供商 id 输入');
  }

  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: DeleteProviderApiKeyDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    clock: createClock(),
  };

  return deleteProviderApiKey(deps, payload.profileId);
}

async function handleTestProviderConnection(payload: unknown): Promise<ConnectionTestResult> {
  if (!isValidProviderProfileIdInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的提供商 id 输入');
  }

  if (!appDb || !secretStore) {
    throw new AppError('WORKER_UNAVAILABLE', '数据库未初始化');
  }

  const deps: TestProviderConnectionDeps = {
    providerRepo: new ProviderProfileRepositoryAdapter(appDb),
    secretStore,
    clock: createClock(),
    testConnection: async (input: {
      baseUrl: string;
      model: string;
      apiKey: string;
      protocol: ProviderProtocol;
    }) => {
      return modelGatewayTestConnection({ fetch: globalThis.fetch, clock: createClock() }, input);
    },
  };

  return testProviderConnection(deps, payload.profileId);
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

  // 解析 provider（Renderer 不传递）：走 D6 两层路由（任务类型覆盖 → 全局默认）。
  // 不再用"列表里第一个 enabled"的旧规则 —— 多 provider 之后那会与默认设置冲突。
  const enabledProfile = resolveProviderForTask(
    { providerRepo: new ProviderProfileRepositoryAdapter(appDb) },
    'GRILL_QUESTION_PLAN',
  );

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
      case 'provider.list':
        data = await handleListProviders();
        break;
      case 'provider.create':
        data = await handleCreateProvider(request.payload);
        redriveAfterProviderConfig();
        break;
      case 'provider.update':
        data = await handleUpdateProvider(request.payload);
        redriveAfterProviderConfig();
        break;
      case 'provider.delete':
        data = await handleDeleteProvider(request.payload);
        break;
      case 'provider.setDefault':
        data = await handleSetDefaultProvider(request.payload);
        redriveAfterProviderConfig();
        break;
      case 'provider.saveApiKey':
        data = await handleSaveProviderApiKey(request.payload);
        redriveAfterProviderConfig();
        break;
      case 'provider.deleteApiKey':
        data = await handleDeleteProviderApiKey(request.payload);
        break;
      case 'search.saveApiKey':
        data = await handleSaveSearchApiKey(request.payload);
        // D-B5-6：搜索 key 补齐后重驱动（PENDING 的 RESEARCH_RUN 任务重调度）
        redriveAfterProviderConfig();
        break;
      case 'search.deleteApiKey':
        data = await handleDeleteSearchApiKey();
        break;
      case 'search.hasApiKey':
        data = await handleHasSearchApiKey();
        break;
      case 'provider.testConnection':
        data = await handleTestProviderConnection(request.payload);
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
      case 'grill.listQuestions':
      case 'grill.markQuestionAsked':
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
          // 走 D6 两层路由（任务类型覆盖 → 全局默认）；无可用 provider 时返回 null，
          // 由调用方按既有语义处理。不再使用"列表里第一个 enabled"的旧规则。
          resolveEnabledProvider: () => {
            try {
              return resolveProviderForTask(
                { providerRepo: new ProviderProfileRepositoryAdapter(appDb!) },
                'CREATION_CONTRACT_DRAFT',
              );
            } catch {
              return null;
            }
          },
          getTaskRepo: (projDb: ProjectDatabase) => new TaskRepositoryAdapter(projDb),
          scheduleContractDraft: (projectId: string, taskId: string) =>
            runContractDraft(projectId, taskId),
        };
        data = dispatchContractCommand(request.command, request.payload, contractCtx);
        break;
      }
      // 仅保留 renderer 安全命令：start / read progress / human decision / list。
      // advanceNode / failNode / requestHumanDecision 已从 RPC 面移除（RW-1 公共安全边界）：
      // 非人工节点推进只能是 Worker 内部 NodeRunner + NodeSettlementService 的可信能力。
      case 'graph.createProjectRun':
      case 'graph.createChapterRun':
      case 'graph.getRunProgress':
      case 'graph.applyHumanDecision':
      case 'graph.listRuns': {
        const graphCtx: GraphHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
          // D-B3-1 live drive：fire-and-forget 驱动 NodeRunner，失败静默（启动恢复兜底）
          driveAfter: driveRunLive,
        };
        data = dispatchGraphCommand(request.command, request.payload, graphCtx);
        break;
      }
      case 'intake.createIntakeSession':
      case 'intake.getActiveIntakeSession':
      case 'intake.propagateSpecInvalidation': {
        const intakeCtx: GrillHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
        };
        data = dispatchIntakeCommand(request.command, request.payload, intakeCtx);
        break;
      }
      case 'research.execute': {
        const provider = createFakeResearchProvider();
        const researchCtx: ResearchHandlerContext = {
          getProjectDb,
          search: provider.search,
          fetch: provider.fetch,
        };
        data = await dispatchResearchCommand(request.command, request.payload, researchCtx);
        break;
      }
      // B6：只读调研态 + ResearchBundle 查看 + 来源排除——不发起搜索/抓取，
      // 不复用 research.execute 的 fake provider ctx 装配（D-B6 交付说明）。
      case 'research.getResearchState':
      case 'research.getBundle':
      case 'research.listBundles':
      case 'research.setSourceExclusion':
      case 'research.listSourceExclusions': {
        const researchReadCtx: ResearchHandlerContext = { getProjectDb };
        data = await dispatchResearchCommand(request.command, request.payload, researchReadCtx);
        break;
      }
      // D-B7-3：blueprint.generate / blueprint.accept 已从 RPC 面移除（绕过 Graph 语义
      // 的写入口收口，见 blueprint-handlers.ts 顶部说明）。
      case 'blueprint.getState':
      case 'blueprint.getBlueprint':
      case 'blueprint.listChapters': {
        const blueprintCtx: BlueprintHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
        };
        data = dispatchBlueprintCommand(request.command, request.payload, blueprintCtx);
        break;
      }
      // GE-6（B10）：章节生成产品通道。写入口只有 startRun / submitDecision，二者都
      // 经 createChapterRun / applyHumanDecision，不提供任何伪造节点完成的通道。
      case 'chapter.getOverview':
      case 'chapter.startRun':
      case 'chapter.getRunState':
      case 'chapter.submitDecision': {
        const chapterCtx: ChapterHandlerContext = {
          getProjectDb,
          idGenerator: createIdGenerator(),
          clock: createClock(),
          driveAfter: driveRunLive,
        };
        data = dispatchChapterCommand(request.command, request.payload, chapterCtx);
        break;
      }
      // GE-7：稿件工作区与导出。写入口只有 saveChapter（用户手写，CAS + append-only）；
      // AI 产出的写入路径是 MANUSCRIPT_COMMIT executor，不在 RPC 面上。
      case 'manuscript.getWorkspace':
      case 'manuscript.getChapter':
      case 'manuscript.saveChapter':
      case 'manuscript.listVersions':
      case 'manuscript.restoreVersion':
      case 'manuscript.export': {
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

void (async () => {
  try {
    // RW-1-R5：await 全部恢复（含 recoverGraphRuns）后才发布 READY / 接受 RPC
    await initialize();

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
})();

// 处理进程退出
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
