/**
 * Provider 命令测试。
 *
 * 使用临时目录创建真实数据库，注入 fake SecretStore。
 * 不访问真实 Keychain。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '@ai-novel/database';
import type { SecretStore } from '@ai-novel/application';

// ── Fake SecretStore ──────────────────────────────────────────────

function createFakeSecretStore(): SecretStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    hasSecret: async (service: string, account: string) => store.has(`${service}:${account}`),
    setSecret: async (service: string, account: string, secret: string) => {
      store.set(`${service}:${account}`, secret);
    },
    getSecret: async (service: string, account: string) =>
      store.get(`${service}:${account}`) ?? null,
    deleteSecret: async (service: string, account: string) => {
      store.delete(`${service}:${account}`);
    },
  };
}

// ── Provider 用例直接测试 ─────────────────────────────────────────

import {
  getProviderState,
  saveProviderApiKey,
  deleteProviderApiKey,
  testProviderConnection,
} from '@ai-novel/application';
import type { ProviderProfileData, ProviderProfileRepository } from '@ai-novel/application';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'worker-provider-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 从数据库创建 ProviderProfileRepository 适配器 */
function createRepoAdapter(appDb: AppDatabase): ProviderProfileRepository {
  const dbRepo = appDb.getProviderProfileRepository();
  return {
    getById(id: string): ProviderProfileData | null {
      const row = dbRepo.getById(id);
      if (!row) return null;
      return {
        id: row.id,
        providerType: row.providerType,
        displayName: row.displayName,
        baseUrl: row.baseUrl,
        model: row.model,
        keychainService: row.keychainService,
        keychainAccount: row.keychainAccount,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastTestedAt: row.lastTestedAt,
        lastTestStatus: row.lastTestStatus,
        lastTestErrorCode: row.lastTestErrorCode,
        lastTestLatencyMs: row.lastTestLatencyMs,
      };
    },
    updateTestResult(
      id: string,
      result: {
        lastTestedAt: string;
        lastTestStatus: string;
        lastTestErrorCode: string | null;
        lastTestLatencyMs: number | null;
      },
    ) {
      dbRepo.updateTestResult(id, result);
    },
  };
}

const FIXED_KEYCHAIN_SERVICE = 'com.ai-novel-generator.provider.mimo-token-plan-cn';
const FIXED_KEYCHAIN_ACCOUNT = 'api-key';

describe('provider commands', () => {
  it('getState 应该返回未配置状态', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();

    const state = await getProviderState({
      providerRepo: createRepoAdapter(appDb),
      secretStore,
    });

    expect(state.id).toBe('mimo-token-plan-cn');
    expect(state.hasApiKey).toBe(false);
    expect(state.lastTestStatus).toBe('never');

    appDb.close();
  });

  it('saveApiKey + getState 应该返回已配置状态', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { apiKey: 'test-secret-not-a-real-key' },
    );

    const state = await getProviderState({ providerRepo: repo, secretStore });
    expect(state.hasApiKey).toBe(true);

    appDb.close();
  });

  it('deleteApiKey 应该返回未配置状态', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    // 先保存
    await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { apiKey: 'test-secret-not-a-real-key' },
    );

    // 删除
    const state = await deleteProviderApiKey({ providerRepo: repo, secretStore, clock });
    expect(state.hasApiKey).toBe(false);

    // 再次确认
    const state2 = await getProviderState({ providerRepo: repo, secretStore });
    expect(state2.hasApiKey).toBe(false);

    appDb.close();
  });

  it('deleteApiKey 幂等：删除不存在的 Key 不报错', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    // 没有保存过就删除
    const state = await deleteProviderApiKey({ providerRepo: repo, secretStore, clock });
    expect(state.hasApiKey).toBe(false);

    appDb.close();
  });

  it('testConnection 应该调用 gateway 并保存结果', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    // 先保存 Key
    await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { apiKey: 'test-secret-not-a-real-key' },
    );

    // 测试连接（使用 mock gateway）
    const mockTestConnection = async () => ({
      success: true,
      latencyMs: 150,
      errorCode: null,
      errorMessage: null,
    });

    const result = await testProviderConnection({
      providerRepo: repo,
      secretStore,
      clock,
      testConnection: mockTestConnection,
    });

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(150);

    // 验证测试结果已保存
    const state = await getProviderState({ providerRepo: repo, secretStore });
    expect(state.lastTestStatus).toBe('success');
    expect(state.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(state.lastTestLatencyMs).toBe(150);

    appDb.close();
  });

  it('testConnection 缺少 Key 时应抛出 API_KEY_REQUIRED', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    await expect(
      testProviderConnection({
        providerRepo: repo,
        secretStore,
        clock,
        testConnection: async () => ({
          success: true,
          latencyMs: 0,
          errorCode: null,
          errorMessage: null,
        }),
      }),
    ).rejects.toThrow(/请先配置 API Key/);

    appDb.close();
  });

  it('saveApiKey 后 secretStore 包含正确的 service/account', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { apiKey: 'test-secret-not-a-real-key' },
    );

    // 验证使用了正确的 service/account
    expect(await secretStore.hasSecret(FIXED_KEYCHAIN_SERVICE, FIXED_KEYCHAIN_ACCOUNT)).toBe(true);
    expect(await secretStore.getSecret(FIXED_KEYCHAIN_SERVICE, FIXED_KEYCHAIN_ACCOUNT)).toBe(
      'test-secret-not-a-real-key',
    );

    appDb.close();
  });

  it('provider 4 个命令都应该是可用的', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const clock = { now: () => '2024-06-15T12:00:00.000Z' };

    // 1. getState
    const state1 = await getProviderState({ providerRepo: repo, secretStore });
    expect(state1.id).toBe('mimo-token-plan-cn');

    // 2. saveApiKey
    const state2 = await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { apiKey: 'test-secret-not-a-real-key' },
    );
    expect(state2.hasApiKey).toBe(true);

    // 3. getState (确认已保存)
    const state3 = await getProviderState({ providerRepo: repo, secretStore });
    expect(state3.hasApiKey).toBe(true);

    // 4. deleteApiKey
    const state4 = await deleteProviderApiKey({ providerRepo: repo, secretStore, clock });
    expect(state4.hasApiKey).toBe(false);

    appDb.close();
  });
});
