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
