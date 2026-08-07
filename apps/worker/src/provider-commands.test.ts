/**
 * Provider 命令测试（B1 多 provider，D6）。
 *
 * 使用临时目录创建真实数据库，注入 fake SecretStore。
 * 不访问真实 Keychain。覆盖新的 8 个 provider 用例：
 * list / create / update / delete / setDefault / saveApiKey / deleteApiKey / testConnection。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '@ai-novel/database';
import type { SecretStore } from '@ai-novel/application';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  saveProviderApiKey,
  deleteProviderApiKey,
  testProviderConnection,
  ProviderNotConfiguredError,
} from '@ai-novel/application';
import type { ProviderProfileData, ProviderProfileRepository } from '@ai-novel/application';

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

// ── ProviderProfileRepository 适配器（与 apps/worker/src/index.ts 内实现等价）──

function createRepoAdapter(appDb: AppDatabase): ProviderProfileRepository {
  const dbRepo = appDb.getProviderProfileRepository();
  const toAppData = (row: {
    id: string;
    providerType: string;
    displayName: string;
    baseUrl: string;
    model: string;
    keychainService: string;
    keychainAccount: string;
    enabled: boolean;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    lastTestErrorCode: string | null;
    lastTestLatencyMs: number | null;
  }): ProviderProfileData => ({
    id: row.id,
    providerType: row.providerType,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    model: row.model,
    keychainService: row.keychainService,
    keychainAccount: row.keychainAccount,
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus: row.lastTestStatus,
    lastTestErrorCode: row.lastTestErrorCode,
    lastTestLatencyMs: row.lastTestLatencyMs,
  });

  return {
    getById: (id: string) => {
      const row = dbRepo.getById(id);
      return row ? toAppData(row) : null;
    },
    list: () => dbRepo.list().map(toAppData),
    getDefault: () => {
      const row = dbRepo.getDefault();
      return row ? toAppData(row) : null;
    },
    create: (data) => dbRepo.create(data),
    update: (data) => dbRepo.update(data),
    delete: (id: string) => dbRepo.delete(id),
    setDefault: (id: string) => dbRepo.setDefault(id),
    getRoute: (taskType: string) => dbRepo.getRoute(taskType),
    setRoute: (taskType: string, profileId: string, updatedAt: string) =>
      dbRepo.setRoute(taskType, profileId, updatedAt),
    deleteRoute: (taskType: string) => dbRepo.deleteRoute(taskType),
    updateTestResult: (
      id: string,
      result: {
        lastTestedAt: string;
        lastTestStatus: string;
        lastTestErrorCode: string | null;
        lastTestLatencyMs: number | null;
      },
    ) => dbRepo.updateTestResult(id, result),
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'worker-provider-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 迁移历史遗留：新建 app.sqlite 仍会自动灌入一条 mimo-token-plan-cn 默认 profile。 */
const SEEDED_PROVIDER_ID = 'mimo-token-plan-cn';

const idGenerator = { generate: (): string => 'new-provider-id' };
const clock = { now: (): string => '2024-06-15T12:00:00.000Z' };

describe('provider commands（8 个新命令）', () => {
  it('list 应该返回数组（至少包含迁移灌入的默认 provider）', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    const list = await listProviders({ providerRepo: repo, secretStore, idGenerator, clock });

    expect(Array.isArray(list)).toBe(true);
    expect(list.some((p) => p.id === SEEDED_PROVIDER_ID)).toBe(true);

    appDb.close();
  });

  it('create 入参应该透传到返回的公开状态', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    const created = await createProvider(
      { providerRepo: repo, secretStore, idGenerator, clock },
      {
        label: '自定义 Provider',
        protocol: 'openai-chat',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-test',
      },
    );

    expect(created.id).toBe('new-provider-id');
    expect(created.label).toBe('自定义 Provider');
    expect(created.protocol).toBe('openai-chat');
    expect(created.baseUrl).toBe('https://example.com/v1');
    expect(created.model).toBe('gpt-test');
    expect(created.hasApiKey).toBe(false);

    appDb.close();
  });

  it('update 入参应该透传到返回的公开状态', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    const updated = await updateProvider(
      { providerRepo: repo, secretStore, idGenerator, clock },
      {
        profileId: SEEDED_PROVIDER_ID,
        label: '改名后的 Provider',
        protocol: 'anthropic-messages',
        baseUrl: 'https://new-base-url.example.com',
        model: 'new-model',
        enabled: false,
      },
    );

    expect(updated.id).toBe(SEEDED_PROVIDER_ID);
    expect(updated.label).toBe('改名后的 Provider');
    expect(updated.baseUrl).toBe('https://new-base-url.example.com');
    expect(updated.model).toBe('new-model');
    expect(updated.enabled).toBe(false);

    appDb.close();
  });

  it('delete 应该返回刷新后的列表，且被删的 id 不再出现', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    const list = await deleteProvider(
      { providerRepo: repo, secretStore, idGenerator, clock },
      SEEDED_PROVIDER_ID,
    );

    expect(Array.isArray(list)).toBe(true);
    expect(list.some((p) => p.id === SEEDED_PROVIDER_ID)).toBe(false);

    appDb.close();
  });

  it('setDefault 应该返回刷新后的列表，且目标 profile isDefault 为 true', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    // 新建第二个 profile，再把它设为默认
    const created = await createProvider(
      { providerRepo: repo, secretStore, idGenerator: { generate: () => 'second-provider' }, clock },
      {
        label: '第二个 Provider',
        protocol: 'openai-chat',
        baseUrl: 'https://second.example.com',
        model: 'model-2',
      },
    );

    const list = await setDefaultProvider(
      { providerRepo: repo, secretStore, idGenerator, clock },
      created.id,
    );

    const target = list.find((p) => p.id === created.id);
    const original = list.find((p) => p.id === SEEDED_PROVIDER_ID);
    expect(target?.isDefault).toBe(true);
    expect(original?.isDefault).toBe(false);

    appDb.close();
  });

  it('saveApiKey / deleteApiKey 应该按 profileId 定位', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    const saved = await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { profileId: SEEDED_PROVIDER_ID, apiKey: 'test-secret-not-a-real-key' },
    );
    expect(saved.hasApiKey).toBe(true);

    const afterList = await listProviders({ providerRepo: repo, secretStore, idGenerator, clock });
    expect(afterList.find((p) => p.id === SEEDED_PROVIDER_ID)?.hasApiKey).toBe(true);

    const deleted = await deleteProviderApiKey({ providerRepo: repo, secretStore, clock }, SEEDED_PROVIDER_ID);
    expect(deleted.hasApiKey).toBe(false);

    appDb.close();
  });

  it('testConnection 应该返回 ConnectionTestResult 并保存测试结果', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);

    await saveProviderApiKey(
      { providerRepo: repo, secretStore, clock },
      { profileId: SEEDED_PROVIDER_ID, apiKey: 'test-secret-not-a-real-key' },
    );

    const result = await testProviderConnection(
      {
        providerRepo: repo,
        secretStore,
        clock,
        testConnection: async () => ({
          success: true,
          latencyMs: 150,
          errorCode: null,
          errorMessage: null,
        }),
      },
      SEEDED_PROVIDER_ID,
    );

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(150);
    expect(typeof result).toBe('object');

    const list = await listProviders({ providerRepo: repo, secretStore, idGenerator, clock });
    const profile = list.find((p) => p.id === SEEDED_PROVIDER_ID);
    expect(profile?.lastTestStatus).toBe('success');
    expect(profile?.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(profile?.lastTestLatencyMs).toBe(150);

    appDb.close();
  });

  it('未知/不存在 profileId 的既有错误语义保持不变：ProviderNotConfiguredError', async () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const secretStore = createFakeSecretStore();
    const repo = createRepoAdapter(appDb);
    const deps = { providerRepo: repo, secretStore, idGenerator, clock };

    await expect(
      updateProvider(deps, {
        profileId: 'no-such-provider',
        label: 'x',
        protocol: 'openai-chat',
        baseUrl: 'https://x',
        model: 'x',
        enabled: true,
      }),
    ).rejects.toThrow(ProviderNotConfiguredError);

    await expect(deleteProvider(deps, 'no-such-provider')).rejects.toThrow(
      ProviderNotConfiguredError,
    );

    await expect(setDefaultProvider(deps, 'no-such-provider')).rejects.toThrow(
      ProviderNotConfiguredError,
    );

    await expect(
      saveProviderApiKey(
        { providerRepo: repo, secretStore, clock },
        { profileId: 'no-such-provider', apiKey: 'k' },
      ),
    ).rejects.toThrow(ProviderNotConfiguredError);

    await expect(
      deleteProviderApiKey({ providerRepo: repo, secretStore, clock }, 'no-such-provider'),
    ).rejects.toThrow(ProviderNotConfiguredError);

    await expect(
      testProviderConnection(
        {
          providerRepo: repo,
          secretStore,
          clock,
          testConnection: async () => ({
            success: true,
            latencyMs: 0,
            errorCode: null,
            errorMessage: null,
          }),
        },
        'no-such-provider',
      ),
    ).rejects.toThrow(ProviderNotConfiguredError);

    appDb.close();
  });
});
