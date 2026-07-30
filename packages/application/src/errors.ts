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
  ) {
    super(message);
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

/** 契约版本冲突（乐观并发控制失败） */
export class ContractVersionConflictError extends AppError {
  constructor(message: string) {
    super('CONTRACT_VERSION_CONFLICT', message);
    this.name = 'ContractVersionConflictError';
  }
}

/** 契约提案已过期 */
export class ContractProposalStaleError extends AppError {
  constructor(message: string) {
    super('CONTRACT_PROPOSAL_STALE', message);
    this.name = 'ContractProposalStaleError';
  }
}

/** 契约提案未找到 */
export class ContractProposalNotFoundError extends AppError {
  constructor(proposalId: string) {
    super('CONTRACT_PROPOSAL_NOT_FOUND', `创作契约提案 ${proposalId} 不存在`);
    this.name = 'ContractProposalNotFoundError';
  }
}

/** 契约提案不可接受 */
export class ContractProposalNotAcceptableError extends AppError {
  constructor(message: string) {
    super('CONTRACT_PROPOSAL_NOT_ACCEPTABLE', message);
    this.name = 'ContractProposalNotAcceptableError';
  }
}

/** 契约锁冲突 */
export class ContractLockConflictError extends AppError {
  constructor(message: string) {
    super('CONTRACT_LOCK_CONFLICT', message);
    this.name = 'ContractLockConflictError';
  }
}

/** 模型输出违反锁定字段 */
export class ContractModelLockViolationError extends AppError {
  constructor(message: string) {
    super('CONTRACT_MODEL_LOCK_VIOLATION', message);
    this.name = 'ContractModelLockViolationError';
  }
}

/** 契约 schema 版本不支持 */
export class ContractSchemaUnsupportedError extends AppError {
  constructor(message: string) {
    super('CONTRACT_SCHEMA_UNSUPPORTED', message);
    this.name = 'ContractSchemaUnsupportedError';
  }
}

/** 契约验证失败 */
export class ContractValidationError extends AppError {
  constructor(message: string) {
    super('CONTRACT_VALIDATION_FAILED', message);
    this.name = 'ContractValidationError';
  }
}
