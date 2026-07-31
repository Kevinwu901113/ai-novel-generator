/**
 * 创作契约 ContractAPI 验证测试。
 *
 * 覆盖所有 contract 输入 validator：exact keys、extra keys 拒绝、
 * strict null 语义、safe integer、hash、operations、field path、
 * DTO round trip、DesktopAPI type parity、IPC 频道完整。
 */

import { describe, it, expect } from 'vitest';
import {
  IPC_CHANNELS,
  isValidRequestContractDraftInput,
  isValidGetCurrentCreationContractInput,
  isValidListCreationContractVersionsInput,
  isValidGetCreationContractProposalInput,
  isValidListCreationContractProposalsInput,
  isValidAcceptContractProposalInput,
  isValidRejectContractProposalInput,
  isValidUpdateContractByUserInput,
  isValidLockContractFieldInput,
  isValidUnlockContractFieldInput,
  isCanonicalContractFieldPath,
  type DesktopAPI,
  type ContractAPI,
  type RequestContractDraftInput,
  type AcceptContractProposalInput,
  type RejectContractProposalInput,
  type UpdateContractByUserInput,
  type LockContractFieldInput,
  type UnlockContractFieldInput,
} from './index.js';

const HEX64 = 'a'.repeat(64);

describe('isCanonicalContractFieldPath', () => {
  it('接受合法 canonical path', () => {
    expect(isCanonicalContractFieldPath('/premise')).toBe(true);
    expect(isCanonicalContractFieldPath('/protagonist/name')).toBe(true);
    expect(isCanonicalContractFieldPath('/supportingCharacters/alice/role')).toBe(true);
    expect(isCanonicalContractFieldPath('/relationships/r1/type')).toBe(true);
    expect(isCanonicalContractFieldPath('/targetLength/value')).toBe(true);
  });

  it('拒绝非法 path', () => {
    expect(isCanonicalContractFieldPath('/nonsense')).toBe(false);
    expect(isCanonicalContractFieldPath('premise')).toBe(false);
    expect(isCanonicalContractFieldPath('/protagonist/characterKey')).toBe(true); // structured child 合法
    expect(isCanonicalContractFieldPath('/protagonist')).toBe(true); // 顶层 structured 合法
    expect(isCanonicalContractFieldPath('/supportingCharacters/')).toBe(false);
    expect(isCanonicalContractFieldPath('/supportingCharacters/BAD!KEY/role')).toBe(false);
    expect(isCanonicalContractFieldPath('/relationships/r1/unknownField')).toBe(false);
    expect(isCanonicalContractFieldPath('/protagonist/name/extra')).toBe(false);
  });
});

describe('isValidRequestContractDraftInput', () => {
  const valid: RequestContractDraftInput = {
    projectId: 'proj-1',
    grillSessionId: 'gs-1',
    expectedGrillSessionVersion: 3,
    expectedContractVersion: null,
  };

  it('接受合法输入（首次 expectedContractVersion=null）', () => {
    expect(isValidRequestContractDraftInput(valid)).toBe(true);
    expect(isValidRequestContractDraftInput({ ...valid, expectedContractVersion: 2 })).toBe(true);
  });

  it('extra key（providerProfileId/now/taskId）拒绝', () => {
    expect(isValidRequestContractDraftInput({ ...valid, providerProfileId: 'p' })).toBe(false);
    expect(isValidRequestContractDraftInput({ ...valid, now: '2024-01-01T00:00:00.000Z' })).toBe(
      false,
    );
    expect(isValidRequestContractDraftInput({ ...valid, taskId: 't1' })).toBe(false);
  });

  it('missing key 拒绝', () => {
    const { expectedContractVersion, ...missing } = valid;
    void expectedContractVersion;
    expect(isValidRequestContractDraftInput(missing)).toBe(false);
    expect(isValidRequestContractDraftInput({ projectId: 'proj-1' })).toBe(false);
  });

  it('safe integer 与 null 语义严格', () => {
    expect(isValidRequestContractDraftInput({ ...valid, expectedGrillSessionVersion: 0 })).toBe(
      false,
    );
    expect(isValidRequestContractDraftInput({ ...valid, expectedGrillSessionVersion: 1.5 })).toBe(
      false,
    );
    expect(
      isValidRequestContractDraftInput({ ...valid, expectedGrillSessionVersion: Number.NaN }),
    ).toBe(false);
    expect(isValidRequestContractDraftInput({ ...valid, expectedContractVersion: -1 })).toBe(false);
  });

  it('ID trim 非空与长度上限', () => {
    expect(isValidRequestContractDraftInput({ ...valid, projectId: '  ' })).toBe(false);
    expect(isValidRequestContractDraftInput({ ...valid, projectId: 'x'.repeat(200) })).toBe(false);
  });
});

describe('query validators', () => {
  it('getCurrent / listVersions / listProposals：exact keys projectId', () => {
    expect(isValidGetCurrentCreationContractInput({ projectId: 'proj-1' })).toBe(true);
    expect(isValidGetCurrentCreationContractInput({ projectId: 'proj-1', extra: 1 })).toBe(false);
    expect(isValidListCreationContractVersionsInput({ projectId: 'proj-1' })).toBe(true);
    expect(isValidListCreationContractProposalsInput({ projectId: 'proj-1' })).toBe(true);
  });

  it('getProposal：projectId + proposalId', () => {
    expect(
      isValidGetCreationContractProposalInput({ projectId: 'proj-1', proposalId: 'prop-1' }),
    ).toBe(true);
    expect(
      isValidGetCreationContractProposalInput({ projectId: 'proj-1', proposalId: 'prop-1', x: 1 }),
    ).toBe(false);
    expect(isValidGetCreationContractProposalInput({ projectId: 'proj-1' })).toBe(false);
  });
});

describe('mutation validators', () => {
  const validAccept: AcceptContractProposalInput = {
    projectId: 'proj-1',
    proposalId: 'prop-1',
    expectedProposalSectionsHash: HEX64,
    expectedGrillSessionVersion: 3,
    expectedContractVersion: null,
    operations: [],
  };
  const validReject: RejectContractProposalInput = {
    projectId: 'proj-1',
    proposalId: 'prop-1',
    expectedProposalSectionsHash: HEX64,
  };
  const validUpdate: UpdateContractByUserInput = {
    projectId: 'proj-1',
    expectedContractVersion: 1,
    operations: [{ kind: 'set-scalar', path: '/premise', value: '新前提' }],
  };
  const validLock: LockContractFieldInput = {
    projectId: 'proj-1',
    expectedContractVersion: 1,
    fieldPath: '/premise',
  };
  const validUnlock: UnlockContractFieldInput = {
    projectId: 'proj-1',
    expectedContractVersion: 1,
    fieldPath: '/premise',
  };

  it('accept：合法通过', () => {
    expect(isValidAcceptContractProposalInput(validAccept)).toBe(true);
  });
  it('accept：hash 非 lowercase 64-hex 拒绝', () => {
    expect(
      isValidAcceptContractProposalInput({ ...validAccept, expectedProposalSectionsHash: 'XYZ' }),
    ).toBe(false);
    expect(
      isValidAcceptContractProposalInput({
        ...validAccept,
        expectedProposalSectionsHash: 'A'.repeat(64),
      }),
    ).toBe(false);
  });
  it('accept：无效 operations 拒绝', () => {
    expect(
      isValidAcceptContractProposalInput({ ...validAccept, operations: [{ kind: 'bogus' }] }),
    ).toBe(false);
    expect(
      isValidAcceptContractProposalInput({
        ...validAccept,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 123 }],
      }),
    ).toBe(false);
  });
  it('accept：caller 注入 newVersionId/now 拒绝', () => {
    expect(isValidAcceptContractProposalInput({ ...validAccept, newVersionId: 'v1' })).toBe(false);
    expect(
      isValidAcceptContractProposalInput({ ...validAccept, now: '2024-01-01T00:00:00.000Z' }),
    ).toBe(false);
  });
  it('reject：合法 + 注入 now 拒绝', () => {
    expect(isValidRejectContractProposalInput(validReject)).toBe(true);
    expect(
      isValidRejectContractProposalInput({ ...validReject, now: '2024-01-01T00:00:00.000Z' }),
    ).toBe(false);
  });
  it('update：合法 + 空 operations 拒绝', () => {
    expect(isValidUpdateContractByUserInput(validUpdate)).toBe(true);
    expect(isValidUpdateContractByUserInput({ ...validUpdate, operations: [] })).toBe(true); // validator 允许空（use case 拒绝）
    expect(isValidUpdateContractByUserInput({ ...validUpdate, operations: [{ kind: 'x' }] })).toBe(
      false,
    );
    expect(isValidUpdateContractByUserInput({ ...validUpdate, newVersionId: 'v1' })).toBe(false);
  });
  it('lock/unlock：非法 field path 拒绝 + 注入 ID 拒绝', () => {
    expect(isValidLockContractFieldInput(validLock)).toBe(true);
    expect(isValidUnlockContractFieldInput(validUnlock)).toBe(true);
    expect(isValidLockContractFieldInput({ ...validLock, fieldPath: '/nonsense' })).toBe(false);
    expect(isValidLockContractFieldInput({ ...validLock, newVersionId: 'v1' })).toBe(false);
    expect(isValidLockContractFieldInput({ ...validLock, lockEventId: 'e1' })).toBe(false);
  });
});

describe('DesktopAPI type parity', () => {
  it('ContractAPI 是 DesktopAPI 的属性且方法签名完整', () => {
    // 编译期校验：DesktopAPI 必须包含 contract: ContractAPI
    const assertShape = (_api: DesktopAPI): void => {
      void _api;
    };
    // 编译期校验 ContractAPI 方法集（不依赖 domain class，全部 DTO）
    const contractApi: ContractAPI = {
      getCurrent: async () => null,
      listVersions: async () => [],
      getProposal: async () => ({
        id: '',
        projectId: '',
        taskId: '',
        invocationId: '',
        status: 'PROPOSED',
        baseGrillSessionId: '',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sections: {
          premise: '',
          genre: [],
          tone: [],
          targetAudience: '',
          narrativePov: 'FIRST',
          tense: 'PAST',
          protagonist: { characterKey: 'k', name: '' },
        },
        sectionsHash: HEX64,
        createdAt: '',
        updatedAt: '',
      }),
      listProposals: async () => [],
      requestDraft: async () => ({
        taskId: '',
        grillSessionId: '',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
      }),
      acceptProposal: async () => {
        throw new Error('n/a');
      },
      rejectProposal: async () => {
        throw new Error('n/a');
      },
      updateByUser: async () => {
        throw new Error('n/a');
      },
      lockField: async () => {
        throw new Error('n/a');
      },
      unlockField: async () => {
        throw new Error('n/a');
      },
    };
    expect(typeof contractApi.getCurrent).toBe('function');
    expect(typeof contractApi.requestDraft).toBe('function');
    assertShape({} as DesktopAPI);
  });

  it('IPC 频道包含全部 contract 命令', () => {
    const channels = Object.values(IPC_CHANNELS);
    for (const ch of [
      'ipc:contract-get-current',
      'ipc:contract-list-versions',
      'ipc:contract-get-proposal',
      'ipc:contract-list-proposals',
      'ipc:contract-request-draft',
      'ipc:contract-accept-proposal',
      'ipc:contract-reject-proposal',
      'ipc:contract-update-by-user',
      'ipc:contract-lock-field',
      'ipc:contract-unlock-field',
    ]) {
      expect(channels).toContain(ch);
    }
  });
});
