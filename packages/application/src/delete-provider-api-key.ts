/**
 * DeleteProviderApiKey 用例。
 *
 * 按 profileId 定位 provider profile，从其 Keychain 槽位删除 API Key，清除测试状态。
 * 幂等：Key 不存在时也不报错。
 */

import type { ProviderPublicState } from '@ai-novel/contracts';
import type { SecretStore, ProviderProfileRepository, Clock } from './types.js';
import { ApiKeyDeleteFailedError, ProviderNotConfiguredError } from './errors.js';
import { toProviderPublicState } from './provider-profiles.js';

/** DeleteProviderApiKey 用例依赖 */
export interface DeleteProviderApiKeyDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
}

/**
 * 删除 API Key。
 *
 * 按 profileId 定位 profile → 从其 Keychain 槽位删除（幂等） → 清除测试状态
 * → 返回 hasApiKey=false 的公开状态。
 */
export async function deleteProviderApiKey(
  deps: DeleteProviderApiKeyDeps,
  profileId: string,
): Promise<ProviderPublicState> {
  const { providerRepo, secretStore, clock } = deps;

  const profile = providerRepo.getById(profileId);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  // 从该 profile 独立的 Keychain 槽位删除（幂等）
  try {
    await secretStore.deleteSecret(profile.keychainService, profile.keychainAccount);
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除 API Key 失败';
    throw new ApiKeyDeleteFailedError(message);
  }

  // 清除测试状态
  providerRepo.updateTestResult(profileId, {
    lastTestedAt: clock.now(),
    lastTestStatus: 'never',
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  });

  // 返回更新后的公开状态
  const updated = providerRepo.getById(profileId);
  if (!updated) {
    throw new ProviderNotConfiguredError();
  }
  return toProviderPublicState({ secretStore }, updated);
}
