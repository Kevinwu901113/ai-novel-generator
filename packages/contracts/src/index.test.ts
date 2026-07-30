import { describe, it, expect } from 'vitest';
import {
  isValidHealthCheckResponse,
  isValidCreateProjectInput,
  isValidOpenProjectInput,
  isValidContractPatchOperationDTO,
  isValidContractPatchOperationsDTO,
  isValidContractVersionPublicData,
  isValidProposalPublicData,
  isValidCreationContractSectionsPublicData,
  isValidAcceptCreationContractProposalInput,
  isValidRejectCreationContractProposalInput,
  isValidLockCreationContractFieldInput,
  isValidUnlockCreationContractFieldInput,
  isValidUpdateCreationContractByUserInput,
  isValidRequestCreationContractProposalInput,
  isAppError,
  isValidSaveApiKeyInput,
  isValidProviderPublicState,
  isValidConnectionTestResult,
  isValidGrillRequestQuestionPlanInput,
  isValidGrillAcceptQuestionPlanProposalInput,
  isValidGrillListQuestionPlanProposalsInput,
  isValidGrillQuestionPlanProposalIdInput,
  type HealthCheckResponse,
  type ProviderPublicState,
  type ConnectionTestResult,
} from './index';

describe('isValidHealthCheckResponse', () => {
  it('应该接受有效的健康检查响应', () => {
    const valid: HealthCheckResponse = {
      ok: true,
      timestamp: '2024-01-01T00:00:00.000Z',
      version: '1.0.0',
    };
    expect(isValidHealthCheckResponse(valid)).toBe(true);
  });

  it('应该接受 ok=false 的响应', () => {
    const valid: HealthCheckResponse = {
      ok: false,
      timestamp: '2024-01-01T00:00:00.000Z',
      version: '1.0.0',
    };
    expect(isValidHealthCheckResponse(valid)).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidHealthCheckResponse(null)).toBe(false);
  });

  it('应该拒绝 undefined', () => {
    expect(isValidHealthCheckResponse(undefined)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidHealthCheckResponse('string')).toBe(false);
    expect(isValidHealthCheckResponse(42)).toBe(false);
    expect(isValidHealthCheckResponse(true)).toBe(false);
  });

  it('应该拒绝缺少 ok 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝缺少 timestamp 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝缺少 version 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('应该拒绝 ok 字段类型错误的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: 'true',
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝 timestamp 字段类型错误的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        timestamp: 1234567890,
        version: '1.0.0',
      }),
    ).toBe(false);
  });
});

describe('isValidCreateProjectInput', () => {
  it('应该接受有效输入', () => {
    expect(isValidCreateProjectInput({ name: '测试', initialIdea: '想法' })).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidCreateProjectInput(null)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidCreateProjectInput('string')).toBe(false);
  });

  it('应该拒绝缺少 name 的对象', () => {
    expect(isValidCreateProjectInput({ initialIdea: '想法' })).toBe(false);
  });

  it('应该拒绝缺少 initialIdea 的对象', () => {
    expect(isValidCreateProjectInput({ name: '测试' })).toBe(false);
  });

  it('应该拒绝 name 类型错误', () => {
    expect(isValidCreateProjectInput({ name: 123, initialIdea: '想法' })).toBe(false);
  });

  it('应该拒绝 initialIdea 类型错误', () => {
    expect(isValidCreateProjectInput({ name: '测试', initialIdea: 123 })).toBe(false);
  });
});

describe('isValidOpenProjectInput', () => {
  it('应该接受有效输入', () => {
    expect(isValidOpenProjectInput({ projectId: 'abc-123' })).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidOpenProjectInput(null)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidOpenProjectInput(42)).toBe(false);
  });

  it('应该拒绝缺少 projectId 的对象', () => {
    expect(isValidOpenProjectInput({})).toBe(false);
  });

  it('应该拒绝 projectId 类型错误', () => {
    expect(isValidOpenProjectInput({ projectId: 123 })).toBe(false);
  });
});

describe('isAppError', () => {
  it('应该接受有效的 AppError', () => {
    expect(isAppError({ code: 'VALIDATION_ERROR', message: '验证失败' })).toBe(true);
  });

  it('应该接受所有有效错误码', () => {
    const codes = [
      'VALIDATION_ERROR',
      'PROJECT_NOT_FOUND',
      'PROJECT_DIRECTORY_MISSING',
      'PROJECT_DATABASE_INVALID',
      'DATABASE_VERSION_UNSUPPORTED',
      'PROJECT_CREATE_FAILED',
      'WORKER_UNAVAILABLE',
      'PROVIDER_NOT_CONFIGURED',
      'API_KEY_REQUIRED',
      'API_KEY_STORE_FAILED',
      'API_KEY_READ_FAILED',
      'API_KEY_DELETE_FAILED',
      'PROVIDER_CONNECTION_FAILED',
      'PROVIDER_AUTH_FAILED',
      'PROVIDER_ACCESS_DENIED',
      'PROVIDER_MODEL_UNAVAILABLE',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_TIMEOUT',
      'PROVIDER_RESPONSE_INVALID',
      'NETWORK_UNAVAILABLE',
    ];
    for (const code of codes) {
      expect(isAppError({ code, message: '错误' })).toBe(true);
    }
  });

  it('应该拒绝无效错误码', () => {
    expect(isAppError({ code: 'UNKNOWN_CODE', message: '错误' })).toBe(false);
  });

  it('应该拒绝缺少 message 的对象', () => {
    expect(isAppError({ code: 'VALIDATION_ERROR' })).toBe(false);
  });

  it('应该拒绝 null', () => {
    expect(isAppError(null)).toBe(false);
  });
});

describe('isValidSaveApiKeyInput', () => {
  it('应该接受有效输入', () => {
    expect(isValidSaveApiKeyInput({ apiKey: 'test-secret-not-a-real-key' })).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidSaveApiKeyInput(null)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidSaveApiKeyInput('string')).toBe(false);
  });

  it('应该拒绝缺少 apiKey 的对象', () => {
    expect(isValidSaveApiKeyInput({})).toBe(false);
  });

  it('应该拒绝 apiKey 类型错误', () => {
    expect(isValidSaveApiKeyInput({ apiKey: 123 })).toBe(false);
  });
});

describe('isValidProviderPublicState', () => {
  const validState: ProviderPublicState = {
    id: 'mimo-token-plan-cn',
    displayName: 'Xiaomi MiMo Token Plan CN',
    providerType: 'anthropic-compatible',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    model: 'mimo-v2.5-pro',
    enabled: true,
    hasApiKey: false,
    lastTestedAt: null,
    lastTestStatus: 'never',
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  };

  it('应该接受有效的公开状态', () => {
    expect(isValidProviderPublicState(validState)).toBe(true);
  });

  it('应该接受已测试的状态', () => {
    expect(
      isValidProviderPublicState({
        ...validState,
        hasApiKey: true,
        lastTestedAt: '2024-01-01T00:00:00.000Z',
        lastTestStatus: 'success',
        lastTestLatencyMs: 150,
      }),
    ).toBe(true);
  });

  it('应该接受测试失败的状态', () => {
    expect(
      isValidProviderPublicState({
        ...validState,
        hasApiKey: true,
        lastTestedAt: '2024-01-01T00:00:00.000Z',
        lastTestStatus: 'failed',
        lastTestErrorCode: 'PROVIDER_AUTH_FAILED',
        lastTestLatencyMs: 200,
      }),
    ).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidProviderPublicState(null)).toBe(false);
  });

  it('应该拒绝缺少 id 的对象', () => {
    expect(isValidProviderPublicState({ ...validState, id: undefined })).toBe(false);
  });

  it('应该拒绝无效的 providerType', () => {
    expect(isValidProviderPublicState({ ...validState, providerType: 'openai' })).toBe(false);
  });

  it('应该拒绝无效的 lastTestStatus', () => {
    expect(isValidProviderPublicState({ ...validState, lastTestStatus: 'unknown' })).toBe(false);
  });

  it('公开状态不应包含 secret 字段', () => {
    const state = isValidProviderPublicState(validState);
    expect(state).toBe(true);
    // 确认类型定义中没有 secret 相关字段（hasApiKey 是布尔元数据，不是 secret）
    const keys = Object.keys(validState);
    const secretPatterns = /^(apiKey|keychain|authorization|secret|password)$/i;
    for (const key of keys) {
      expect(key).not.toMatch(secretPatterns);
    }
  });
});

describe('isValidConnectionTestResult', () => {
  const validResult: ConnectionTestResult = {
    success: true,
    latencyMs: 150,
    errorCode: null,
    errorMessage: null,
  };

  it('应该接受有效的测试结果', () => {
    expect(isValidConnectionTestResult(validResult)).toBe(true);
  });

  it('应该接受失败的测试结果', () => {
    expect(
      isValidConnectionTestResult({
        success: false,
        latencyMs: 200,
        errorCode: 'PROVIDER_AUTH_FAILED',
        errorMessage: '认证失败',
      }),
    ).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidConnectionTestResult(null)).toBe(false);
  });

  it('应该拒绝缺少 success 的对象', () => {
    expect(
      isValidConnectionTestResult({ latencyMs: 100, errorCode: null, errorMessage: null }),
    ).toBe(false);
  });

  it('应该拒绝 latencyMs 类型错误', () => {
    expect(isValidConnectionTestResult({ ...validResult, latencyMs: 'fast' })).toBe(false);
  });
});

describe('Grill 问题规划输入验证', () => {
  it('55. request 有效输入通过', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 3,
      }),
    ).toBe(true);
  });

  it('56. request 缺少 expectedVersion 失败', () => {
    expect(isValidGrillRequestQuestionPlanInput({ projectId: 'proj-1', sessionId: 'sess-1' })).toBe(
      false,
    );
  });

  it('57. request 畸形 id 失败', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 123,
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
    expect(isValidGrillRequestQuestionPlanInput(null)).toBe(false);
    expect(isValidGrillRequestQuestionPlanInput('str')).toBe(false);
  });

  it('accept 有效输入通过', () => {
    expect(
      isValidGrillAcceptQuestionPlanProposalInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 3,
      }),
    ).toBe(true);
  });

  it('accept 缺少 proposalId 失败', () => {
    expect(
      isValidGrillAcceptQuestionPlanProposalInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 3,
      }),
    ).toBe(false);
  });

  it('list 有效输入通过', () => {
    expect(
      isValidGrillListQuestionPlanProposalsInput({ projectId: 'proj-1', sessionId: 'sess-1' }),
    ).toBe(true);
  });

  it('list 缺少 sessionId 失败', () => {
    expect(isValidGrillListQuestionPlanProposalsInput({ projectId: 'proj-1' })).toBe(false);
  });

  it('get 有效输入通过', () => {
    expect(
      isValidGrillQuestionPlanProposalIdInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
      }),
    ).toBe(true);
  });

  it('58. get 畸形 proposalId 失败', () => {
    expect(
      isValidGrillQuestionPlanProposalIdInput({ projectId: 'proj-1', sessionId: 'sess-1' }),
    ).toBe(false);
    expect(isValidGrillQuestionPlanProposalIdInput(null)).toBe(false);
  });

  it('空字符串 ID 拒绝', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: '',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: '',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
  });

  it('纯空白 ID 拒绝', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: '   ',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: '\t\n',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
  });

  it('超长 ID 拒绝（>128 码点）', () => {
    const longId = 'x'.repeat(129);
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: longId,
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
    expect(
      isValidGrillAcceptQuestionPlanProposalInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: longId,
        expectedSessionVersion: 1,
      }),
    ).toBe(false);
  });

  it('128 码点 ID 通过', () => {
    const maxId = 'x'.repeat(128);
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: maxId,
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
      }),
    ).toBe(true);
  });

  it('NaN/Infinity 版本拒绝', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: NaN,
      }),
    ).toBe(false);
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: Infinity,
      }),
    ).toBe(false);
  });

  it('版本 0/负数/小数拒绝', () => {
    for (const v of [0, -1, 1.5]) {
      expect(
        isValidGrillRequestQuestionPlanInput({
          projectId: 'proj-1',
          sessionId: 'sess-1',
          expectedSessionVersion: v,
        }),
      ).toBe(false);
    }
  });

  it('额外字段拒绝', () => {
    expect(
      isValidGrillRequestQuestionPlanInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
        extra: 'hack',
      }),
    ).toBe(false);
    expect(
      isValidGrillAcceptQuestionPlanProposalInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
        admin: true,
      }),
    ).toBe(false);
    expect(
      isValidGrillListQuestionPlanProposalsInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        limit: 10,
      }),
    ).toBe(false);
    expect(
      isValidGrillQuestionPlanProposalIdInput({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        force: true,
      }),
    ).toBe(false);
  });
});

// ── 创作契约 DTO 验证 ──────────────────────────────────────────

const VALID_SECTIONS_PUBLIC = {
  premise: 'A story',
  genre: ['fantasy'],
  tone: ['epic'],
  targetAudience: 'adults',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: { characterKey: 'hero', name: 'Hero' },
};

describe('isValidContractPatchOperationDTO', () => {
  it('accepts valid set-scalar with string value', () => {
    expect(
      isValidContractPatchOperationDTO({ kind: 'set-scalar', path: '/premise', value: 'x' }),
    ).toBe(true);
  });

  it('accepts valid set-scalar with number value', () => {
    expect(
      isValidContractPatchOperationDTO({
        kind: 'set-scalar',
        path: '/targetLength/value',
        value: 80000,
      }),
    ).toBe(true);
  });

  it('rejects set-scalar with missing value', () => {
    expect(isValidContractPatchOperationDTO({ kind: 'set-scalar', path: '/premise' })).toBe(false);
  });

  it('accepts valid set-string-list', () => {
    expect(
      isValidContractPatchOperationDTO({
        kind: 'set-string-list',
        path: '/genre',
        value: ['fantasy'],
      }),
    ).toBe(true);
  });

  it('rejects set-string-list with non-string elements', () => {
    expect(
      isValidContractPatchOperationDTO({ kind: 'set-string-list', path: '/genre', value: [1] }),
    ).toBe(false);
  });

  it('accepts valid set-structured', () => {
    expect(
      isValidContractPatchOperationDTO({
        kind: 'set-structured',
        path: '/targetLength',
        value: { unit: 'words', value: 100 },
      }),
    ).toBe(true);
  });

  it('rejects set-structured with invalid path', () => {
    expect(
      isValidContractPatchOperationDTO({ kind: 'set-structured', path: '/premise', value: {} }),
    ).toBe(false);
  });

  it('accepts valid remove-field', () => {
    expect(isValidContractPatchOperationDTO({ kind: 'remove-field', path: '/themes' })).toBe(true);
  });

  it('accepts valid upsert-protagonist', () => {
    expect(
      isValidContractPatchOperationDTO({
        kind: 'upsert-protagonist',
        value: { characterKey: 'h', name: 'H' },
      }),
    ).toBe(true);
  });

  it('accepts valid remove-character', () => {
    expect(isValidContractPatchOperationDTO({ kind: 'remove-character', target: 'sidekick' })).toBe(
      true,
    );
  });

  it('rejects unknown kind', () => {
    expect(isValidContractPatchOperationDTO({ kind: 'unknown-op' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidContractPatchOperationDTO(null)).toBe(false);
  });
});

describe('isValidContractPatchOperationsDTO', () => {
  it('accepts valid array', () => {
    expect(
      isValidContractPatchOperationsDTO([
        { kind: 'set-scalar', path: '/premise', value: 'x' },
        { kind: 'remove-field', path: '/themes' },
      ]),
    ).toBe(true);
  });

  it('accepts empty array', () => {
    expect(isValidContractPatchOperationsDTO([])).toBe(true);
  });

  it('rejects non-array', () => {
    expect(isValidContractPatchOperationsDTO({ kind: 'set-scalar' })).toBe(false);
  });

  it('rejects array with invalid element', () => {
    expect(isValidContractPatchOperationsDTO([{ kind: 'bad' }])).toBe(false);
  });
});

describe('isValidCreationContractSectionsPublicData', () => {
  it('accepts valid sections', () => {
    expect(isValidCreationContractSectionsPublicData(VALID_SECTIONS_PUBLIC)).toBe(true);
  });

  it('rejects missing premise', () => {
    expect(
      isValidCreationContractSectionsPublicData({ ...VALID_SECTIONS_PUBLIC, premise: undefined }),
    ).toBe(false);
  });

  it('rejects missing protagonist', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { protagonist, ...rest } = VALID_SECTIONS_PUBLIC;
    expect(isValidCreationContractSectionsPublicData(rest)).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidCreationContractSectionsPublicData(null)).toBe(false);
  });
});

describe('isValidContractVersionPublicData', () => {
  const validVersion = {
    id: 'v1',
    projectId: 'p1',
    version: 1,
    schemaVersion: 1,
    sourceProposalId: null,
    basedOnGrillSessionId: null,
    basedOnGrillSessionVersion: null,
    sections: VALID_SECTIONS_PUBLIC,
    lockedFieldPaths: [],
    contractSnapshotHash: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'user',
  };

  it('accepts valid version', () => {
    expect(isValidContractVersionPublicData(validVersion)).toBe(true);
  });

  it('rejects missing id', () => {
    expect(isValidContractVersionPublicData({ ...validVersion, id: undefined })).toBe(false);
  });

  it('rejects invalid createdBy', () => {
    expect(isValidContractVersionPublicData({ ...validVersion, createdBy: 'hacker' })).toBe(false);
  });

  it('accepts all valid createdBy values', () => {
    for (const cb of ['user', 'ai-proposal-accepted', 'lock', 'unlock']) {
      expect(isValidContractVersionPublicData({ ...validVersion, createdBy: cb })).toBe(true);
    }
  });
});

describe('isValidProposalPublicData', () => {
  const validProposal = {
    id: 'prop1',
    projectId: 'p1',
    taskId: 't1',
    invocationId: 'inv1',
    status: 'PROPOSED',
    baseGrillSessionId: 'gs1',
    baseGrillSessionVersion: 1,
    baseContractVersion: null,
    schemaVersion: 1,
    sections: VALID_SECTIONS_PUBLIC,
    sectionsHash: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('accepts valid proposal', () => {
    expect(isValidProposalPublicData(validProposal)).toBe(true);
  });

  it('rejects invalid status', () => {
    expect(isValidProposalPublicData({ ...validProposal, status: 'INVALID' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidProposalPublicData(null)).toBe(false);
  });
});

describe('创作契约 mutation 输入验证', () => {
  it('accept 有效输入通过', () => {
    expect(
      isValidAcceptCreationContractProposalInput({
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'a'.repeat(64),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
      }),
    ).toBe(true);
  });

  it('accept 缺少 proposalId 失败', () => {
    expect(
      isValidAcceptCreationContractProposalInput({
        projectId: 'p1',
        expectedProposalSectionsHash: 'a'.repeat(64),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
      }),
    ).toBe(false);
  });

  it('reject 有效输入通过', () => {
    expect(
      isValidRejectCreationContractProposalInput({
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'a'.repeat(64),
      }),
    ).toBe(true);
  });

  it('lock 有效输入通过', () => {
    expect(
      isValidLockCreationContractFieldInput({
        projectId: 'p1',
        fieldPath: '/premise',
        expectedContractVersion: 1,
      }),
    ).toBe(true);
  });

  it('unlock 有效输入通过', () => {
    expect(
      isValidUnlockCreationContractFieldInput({
        projectId: 'p1',
        fieldPath: '/premise',
        expectedContractVersion: 1,
      }),
    ).toBe(true);
  });

  it('updateByUser 有效输入通过', () => {
    expect(
      isValidUpdateCreationContractByUserInput({
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'new' }],
      }),
    ).toBe(true);
  });

  it('updateByUser 无效 operations 失败', () => {
    expect(
      isValidUpdateCreationContractByUserInput({
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'bad' }],
      }),
    ).toBe(false);
  });

  it('requestProposal 有效输入通过', () => {
    expect(
      isValidRequestCreationContractProposalInput({
        projectId: 'p1',
        expectedGrillSessionVersion: 2,
      }),
    ).toBe(true);
  });

  it('requestProposal 缺少字段失败', () => {
    expect(
      isValidRequestCreationContractProposalInput({
        projectId: 'p1',
      }),
    ).toBe(false);
  });
});
