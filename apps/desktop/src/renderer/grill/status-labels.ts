/**
 * Grill-me 状态中文标签。
 */

import { ERROR_CODE_LABELS } from '../safety/error-code-labels';

const SESSION_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  ABANDONED: '已放弃',
};

const QUESTION_STATUS_LABELS: Record<string, string> = {
  PLANNED: '待提问',
  ASKED: '已提问',
  ANSWERED: '已回答',
  SKIPPED: '已跳过',
  SUPERSEDED: '已废弃',
};

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  PROPOSED: '待审核',
  ACCEPTED: '已接受',
  REJECTED: '已拒绝',
  SUPERSEDED: '已废弃',
};

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}

export function questionStatusLabel(status: string): string {
  return QUESTION_STATUS_LABELS[status] ?? status;
}

export function proposalStatusLabel(status: string): string {
  return PROPOSAL_STATUS_LABELS[status] ?? status;
}

/** 判断会话是否处于终态 */
export function isTerminalSession(status: string): boolean {
  return status === 'COMPLETED' || status === 'ABANDONED';
}

/** 判断会话是否处于暂停状态 */
export function isPausedSession(status: string): boolean {
  return status === 'PAUSED';
}

/** 判断问题是否可以回答 */
export function isQuestionAnswerable(status: string): boolean {
  return status === 'PLANNED' || status === 'ASKED' || status === 'ANSWERED';
}

/** 判断问题是否可以跳过 */
export function isQuestionSkippable(status: string): boolean {
  return status === 'PLANNED' || status === 'ASKED';
}

/** 判断问题是否可以废弃 */
export function isQuestionSupersedable(status: string): boolean {
  return status === 'PLANNED' || status === 'ASKED' || status === 'ANSWERED';
}

/** 判断提案是否可以审核 */
export function isProposalReviewable(status: string): boolean {
  return status === 'PROPOSED';
}

/** 错误码中文映射 */
const GRILL_ERROR_MESSAGES: Record<string, string> = {
  GRILL_SESSION_NOT_FOUND: '会话不存在',
  GRILL_QUESTION_NOT_FOUND: '问题不存在',
  GRILL_ANSWER_NOT_FOUND: '回答不存在',
  GRILL_PROPOSAL_NOT_FOUND: '提案不存在',
  GRILL_STATE_CONFLICT: '状态冲突，操作无法执行',
  GRILL_VERSION_CONFLICT: '会话已在其他操作中更新',
  GRILL_OWNERSHIP_CONFLICT: '资源不属于当前会话',
  GRILL_VALIDATION_ERROR: '输入验证失败',
};

export function grillErrorMessage(code: string | undefined, fallback: string): string {
  if (code && GRILL_ERROR_MESSAGES[code]) return GRILL_ERROR_MESSAGES[code];
  return fallback;
}

/**
 * FAILED 任务的安全标签。
 *
 * 只输出稳定中文标签和 error code，绝不输出 errorMessage 原文。
 * - 已知 code：`任务执行失败（TASK_EXECUTION_FAILED）`（按映射取标签）
 * - 未知 code：`任务执行失败（UNKNOWN_CODE）`
 * - null code：`任务执行失败`
 */
export function formatFailedTaskLabel(errorCode: string | null): string {
  if (!errorCode) return '任务执行失败';
  const label = ERROR_CODE_LABELS[errorCode] ?? '任务执行失败';
  return `${label}（${errorCode}）`;
}
