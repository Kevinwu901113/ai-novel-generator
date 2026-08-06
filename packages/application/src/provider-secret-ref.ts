/**
 * Provider secretRef（B1 / D6）。
 *
 * D6 要求"每 profile 一个 key 槽位"。槽位即 Keychain 的 (service, account) 二元组，
 * 由 profile id 确定性派生 —— 数据库只存这两个非敏感字段，API Key 本身永不入库、
 * 不进项目备份、不经 IPC 返回。
 *
 * 派生规则固定为：
 *   service = `com.ai-novel-generator.provider.<profileId>`
 *   account = `api-key`
 *
 * 该规则与迁移前既有 MiMo profile 的槽位完全一致
 * （`com.ai-novel-generator.provider.mimo-token-plan-cn` / `api-key`），
 * 因此迁移后原有 Key 继续可读，用户无需重新录入。
 *
 * profile id 由系统生成（不接受 Renderer 提供），此处仍做一次字符集校验，
 * 确保派生出的 service 名不会被意外注入分隔符或空白。
 */

const SERVICE_PREFIX = 'com.ai-novel-generator.provider.';
const ACCOUNT = 'api-key';

/** Keychain 槽位引用（数据库中持久化的非敏感字段） */
export interface ProviderSecretRef {
  readonly service: string;
  readonly account: string;
}

/** profile id 合法字符集：仅小写字母、数字、连字符（系统生成的 id 形态） */
export function isValidProviderProfileId(profileId: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId);
}

/**
 * 由 profile id 派生 Keychain 槽位。
 * id 非法时抛错而不是拼出一个可疑的 service 名（fail-closed）。
 */
export function secretRefForProfile(profileId: string): ProviderSecretRef {
  if (!isValidProviderProfileId(profileId)) {
    throw new Error('非法的 provider profile id');
  }
  return { service: `${SERVICE_PREFIX}${profileId}`, account: ACCOUNT };
}
