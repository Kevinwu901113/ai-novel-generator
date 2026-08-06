/**
 * TestProviderConnection 用例。
 *
 * 按 profileId 定位 provider profile，从其 Keychain 槽位临时读取 API Key，
 * 调用 Model Gateway（按该 profile 的协议）测试连接，保存测试结果，
 * 返回清理后的结果。无论成功失败，都确保不把 Key 留在长期状态。
 */

import type { ConnectionTestResult, ProviderProtocol } from '@ai-novel/contracts';
import { isProviderProtocol } from '@ai-novel/contracts';
import type { SecretStore, ProviderProfileRepository, Clock } from './types.js';
import {
  ApiKeyRequiredError,
  ApiKeyReadFailedError,
  ProviderNotConfiguredError,
} from './errors.js';

/** TestProviderConnection 用例依赖 */
export interface TestProviderConnectionDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
  readonly testConnection: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    protocol: ProviderProtocol;
  }) => Promise<{
    success: boolean;
    latencyMs: number;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
}

/**
 * 测试提供商连接。
 *
 * 1. 按 profileId 获取 profile
 * 2. 从其 Keychain 槽位临时读取 API Key
 * 3. 缺少 Key → throw API_KEY_REQUIRED
 * 4. 调用 model gateway（传入该 profile 的协议）
 * 5. 保存测试结果到 repo
 * 6. 不保存上游完整响应
 * 7. 返回清理后的 ConnectionTestResult
 */
export async function testProviderConnection(
  deps: TestProviderConnectionDeps,
  profileId: string,
): Promise<ConnectionTestResult> {
  const { providerRepo, secretStore, clock, testConnection: doTest } = deps;

  // 1. 按 profileId 获取 profile
  const profile = providerRepo.getById(profileId);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }
  if (!isProviderProtocol(profile.providerType)) {
    throw new ProviderNotConfiguredError();
  }
  const protocol = profile.providerType;

  // 2. 从该 profile 独立的 Keychain 槽位临时读取 API Key
  let apiKey: string | null;
  try {
    apiKey = await secretStore.getSecret(profile.keychainService, profile.keychainAccount);
  } catch (err) {
    const message = err instanceof Error ? err.message : '读取 API Key 失败';
    throw new ApiKeyReadFailedError(message);
  }

  // 3. 缺少 Key
  if (!apiKey) {
    throw new ApiKeyRequiredError();
  }

  // 4. 调用 model gateway
  let result: {
    success: boolean;
    latencyMs: number;
    errorCode: string | null;
    errorMessage: string | null;
  };

  try {
    result = await doTest({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      protocol,
    });
  } catch {
    // 确保异常也被记录
    const now = clock.now();
    providerRepo.updateTestResult(profileId, {
      lastTestedAt: now,
      lastTestStatus: 'failed',
      lastTestErrorCode: 'PROVIDER_CONNECTION_FAILED',
      lastTestLatencyMs: null,
    });
    throw new Error('连接测试失败');
  } finally {
    // apiKey 是临时变量，函数返回后自然离开作用域
    // 不缓存到模块级全局变量
  }

  // 5. 保存测试结果到 repo
  const now = clock.now();
  providerRepo.updateTestResult(profileId, {
    lastTestedAt: now,
    lastTestStatus: result.success ? 'success' : 'failed',
    lastTestErrorCode: result.errorCode,
    lastTestLatencyMs: result.latencyMs,
  });

  // 6. 返回清理后的结果（不包含上游完整响应）
  return {
    success: result.success,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}
