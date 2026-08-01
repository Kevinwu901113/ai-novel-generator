/**
 * Provider registry 测试：默认值 / 精确固定值 / 未知 ID 前置拒绝。
 * 值锁定 product FIXED_PROVIDER_PROFILE（packages/database/src/app-database.ts:481），
 * 防止默认模型 / 端点 / Keychain 选择器漂移。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_REGISTRY,
  listProviderIds,
  resolveProvider,
} from './providers.js';
import { CliUsageError } from './safe-error.js';

describe('provider registry', () => {
  it('默认 provider 是 mimo-token-plan-cn', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('mimo-token-plan-cn');
  });

  it('mimo-token-plan-cn 的精确固定值锁定', () => {
    const entry = PROVIDER_REGISTRY['mimo-token-plan-cn'];
    expect(entry).toEqual({
      providerId: 'mimo-token-plan-cn',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      modelId: 'mimo-v2.5-pro',
      keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
      keychainAccount: 'api-key',
    });
    // 与 FIXED_PROVIDER_PROFILE（app-database.ts:481）逐字段一致
    expect(entry.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(entry.modelId).toBe('mimo-v2.5-pro');
    expect(entry.keychainService).toBe('com.ai-novel-generator.provider.mimo-token-plan-cn');
    expect(entry.keychainAccount).toBe('api-key');
  });

  it('没有任意 model / URL / Keychain 选择器入口', () => {
    // registry 只允许唯一固定 entry
    expect(listProviderIds()).toEqual(['mimo-token-plan-cn']);
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      expect(entry.modelId).toBe('mimo-v2.5-pro');
      expect(entry.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it('未知 provider ID 前置拒绝（安全消息，不泄漏）', () => {
    expect(() => resolveProvider('unknown-provider')).toThrow(CliUsageError);
    expect(() => resolveProvider('unknown-provider')).toThrow(/未知 provider ID/);
  });

  it('已知 provider ID 解析出固定配置', () => {
    const entry = resolveProvider('mimo-token-plan-cn');
    expect(entry.modelId).toBe('mimo-v2.5-pro');
    expect(entry.keychainService).toBe('com.ai-novel-generator.provider.mimo-token-plan-cn');
  });
});
