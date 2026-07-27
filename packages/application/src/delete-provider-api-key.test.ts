/**
 * DeleteProviderApiKey 用例测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { deleteProviderApiKey, type DeleteProviderApiKeyDeps } from './delete-provider-api-key.js';
import type { SecretStore, ProviderProfileData, Clock } from './types.js';

const FIXED_PROFILE: ProviderProfileData = {
  id: 'mimo-token-plan-cn',
  providerType: 'anthropic-compatible',
  displayName: 'Xiaomi MiMo Token Plan CN',
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  model: 'mimo-v2.5-pro',
  keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
  keychainAccount: 'api-key',
  enabled: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  lastTestedAt: '2024-06-15T12:00:00.000Z',
  lastTestStatus: 'success',
  lastTestErrorCode: null,
  lastTestLatencyMs: 150,
};

function createMockProviderRepo(profile: ProviderProfileData = FIXED_PROFILE) {
  let currentProfile = { ...profile };
  return {
    getById: () => currentProfile,
    updateTestResult: vi.fn(
      (_id: string, result: { lastTestedAt: string; lastTestStatus: string }) => {
        currentProfile = {
          ...currentProfile,
          lastTestedAt: result.lastTestedAt,
          lastTestStatus: result.lastTestStatus,
          lastTestErrorCode: null,
          lastTestLatencyMs: null,
        };
      },
    ),
  };
}

function createMockSecretStore(): SecretStore & { deleted: boolean } {
  return {
    deleted: false,
    hasSecret: async () => false,
    setSecret: async () => {},
    getSecret: async () => null,
    deleteSecret: async () => {
      // 幂等
    },
  };
}

function createMockClock(time = '2024-06-16T00:00:00.000Z'): Clock {
  return { now: () => time };
}

function createDeps(overrides: Partial<DeleteProviderApiKeyDeps> = {}): DeleteProviderApiKeyDeps {
  return {
    providerRepo: createMockProviderRepo(),
    secretStore: createMockSecretStore(),
    clock: createMockClock(),
    ...overrides,
  };
}

describe('deleteProviderApiKey', () => {
  it('应该成功删除 API Key', async () => {
    const deps = createDeps();
    const state = await deleteProviderApiKey(deps);

    expect(state.hasApiKey).toBe(false);
  });

  it('应该清除测试状态', async () => {
    const providerRepo = createMockProviderRepo();
    const deps = createDeps({ providerRepo });

    await deleteProviderApiKey(deps);

    expect(providerRepo.updateTestResult).toHaveBeenCalledWith('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-16T00:00:00.000Z',
      lastTestStatus: 'never',
      lastTestErrorCode: null,
      lastTestLatencyMs: null,
    });
  });

  it('应该返回更新后的 lastTestStatus', async () => {
    const deps = createDeps();
    const state = await deleteProviderApiKey(deps);

    expect(state.lastTestStatus).toBe('never');
    expect(state.lastTestedAt).toBe('2024-06-16T00:00:00.000Z');
  });

  it('删除不存在的 Key 应该幂等', async () => {
    const secretStore: SecretStore = {
      hasSecret: async () => false,
      setSecret: async () => {},
      getSecret: async () => null,
      deleteSecret: async () => {
        // 不抛出，幂等
      },
    };
    const deps = createDeps({ secretStore });

    await expect(deleteProviderApiKey(deps)).resolves.not.toThrow();
    expect((await deleteProviderApiKey(deps)).hasApiKey).toBe(false);
  });

  it('profile 不存在时应抛出 PROVIDER_NOT_CONFIGURED', async () => {
    const deps = createDeps({
      providerRepo: {
        getById: () => null,
        updateTestResult: vi.fn(),
      },
    });

    await expect(deleteProviderApiKey(deps)).rejects.toThrow(/模型提供商未配置/);
  });

  it('Keychain 删除失败时应抛出 API_KEY_DELETE_FAILED', async () => {
    const failingSecretStore: SecretStore = {
      hasSecret: async () => true,
      setSecret: async () => {},
      getSecret: async () => 'test-secret',
      deleteSecret: async () => {
        throw new Error('Keychain error');
      },
    };
    const deps = createDeps({ secretStore: failingSecretStore });

    await expect(deleteProviderApiKey(deps)).rejects.toThrow(/Keychain error/);
  });
});
