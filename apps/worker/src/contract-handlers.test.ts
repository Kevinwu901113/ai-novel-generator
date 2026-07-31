/**
 * 创作契约 Worker 命令分发测试。
 *
 * 覆盖：每个 contract command dispatch、payload 严格验证、
 * provider 路由、request 立即返回、schedule false fallback、
 * Worker DB close、AppError 映射、unknown error 安全、
 * caller 不能注入 ID/time/provider、happy path（accept/reject/update/lock/unlock）。
 *
 * 与真实 Worker 一致：每次命令调用打开独立 ProjectDatabase 并在 finally 关闭。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { AppError } from '@ai-novel/application';
import { executeCreationContractDraft } from '@ai-novel/task-engine';
import { dispatchContractCommand, type ContractHandlerContext } from './contract-handlers.js';
import { TaskRepoAdapter } from './contract-test-utils.js';
import {
  buildEngineDeps,
  seedCompletedGrillSession,
  makeCanonicalSectionsJson,
  NOW,
  NOW2,
} from './contract-test-utils.js';

let tempDir: string;
let dbPath: string;
let closeCount: number;

const HEX64 = 'a'.repeat(64);

function openFreshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'proj-1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const origClose = db.close.bind(db);
  db.close = () => {
    closeCount++;
    origClose();
  };
  return db;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-handlers-'));
  dbPath = join(tempDir, 'project.sqlite');
  closeCount = 0;
  const db = new ProjectDatabase(dbPath);
  db.getProjectMetadataRepository().create({
    id: 'proj-1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'contract',
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeProviderProfile() {
  return {
    id: 'provider-1',
    providerType: 'anthropic-compatible' as const,
    displayName: 'Test',
    baseUrl: 'https://test.example',
    model: 'test-model',
    keychainService: 'svc',
    keychainAccount: 'acct',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  };
}

// 全局递增 ID 生成器，模拟 Worker 的 randomUUID（跨命令唯一）
let idSeq = 0;

function makeCtx(overrides: Partial<ContractHandlerContext> = {}): ContractHandlerContext {
  return {
    getProjectDb: () => openFreshDb(),
    idGenerator: { generate: () => `gen-id-${++idSeq}` },
    clock: { now: () => NOW2 },
    resolveEnabledProvider: () => makeProviderProfile(),
    getTaskRepo: (db) => new TaskRepoAdapter(db),
    scheduleContractDraft: () => ({ scheduled: true }),
    ...overrides,
  };
}

/** 通过 requestDraft + engine 生成一个 proposal，返回 proposalId。 */
async function createProposal(
  projectId: string,
  sessionId: string,
  sessionVersion: number,
): Promise<string> {
  const ctx = makeCtx();
  const requested = dispatchContractCommand(
    'contract.requestDraft',
    {
      projectId,
      grillSessionId: sessionId,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
    },
    ctx,
  ) as { taskId: string };
  const db = openFreshDb();
  const result = await executeCreationContractDraft(buildEngineDeps(db), requested.taskId);
  db.close();
  return result.proposalId!;
}

describe('dispatchContractCommand', () => {
  it('requestDraft：立即返回 taskId，task PENDING，provider 由 Worker 解析', () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h',
      projectId: 'proj-1',
    });
    const scheduleMock = vi.fn(() => ({ scheduled: true }) as const);
    const result = dispatchContractCommand(
      'contract.requestDraft',
      {
        projectId: 'proj-1',
        grillSessionId: 'gs-h',
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: null,
      },
      makeCtx({ scheduleContractDraft: scheduleMock }),
    ) as { taskId: string; baseContractVersion: number | null };
    expect(result.taskId).toBeTruthy();
    expect(result.baseContractVersion).toBeNull();
    expect(scheduleMock).toHaveBeenCalledWith('proj-1', result.taskId);
    // handler 关闭其打开的 DB（exactly once）
    expect(closeCount).toBe(1);
    const db = openFreshDb();
    const task = db.getTaskRepository().getById(result.taskId);
    db.close();
    expect(task?.status).toBe('PENDING');
    expect(task?.taskType).toBe('CREATION_CONTRACT_DRAFT');
  });

  it('requestDraft：无启用 provider → PROVIDER_NOT_CONFIGURED', () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h2',
      projectId: 'proj-1',
    });
    expect(() =>
      dispatchContractCommand(
        'contract.requestDraft',
        {
          projectId: 'proj-1',
          grillSessionId: 'gs-h2',
          expectedGrillSessionVersion: sessionVersion,
          expectedContractVersion: null,
        },
        makeCtx({ resolveEnabledProvider: () => null }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }));
  });

  it('requestDraft：schedule false → 立即 failPending，不留 PENDING', () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h3',
      projectId: 'proj-1',
    });
    const result = dispatchContractCommand(
      'contract.requestDraft',
      {
        projectId: 'proj-1',
        grillSessionId: 'gs-h3',
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: null,
      },
      makeCtx({ scheduleContractDraft: () => ({ scheduled: false, reason: 'OPEN_FAILED' }) }),
    ) as { taskId: string };
    const db = openFreshDb();
    const task = db.getTaskRepository().getById(result.taskId);
    db.close();
    expect(task?.status).toBe('FAILED');
    expect(task?.errorCode).toBe('TASK_EXECUTION_FAILED');
  });

  it('caller 注入 providerProfileId / now / newVersionId → VALIDATION_ERROR', () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h4',
      projectId: 'proj-1',
    });
    const base = {
      projectId: 'proj-1',
      grillSessionId: 'gs-h4',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
    };
    expect(() =>
      dispatchContractCommand(
        'contract.requestDraft',
        { ...base, providerProfileId: 'p' },
        makeCtx(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      dispatchContractCommand(
        'contract.acceptProposal',
        {
          projectId: 'proj-1',
          proposalId: 'prop-1',
          expectedProposalSectionsHash: HEX64,
          expectedGrillSessionVersion: sessionVersion,
          expectedContractVersion: null,
          operations: [],
          newVersionId: 'injected',
        },
        makeCtx(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      dispatchContractCommand(
        'contract.rejectProposal',
        {
          projectId: 'proj-1',
          proposalId: 'prop-1',
          expectedProposalSectionsHash: HEX64,
          now: NOW,
        },
        makeCtx(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('unknown command → AppError', () => {
    expect(() => dispatchContractCommand('contract.nonsense', {}, makeCtx())).toThrow(AppError);
  });

  it('happy path：requestDraft → getProposal/listProposals → acceptProposal → getCurrent/listVersions', async () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h5',
      projectId: 'proj-1',
    });
    const proposalId = await createProposal('proj-1', 'gs-h5', sessionVersion);

    const proposal = dispatchContractCommand(
      'contract.getProposal',
      { projectId: 'proj-1', proposalId },
      makeCtx(),
    ) as { status: string; sectionsHash: string };
    expect(proposal.status).toBe('PROPOSED');
    const proposals = dispatchContractCommand(
      'contract.listProposals',
      { projectId: 'proj-1' },
      makeCtx(),
    ) as ReadonlyArray<{ id: string }>;
    expect(proposals).toHaveLength(1);

    const accepted = dispatchContractCommand(
      'contract.acceptProposal',
      {
        projectId: 'proj-1',
        proposalId,
        expectedProposalSectionsHash: proposal.sectionsHash,
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: null,
        operations: [],
      },
      makeCtx(),
    ) as { id: string; version: number; createdBy: string };
    expect(accepted.version).toBe(1);
    expect(accepted.createdBy).toBe('ai-proposal-accepted');

    const current = dispatchContractCommand(
      'contract.getCurrent',
      { projectId: 'proj-1' },
      makeCtx(),
    ) as { id: string; version: number };
    expect(current.id).toBe(accepted.id);

    const versions = dispatchContractCommand(
      'contract.listVersions',
      { projectId: 'proj-1' },
      makeCtx(),
    ) as ReadonlyArray<{ version: number }>;
    expect(versions.map((v) => v.version)).toContain(1);
  });

  it('happy path：rejectProposal → proposal REJECTED，不创建版本', async () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h6',
      projectId: 'proj-1',
    });
    const proposalId = await createProposal('proj-1', 'gs-h6', sessionVersion);
    const proposal = dispatchContractCommand(
      'contract.getProposal',
      { projectId: 'proj-1', proposalId },
      makeCtx(),
    ) as { sectionsHash: string };
    const rejected = dispatchContractCommand(
      'contract.rejectProposal',
      {
        projectId: 'proj-1',
        proposalId,
        expectedProposalSectionsHash: proposal.sectionsHash,
      },
      makeCtx(),
    ) as { status: string };
    expect(rejected.status).toBe('REJECTED');
    const current = dispatchContractCommand(
      'contract.getCurrent',
      { projectId: 'proj-1' },
      makeCtx(),
    );
    expect(current).toBeNull();
  });

  it('happy path：updateByUser / lockField / unlockField 创建新版本', async () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h7',
      projectId: 'proj-1',
    });
    const proposalId = await createProposal('proj-1', 'gs-h7', sessionVersion);
    const proposal = dispatchContractCommand(
      'contract.getProposal',
      { projectId: 'proj-1', proposalId },
      makeCtx(),
    ) as { sectionsHash: string };
    dispatchContractCommand(
      'contract.acceptProposal',
      {
        projectId: 'proj-1',
        proposalId,
        expectedProposalSectionsHash: proposal.sectionsHash,
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: null,
        operations: [],
      },
      makeCtx(),
    );

    const updated = dispatchContractCommand(
      'contract.updateByUser',
      {
        projectId: 'proj-1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: '用户改写的前提' }],
      },
      makeCtx(),
    ) as { version: number; sections: { premise: string } };
    expect(updated.version).toBe(2);
    expect(updated.sections.premise).toBe('用户改写的前提');

    const locked = dispatchContractCommand(
      'contract.lockField',
      { projectId: 'proj-1', expectedContractVersion: 2, fieldPath: '/premise' },
      makeCtx(),
    ) as { version: number; lockedFieldPaths: ReadonlyArray<string> };
    expect(locked.version).toBe(3);
    expect(locked.lockedFieldPaths).toContain('/premise');

    const unlocked = dispatchContractCommand(
      'contract.unlockField',
      { projectId: 'proj-1', expectedContractVersion: 3, fieldPath: '/premise' },
      makeCtx(),
    ) as { version: number; lockedFieldPaths: ReadonlyArray<string> };
    expect(unlocked.version).toBe(4);
    expect(unlocked.lockedFieldPaths).not.toContain('/premise');
  });

  it('AppError 传播：accept 不存在的 proposal → CONTRACT_PROPOSAL_NOT_FOUND', () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h8',
      projectId: 'proj-1',
    });
    expect(() =>
      dispatchContractCommand(
        'contract.acceptProposal',
        {
          projectId: 'proj-1',
          proposalId: 'missing',
          expectedProposalSectionsHash: HEX64,
          expectedGrillSessionVersion: sessionVersion,
          expectedContractVersion: null,
          operations: [],
        },
        makeCtx(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONTRACT_PROPOSAL_NOT_FOUND' }));
  });

  it('Worker DB close：每个命令后关闭，且安全错误不泄露内部细节', () => {
    seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h9',
      projectId: 'proj-1',
    });
    dispatchContractCommand('contract.getCurrent', { projectId: 'proj-1' }, makeCtx());
    expect(closeCount).toBe(1);
    try {
      dispatchContractCommand('contract.getCurrent', { projectId: 123 }, makeCtx());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('model 输出合法 sections 可被接受（fake gateway 完整链路）', async () => {
    const sessionVersion = seedCompletedGrillSession(openFreshDb(), {
      sessionId: 'gs-h10',
      projectId: 'proj-1',
    });
    const requested = dispatchContractCommand(
      'contract.requestDraft',
      {
        projectId: 'proj-1',
        grillSessionId: 'gs-h10',
        expectedGrillSessionVersion: sessionVersion,
        expectedContractVersion: null,
      },
      makeCtx(),
    ) as { taskId: string };
    const db = openFreshDb();
    const result = await executeCreationContractDraft(buildEngineDeps(db), requested.taskId);
    expect(result.task.status).toBe('SUCCEEDED');
    const proposal = db
      .getCreationContractProposalRepository()
      .getById('proj-1', result.proposalId!);
    db.close();
    expect(proposal).not.toBeNull();
    expect(JSON.parse(proposal!.sectionsJson)).toEqual(JSON.parse(makeCanonicalSectionsJson()));
  });
});
