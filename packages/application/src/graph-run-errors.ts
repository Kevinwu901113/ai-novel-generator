/**
 * Graph Run 应用层错误定义（GE-1）。
 */

import { AppError } from './errors.js';

/** run 不存在 */
export class GraphRunNotFoundError extends AppError {
  constructor(runId: string) {
    super('GRAPH_RUN_NOT_FOUND', `Graph run ${runId} 不存在`);
    this.name = 'GraphRunNotFoundError';
  }
}

/** CAS 冲突：expectedVersion 不匹配 */
export class GraphRunVersionConflictError extends AppError {
  constructor(runId: string) {
    super('GRAPH_RUN_VERSION_CONFLICT', `Graph run ${runId} 版本冲突，请刷新后重试`);
    this.name = 'GraphRunVersionConflictError';
  }
}

/** 状态冲突：节点不在活跃 frontier / 无待处理决策 / 决策不匹配等 */
export class GraphRunStateConflictError extends AppError {
  constructor(message: string) {
    super('GRAPH_RUN_STATE_CONFLICT', message);
    this.name = 'GraphRunStateConflictError';
  }
}

/** 状态校验失败（domain transition 产出非法状态或非法输入） */
export class GraphRunValidationError extends AppError {
  constructor(message: string) {
    super('GRAPH_RUN_VALIDATION_ERROR', message);
    this.name = 'GraphRunValidationError';
  }
}

/** 幂等键冲突：同一 key 携带不同命令 */
export class GraphRunIdempotencyConflictError extends AppError {
  constructor() {
    super('GRAPH_RUN_IDEMPOTENCY_CONFLICT', '幂等命令冲突：同一命令 ID 携带不同内容');
    this.name = 'GraphRunIdempotencyConflictError';
  }
}

/** 启动恢复把中断的 active 节点标为失败 */
export class GraphRunInterruptedError extends AppError {
  constructor(runId: string, nodeId: string) {
    super('GRAPH_RUN_INTERRUPTED', `Graph run ${runId} 节点 ${nodeId} 因中断而失败`);
    this.name = 'GraphRunInterruptedError';
  }
}

/** 事务嵌套检测失败 */
export class GraphRunNestedTransactionError extends AppError {
  constructor() {
    super('GRAPH_RUN_VALIDATION_ERROR', 'Graph run 事务嵌套调用');
    this.name = 'GraphRunNestedTransactionError';
  }
}

/** 事务 busy/locked */
export class GraphRunTransactionBusyError extends AppError {
  constructor(cause?: unknown) {
    super('INTERNAL_ERROR', '数据库忙，请稍后重试', cause);
    this.name = 'GraphRunTransactionBusyError';
  }
}

/** 事务其他错误 */
export class GraphRunTransactionError extends AppError {
  constructor(cause?: unknown) {
    super('INTERNAL_ERROR', 'Graph run 事务失败', cause);
    this.name = 'GraphRunTransactionError';
  }
}

/** 同步事务不允许异步回调 */
export class GraphRunAsyncTransactionCallbackError extends AppError {
  constructor() {
    super('GRAPH_RUN_VALIDATION_ERROR', 'Graph run 事务不允许异步回调');
    this.name = 'GraphRunAsyncTransactionCallbackError';
  }
}
