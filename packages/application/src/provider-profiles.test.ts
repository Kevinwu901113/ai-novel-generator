/**
 * Provider Profile 用例测试（B1 多 provider，D6）。
 */

import { describe, it, expect } from 'vitest';
import {
  toProviderPublicState,
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  resolveProviderForTask,
  type ProviderProfileDeps,
} from './provider-profiles.js';
import type {
  SecretStore,
  ProviderProfileData,
  ProviderProfileRepository,
  CreateProviderProfileData,
  UpdateProviderProfileData,
  IdGenerator,
  Clock,
} from './types.js';
import type { CreateProviderProfileInput, UpdateProviderProfileInput } from '@ai-novel/contracts';

function makeProfile(overrides: Partial<ProviderProfileData> = {}): ProviderProfileData {
  return {
    id: 'profile-a',
    providerType: 'anthropic-messages',
    displayName: 'Profile A',
    baseUrl: 'https://a.example.com',
    model: 'model-a',
    keychainService: 'com.ai-novel-generator.provider.profile-a',
    keychainAccount: 'api-key',
    enabled: true,
    isDefault: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
    ...overrides,
  };
}

/** 内存 provider profile 仓库 fake —— 模拟 D6 约束（至多一条默认、原子设置）。 */
class FakeProviderProfileRepo implements ProviderProfileRepository {
  private readonly profiles = new Map<string, ProviderProfileData>();
  private readonly routes = new Map<string, string>();

  seed(profile: ProviderProfileData): void {
    this.profiles.set(profile.id, profile);
  }

  getById(id: string): ProviderProfileData | null {
    return this.profiles.get(id) ?? null;
  }

  list(): ReadonlyArray<ProviderProfileData> {
    return [...this.profiles.values()];
  }

  getDefault(): ProviderProfileData | null {
    return [...this.profiles.values()].find((p) => p.isDefault) ?? null;
  }

  create(data: CreateProviderProfileData): void {
    this.profiles.set(data.id, {
      ...data,
      isDefault: false,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestErrorCode: null,
      lastTestLatencyMs: null,
    });
  }

  update(data: UpdateProviderProfileData): void {
    const existing = this.profiles.get(data.id);
    if (!existing) return;
    this.profiles.set(data.id, {
      ...existing,
      providerType: data.providerType,
      displayName: data.displayName,
      baseUrl: data.baseUrl,
      model: data.model,
      enabled: data.enabled,
      updatedAt: data.updatedAt,
    });
  }

  delete(id: string): boolean {
    this.routes.forEach((profileId, taskType) => {
      if (profileId === id) this.routes.delete(taskType);
    });
    return this.profiles.delete(id);
  }

  setDefault(id: string): boolean {
    if (!this.profiles.has(id)) return false;
    for (const [key, value] of this.profiles) {
      this.profiles.set(key, { ...value, isDefault: key === id });
    }
    return true;
  }

  getRoute(taskType: string): string | null {
    return this.routes.get(taskType) ?? null;
  }

  setRoute(taskType: string, profileId: string, _updatedAt: string): void {
    this.routes.set(taskType, profileId);
  }

  deleteRoute(taskType: string): void {
    this.routes.delete(taskType);
  }

  updateTestResult(
    id: string,
    result: {
      lastTestedAt: string;
      lastTestStatus: string;
      lastTestErrorCode: string | null;
      lastTestLatencyMs: number | null;
    },
  ): void {
    const existing = this.profiles.get(id);
    if (!existing) return;
    this.profiles.set(id, { ...existing, ...result });
  }
}

/** 内存 SecretStore fake —— 按 (service, account) 隔离，验证每 profile 独立槽位。 */
function createFakeSecretStore(
  failHasSecret = false,
): SecretStore & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  const key = (service: string, account: string): string => `${service}::${account}`;
  return {
    store,
    hasSecret: async (service, account) => {
      if (failHasSecret) throw new Error('keychain unavailable');
      return store.has(key(service, account));
    },
    setSecret: async (service, account, secret) => {
      store.set(key(service, account), secret);
    },
    getSecret: async (service, account) => store.get(key(service, account)) ?? null,
    deleteSecret: async (service, account) => {
      store.delete(key(service, account));
    },
  };
}

function createFakeIdGenerator(ids: ReadonlyArray<string>): IdGenerator {
  let index = 0;
  return {
    generate: () => {
      const id = ids[index] ?? `generated-${index}`;
      index += 1;
      return id;
    },
  };
}

function createFakeClock(time = '2024-06-15T12:00:00.000Z'): Clock {
  return { now: () => time };
}

function createDeps(overrides: Partial<ProviderProfileDeps> = {}): ProviderProfileDeps {
  return {
    providerRepo: new FakeProviderProfileRepo(),
    secretStore: createFakeSecretStore(),
    idGenerator: createFakeIdGenerator(['profile-a', 'profile-b']),
    clock: createFakeClock(),
    ...overrides,
  };
}

describe('toProviderPublicState', () => {
  it('hasApiKey 在 Keychain 抛错时应抛 ApiKeyReadFailedError，而不是降级为 false', async () => {
    const secretStore = createFakeSecretStore(true);
    await expect(toProviderPublicState({ secretStore }, makeProfile())).rejects.toMatchObject({
      code: 'API_KEY_READ_FAILED',
    });
  });

  it('providerType 不是合法协议时应抛 ProviderNotConfiguredError', async () => {
    const secretStore = createFakeSecretStore();
    await expect(
      toProviderPublicState({ secretStore }, makeProfile({ providerType: 'bogus' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });
});

describe('两个 profile 的 key 槽位相互独立', () => {
  it('分别为两个 profile 保存 key，互不覆盖也互不可见', async () => {
    const secretStore = createFakeSecretStore();
    const profileA = makeProfile({
      id: 'profile-a',
      keychainService: 'com.ai-novel-generator.provider.profile-a',
    });
    const profileB = makeProfile({
      id: 'profile-b',
      keychainService: 'com.ai-novel-generator.provider.profile-b',
    });

    await secretStore.setSecret(profileA.keychainService, profileA.keychainAccount, 'key-a');

    const stateA = await toProviderPublicState({ secretStore }, profileA);
    const stateB = await toProviderPublicState({ secretStore }, profileB);

    expect(stateA.hasApiKey).toBe(true);
    expect(stateB.hasApiKey).toBe(false);
  });
});

describe('createProvider', () => {
  const input: CreateProviderProfileInput = {
    label: 'My Provider',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com',
    model: 'gpt-x',
  };

  it('首个 profile 应自动成为默认', async () => {
    const deps = createDeps();
    const state = await createProvider(deps, input);

    expect(state.isDefault).toBe(true);
    expect(deps.providerRepo.getDefault()?.id).toBe(state.id);
  });

  it('已有默认 provider 时新建的不应抢占默认', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'existing', isDefault: true }));
    providerRepo.setDefault('existing');
    const deps = createDeps({ providerRepo, idGenerator: createFakeIdGenerator(['profile-new']) });

    const state = await createProvider(deps, input);

    expect(state.isDefault).toBe(false);
    expect(deps.providerRepo.getDefault()?.id).toBe('existing');
  });

  it('生成的 id 与 secretRefForProfile 派生的槽位一致', async () => {
    const deps = createDeps({ idGenerator: createFakeIdGenerator(['profile-a']) });
    await createProvider(deps, input);

    const created = deps.providerRepo.getById('profile-a');
    expect(created?.keychainService).toBe('com.ai-novel-generator.provider.profile-a');
    expect(created?.keychainAccount).toBe('api-key');
  });
});

describe('updateProvider', () => {
  it('profile 不存在时应抛 ProviderNotConfiguredError', async () => {
    const deps = createDeps();
    const input: UpdateProviderProfileInput = {
      profileId: 'missing',
      label: 'x',
      protocol: 'anthropic-messages',
      baseUrl: 'https://x.example.com',
      model: 'm',
      enabled: true,
    };
    await expect(updateProvider(deps, input)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });

  it('应更新非敏感字段并保留 keychain 槽位不变', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile());
    const deps = createDeps({ providerRepo });

    const state = await updateProvider(deps, {
      profileId: 'profile-a',
      label: 'Renamed',
      protocol: 'openai-chat',
      baseUrl: 'https://new.example.com',
      model: 'model-new',
      enabled: false,
    });

    expect(state.label).toBe('Renamed');
    expect(state.protocol).toBe('openai-chat');
    expect(state.enabled).toBe(false);
    expect(providerRepo.getById('profile-a')?.keychainService).toBe(
      'com.ai-novel-generator.provider.profile-a',
    );
  });
});

describe('deleteProvider', () => {
  it('删除默认 profile 后默认应转移给创建时间最早的剩余 profile，且 Keychain secret 被删除', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    const oldest = makeProfile({
      id: 'oldest',
      isDefault: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      keychainService: 'com.ai-novel-generator.provider.oldest',
    });
    const newer = makeProfile({
      id: 'newer',
      isDefault: false,
      createdAt: '2024-02-01T00:00:00.000Z',
      keychainService: 'com.ai-novel-generator.provider.newer',
    });
    const toDelete = makeProfile({
      id: 'to-delete',
      isDefault: true,
      createdAt: '2024-03-01T00:00:00.000Z',
      keychainService: 'com.ai-novel-generator.provider.to-delete',
    });
    providerRepo.seed(oldest);
    providerRepo.seed(newer);
    providerRepo.seed(toDelete);
    providerRepo.setDefault('to-delete');

    const secretStore = createFakeSecretStore();
    await secretStore.setSecret(toDelete.keychainService, toDelete.keychainAccount, 'k');
    const deps = createDeps({ providerRepo, secretStore });

    const remaining = await deleteProvider(deps, 'to-delete');

    expect(remaining.some((p) => p.id === 'to-delete')).toBe(false);
    expect(providerRepo.getDefault()?.id).toBe('oldest');
    expect(await secretStore.hasSecret(toDelete.keychainService, toDelete.keychainAccount)).toBe(
      false,
    );
  });

  it('Keychain 删除失败不应让整个操作失败', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'only', isDefault: true }));
    providerRepo.setDefault('only');
    const secretStore: SecretStore = {
      hasSecret: async () => false,
      setSecret: async () => {},
      getSecret: async () => null,
      deleteSecret: async () => {
        throw new Error('keychain failure');
      },
    };
    const deps = createDeps({ providerRepo, secretStore });

    await expect(deleteProvider(deps, 'only')).resolves.toEqual([]);
    expect(providerRepo.getById('only')).toBeNull();
  });

  it('profile 不存在时应抛 ProviderNotConfiguredError', async () => {
    const deps = createDeps();
    await expect(deleteProvider(deps, 'missing')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });
});

describe('setDefaultProvider', () => {
  it('应把指定 profile 设为默认', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'a', isDefault: true }));
    providerRepo.seed(makeProfile({ id: 'b', isDefault: false }));
    providerRepo.setDefault('a');
    const deps = createDeps({ providerRepo });

    const list = await setDefaultProvider(deps, 'b');

    expect(list.find((p) => p.id === 'b')?.isDefault).toBe(true);
    expect(list.find((p) => p.id === 'a')?.isDefault).toBe(false);
  });

  it('profile 不存在时应抛 ProviderNotConfiguredError', async () => {
    const deps = createDeps();
    await expect(setDefaultProvider(deps, 'missing')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });
});

describe('resolveProviderForTask', () => {
  it('命中路由覆盖且 enabled 时应返回覆盖的 profile', () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'default-p', isDefault: true }));
    providerRepo.setDefault('default-p');
    providerRepo.seed(makeProfile({ id: 'override-p', isDefault: false, enabled: true }));
    providerRepo.setRoute('CONTRACT_DRAFT', 'override-p', '2024-01-01T00:00:00.000Z');

    const resolved = resolveProviderForTask({ providerRepo }, 'CONTRACT_DRAFT');
    expect(resolved.id).toBe('override-p');
  });

  it('覆盖指向的 profile 被禁用时应回退默认', () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'default-p', isDefault: true }));
    providerRepo.setDefault('default-p');
    providerRepo.seed(makeProfile({ id: 'disabled-p', isDefault: false, enabled: false }));
    providerRepo.setRoute('CONTRACT_DRAFT', 'disabled-p', '2024-01-01T00:00:00.000Z');

    const resolved = resolveProviderForTask({ providerRepo }, 'CONTRACT_DRAFT');
    expect(resolved.id).toBe('default-p');
  });

  it('无路由覆盖时应回退默认', () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'default-p', isDefault: true }));
    providerRepo.setDefault('default-p');

    const resolved = resolveProviderForTask({ providerRepo }, 'ANY_TASK');
    expect(resolved.id).toBe('default-p');
  });

  it('无默认且无路由覆盖时应抛 ProviderNotConfiguredError', () => {
    const providerRepo = new FakeProviderProfileRepo();
    expect(() => resolveProviderForTask({ providerRepo }, 'ANY_TASK')).toThrow(
      /模型提供商未配置/,
    );
  });
});

describe('listProviders', () => {
  it('应返回所有 profile 的公开状态', async () => {
    const providerRepo = new FakeProviderProfileRepo();
    providerRepo.seed(makeProfile({ id: 'a', isDefault: true }));
    providerRepo.seed(makeProfile({ id: 'b', isDefault: false }));
    const deps = createDeps({ providerRepo });

    const list = await listProviders(deps);
    expect(list.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });
});
