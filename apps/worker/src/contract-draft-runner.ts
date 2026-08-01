/**
 * 创作契约草案后台 runner。
 *
 * 调度 / settlement / 恢复逻辑复用共享 runner kernel（runner-kernel.ts），
 * 仅注入创作契约的固定安全消息。
 *
 * - 打开独立 ProjectDatabase；
 * - 单一异常边界，任何异常通过 settlement 收口，不留永久 PENDING/RUNNING；
 * - DB close exactly once；不产生 unhandled rejection。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type { TaskRepositoryPort, ModelInvocationRepositoryPort } from '@ai-novel/application';
import { executeCreationContractDraft, type ContractDraftEngineDeps } from '@ai-novel/task-engine';
import {
  settleRunnerFailure,
  scheduleRunnerRun,
  recoverPendingRunnerTasks,
  type RunnerKernelDeps,
  type RunnerScheduleResult,
  type RunnerRecoveryDeps,
  type SettleMessages,
  type SettlementOutcome,
} from './runner-kernel.js';

// ── 依赖接口 ─────────────────────────────────────────────────────

export type ContractDraftRunnerDeps = RunnerKernelDeps<ContractDraftEngineDeps>;

export type ContractDraftScheduleResult = RunnerScheduleResult;

export type ContractDraftRecoveryDeps = RunnerRecoveryDeps;

// ── 固定安全消息 ────────────────────────────────────────────────

const CONTRACT_DRAFT_MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: '创作契约草案任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

// ── Settlement ────────────────────────────────────────────────────

export function settleContractDraftRunnerFailure(
  deps: ContractDraftRunnerDeps,
  projDb: ProjectDatabase,
  taskId: string,
): SettlementOutcome {
  return settleRunnerFailure(deps, projDb, taskId, CONTRACT_DRAFT_MESSAGES);
}

// ── Runner ────────────────────────────────────────────────────────

export function scheduleContractDraftRun(
  deps: ContractDraftRunnerDeps,
  projectId: string,
  taskId: string,
): ContractDraftScheduleResult {
  return scheduleRunnerRun(
    deps,
    projectId,
    taskId,
    executeCreationContractDraft,
    CONTRACT_DRAFT_MESSAGES,
  );
}

// ── Startup Recovery ──────────────────────────────────────────────

export function recoverPendingContractDrafts(deps: ContractDraftRecoveryDeps): void {
  recoverPendingRunnerTasks(deps, 'CREATION_CONTRACT_DRAFT');
}

export type { TaskRepositoryPort, ModelInvocationRepositoryPort };
