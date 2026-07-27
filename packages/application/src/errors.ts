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

/** 烧烤验证错误 */
export class GrillValidationError extends AppError {
  constructor(message: string) {
    super('GRILL_VALIDATION_ERROR', message);
    this.name = 'GrillValidationError';
  }
}
