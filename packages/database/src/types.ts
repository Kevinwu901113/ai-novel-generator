/**
 * 数据库层接口定义。
 *
 * 领域层和应用层通过这些接口与数据库交互，
 * 不直接依赖 node:sqlite 或具体实现。
 */

// ── 迁移 ──────────────────────────────────────────────────────────

/** 单个迁移 */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}

/** 迁移运行器 */
export interface Migrator {
  /** 运行迁移，返回新应用的迁移数量 */
  migrate(currentVersion: number, migrations: ReadonlyArray<Migration>): number;
  /** 获取当前数据库版本 */
  getCurrentVersion(): number;
}

// ── 项目索引（app.sqlite）────────────────────────────────────────

/** 项目索引行 —— 存储在 app.sqlite 中 */
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

/** 创建项目索引数据 */
export interface CreateProjectIndexData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目索引仓库 */
export interface ProjectIndexRepository {
  create(data: CreateProjectIndexData): void;
  list(): ReadonlyArray<ProjectIndexRow>;
  getById(id: string): ProjectIndexRow | null;
  updateLastOpened(id: string, timestamp: string): void;
  delete(id: string): void;
}

// ── 项目元数据（project.sqlite）──────────────────────────────────

/** 项目元数据行 —— 存储在 project.sqlite 中 */
export interface ProjectMetadataRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建项目元数据数据 */
export interface CreateProjectMetadataData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据仓库 */
export interface ProjectMetadataRepository {
  create(data: CreateProjectMetadataData): void;
  get(): ProjectMetadataRow | null;
  update(data: Partial<Omit<ProjectMetadataRow, 'id'>>): void;
}

// ── 创建事务（app.sqlite）────────────────────────────────────────

/** 创建事务阶段 */
export type CreationPhase = 'preparing' | 'prepared' | 'promoted';

/** 创建事务记录 */
export interface ProjectCreationRow {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建创建事务数据 */
export interface CreateProjectCreationData {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建事务仓库 */
export interface ProjectCreationRepository {
  create(data: CreateProjectCreationData): void;
  getByProjectId(projectId: string): ProjectCreationRow | null;
  list(): ReadonlyArray<ProjectCreationRow>;
  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void;
  delete(projectId: string): void;
}

// ── 提供商配置（app.sqlite）──────────────────────────────────────

/** 提供商配置行 */
export interface ProviderProfileRow {
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastTestedAt: string | null;
  readonly lastTestStatus: string | null;
  readonly lastTestErrorCode: string | null;
  readonly lastTestLatencyMs: number | null;
}

/** 提供商配置仓库 */
export interface ProviderProfileRepository {
  getById(id: string): ProviderProfileRow | null;
  list(): ReadonlyArray<ProviderProfileRow>;
  upsert(
    data: Omit<
      ProviderProfileRow,
      'lastTestedAt' | 'lastTestStatus' | 'lastTestErrorCode' | 'lastTestLatencyMs'
    >,
  ): void;
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

// ── 数据库管理 ────────────────────────────────────────────────────

/** AppDatabase 管理接口 */
export interface AppDatabaseManager {
  /** 获取项目索引仓库 */
  getProjectIndexRepository(): ProjectIndexRepository;
  /** 获取创建事务仓库 */
  getProjectCreationRepository(): ProjectCreationRepository;
  /** 获取提供商配置仓库 */
  getProviderProfileRepository(): ProviderProfileRepository;
  /** 关闭数据库连接 */
  close(): void;
}

/** ProjectDatabase 管理接口 */
export interface ProjectDatabaseManager {
  /** 获取项目元数据仓库 */
  getProjectMetadataRepository(): ProjectMetadataRepository;
  /** 获取任务仓库 */
  getTaskRepository(): TaskRepository;
  /** 获取模型调用仓库 */
  getModelInvocationRepository(): ModelInvocationRepository;
  /** 获取烧烤会话仓库 */
  getGrillSessionRepository(): GrillSessionRepository;
  /** 获取烧烤问题仓库 */
  getGrillQuestionRepository(): GrillQuestionRepository;
  /** 获取烧烤回答仓库 */
  getGrillAnswerRepository(): GrillAnswerRepository;
  /** 获取推理提案仓库 */
  getGrillProposalRepository(): GrillProposalRepository;
  /** 获取问题规划提案仓库 */
  getGrillQuestionPlanProposalRepository(): GrillQuestionPlanProposalRepository;
  /** 执行事务 */
  transaction<T>(fn: () => T): T;
  /** 关闭数据库连接 */
  close(): void;
}

// ── 任务（project.sqlite）────────────────────────────────────────

/** 任务状态 */
export type DbTaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'STALE';

/** 任务类型 */
export type DbTaskType =
  'PROVIDER_CONNECTION_TEST' | 'MODEL_INVOCATION_TEST' | 'GRILL_QUESTION_PLAN';

/** 任务行 */
export interface TaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: DbTaskType;
  readonly status: DbTaskStatus;
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

/** 创建任务数据 */
export interface CreateTaskData {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: DbTaskType;
  readonly status: DbTaskStatus;
  readonly inputVersionJson: string;
  readonly payloadJson: string;
  readonly dedupeKey?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 任务仓库 */
export interface TaskRepository {
  create(data: CreateTaskData): void;
  getById(id: string): TaskRow | null;
  listByProject(projectId: string, limit?: number): ReadonlyArray<TaskRow>;
  listByStatus(status: DbTaskStatus): ReadonlyArray<TaskRow>;
  /** CAS claim：PENDING → RUNNING 并递增 attempt_count，原子操作 */
  claimPending(id: string, now: string): boolean;
  /** CAS 完成：RUNNING → SUCCEEDED，返回是否成功 */
  completeRunning(id: string, resultJson: string, now: string): boolean;
  /** CAS 失败：RUNNING → FAILED，返回是否成功 */
  failRunning(id: string, errorCode: string, errorMessage: string, now: string): boolean;
  /** CAS 标记 STALE，expectedStatuses 限制当前状态 */
  markStale(id: string, expectedStatuses: ReadonlyArray<DbTaskStatus>, now: string): boolean;
  /** CAS 重置为 PENDING，expectedStatus 限制当前状态 */
  resetToPending(id: string, expectedStatus: DbTaskStatus, now: string): boolean;
  /** 获取所有 RUNNING 任务（用于恢复） */
  listRunning(): ReadonlyArray<TaskRow>;
}

// ── 模型调用（project.sqlite）────────────────────────────────────

/** 模型调用状态 */
export type DbInvocationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** 模型调用行 */
export interface ModelInvocationRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly providerProfileId: string;
  readonly model: string;
  readonly status: DbInvocationStatus;
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

/** 创建调用数据 */
export interface CreateInvocationData {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly providerProfileId: string;
  readonly model: string;
  readonly status: DbInvocationStatus;
  readonly attemptNumber: number;
  readonly requestKind: string;
  readonly promptHash: string;
  readonly requestMetadataJson: string;
  readonly createdAt: string;
}

/** 调用统计数据 */
export interface InvocationStats {
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
}

/** 模型调用仓库 */
export interface ModelInvocationRepository {
  create(data: CreateInvocationData): void;
  getById(id: string): ModelInvocationRow | null;
  listByTask(taskId: string): ReadonlyArray<ModelInvocationRow>;
  /** CAS：PENDING → RUNNING，返回是否成功 */
  markRunning(id: string, expectedStatus: 'PENDING', now: string): boolean;
  /** CAS：RUNNING → SUCCEEDED，返回是否成功 */
  markSucceeded(
    id: string,
    expectedStatus: 'RUNNING',
    result: {
      responseMetadataJson: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      totalTokens: number | null;
      latencyMs: number | null;
      finishReason: string | null;
      providerRequestId: string | null;
      finishedAt: string;
    },
  ): boolean;
  /** CAS：expectedStatuses → FAILED，返回是否成功 */
  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<DbInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
    finishedAt: string,
  ): boolean;
  getStatsByProject(projectId: string): InvocationStats;
  /** 获取所有 RUNNING 调用（用于恢复） */
  listRunning(): ReadonlyArray<ModelInvocationRow>;
}

// ── 烧烤会话（project.sqlite）────────────────────────────────────

/** 烧烤会话状态 */
export type DbGrillSessionStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';

/** 烧烤问题状态 */
export type DbGrillQuestionStatus = 'PLANNED' | 'ASKED' | 'ANSWERED' | 'SKIPPED' | 'SUPERSEDED';

/** 烧烤回答来源 */
export type DbGrillAnswerSource = 'USER' | 'IMPORTED';

/** 推理提案状态 */
export type DbGrillProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';

/** 烧烤会话行 */
export interface GrillSessionRow {
  readonly id: string;
  readonly projectId: string;
  readonly status: DbGrillSessionStatus;
  readonly version: number;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly abandonedAt: string | null;
}

/** 创建烧烤会话数据 */
export interface CreateGrillSessionData {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 烧烤会话仓库 */
export interface GrillSessionRepository {
  create(data: CreateGrillSessionData): void;
  getById(id: string): GrillSessionRow | null;
  listByProject(projectId: string): ReadonlyArray<GrillSessionRow>;
  /** CAS 状态转换：version+1 WHERE id=? AND version=? */
  transitionStatus(
    id: string,
    expectedVersion: number,
    newStatus: DbGrillSessionStatus,
    now: string,
  ): boolean;
  /** CAS 版本递增（子实体变更时） */
  bumpVersion(id: string, expectedVersion: number, now: string): boolean;
}

/** 烧烤问题行 */
export interface GrillQuestionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly status: DbGrillQuestionStatus;
  readonly dependsOnQuestionIds: string;
  readonly createdAt: string;
  readonly askedAt: string | null;
  readonly answeredAt: string | null;
  readonly skippedAt: string | null;
  readonly supersededAt: string | null;
}

/** 创建烧烤问题数据 */
export interface CreateGrillQuestionData {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly dependsOnQuestionIds: string;
  readonly createdAt: string;
}

/** 烧烤问题仓库 */
export interface GrillQuestionRepository {
  create(data: CreateGrillQuestionData): void;
  getById(id: string): GrillQuestionRow | null;
  listBySession(sessionId: string): ReadonlyArray<GrillQuestionRow>;
  /** CAS 状态转换并设置对应时间戳 */
  transitionStatus(
    id: string,
    expectedStatus: DbGrillQuestionStatus,
    newStatus: DbGrillQuestionStatus,
    now: string,
  ): boolean;
  getMaxSequence(sessionId: string): number;
}

/** 烧烤回答行 */
export interface GrillAnswerRow {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly source: DbGrillAnswerSource;
  readonly text: string;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

/** 创建烧烤回答数据 */
export interface CreateGrillAnswerData {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly source: DbGrillAnswerSource;
  readonly text: string;
  readonly createdAt: string;
}

/** 烧烤回答仓库 */
export interface GrillAnswerRepository {
  create(data: CreateGrillAnswerData): void;
  getById(id: string): GrillAnswerRow | null;
  /** 获取当前有效答案（superseded_at IS NULL） */
  getCurrentByQuestion(questionId: string): GrillAnswerRow | null;
  /** 获取问题的所有答案历史（按 revision 排序） */
  listByQuestion(questionId: string): ReadonlyArray<GrillAnswerRow>;
  /** 获取会话的所有当前答案 */
  listCurrentBySession(sessionId: string): ReadonlyArray<GrillAnswerRow>;
  /** 废弃当前答案 */
  supersedeCurrent(questionId: string, now: string): boolean;
}

/** 推理提案行 */
export interface GrillProposalRow {
  readonly id: string;
  readonly sessionId: string;
  readonly basedOnAnswerIds: string;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: DbGrillProposalStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

/** 创建推理提案数据 */
export interface CreateGrillProposalData {
  readonly id: string;
  readonly sessionId: string;
  readonly basedOnAnswerIds: string;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly createdAt: string;
}

/** 推理提案仓库 */
export interface GrillProposalRepository {
  create(data: CreateGrillProposalData): void;
  getById(id: string): GrillProposalRow | null;
  listBySession(sessionId: string): ReadonlyArray<GrillProposalRow>;
  /** CAS 状态转换 */
  transitionStatus(
    id: string,
    expectedStatus: DbGrillProposalStatus,
    newStatus: DbGrillProposalStatus,
    now: string,
  ): boolean;
}

// ── 烧烤问题规划提案（project.sqlite）────────────────────────────

/** 问题规划提案状态 */
export type DbGrillQuestionPlanProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE';

/** 问题规划提案行 —— 仅保存经验证的规范化计划，不保存原始模型输出 */
export interface GrillQuestionPlanProposalRow {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly questionsJson: string;
  readonly status: DbGrillQuestionPlanProposalStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

/** 创建问题规划提案数据 */
export interface CreateGrillQuestionPlanProposalData {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly questionsJson: string;
  readonly createdAt: string;
}

/** 问题规划提案仓库 */
export interface GrillQuestionPlanProposalRepository {
  create(data: CreateGrillQuestionPlanProposalData): void;
  getById(id: string): GrillQuestionPlanProposalRow | null;
  listBySession(sessionId: string): ReadonlyArray<GrillQuestionPlanProposalRow>;
  /** CAS 状态转换 */
  transitionStatus(
    id: string,
    expectedStatus: DbGrillQuestionPlanProposalStatus,
    newStatus: DbGrillQuestionPlanProposalStatus,
    now: string,
  ): boolean;
}
