/**
 * SaveProviderApiKey 用例。
 *
 * 验证输入、写入 Keychain、返回公开状态。
 * 不在数据库中保存 API Key 明文。
 */

import type { ProviderPublicState } from '@ai-novel/contracts';
import { unicodeCodePointLength } from '@ai-novel/domain';
import type { SecretStore, ProviderProfileRepository, Clock } from './types.js';
import { ValidationError, ApiKeyStoreFailedError, ProviderNotConfiguredError } from './errors.js';

/** 固定 MiMo profile ID */
const FIXED_PROVIDER_ID = 'mimo-token-plan-cn';

/** API Key 最大长度（Unicode code points） */
const MAX_API_KEY_LENGTH = 4096;

/** SaveProviderApiKey 用例依赖 */
export interface SaveProviderApiKeyDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
}

/** SaveProviderApiKey 输入 */
export interface SaveProviderApiKeyInput {
  readonly apiKey: string;
}

/**
 * 保存 API Key。
 *
 * 验证 → 写入 Keychain → 返回新的公开状态。
 * 失败时不改变数据库测试状态。
 */
export async function saveProviderApiKey(
  deps: SaveProviderApiKeyDeps,
  input: SaveProviderApiKeyInput,
): Promise<ProviderPublicState> {
  const { providerRepo, secretStore } = deps;

  // 验证输入
  const trimmed = input.apiKey.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('API Key 不能为空');
  }
  if (unicodeCodePointLength(trimmed) > MAX_API_KEY_LENGTH) {
    throw new ValidationError(`API Key 不能超过 ${MAX_API_KEY_LENGTH} 个字符`);
  }

  // 获取固定 profile
  const profile = providerRepo.getById(FIXED_PROVIDER_ID);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  // 写入 Keychain
  try {
    await secretStore.setSecret(profile.keychainService, profile.keychainAccount, trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : '存储 API Key 失败';
    throw new ApiKeyStoreFailedError(message);
  }

  // 返回新的公开状态
  return {
    id: profile.id,
    displayName: profile.displayName,
    providerType: profile.providerType as ProviderPublicState['providerType'],
    baseUrl: profile.baseUrl,
    model: profile.model,
    enabled: profile.enabled,
    hasApiKey: true,
    lastTestedAt: profile.lastTestedAt,
    lastTestStatus: (profile.lastTestStatus ?? 'never') as ProviderPublicState['lastTestStatus'],
    lastTestErrorCode: profile.lastTestErrorCode,
    lastTestLatencyMs: profile.lastTestLatencyMs,
  };
}
