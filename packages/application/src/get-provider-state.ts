/**
 * GetProviderState 用例。
 *
 * 获取固定 MiMo 提供商的公开状态。
 * 不返回 API Key 或其他 secret。
 */

import type { ProviderPublicState } from '@ai-novel/contracts';
import type { SecretStore, ProviderProfileRepository } from './types.js';
import { ApiKeyReadFailedError, ProviderNotConfiguredError } from './errors.js';

const FIXED_PROVIDER_ID = 'mimo-token-plan-cn';

export interface GetProviderStateDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
}

export async function getProviderState(deps: GetProviderStateDeps): Promise<ProviderPublicState> {
  const { providerRepo, secretStore } = deps;

  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  let hasApiKey: boolean;
  try {
    hasApiKey = await secretStore.hasSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    // Keychain 故障不能伪装成“尚未配置”。
    throw new ApiKeyReadFailedError('无法读取 API Key 配置状态');
  }

  return {
    id: profile.id,
    displayName: profile.displayName,
    providerType: profile.providerType as ProviderPublicState['providerType'],
    baseUrl: profile.baseUrl,
    model: profile.model,
    enabled: profile.enabled,
    hasApiKey,
    lastTestedAt: profile.lastTestedAt,
    lastTestStatus: (profile.lastTestStatus ?? 'never') as ProviderPublicState['lastTestStatus'],
    lastTestErrorCode: profile.lastTestErrorCode,
    lastTestLatencyMs: profile.lastTestLatencyMs,
  };
}
