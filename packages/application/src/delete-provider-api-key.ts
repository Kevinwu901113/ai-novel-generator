/**
 * DeleteProviderApiKey 用例。
 *
 * 从 Keychain 删除 API Key，清除测试状态。
 * 幂等：Key 不存在时也不报错。
 */

import type { ProviderPublicState } from '@ai-novel/contracts';
import type { SecretStore, ProviderProfileRepository, Clock } from './types.js';
import { ApiKeyDeleteFailedError, ProviderNotConfiguredError } from './errors.js';

/** 固定 MiMo profile ID */
const FIXED_PROVIDER_ID = 'mimo-token-plan-cn';

/** DeleteProviderApiKey 用例依赖 */
export interface DeleteProviderApiKeyDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
}

/**
 * 删除 API Key。
 *
 * 从 Keychain 删除 → 清除测试状态 → 返回 hasApiKey=false。
 * 幂等：Key 不存在时也不报错。
 */
export async function deleteProviderApiKey(
  deps: DeleteProviderApiKeyDeps,
): Promise<ProviderPublicState> {
  const { providerRepo, secretStore, clock } = deps;

  // 获取固定 profile
  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  // 从 Keychain 删除（幂等）
  try {
    await secretStore.deleteSecret(profile.keychainService, profile.keychainAccount);
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除 API Key 失败';
    throw new ApiKeyDeleteFailedError(message);
  }

  // 清除测试状态
  providerRepo.updateTestResult(FIXED_PROVIDER_ID, {
    lastTestedAt: clock.now(),
    lastTestStatus: 'never',
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  });

  // 返回更新后的公开状态
  const updated = providerRepo.getById(FIXED_PROVIDER_ID);
  return {
    id: updated?.id ?? profile.id,
    displayName: updated?.displayName ?? profile.displayName,
    providerType: (updated?.providerType ??
      profile.providerType) as ProviderPublicState['providerType'],
    baseUrl: updated?.baseUrl ?? profile.baseUrl,
    model: updated?.model ?? profile.model,
    enabled: updated?.enabled ?? profile.enabled,
    hasApiKey: false,
    lastTestedAt: updated?.lastTestedAt ?? null,
    lastTestStatus: (updated?.lastTestStatus ?? 'never') as ProviderPublicState['lastTestStatus'],
    lastTestErrorCode: updated?.lastTestErrorCode ?? null,
    lastTestLatencyMs: updated?.lastTestLatencyMs ?? null,
  };
}
