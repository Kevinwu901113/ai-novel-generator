/**
 * 应用层错误定义。
 *
 * 所有应用错误都有明确的错误码，便于 IPC 层映射。
 * 不泄露内部绝对路径或堆栈信息。
 */

import type { ErrorCode } from '@ai-novel/contracts';

/** 应用错误基类 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
  }
}

/** 输入验证错误 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

/** 项目未找到 */
export class ProjectNotFoundError extends AppError {
  constructor(projectId: string) {
    super('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
    this.name = 'ProjectNotFoundError';
  }
}

/** 项目目录缺失 */
export class ProjectDirectoryMissingError extends AppError {
  constructor() {
    super('PROJECT_DIRECTORY_MISSING', '项目目录不存在或已被删除');
    this.name = 'ProjectDirectoryMissingError';
  }
}

/** 项目数据库无效 */
export class ProjectDatabaseInvalidError extends AppError {
  constructor() {
    super('PROJECT_DATABASE_INVALID', '项目数据库不存在或已损坏');
    this.name = 'ProjectDatabaseInvalidError';
  }
}

/** 数据库版本不支持 */
export class DatabaseVersionUnsupportedError extends AppError {
  constructor(message: string) {
    super('DATABASE_VERSION_UNSUPPORTED', message);
    this.name = 'DatabaseVersionUnsupportedError';
  }
}

/** 项目创建失败 */
export class ProjectCreateFailedError extends AppError {
  constructor(message: string) {
    super('PROJECT_CREATE_FAILED', message);
    this.name = 'ProjectCreateFailedError';
  }
}

/** Worker 不可用 */
export class WorkerUnavailableError extends AppError {
  constructor() {
    super('WORKER_UNAVAILABLE', '数据服务不可用，请重启应用');
    this.name = 'WorkerUnavailableError';
  }
}

/** 提供商未配置 */
export class ProviderNotConfiguredError extends AppError {
  constructor() {
    super('PROVIDER_NOT_CONFIGURED', '模型提供商未配置');
    this.name = 'ProviderNotConfiguredError';
  }
}

/** API Key 必需 */
export class ApiKeyRequiredError extends AppError {
  constructor() {
    super('API_KEY_REQUIRED', '请先配置 API Key');
    this.name = 'ApiKeyRequiredError';
  }
}

/** API Key 存储失败 */
export class ApiKeyStoreFailedError extends AppError {
  constructor(message: string) {
    super('API_KEY_STORE_FAILED', message);
    this.name = 'ApiKeyStoreFailedError';
  }
}

/** API Key 读取失败 */
export class ApiKeyReadFailedError extends AppError {
  constructor(message: string) {
    super('API_KEY_READ_FAILED', message);
    this.name = 'ApiKeyReadFailedError';
  }
}

/** API Key 删除失败 */
export class ApiKeyDeleteFailedError extends AppError {
  constructor(message: string) {
    super('API_KEY_DELETE_FAILED', message);
    this.name = 'ApiKeyDeleteFailedError';
  }
}

// ── Grill-me 错误 ─────────────────────────────────────────────────

/** 烧烤会话未找到 */
export class GrillSessionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super('GRILL_SESSION_NOT_FOUND', `烧烤会话 ${sessionId} 不存在`);
    this.name = 'GrillSessionNotFoundError';
  }
}

/** 烧烤问题未找到 */
export class GrillQuestionNotFoundError extends AppError {
  constructor(questionId: string) {
    super('GRILL_QUESTION_NOT_FOUND', `烧烤问题 ${questionId} 不存在`);
    this.name = 'GrillQuestionNotFoundError';
  }
}

/** 烧烤回答未找到 */
export class GrillAnswerNotFoundError extends AppError {
  constructor(answerId: string) {
    super('GRILL_ANSWER_NOT_FOUND', `烧烤回答 ${answerId} 不存在`);
    this.name = 'GrillAnswerNotFoundError';
  }
}

/** 推理提案未找到 */
export class GrillProposalNotFoundError extends AppError {
  constructor(proposalId: string) {
    super('GRILL_PROPOSAL_NOT_FOUND', `推理提案 ${proposalId} 不存在`);
    this.name = 'GrillProposalNotFoundError';
  }
}

/** 烧烤状态冲突 */
export class GrillStateConflictError extends AppError {
  constructor(message: string) {
    super('GRILL_STATE_CONFLICT', message);
    this.name = 'GrillStateConflictError';
  }
}

/** 烧烤版本冲突 */
export class GrillVersionConflictError extends AppError {
  constructor(message: string) {
    super('GRILL_VERSION_CONFLICT', message);
    this.name = 'GrillVersionConflictError';
  }
}

/** 烧烤归属冲突 —— 子实体不属于指定会话 */
export class GrillOwnershipConflictError extends AppError {
  constructor(message: string) {
    super('GRILL_OWNERSHIP_CONFLICT', message);
    this.name = 'GrillOwnershipConflictError';
  }
}

/** 烧烤验证错误 */
export class GrillValidationError extends AppError {
  constructor(message: string) {
    super('GRILL_VALIDATION_ERROR', message);
    this.name = 'GrillValidationError';
  }
}

// ── Grill-me 问题规划器错误 ───────────────────────────────────────

/** 同一会话/版本已存在活跃的规划任务 */
export class GrillPlanAlreadyRunningError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_ALREADY_RUNNING', message);
    this.name = 'GrillPlanAlreadyRunningError';
  }
}

/** 规划任务因会话版本变化而过期 */
export class GrillPlanStaleError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_STALE', message);
    this.name = 'GrillPlanStaleError';
  }
}

/** 模型输出不符合问题计划 schema */
export class GrillPlanSchemaInvalidError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_SCHEMA_INVALID', message);
    this.name = 'GrillPlanSchemaInvalidError';
  }
}

/** 问题计划引用了非法或不属于当前会话的实体 */
export class GrillPlanReferenceInvalidError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_REFERENCE_INVALID', message);
    this.name = 'GrillPlanReferenceInvalidError';
  }
}

/** 问题计划依赖图存在循环 */
export class GrillPlanCycleDetectedError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_CYCLE_DETECTED', message);
    this.name = 'GrillPlanCycleDetectedError';
  }
}

/** 问题规划提案未找到 */
export class GrillPlanProposalNotFoundError extends AppError {
  constructor(proposalId: string) {
    super('GRILL_PLAN_PROPOSAL_NOT_FOUND', `问题规划提案 ${proposalId} 不存在`);
    this.name = 'GrillPlanProposalNotFoundError';
  }
}

/** 问题规划提案不可接受（状态非法或已过期） */
export class GrillPlanProposalNotAcceptableError extends AppError {
  constructor(message: string) {
    super('GRILL_PLAN_PROPOSAL_NOT_ACCEPTABLE', message);
    this.name = 'GrillPlanProposalNotAcceptableError';
  }
}

/**
 * 任务去重冲突（数据库级唯一约束触发）。
 *
 * 内部错误，由任务仓库适配器在 dedupe_key 唯一约束冲突时抛出，
 * 请求用例将其映射为 GrillPlanAlreadyRunningError。
 */
export class TaskDedupeConflictError extends AppError {
  constructor(message: string) {
    super('TASK_STATE_CONFLICT', message);
    this.name = 'TaskDedupeConflictError';
  }
}

// ── 创作契约错误 ───────────────────────────────────────────────

/**
 * 内部诊断包装：public message 固定时，把内部细节放入 cause。
 * detail 字符串 + 可选的原始 cause 都会被保留。
 */
function diagnostic(detail: string, cause?: unknown): Error {
  return cause === undefined ? new Error(detail) : new Error(detail, { cause });
}

/** 契约版本冲突（乐观并发控制失败）。public message 固定，内部细节在 cause。 */
export class ContractVersionConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'CONTRACT_VERSION_CONFLICT',
      '创作契约版本已变化，请刷新后重试',
      diagnostic(message, cause),
    );
    this.name = 'ContractVersionConflictError';
  }
}

/** 契约提案已过期。public message 固定，内部细节在 cause。 */
export class ContractProposalStaleError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONTRACT_PROPOSAL_STALE', '创作契约提案已过期，请重新生成', diagnostic(message, cause));
    this.name = 'ContractProposalStaleError';
  }
}

/**
 * 契约提案未找到。
 *
 * 按项目既有安全策略（ProjectNotFoundError、Grill*NotFoundError 等
 * 均暴露实体 ID），proposalId 属于非敏感 UI 信息，保留在 public message。
 */
export class ContractProposalNotFoundError extends AppError {
  constructor(proposalId: string) {
    super('CONTRACT_PROPOSAL_NOT_FOUND', `创作契约提案 ${proposalId} 不存在`);
    this.name = 'ContractProposalNotFoundError';
  }
}

/** 契约提案不可接受。public message 固定，不暴露原始 status。 */
export class ContractProposalNotAcceptableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'CONTRACT_PROPOSAL_NOT_ACCEPTABLE',
      '创作契约提案当前状态不允许此操作',
      diagnostic(message, cause),
    );
    this.name = 'ContractProposalNotAcceptableError';
  }
}

/** 契约锁冲突。public message 固定，不暴露 locked path。 */
export class ContractLockConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONTRACT_LOCK_CONFLICT', '操作与受保护的契约字段冲突', diagnostic(message, cause));
    this.name = 'ContractLockConflictError';
  }
}

/** 模型输出违反锁定字段。public message 固定，不暴露 locked path。 */
export class ContractModelLockViolationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'CONTRACT_MODEL_LOCK_VIOLATION',
      '模型输出修改了受保护的契约字段',
      diagnostic(message, cause),
    );
    this.name = 'ContractModelLockViolationError';
  }
}

/** 契约 schema 版本不支持。public message 固定，不暴露 schemaVersion。 */
export class ContractSchemaUnsupportedError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'CONTRACT_SCHEMA_UNSUPPORTED',
      '创作契约 schema 版本不受支持',
      diagnostic(message, cause),
    );
    this.name = 'ContractSchemaUnsupportedError';
  }
}

/** 契约验证失败。public message 固定，不暴露 operation index/path 或原始 validator 消息。 */
export class ContractValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONTRACT_VALIDATION_FAILED', '创作契约内容验证失败', diagnostic(message, cause));
    this.name = 'ContractValidationError';
  }
}

/** 契约数据完整性异常。public message 固定，内部细节（JSON 解析错误、字段路径等）在 cause。 */
export class ContractDataCorruptionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('INTERNAL_ERROR', '创作契约数据完整性异常', diagnostic(message, cause));
    this.name = 'ContractDataCorruptionError';
  }
}

/**
 * SQLite busy/locked — 由事务适配器抛出。
 *
 * public message 固定，不包含 SQLite 实现细节（SQLITE_BUSY / database is locked 等）。
 * 内部诊断保存在 cause。
 */
export class ContractTransactionBusyError extends AppError {
  constructor(cause?: unknown) {
    super('CONTRACT_VERSION_CONFLICT', '创作契约正在被其他操作修改，请重试', cause);
    this.name = 'ContractTransactionBusyError';
  }
}

/**
 * 嵌套事务检测 — 由事务适配器抛出。
 *
 * public message 固定，不包含 BEGIN IMMEDIATE 等 SQLite 实现细节。
 */
export class ContractNestedTransactionError extends AppError {
  constructor() {
    super('INTERNAL_ERROR', '检测到嵌套创作契约事务');
    this.name = 'ContractNestedTransactionError';
  }
}

/**
 * 创作契约事务基础设施失败（非 busy/locked）。
 *
 * 用于把 SQLite 约束错误、磁盘错误等原始错误转换为安全错误，
 * 内部诊断保存在 cause。
 */
export class ContractTransactionError extends AppError {
  constructor(cause?: unknown) {
    super('INTERNAL_ERROR', '创作契约事务执行失败', cause);
    this.name = 'ContractTransactionError';
  }
}

/**
 * 事务回调返回 Promise/thenable。
 *
 * 同步事务要求回调同步完成，否则 adapter 会在 Promise 完成前 COMMIT，
 * 破坏事务生命周期。public message 固定，不暴露实现细节。
 */
export class ContractAsyncTransactionCallbackError extends AppError {
  constructor() {
    super('INTERNAL_ERROR', '创作契约事务回调必须同步执行');
    this.name = 'ContractAsyncTransactionCallbackError';
  }
}

/**
 * 创作契约草案任务已存在（dedupe 冲突）。
 *
 * 由请求用例在 TaskDedupeConflictError 触发时映射为稳定安全错误。
 * public message 固定，不暴露 dedupe key 或内部细节（detail 进入 cause）。
 */
export class ContractDraftAlreadyRunningError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super(
      'CONTRACT_DRAFT_ALREADY_RUNNING',
      '创作契约草案任务已存在，请等待其完成后重试',
      diagnostic(detail, cause),
    );
    this.name = 'ContractDraftAlreadyRunningError';
  }
}

// ── 稿件 / 章节 / 章节版本错误 ─────────────────────────────────

/**
 * 稿件不存在或无权限。跨 project 查询同样返回此码，不泄露存在性（§7）。
 */
export class ManuscriptNotFoundError extends AppError {
  constructor() {
    super('MANUSCRIPT_NOT_FOUND', '稿件不存在或无权访问');
    this.name = 'ManuscriptNotFoundError';
  }
}

/**
 * 稿件 / 章节状态不允许此操作（归档/非活跃）。public message 固定，
 * 内部细节（归档章节 id 等）在 cause。
 */
export class ManuscriptStateConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'MANUSCRIPT_STATE_CONFLICT',
      '稿件或章节当前状态不允许此操作',
      diagnostic(message, cause),
    );
    this.name = 'ManuscriptStateConflictError';
  }
}

/**
 * current version CAS 失败（乐观并发冲突）。public message 固定，
 * 内部细节（期望/实际指针）在 cause。
 */
export class ManuscriptVersionConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      'MANUSCRIPT_VERSION_CONFLICT',
      '稿件内容已更新，请刷新后重试',
      diagnostic(message, cause),
    );
    this.name = 'ManuscriptVersionConflictError';
  }
}

/**
 * 排序 position 空间溢出（超过 MAX_SAFE_INTEGER）。整笔事务 rollback，
 * 不修改任何 position、不执行 DDL、不删除/归档章节（§6.1、§7）。
 */
export class ManuscriptPositionOverflowError extends AppError {
  constructor() {
    super('MANUSCRIPT_POSITION_OVERFLOW', '章节排序位置空间已满，无法继续添加');
    this.name = 'ManuscriptPositionOverflowError';
  }
}

/**
 * 章节不存在或无权限。跨 project / 跨稿件查询同样返回此码（§7）。
 */
export class ChapterNotFoundError extends AppError {
  constructor() {
    super('CHAPTER_NOT_FOUND', '章节不存在或无权访问');
    this.name = 'ChapterNotFoundError';
  }
}

/**
 * 版本不存在或无权限（含跨章引用）。public message 固定，不泄露存在性。
 */
export class ChapterVersionNotFoundError extends AppError {
  constructor() {
    super('CHAPTER_VERSION_NOT_FOUND', '版本不存在或无权访问');
    this.name = 'ChapterVersionNotFoundError';
  }
}

/**
 * SQLite busy/locked — 由稿件事务适配器抛出。
 * public message 固定，不包含 SQLite 实现细节；内部诊断保存在 cause。
 */
export class ManuscriptTransactionBusyError extends AppError {
  constructor(cause?: unknown) {
    super('MANUSCRIPT_VERSION_CONFLICT', '稿件正在被其他操作修改，请重试', cause);
    this.name = 'ManuscriptTransactionBusyError';
  }
}

/** 嵌套稿件事务检测 — 由事务适配器抛出。 */
export class ManuscriptNestedTransactionError extends AppError {
  constructor() {
    super('INTERNAL_ERROR', '检测到嵌套稿件事务');
    this.name = 'ManuscriptNestedTransactionError';
  }
}

/** 稿件事务基础设施失败（非 busy/locked）。 */
export class ManuscriptTransactionError extends AppError {
  constructor(cause?: unknown) {
    super('INTERNAL_ERROR', '稿件事务执行失败', cause);
    this.name = 'ManuscriptTransactionError';
  }
}

/** 事务回调返回 Promise/thenable。 */
export class ManuscriptAsyncTransactionCallbackError extends AppError {
  constructor() {
    super('INTERNAL_ERROR', '稿件事务回调必须同步执行');
    this.name = 'ManuscriptAsyncTransactionCallbackError';
  }
}
