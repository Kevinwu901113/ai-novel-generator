/**
 * SaveProviderApiKey 用例。
 *
 * 按 profileId 定位 provider profile，验证输入、写入 Keychain（每 profile 独立槽位），
 * 返回公开状态。不在数据库中保存 API Key 明文。
 */

import type { ProviderPublicState, SaveApiKeyInput } from '@ai-novel/contracts';
import { unicodeCodePointLength } from '@ai-novel/domain';
import type { SecretStore, ProviderProfileRepository, Clock } from './types.js';
import { ValidationError, ApiKeyStoreFailedError, ProviderNotConfiguredError } from './errors.js';
import { toProviderPublicState } from './provider-profiles.js';

/** API Key 最大长度（Unicode code points） */
const MAX_API_KEY_LENGTH = 4096;

/** SaveProviderApiKey 用例依赖 */
export interface SaveProviderApiKeyDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly clock: Clock;
}

/**
 * 保存 API Key。
 *
 * 验证 → 按 profileId 定位 profile → 写入该 profile 的 Keychain 槽位 → 返回新的公开状态。
 * 失败时不改变数据库测试状态。
 */
export async function saveProviderApiKey(
  deps: SaveProviderApiKeyDeps,
  input: SaveApiKeyInput,
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

  // 按 profileId 定位 profile
  const profile = providerRepo.getById(input.profileId);
  if (!profile) {
    throw new ProviderNotConfiguredError();
  }

  // 写入该 profile 独立的 Keychain 槽位
  try {
    await secretStore.setSecret(profile.keychainService, profile.keychainAccount, trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : '存储 API Key 失败';
    throw new ApiKeyStoreFailedError(message);
  }

  // 返回新的公开状态
  return toProviderPublicState({ secretStore }, profile);
}
