/**
 * SaveProviderApiKey 用例测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { saveProviderApiKey, type SaveProviderApiKeyDeps } from './save-provider-api-key.js';
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
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

function createMockProviderRepo(profile: ProviderProfileData | null = FIXED_PROFILE) {
  return {
    getById: () => profile,
    updateTestResult: vi.fn(),
  };
}

function createMockSecretStore(): SecretStore & {
  stored: Array<{ service: string; account: string; secret: string }>;
} {
  const stored: Array<{ service: string; account: string; secret: string }> = [];
  return {
    stored,
    hasSecret: async () => stored.length > 0,
    setSecret: async (service: string, account: string, secret: string) => {
      stored.push({ service, account, secret });
    },
    getSecret: async () => (stored.length > 0 ? stored[stored.length - 1].secret : null),
    deleteSecret: async () => {
      stored.length = 0;
    },
  };
}

function createMockClock(time = '2024-06-15T12:00:00.000Z'): Clock {
  return { now: () => time };
}

function createDeps(overrides: Partial<SaveProviderApiKeyDeps> = {}): SaveProviderApiKeyDeps {
  return {
    providerRepo: createMockProviderRepo(),
    secretStore: createMockSecretStore(),
    clock: createMockClock(),
    ...overrides,
  };
}

describe('saveProviderApiKey', () => {
  it('应该成功保存 API Key', async () => {
    const secretStore = createMockSecretStore();
    const deps = createDeps({ secretStore });

    const state = await saveProviderApiKey(deps, { apiKey: 'test-secret-not-a-real-key' });

    expect(state.hasApiKey).toBe(true);
    expect(secretStore.stored).toHaveLength(1);
    expect(secretStore.stored[0].secret).toBe('test-secret-not-a-real-key');
  });

  it('应该 trim 后保存', async () => {
    const secretStore = createMockSecretStore();
    const deps = createDeps({ secretStore });

    await saveProviderApiKey(deps, { apiKey: '  test-secret-not-a-real-key  ' });

    expect(secretStore.stored[0].secret).toBe('test-secret-not-a-real-key');
  });

  it('应该拒绝空 API Key', async () => {
    const deps = createDeps();
    await expect(saveProviderApiKey(deps, { apiKey: '' })).rejects.toThrow(/API Key 不能为空/);
  });

  it('应该拒绝纯空白 API Key', async () => {
    const deps = createDeps();
    await expect(saveProviderApiKey(deps, { apiKey: '   ' })).rejects.toThrow(/API Key 不能为空/);
  });

  it('应该拒绝超长 API Key', async () => {
    const deps = createDeps();
    const longKey = 'a'.repeat(4097);
    await expect(saveProviderApiKey(deps, { apiKey: longKey })).rejects.toThrow(/不能超过 4096/);
  });

  it('应该接受 4096 个字符的 API Key', async () => {
    const secretStore = createMockSecretStore();
    const deps = createDeps({ secretStore });
    const maxKey = 'a'.repeat(4096);

    await saveProviderApiKey(deps, { apiKey: maxKey });

    expect(secretStore.stored[0].secret).toBe(maxKey);
  });

  it('Keychain 写入失败时应抛出 API_KEY_STORE_FAILED', async () => {
    const failingSecretStore: SecretStore = {
      hasSecret: async () => false,
      setSecret: async () => {
        throw new Error('Keychain error');
      },
      getSecret: async () => null,
      deleteSecret: async () => {},
    };
    const deps = createDeps({ secretStore: failingSecretStore });

    await expect(saveProviderApiKey(deps, { apiKey: 'test-secret' })).rejects.toThrow(
      /Keychain error/,
    );
  });

  it('profile 不存在时应抛出 PROVIDER_NOT_CONFIGURED', async () => {
    const deps = createDeps({
      providerRepo: createMockProviderRepo(null),
    });

    await expect(saveProviderApiKey(deps, { apiKey: 'test-secret' })).rejects.toThrow(
      /模型提供商未配置/,
    );
  });

  it('返回的公开状态不应包含 API Key', async () => {
    const deps = createDeps();
    const state = await saveProviderApiKey(deps, { apiKey: 'test-secret-not-a-real-key' });

    const keys = Object.keys(state);
    const secretPatterns = /^(apiKey|keychain|authorization|secret|password)$/i;
    for (const key of keys) {
      expect(key).not.toMatch(secretPatterns);
    }
  });
});
