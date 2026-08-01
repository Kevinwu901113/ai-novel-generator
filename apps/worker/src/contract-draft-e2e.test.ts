/**
 * 创作契约草案 backend E2E（真实 SQLite + fake model gateway）。
 *
 * 完整链路：完成 Grill session → requestDraft → PENDING task →
 * 执行 runner → task/invocation SUCCEEDED → proposal PROPOSED →
 * 读取 proposal → current contract 不变 → acceptProposal → 新权威版本 +
 * current pointer → proposal ACCEPTED → provenance 正确 → 原 proposal 不变。
 *
 * 再覆盖已有 contract + locks 的第二轮生成。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { CreationContractTransactionPortImpl, sha256Utf8 } from '@ai-novel/database';
import {
  requestCreationContractProposal,
  getCreationContractProposal,
  listCreationContractProposals,
  getCurrentCreationContract,
  acceptCreationContractProposal,
  lockCreationContractField,
} from '@ai-novel/application';
import { executeCreationContractDraft } from '@ai-novel/task-engine';
import {
  buildEngineDeps,
  buildRequestDeps,
  seedCompletedGrillSession,
  NOW,
} from './contract-test-utils.js';

// mutation 时间戳必须晚于 proposal 创建时间（status 变更 trigger 要求 updated_at 变化）
const NOW2 = '2026-01-10T08:00:30.000Z';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-e2e-'));
  dbPath = join(tempDir, 'project.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function openDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  // project_metadata：accept 用例的 projectExistsReadPort 需要
  db.getProjectMetadataRepository().create({
    id: 'proj-1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'contract',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

describe('backend E2E: 创作契约草案链路', () => {
  it('首次生成 → 后台执行 → proposal → accept → 权威版本', async () => {
    const projDb = openDb();
    const sessionVersion = seedCompletedGrillSession(projDb, {
      sessionId: 'gs-e2e',
      projectId: 'proj-1',
    });

    // 1. requestDraft
    const requestDeps = buildRequestDeps(projDb, { generate: () => 'task-e2e-1' });
    const requested = requestCreationContractProposal(requestDeps, {
      projectId: 'proj-1',
      grillSessionId: 'gs-e2e',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });
    expect(requested.taskId).toBe('task-e2e-1');
    expect(requested.baseContractVersion).toBeNull();

    // 2. PENDING task
    const taskBefore = projDb.getTaskRepository().getById('task-e2e-1');
    expect(taskBefore?.status).toBe('PENDING');
    expect(taskBefore?.taskType).toBe('CREATION_CONTRACT_DRAFT');

    // 3. 后台执行（真实 engine + fake model gateway）
    const engineDeps = buildEngineDeps(projDb);
    const result = await executeCreationContractDraft(engineDeps, 'task-e2e-1');

    // 4-8. task/invocation/proposal 状态
    expect(result.task.status).toBe('SUCCEEDED');
    const invocation = projDb.getModelInvocationRepository().getById(result.invocation!.id);
    expect(invocation?.status).toBe('SUCCEEDED');
    expect(invocation?.requestKind).toBe('creation_contract_draft');

    const proposal = projDb
      .getCreationContractProposalRepository()
      .getById('proj-1', result.proposalId!);
    expect(proposal).not.toBeNull();
    expect(proposal?.status).toBe('PROPOSED');
    expect(proposal?.baseGrillSessionId).toBe('gs-e2e');
    expect(proposal?.baseGrillSessionVersion).toBe(sessionVersion);
    expect(proposal?.baseContractVersion).toBeNull();

    // 9. current contract 仍不存在
    const current = projDb.getCreationContractCurrentRepository().get('proj-1');
    expect(current).toBeNull();

    // 10. 读取 proposal 可读
    const proposalPublic = getCreationContractProposal(
      {
        proposalRepo: projDb.getCreationContractProposalRepository(),
        versionRepo: projDb.getCreationContractVersionRepository(),
        currentRepo: projDb.getCreationContractCurrentRepository(),
      },
      { projectId: 'proj-1', proposalId: result.proposalId! },
    );
    expect(proposalPublic.sections.premise).toBe('一个关于契约的故事');
    expect(proposalPublic.sectionsHash).toBe(proposal?.sectionsHash);

    const listPublic = listCreationContractProposals(
      {
        proposalRepo: projDb.getCreationContractProposalRepository(),
        versionRepo: projDb.getCreationContractVersionRepository(),
        currentRepo: projDb.getCreationContractCurrentRepository(),
      },
      { projectId: 'proj-1' },
    );
    expect(listPublic).toHaveLength(1);

    // 11. acceptProposal（Worker 注入 now/newVersionId）
    const mutationDeps = {
      transactionPort: new CreationContractTransactionPortImpl(projDb.database),
      sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
    };
    const acceptedVersion = acceptCreationContractProposal(mutationDeps, {
      projectId: 'proj-1',
      proposalId: result.proposalId!,
      expectedProposalSectionsHash: proposal!.sectionsHash,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      operations: [],
      now: NOW2,
      newVersionId: 'ver-e2e-1',
    });

    // 12. 新权威版本 + current pointer
    expect(acceptedVersion.version).toBe(1);
    expect(acceptedVersion.createdBy).toBe('ai-proposal-accepted');
    const currentAfter = projDb.getCreationContractCurrentRepository().get('proj-1');
    expect(currentAfter?.currentVersionId).toBe('ver-e2e-1');

    // 13. proposal ACCEPTED
    const proposalAfter = projDb
      .getCreationContractProposalRepository()
      .getById('proj-1', result.proposalId!);
    expect(proposalAfter?.status).toBe('ACCEPTED');

    // 14. provenance 关联正确（9 个 canonical field path）
    expect(acceptedVersion.provenance).toHaveLength(9);
    const premiseProv = acceptedVersion.provenance.find((p) => p.sectionKey === '/premise');
    expect(premiseProv?.aiTaskId).toBe('task-e2e-1');
    expect(premiseProv?.modelInvocationId).toBe(result.invocation!.id);
    expect(premiseProv?.sourceProposalId).toBe(result.proposalId);

    // 15. 原 proposal sections 不变（不可变）
    const proposalSectionsAfter = projDb
      .getCreationContractProposalRepository()
      .getById('proj-1', result.proposalId!);
    expect(proposalSectionsAfter?.sectionsJson).toBe(proposal!.sectionsJson);
    expect(proposalSectionsAfter?.sectionsHash).toBe(proposal!.sectionsHash);
    projDb.close();
  });

  it('已有契约 + locks 的第二轮生成', async () => {
    const projDb = openDb();
    const sessionVersion = seedCompletedGrillSession(projDb, {
      sessionId: 'gs-e2e-2',
      projectId: 'proj-1',
    });

    // 第一轮：生成并接受 → version 1
    const requestDeps = buildRequestDeps(projDb, { generate: () => 'task-r1' });
    const r1 = requestCreationContractProposal(requestDeps, {
      projectId: 'proj-1',
      grillSessionId: 'gs-e2e-2',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      providerProfileId: 'provider-1',
    });
    const result1 = await executeCreationContractDraft(buildEngineDeps(projDb), r1.taskId);
    const proposal1 = projDb
      .getCreationContractProposalRepository()
      .getById('proj-1', result1.proposalId!);
    const mutationDeps = {
      transactionPort: new CreationContractTransactionPortImpl(projDb.database),
      sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
    };
    acceptCreationContractProposal(mutationDeps, {
      projectId: 'proj-1',
      proposalId: result1.proposalId!,
      expectedProposalSectionsHash: proposal1!.sectionsHash,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: null,
      operations: [],
      now: NOW2,
      newVersionId: 'ver-r1',
    });

    // 锁定 /protagonist/name（创建 version 2）
    lockCreationContractField(mutationDeps, {
      projectId: 'proj-1',
      expectedContractVersion: 1,
      fieldPath: '/protagonist/name',
      now: NOW2,
      newVersionId: 'ver-r2',
      lockEventId: 'lock-r2',
    });
    const current = projDb.getCreationContractCurrentRepository().get('proj-1');
    expect(current?.currentVersionId).toBe('ver-r2');

    // 第二轮：requestDraft 捕获 baseline（version 2）
    const requestDeps2 = buildRequestDeps(projDb, { generate: () => 'task-r2' });
    const r2 = requestCreationContractProposal(requestDeps2, {
      projectId: 'proj-1',
      grillSessionId: 'gs-e2e-2',
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: 2,
      providerProfileId: 'provider-1',
    });
    expect(r2.baseContractVersion).toBe(2);

    // 模型输出保持 locked name（fake 输出与 baseline 相同）
    const result2 = await executeCreationContractDraft(buildEngineDeps(projDb), r2.taskId);
    expect(result2.task.status).toBe('SUCCEEDED');
    const proposal2 = projDb
      .getCreationContractProposalRepository()
      .getById('proj-1', result2.proposalId!);
    expect(proposal2).not.toBeNull();
    expect(proposal2?.baseContractVersion).toBe(2);

    // 接受第二轮 → version 3
    const accepted2 = acceptCreationContractProposal(mutationDeps, {
      projectId: 'proj-1',
      proposalId: result2.proposalId!,
      expectedProposalSectionsHash: proposal2!.sectionsHash,
      expectedGrillSessionVersion: sessionVersion,
      expectedContractVersion: 2,
      operations: [],
      now: NOW2,
      newVersionId: 'ver-r3',
    });
    expect(accepted2.version).toBe(3);
    expect(accepted2.lockedFieldPaths).toContain('/protagonist/name');
    // locked field 值保持 baseline
    expect(accepted2.sections.protagonist.name).toBe('主角');

    // current 可读
    const currentPublic = getCurrentCreationContract(
      {
        proposalRepo: projDb.getCreationContractProposalRepository(),
        versionRepo: projDb.getCreationContractVersionRepository(),
        currentRepo: projDb.getCreationContractCurrentRepository(),
      },
      { projectId: 'proj-1' },
    );
    expect(currentPublic?.id).toBe('ver-r3');
    expect(currentPublic?.version).toBe(3);
    projDb.close();
  });
});
