/**
 * 创作契约 RPC 处理器。
 *
 * 严格 payload 验证 → 打开 ProjectDatabase → 构造 repositories/adapters →
 * 注入 IdGenerator/Clock/Sha256Port → 解析 enabled provider（requestDraft）→
 * 调用 Application use case → DTO mapping → 关闭 DB → 安全错误映射。
 *
 * Renderer/API caller 不得生成持久化 ID 或时间戳：
 * - Accept：newVersionId、now 由 Worker 注入；
 * - Reject：now；
 * - User Update：newVersionId、now；
 * - Lock/Unlock：newVersionId、lockEventId、now；
 * - requestDraft：Worker 选择当前启用 provider，Renderer 不传 providerProfileId。
 */

import {
  isValidGetCurrentCreationContractInput,
  isValidListCreationContractVersionsInput,
  isValidGetCreationContractProposalInput,
  isValidListCreationContractProposalsInput,
  isValidRequestContractDraftInput,
  isValidAcceptContractProposalInput,
  isValidRejectContractProposalInput,
  isValidUpdateContractByUserInput,
  isValidLockContractFieldInput,
  isValidUnlockContractFieldInput,
  type ContractVersionPublicData,
  type ContractVersionSummary,
  type ProposalPublicData,
  type RequestContractDraftResult,
} from '@ai-novel/contracts';
import type { ContractPatchOperation } from '@ai-novel/domain';
import {
  AppError,
  getCurrentCreationContract,
  listCreationContractVersions,
  getCreationContractProposal,
  listCreationContractProposals,
  requestCreationContractProposal,
  acceptCreationContractProposal,
  rejectCreationContractProposal,
  updateCreationContractByUser,
  lockCreationContractField,
  unlockCreationContractField,
  type IdGenerator,
  type Clock,
  type TaskRepositoryPort,
  type ProviderProfileData,
  type CreationContractQueryDeps,
  type CreationContractMutationDeps,
  type RequestCreationContractProposalDeps,
} from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import { CreationContractTransactionPortImpl, sha256Utf8 } from '@ai-novel/database';
import { GrillSessionRepositoryAdapter } from './grill-handlers.js';
import { isTerminalStatus } from './runner-kernel.js';
import type { ContractDraftScheduleResult } from './contract-draft-runner.js';

// ── 上下文 ────────────────────────────────────────────────────────

export interface ContractHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
  /** 解析当前启用的产品 provider（Renderer 不传 providerProfileId） */
  resolveEnabledProvider(): ProviderProfileData | null;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  /** 后台调度创作契约草案执行 */
  scheduleContractDraft(projectId: string, taskId: string): ContractDraftScheduleResult;
}

// ── Deps 构建 ─────────────────────────────────────────────────────

function buildQueryDeps(projDb: ProjectDatabase): CreationContractQueryDeps {
  return {
    proposalRepo: projDb.getCreationContractProposalRepository(),
    versionRepo: projDb.getCreationContractVersionRepository(),
    currentRepo: projDb.getCreationContractCurrentRepository(),
  };
}

function buildMutationDeps(projDb: ProjectDatabase): CreationContractMutationDeps {
  return {
    transactionPort: new CreationContractTransactionPortImpl(projDb.database),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

function buildRequestDeps(
  projDb: ProjectDatabase,
  ctx: ContractHandlerContext,
): RequestCreationContractProposalDeps {
  const clock = ctx.clock;
  return {
    idGenerator: ctx.idGenerator,
    clock,
    sessionRepo: new GrillSessionRepositoryAdapter(projDb, clock),
    currentRepo: projDb.getCreationContractCurrentRepository(),
    versionRepo: projDb.getCreationContractVersionRepository(),
    taskRepo: ctx.getTaskRepo(projDb),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
    // Request 用例在单个 BEGIN IMMEDIATE 事务内捕获 session + contract 快照，
    // 防止其他 writer 在中间改变 session/current 产生混合快照。
    transaction: <T>(fn: () => T) => projDb.transactionImmediate(fn),
  };
}

// ── 处理器 ────────────────────────────────────────────────────────

function handleGetCurrent(
  payload: unknown,
  ctx: ContractHandlerContext,
): ContractVersionPublicData | null {
  if (!isValidGetCurrentCreationContractInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的当前契约查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getCurrentCreationContract(buildQueryDeps(projDb), { projectId: payload.projectId });
  } finally {
    projDb.close();
  }
}

function handleListVersions(
  payload: unknown,
  ctx: ContractHandlerContext,
): ReadonlyArray<ContractVersionSummary> {
  if (!isValidListCreationContractVersionsInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的契约版本列表输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return listCreationContractVersions(buildQueryDeps(projDb), { projectId: payload.projectId });
  } finally {
    projDb.close();
  }
}

function handleGetProposal(payload: unknown, ctx: ContractHandlerContext): ProposalPublicData {
  if (!isValidGetCreationContractProposalInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的契约提案查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getCreationContractProposal(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      proposalId: payload.proposalId,
    });
  } finally {
    projDb.close();
  }
}

function handleListProposals(
  payload: unknown,
  ctx: ContractHandlerContext,
): ReadonlyArray<ProposalPublicData> {
  if (!isValidListCreationContractProposalsInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的契约提案列表输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return listCreationContractProposals(buildQueryDeps(projDb), { projectId: payload.projectId });
  } finally {
    projDb.close();
  }
}

function handleRequestDraft(
  payload: unknown,
  ctx: ContractHandlerContext,
): RequestContractDraftResult {
  if (!isValidRequestContractDraftInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的请求创作契约输入');
  }

  // Worker 选择当前启用 provider（Renderer 不传 providerProfileId）
  const enabledProfile = ctx.resolveEnabledProvider();
  if (!enabledProfile) {
    throw new AppError('PROVIDER_NOT_CONFIGURED', '请先配置模型提供商');
  }

  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const taskRepo = ctx.getTaskRepo(projDb);
    const requested = requestCreationContractProposal(buildRequestDeps(projDb, ctx), {
      projectId: payload.projectId,
      grillSessionId: payload.grillSessionId,
      expectedGrillSessionVersion: payload.expectedGrillSessionVersion,
      expectedContractVersion: payload.expectedContractVersion,
      providerProfileId: enabledProfile.id,
    });

    // 异步调度后台执行（独立 DB，不阻塞 IPC 响应）
    const scheduleResult = ctx.scheduleContractDraft(payload.projectId, requested.taskId);
    if (!scheduleResult.scheduled) {
      // 调度失败：先尝试 failPending，释放 dedupe，不留永久 PENDING。
      const failed = taskRepo.failPending(
        requested.taskId,
        'TASK_EXECUTION_FAILED',
        '创作契约草案任务调度失败',
      );
      if (!failed) {
        // CAS 失败：重新读取任务，按实际状态分类处理（不得静默返回 taskId）。
        const reread = taskRepo.getById(requested.taskId);
        if (reread) {
          if (isTerminalStatus(reread.status)) {
            // 已终态：接受该终态，不覆盖。
          } else if (reread.status === 'RUNNING') {
            // 其他 runner 已领取：不得覆盖，返回 taskId。
          } else {
            // 仍 PENDING：不得静默返回，抛固定安全 INTERNAL_ERROR。
            throw new AppError('INTERNAL_ERROR', '创作契约草案任务调度失败');
          }
        }
      }
    }

    return {
      taskId: requested.taskId,
      grillSessionId: requested.grillSessionId,
      baseGrillSessionVersion: requested.baseGrillSessionVersion,
      baseContractVersion: requested.baseContractVersion,
    };
  } finally {
    projDb.close();
  }
}

function handleAcceptProposal(
  payload: unknown,
  ctx: ContractHandlerContext,
): ContractVersionPublicData {
  if (!isValidAcceptContractProposalInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的接受契约提案输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return acceptCreationContractProposal(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      proposalId: payload.proposalId,
      expectedProposalSectionsHash: payload.expectedProposalSectionsHash,
      expectedGrillSessionVersion: payload.expectedGrillSessionVersion,
      expectedContractVersion: payload.expectedContractVersion,
      operations: payload.operations as unknown as ReadonlyArray<ContractPatchOperation>,
      now: ctx.clock.now(),
      newVersionId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

function handleRejectProposal(payload: unknown, ctx: ContractHandlerContext): ProposalPublicData {
  if (!isValidRejectContractProposalInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的拒绝契约提案输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return rejectCreationContractProposal(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      proposalId: payload.proposalId,
      expectedProposalSectionsHash: payload.expectedProposalSectionsHash,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

function handleUpdateByUser(
  payload: unknown,
  ctx: ContractHandlerContext,
): ContractVersionPublicData {
  if (!isValidUpdateContractByUserInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的用户更新契约输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return updateCreationContractByUser(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      expectedContractVersion: payload.expectedContractVersion,
      operations: payload.operations as unknown as ReadonlyArray<ContractPatchOperation>,
      now: ctx.clock.now(),
      newVersionId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

function handleLockField(payload: unknown, ctx: ContractHandlerContext): ContractVersionPublicData {
  if (!isValidLockContractFieldInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的锁定契约字段输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return lockCreationContractField(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      expectedContractVersion: payload.expectedContractVersion,
      fieldPath: payload.fieldPath,
      now: ctx.clock.now(),
      newVersionId: ctx.idGenerator.generate(),
      lockEventId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

function handleUnlockField(
  payload: unknown,
  ctx: ContractHandlerContext,
): ContractVersionPublicData {
  if (!isValidUnlockContractFieldInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的解锁契约字段输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return unlockCreationContractField(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      expectedContractVersion: payload.expectedContractVersion,
      fieldPath: payload.fieldPath,
      now: ctx.clock.now(),
      newVersionId: ctx.idGenerator.generate(),
      lockEventId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

// ── 分发 ──────────────────────────────────────────────────────────

export function dispatchContractCommand(
  command: string,
  payload: unknown,
  ctx: ContractHandlerContext,
): unknown {
  switch (command) {
    case 'contract.getCurrent':
      return handleGetCurrent(payload, ctx);
    case 'contract.listVersions':
      return handleListVersions(payload, ctx);
    case 'contract.getProposal':
      return handleGetProposal(payload, ctx);
    case 'contract.listProposals':
      return handleListProposals(payload, ctx);
    case 'contract.requestDraft':
      return handleRequestDraft(payload, ctx);
    case 'contract.acceptProposal':
      return handleAcceptProposal(payload, ctx);
    case 'contract.rejectProposal':
      return handleRejectProposal(payload, ctx);
    case 'contract.updateByUser':
      return handleUpdateByUser(payload, ctx);
    case 'contract.lockField':
      return handleLockField(payload, ctx);
    case 'contract.unlockField':
      return handleUnlockField(payload, ctx);
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
