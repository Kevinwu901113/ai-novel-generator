/**
 * 应用层端口接口。
 *
 * 应用用例通过这些接口与基础设施交互，
 * 不依赖 Electron、React 或 node:sqlite。
 */

import type { TaskStatus, TaskType, ModelInvocationStatus } from '@ai-novel/domain';

// ── ID 生成器 ─────────────────────────────────────────────────────

/** ID 生成器接口 —— 基础设施侧实现（crypto.randomUUID()），测试可注入固定值 */
export interface IdGenerator {
  generate(): string;
}

// ── 时钟 ──────────────────────────────────────────────────────────

/** 时钟接口 —— 基础设施侧实现，测试可注入固定时间 */
export interface Clock {
  /** 返回 UTC ISO 8601 时间字符串 */
  now(): string;
}

// ── 项目索引仓库（app.sqlite）────────────────────────────────────

/** 项目索引行 */
export interface ProjectIndexData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目索引查询结果 */
export interface ProjectIndexRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
}

/** 项目索引仓库接口 */
export interface ProjectIndexRepository {
  create(data: ProjectIndexData): void;
  list(): ReadonlyArray<ProjectIndexRow>;
  getById(id: string): ProjectIndexRow | null;
  updateLastOpened(id: string, timestamp: string): void;
  delete(id: string): void;
}

// ── 创建事务仓库（app.sqlite）────────────────────────────────────

/** 创建事务阶段 */
export type CreationPhase = 'preparing' | 'prepared' | 'promoted';

/** 创建事务行 */
export interface ProjectCreationRow {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建事务仓库接口 */
export interface ProjectCreationRepository {
  create(data: ProjectCreationRow): void;
  getByProjectId(projectId: string): ProjectCreationRow | null;
  list(): ReadonlyArray<ProjectCreationRow>;
  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void;
  delete(projectId: string): void;
}

// ── 项目元数据存储（project.sqlite）──────────────────────────────

/** 项目元数据数据 */
export interface ProjectMetadataData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据查询结果 */
export interface ProjectMetadataRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据存储接口 */
export interface ProjectMetadataStore {
  /** 初始化项目元数据（创建 project.sqlite 并写入） */
  init(projectDir: string, data: ProjectMetadataData): void;
  /** 读取项目元数据 */
  read(projectDir: string): ProjectMetadataRow | null;
  /** 检查数据库版本兼容性 */
  checkVersion(projectDir: string): void;
}

// ── 项目文件系统 ──────────────────────────────────────────────────

/** 项目文件系统接口 */
export interface ProjectFileSystem {
  /** 获取项目基础目录（projects/ 的父目录） */
  getBaseDir(): string;
  /** 创建项目目录（先创建临时目录，返回临时目录路径） */
  createTempDirectory(baseDir: string, projectId: string): string;
  /** 将临时目录重命名为最终目录 */
  renameToFinal(tempDir: string, finalDir: string): void;
  /** 确保项目子目录存在 */
  ensureSubdirectories(projectDir: string): void;
  /** 检查路径是否存在 */
  exists(path: string): boolean;
  /** 删除目录 */
  removeDirectory(dirPath: string): void;
  /** 清理属于本应用的过期临时目录 */
  cleanupTemp(baseDir: string, maxAgeMs: number): void;
  /** 判断是否为本应用的临时目录 */
  isTempDirectory(name: string): boolean;
}

// ── SecretStore ────────────────────────────────────────────────────

/** 密钥存储接口 —— 基础设施侧实现，应用层不依赖具体实现 */
export interface SecretStore {
  /** 检查密钥是否存在 */
  hasSecret(service: string, account: string): Promise<boolean>;
  /** 存储密钥（覆盖旧值） */
  setSecret(service: string, account: string, secret: string): Promise<void>;
  /** 读取密钥 */
  getSecret(service: string, account: string): Promise<string | null>;
  /** 删除密钥（幂等） */
  deleteSecret(service: string, account: string): Promise<void>;
}

// ── 提供商配置（应用层端口）────────────────────────────────────────

/** 提供商配置数据 */
export interface ProviderProfileData {
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly enabled: boolean;
  /** 是否为全局默认 provider（D6 路由第一层） */
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: string | null;
  readonly lastTestErrorCode: string | null;
  readonly lastTestLatencyMs: number | null;
}

/** 新建 provider profile 的持久化输入（id 与 keychain 槽位均由应用层生成） */
export interface CreateProviderProfileData {
  readonly id: string;
  /** 协议标识：'anthropic-messages' | 'openai-chat' */
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 更新 provider profile 的可变字段（不含 keychain 槽位与 id） */
export interface UpdateProviderProfileData {
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/**
 * 提供商配置仓库接口（B1 多 provider）。
 *
 * 约束：
 * - `setDefault` 必须原子地清除旧默认并设置新默认（DB 侧 partial unique 保证至多一条）；
 * - `delete` 同时清除该 profile 的任务类型路由覆盖；
 * - 仓库只处理非敏感配置，API Key 由 SecretStore 独立管理。
 */
export interface ProviderProfileRepository {
  getById(id: string): ProviderProfileData | null;
  list(): ReadonlyArray<ProviderProfileData>;
  /** 全局默认 provider（D6 路由第一层）；无默认时返回 null */
  getDefault(): ProviderProfileData | null;
  create(data: CreateProviderProfileData): void;
  update(data: UpdateProviderProfileData): void;
  /** 删除 profile 及其路由覆盖；返回是否确有删除 */
  delete(id: string): boolean;
  /** 原子设置全局默认；id 不存在返回 false */
  setDefault(id: string): boolean;
  /** 任务类型路由覆盖（D6 路由第二层）；无覆盖返回 null */
  getRoute(taskType: string): string | null;
  setRoute(taskType: string, profileId: string, updatedAt: string): void;
  deleteRoute(taskType: string): void;
  updateTestResult(
    id: string,
    result: {
      lastTestedAt: string;
      lastTestStatus: string;
      lastTestErrorCode: string | null;
      lastTestLatencyMs: number | null;
    },
  ): void;
}

// ── 任务（应用层端口）────────────────────────────────────────────

/** 任务数据 */
export interface TaskData {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  readonly inputVersionJson: string;
  readonly payloadJson: string;
  readonly resultJson: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly dedupeKey: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly staleAt: string | null;
  readonly cancelledAt: string | null;
}

/** 创建任务输入 */
export interface CreateTaskInput {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: TaskType;
  readonly inputVersionJson: string;
  readonly payloadJson: string;
  readonly dedupeKey?: string;
}

/** 任务仓库端口 */
export interface TaskRepositoryPort {
  create(data: CreateTaskInput): void;
  getById(id: string): TaskData | null;
  listByProject(projectId: string, limit?: number): ReadonlyArray<TaskData>;
  listByStatus(status: TaskStatus): ReadonlyArray<TaskData>;
  /** CAS claim：PENDING → RUNNING 并递增 attempt_count，原子操作 */
  claimPending(id: string): boolean;
  /** CAS 完成：RUNNING → SUCCEEDED */
  completeRunning(id: string, resultJson: string): boolean;
  /** CAS 失败：RUNNING → FAILED */
  failRunning(id: string, errorCode: string, errorMessage: string): boolean;
  /** CAS 失败：PENDING → FAILED（claim 前终结，不递增 attempt_count） */
  failPending(id: string, errorCode: string, errorMessage: string): boolean;
  /** CAS 标记 STALE */
  markStale(id: string, expectedStatuses: ReadonlyArray<TaskStatus>): boolean;
  /** CAS 重置为 PENDING */
  resetToPending(id: string, expectedStatus: TaskStatus): boolean;
  /** 获取所有 RUNNING 任务 */
  listRunning(): ReadonlyArray<TaskData>;
}

// ── 模型调用（应用层端口）────────────────────────────────────────

/** 模型调用数据 */
export interface ModelInvocationData {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly providerProfileId: string;
  readonly model: string;
  readonly status: ModelInvocationStatus;
  readonly attemptNumber: number;
  readonly requestKind: string;
  readonly promptHash: string;
  readonly requestMetadataJson: string;
  readonly responseMetadataJson: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly providerRequestId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** 创建调用输入 */
export interface CreateInvocationInput {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly providerProfileId: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly requestKind: string;
  readonly promptHash: string;
  readonly requestMetadataJson: string;
}

/** 调用成功结果 */
export interface InvocationSuccessResult {
  readonly responseMetadataJson: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly providerRequestId: string | null;
}

/** 调用统计数据 */
export interface InvocationStatsData {
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
}

/** 模型调用仓库端口 */
export interface ModelInvocationRepositoryPort {
  create(data: CreateInvocationInput): void;
  getById(id: string): ModelInvocationData | null;
  listByTask(taskId: string): ReadonlyArray<ModelInvocationData>;
  /** CAS：PENDING → RUNNING */
  markRunning(id: string, expectedStatus: 'PENDING'): boolean;
  /** CAS：RUNNING → SUCCEEDED */
  markSucceeded(id: string, expectedStatus: 'RUNNING', result: InvocationSuccessResult): boolean;
  /** CAS：expectedStatuses → FAILED */
  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<ModelInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
  ): boolean;
  getStatsByProject(projectId: string): InvocationStatsData;
  listRunning(): ReadonlyArray<ModelInvocationData>;
}
