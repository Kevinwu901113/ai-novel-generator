/**
 * TestProviderConnection 用例测试。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  testProviderConnection,
  type TestProviderConnectionDeps,
} from './test-provider-connection.js';
import type { SecretStore, ProviderProfileData, Clock } from './types.js';

const FIXED_PROFILE: ProviderProfileData = {
  id: 'mimo-token-plan-cn',
  providerType: 'anthropic-messages',
  displayName: 'Xiaomi MiMo Token Plan CN',
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  model: 'mimo-v2.5-pro',
  keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
  keychainAccount: 'api-key',
  enabled: true,
  isDefault: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

function createMockProviderRepo(initial: ProviderProfileData = FIXED_PROFILE) {
  let profile: ProviderProfileData = { ...initial };
  return {
    getById: () => profile,
    list: () => [profile],
    getDefault: () => (profile.isDefault ? profile : null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(() => true),
    setDefault: vi.fn(() => true),
    getRoute: () => null,
    setRoute: vi.fn(),
    deleteRoute: vi.fn(),
    updateTestResult: vi.fn(
      (
        _id: string,
        result: {
          lastTestedAt: string;
          lastTestStatus: string;
          lastTestErrorCode: string | null;
          lastTestLatencyMs: number | null;
        },
      ) => {
        profile = {
          ...profile,
          lastTestedAt: result.lastTestedAt,
          lastTestStatus: result.lastTestStatus,
          lastTestErrorCode: result.lastTestErrorCode,
          lastTestLatencyMs: result.lastTestLatencyMs,
        };
      },
    ),
  };
}

function createMockSecretStore(hasKey = true): SecretStore {
  return {
    hasSecret: async () => hasKey,
    setSecret: async () => {},
    getSecret: async () => (hasKey ? 'test-secret-not-a-real-key' : null),
    deleteSecret: async () => {},
  };
}

function createMockClock(time = '2024-06-15T12:00:00.000Z'): Clock {
  return { now: () => time };
}

function createMockTestConnection(
  result: {
    success: boolean;
    latencyMs: number;
    errorCode: string | null;
    errorMessage: string | null;
  } = {
    success: true,
    latencyMs: 150,
    errorCode: null,
    errorMessage: null,
  },
) {
  return vi.fn().mockResolvedValue(result);
}

function createDeps(
  overrides: Partial<TestProviderConnectionDeps> = {},
): TestProviderConnectionDeps {
  return {
    providerRepo: createMockProviderRepo(),
    secretStore: createMockSecretStore(),
    clock: createMockClock(),
    testConnection: createMockTestConnection(),
    ...overrides,
  };
}

describe('testProviderConnection', () => {
  it('应该成功测试连接', async () => {
    const deps = createDeps();
    const result = await testProviderConnection(deps, 'mimo-token-plan-cn');

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(150);
    expect(result.errorCode).toBeNull();
  });

  it('应该保存成功测试结果到 repo', async () => {
    const providerRepo = createMockProviderRepo();
    const deps = createDeps({ providerRepo });

    await testProviderConnection(deps, 'mimo-token-plan-cn');

    expect(providerRepo.updateTestResult).toHaveBeenCalledWith('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'success',
      lastTestErrorCode: null,
      lastTestLatencyMs: 150,
    });
  });

  it('应该保存失败测试结果到 repo', async () => {
    const providerRepo = createMockProviderRepo();
    const testConn = createMockTestConnection({
      success: false,
      latencyMs: 200,
      errorCode: 'PROVIDER_AUTH_FAILED',
      errorMessage: '认证失败',
    });
    const deps = createDeps({ providerRepo, testConnection: testConn });

    const result = await testProviderConnection(deps, 'mimo-token-plan-cn');

    expect(result.success).toBe(false);
    expect(providerRepo.updateTestResult).toHaveBeenCalledWith('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'failed',
      lastTestErrorCode: 'PROVIDER_AUTH_FAILED',
      lastTestLatencyMs: 200,
    });
  });

  it('缺少 Key 时应抛出 API_KEY_REQUIRED', async () => {
    const deps = createDeps({ secretStore: createMockSecretStore(false) });

    await expect(testProviderConnection(deps, 'mimo-token-plan-cn')).rejects.toThrow(
      /请先配置 API Key/,
    );
  });

  it('Keychain 读取失败时应抛出 API_KEY_READ_FAILED', async () => {
    const failingSecretStore: SecretStore = {
      hasSecret: async () => true,
      setSecret: async () => {},
      getSecret: async () => {
        throw new Error('Keychain read error');
      },
      deleteSecret: async () => {},
    };
    const deps = createDeps({ secretStore: failingSecretStore });

    await expect(testProviderConnection(deps, 'mimo-token-plan-cn')).rejects.toThrow(
      /Keychain read error/,
    );
  });

  it('profile 不存在时应抛出 PROVIDER_NOT_CONFIGURED', async () => {
    const deps = createDeps({
      providerRepo: { ...createMockProviderRepo(), getById: () => null },
    });

    await expect(testProviderConnection(deps, 'missing')).rejects.toThrow(/模型提供商未配置/);
  });

  it('应该使用 profile 中的 baseUrl、model 与 protocol（anthropic-messages）', async () => {
    const testConn = createMockTestConnection();
    const deps = createDeps({ testConnection: testConn });

    await testProviderConnection(deps, 'mimo-token-plan-cn');

    expect(testConn).toHaveBeenCalledWith({
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      model: 'mimo-v2.5-pro',
      apiKey: 'test-secret-not-a-real-key',
      protocol: 'anthropic-messages',
    });
  });

  it('应该把 openai-chat 协议正确传给网关', async () => {
    const openAiProfile: ProviderProfileData = {
      ...FIXED_PROFILE,
      id: 'openai-profile',
      providerType: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      keychainService: 'com.ai-novel-generator.provider.openai-profile',
    };
    const testConn = createMockTestConnection();
    const deps = createDeps({
      providerRepo: createMockProviderRepo(openAiProfile),
      testConnection: testConn,
    });

    await testProviderConnection(deps, 'openai-profile');

    expect(testConn).toHaveBeenCalledWith({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'test-secret-not-a-real-key',
      protocol: 'openai-chat',
    });
  });

  it('返回结果不应包含 API Key', async () => {
    const deps = createDeps();
    const result = await testProviderConnection(deps, 'mimo-token-plan-cn');

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('test-secret-not-a-real-key');
  });

  it('testConnection 异常时应保存失败结果并抛出', async () => {
    const providerRepo = createMockProviderRepo();
    const failingTestConn = vi.fn().mockRejectedValue(new Error('Network error'));
    const deps = createDeps({ providerRepo, testConnection: failingTestConn });

    await expect(testProviderConnection(deps, 'mimo-token-plan-cn')).rejects.toThrow();

    expect(providerRepo.updateTestResult).toHaveBeenCalledWith('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'failed',
      lastTestErrorCode: 'PROVIDER_CONNECTION_FAILED',
      lastTestLatencyMs: null,
    });
  });
});
