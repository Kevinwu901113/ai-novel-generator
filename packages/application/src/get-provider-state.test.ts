/**
 * GetProviderState 用例测试。
 */

import { describe, it, expect } from 'vitest';
import { getProviderState, type GetProviderStateDeps } from './get-provider-state.js';
import type { SecretStore, ProviderProfileRepository, ProviderProfileData } from './types.js';

// ── Mock ──────────────────────────────────────────────────────────

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
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

function createMockProviderRepo(
  profile: ProviderProfileData | null = FIXED_PROFILE,
): ProviderProfileRepository {
  return {
    getById: () => profile,
    updateTestResult: () => {},
  };
}

function createMockSecretStore(hasKey = false): SecretStore {
  return {
    hasSecret: async () => hasKey,
    setSecret: async () => {},
    getSecret: async () => (hasKey ? 'test-secret' : null),
    deleteSecret: async () => {},
  };
}

function createDeps(overrides: Partial<GetProviderStateDeps> = {}): GetProviderStateDeps {
  return {
    providerRepo: createMockProviderRepo(),
    secretStore: createMockSecretStore(),
    ...overrides,
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('getProviderState', () => {
  it('应该返回提供商公开状态（未配置 Key）', async () => {
    const deps = createDeps({ secretStore: createMockSecretStore(false) });
    const state = await getProviderState(deps);

    expect(state.id).toBe('mimo-token-plan-cn');
    expect(state.displayName).toBe('Xiaomi MiMo Token Plan CN');
    expect(state.providerType).toBe('anthropic-compatible');
    expect(state.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(state.model).toBe('mimo-v2.5-pro');
    expect(state.enabled).toBe(true);
    expect(state.hasApiKey).toBe(false);
    expect(state.lastTestStatus).toBe('never');
  });

  it('应该返回 hasApiKey=true（已配置 Key）', async () => {
    const deps = createDeps({ secretStore: createMockSecretStore(true) });
    const state = await getProviderState(deps);

    expect(state.hasApiKey).toBe(true);
  });

  it('应该返回测试结果', async () => {
    const profileWithTest: ProviderProfileData = {
      ...FIXED_PROFILE,
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'success',
      lastTestLatencyMs: 150,
    };
    const deps = createDeps({
      providerRepo: createMockProviderRepo(profileWithTest),
      secretStore: createMockSecretStore(true),
    });
    const state = await getProviderState(deps);

    expect(state.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(state.lastTestStatus).toBe('success');
    expect(state.lastTestLatencyMs).toBe(150);
  });

  it('profile 不存在时应抛出 PROVIDER_NOT_CONFIGURED', async () => {
    const deps = createDeps({
      providerRepo: createMockProviderRepo(null),
    });

    await expect(getProviderState(deps)).rejects.toThrow(/模型提供商未配置/);
  });

  it('返回的状态不应包含 secret 字段', async () => {
    const deps = createDeps({ secretStore: createMockSecretStore(true) });
    const state = await getProviderState(deps);

    const keys = Object.keys(state);
    const secretPatterns = /^(apiKey|keychain|authorization|secret|password)$/i;
    for (const key of keys) {
      expect(key).not.toMatch(secretPatterns);
    }
  });
});
