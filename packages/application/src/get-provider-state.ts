/**
 * GetProviderState 用例。
 *
 * 获取固定 MiMo 提供商的公开状态。
 * 不返回 API Key 或其他 secret。
 */

import type { ProviderPublicState } from '@ai-novel/contracts';
import type { SecretStore, ProviderProfileRepository } from './types.js';
import { ProviderNotConfiguredError } from './errors.js';

/** 固定 MiMo profile ID */
const FIXED_PROVIDER_ID = 'mimo-token-plan-cn';

/** GetProviderState 用例依赖 */
export interface GetProviderStateDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
}

/**
 * 获取提供商公开状态。
 *
 * 从 app.sqlite 读取非敏感配置，通过 SecretStore 检查 hasApiKey。
 * 返回的数据不含 API Key、Authorization 或任何 secret。
 */
export async function getProviderState(deps: GetProviderStateDeps): Promise<ProviderPublicState> {
  const { providerRepo, secretStore } = deps;

  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  const hasApiKey = await secretStore.hasSecret(profile.keychainService, profile.keychainAccount);

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
