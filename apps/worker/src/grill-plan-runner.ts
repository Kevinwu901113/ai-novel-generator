/**
 * Grill 问题规划后台 runner。
 *
 * 薄封装：调度 / settlement / 恢复逻辑委托共享 runner kernel
 * （runner-kernel.ts），仅注入 Grill 的固定安全消息。
 * 行为与抽取前完全一致。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type { TaskRepositoryPort, ModelInvocationRepositoryPort } from '@ai-novel/application';
import { executeGrillQuestionPlan, type GrillQuestionPlanEngineDeps } from '@ai-novel/task-engine';
import {
  settleRunnerFailure,
  scheduleRunnerRun,
  recoverPendingRunnerTasks,
  isTerminalStatus,
  type RunnerKernelDeps,
  type RunnerScheduleResult,
  type RunnerRecoveryDeps,
  type SettleMessages,
} from './runner-kernel.js';

// ── 依赖接口（委托 kernel 类型）────────────────────────────────

export type GrillPlanRunnerDeps = RunnerKernelDeps<GrillQuestionPlanEngineDeps>;

export type GrillPlanScheduleResult = RunnerScheduleResult;

export type GrillPlanRecoveryDeps = RunnerRecoveryDeps;

// ── 固定安全消息 ────────────────────────────────────────────────

const GRILL_MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: '问题规划任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

// ── Settlement ────────────────────────────────────────────────────

export function settleGrillPlanRunnerFailure(
  deps: GrillPlanRunnerDeps,
  projDb: ProjectDatabase,
  taskId: string,
): void {
  settleRunnerFailure(deps, projDb, taskId, GRILL_MESSAGES);
}

// ── Runner ────────────────────────────────────────────────────────

export function scheduleGrillPlanRun(
  deps: GrillPlanRunnerDeps,
  projectId: string,
  taskId: string,
): GrillPlanScheduleResult {
  return scheduleRunnerRun(deps, projectId, taskId, executeGrillQuestionPlan, GRILL_MESSAGES);
}

// ── Startup Recovery ──────────────────────────────────────────────

export function recoverPendingGrillPlans(deps: GrillPlanRecoveryDeps): void {
  recoverPendingRunnerTasks(deps, 'GRILL_QUESTION_PLAN');
}

// 保持既有内部测试引用兼容
export { isTerminalStatus };
export type { TaskRepositoryPort, ModelInvocationRepositoryPort };
