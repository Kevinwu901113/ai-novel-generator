/**
 * 代码内 allowlisted provider registry。
 *
 * 安全边界：baseUrl / model / keychainService / keychainAccount 一律来自本代码内
 * 注册表，不接受外部 JSON / CLI 参数控制（禁止任意 Keychain 选择器与任意网络端点）。
 * 值镜像 product `FIXED_PROVIDER_PROFILE`（packages/database/src/app-database.ts:481）。
 *
 * 唯一 V1 entry：mimo-token-plan-cn（MiMo V2.5 Pro，Anthropic-compatible）。
 */

import { CliUsageError } from './safe-error.js';

export interface ProviderEntry {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
}

export const PROVIDER_REGISTRY = {
  'mimo-token-plan-cn': {
    providerId: 'mimo-token-plan-cn',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    modelId: 'mimo-v2.5-pro',
    keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
    keychainAccount: 'api-key',
  },
} as const satisfies Readonly<Record<string, ProviderEntry>>;

/** CLI --provider-id 省略时的默认 provider（防止默认模型漂移）。 */
export const DEFAULT_PROVIDER_ID = 'mimo-token-plan-cn';

export function listProviderIds(): readonly string[] {
  return Object.keys(PROVIDER_REGISTRY);
}

/** 解析 provider；未知 ID 在任何 IO / 网络 / 生成之前前置拒绝。 */
export function resolveProvider(providerId: string): ProviderEntry {
  const entry = PROVIDER_REGISTRY[providerId as keyof typeof PROVIDER_REGISTRY];
  if (entry === undefined) {
    throw new CliUsageError(
      `未知 provider ID "${providerId}"；可用 provider: ${listProviderIds().join(', ')}`,
    );
  }
  return entry;
}
