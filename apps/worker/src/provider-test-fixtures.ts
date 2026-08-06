/**
 * Provider 测试夹具（B1 / D6）。
 *
 * 多 provider 之后 `ProviderProfileRepository` 端口变宽（list / getDefault / create /
 * update / delete / setDefault / getRoute / setRoute / deleteRoute / updateTestResult），
 * worker 的多个测试各自手写一份局部 fake 会持续漂移。这里提供唯一一份共用夹具：
 *
 * - `makeTestProviderProfile`：一条合法的 provider 配置（协议为 `anthropic-messages`）；
 * - `makeFakeProviderRepo`：完整实现端口的 fake —— 只有 `getById` / `list` / `getDefault` /
 *   `getRoute` 有行为，其余方法显式抛错，避免测试静默走到未预期的写路径。
 */

import type { ProviderProfileData, ProviderProfileRepository } from '@ai-novel/application';

const DEFAULT_NOW = '2026-08-06T00:00:00.000Z';

/** 构造一条测试用 provider 配置（默认即全局默认 provider） */
export function makeTestProviderProfile(
  overrides: Partial<ProviderProfileData> = {},
): ProviderProfileData {
  return {
    id: 'provider-1',
    providerType: 'anthropic-messages',
    displayName: 'Test',
    baseUrl: 'https://test.example',
    model: 'test-model',
    keychainService: 'test-service',
    keychainAccount: 'api-key',
    enabled: true,
    isDefault: true,
    createdAt: DEFAULT_NOW,
    updatedAt: DEFAULT_NOW,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
    ...overrides,
  };
}

/**
 * 完整实现 `ProviderProfileRepository` 的 fake。
 * `profile` 为 null 表示"未配置任何 provider"（用于验证 fail-closed 路径）。
 */
export function makeFakeProviderRepo(
  profile: ProviderProfileData | null = makeTestProviderProfile(),
): ProviderProfileRepository {
  const unused = (name: string): never => {
    throw new Error(`providerRepo.${name} 不应在本测试中被调用`);
  };
  return {
    getById: (id) => (profile && profile.id === id ? profile : null),
    list: () => (profile ? [profile] : []),
    getDefault: () => (profile && profile.isDefault ? profile : null),
    getRoute: () => null,
    create: () => unused('create'),
    update: () => unused('update'),
    delete: () => unused('delete'),
    setDefault: () => unused('setDefault'),
    setRoute: () => unused('setRoute'),
    deleteRoute: () => unused('deleteRoute'),
    updateTestResult: () => {},
  };
}
