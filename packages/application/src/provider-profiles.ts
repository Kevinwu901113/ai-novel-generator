/**
 * Provider Profile 用例（B1 多 provider，D6）。
 *
 * 管理 provider profile 的增删改查、默认 provider 与两层路由（D6：
 * 全局默认 provider + 按任务类型可选覆盖，无第三层、无 fallback 轮询）。
 *
 * API Key 本身由 SecretStore 独立管理，这里只处理非敏感配置；
 * `hasApiKey` 一律经 Keychain 现查，Keychain 故障不得伪装成"未配置"。
 */

import {
  isProviderProtocol,
  type ProviderPublicState,
  type ConnectionTestStatus,
  type CreateProviderProfileInput,
  type UpdateProviderProfileInput,
} from '@ai-novel/contracts';
import { secretRefForProfile, isValidProviderProfileId } from './provider-secret-ref.js';
import type {
  SecretStore,
  ProviderProfileRepository,
  ProviderProfileData,
  IdGenerator,
  Clock,
} from './types.js';
import { AppError, ApiKeyReadFailedError, ProviderNotConfiguredError } from './errors.js';

/** ProviderProfile 用例依赖 */
export interface ProviderProfileDeps {
  readonly providerRepo: ProviderProfileRepository;
  readonly secretStore: SecretStore;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

/**
 * 把持久化的 profile 转换为公开状态。
 *
 * 只依赖 secretStore，因此调用方可以传入完整 ProviderProfileDeps，
 * 也可以在不需要 idGenerator / clock 的用例（保存 / 删除 / 测试 API Key）中
 * 单独构造 `{ secretStore }`。
 */
export async function toProviderPublicState(
  deps: Pick<ProviderProfileDeps, 'secretStore'>,
  profile: ProviderProfileData,
): Promise<ProviderPublicState> {
  if (!isProviderProtocol(profile.providerType)) {
    throw new ProviderNotConfiguredError();
  }

  let hasApiKey: boolean;
  try {
    hasApiKey = await deps.secretStore.hasSecret(profile.keychainService, profile.keychainAccount);
  } catch {
    // Keychain 故障不能伪装成"尚未配置"。
    throw new ApiKeyReadFailedError('无法读取 API Key 配置状态');
  }

  return {
    id: profile.id,
    label: profile.displayName,
    protocol: profile.providerType,
    baseUrl: profile.baseUrl,
    model: profile.model,
    enabled: profile.enabled,
    isDefault: profile.isDefault,
    hasApiKey,
    lastTestedAt: profile.lastTestedAt,
    lastTestStatus: (profile.lastTestStatus ?? 'never') as ConnectionTestStatus,
    lastTestErrorCode: profile.lastTestErrorCode,
    lastTestLatencyMs: profile.lastTestLatencyMs,
  };
}

/** 列出所有 provider profile 的公开状态 */
export async function listProviders(
  deps: ProviderProfileDeps,
): Promise<ReadonlyArray<ProviderPublicState>> {
  const profiles = deps.providerRepo.list();
  return Promise.all(profiles.map((profile) => toProviderPublicState(deps, profile)));
}

/**
 * 新建 provider profile。
 *
 * id 由 idGenerator 生成后必须经 isValidProviderProfileId 校验（系统内部一致性检查，
 * 不合法说明 idGenerator 实现有问题，fail-closed 而不是拼出可疑的 Keychain service 名）。
 * 创建后若当前无默认 provider，则把新建的设为默认。
 */
export async function createProvider(
  deps: ProviderProfileDeps,
  input: CreateProviderProfileInput,
): Promise<ProviderPublicState> {
  const { providerRepo, idGenerator, clock } = deps;

  const id = idGenerator.generate();
  if (!isValidProviderProfileId(id)) {
    throw new AppError('INTERNAL_ERROR', '生成的 provider profile id 不合法');
  }
  const secretRef = secretRefForProfile(id);
  const now = clock.now();
  const hadDefault = providerRepo.getDefault() !== null;

  providerRepo.create({
    id,
    providerType: input.protocol,
    displayName: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    keychainService: secretRef.service,
    keychainAccount: secretRef.account,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  if (!hadDefault) {
    providerRepo.setDefault(id);
  }

  const created = providerRepo.getById(id);
  if (!created) {
    throw new AppError('INTERNAL_ERROR', 'provider profile 创建后未能读取');
  }
  return toProviderPublicState(deps, created);
}

/** 更新 provider profile（不含 API Key、不含 keychain 槽位、不含 id） */
export async function updateProvider(
  deps: ProviderProfileDeps,
  input: UpdateProviderProfileInput,
): Promise<ProviderPublicState> {
  const { providerRepo, clock } = deps;

  const existing = providerRepo.getById(input.profileId);
  if (!existing) {
    throw new ProviderNotConfiguredError();
  }

  providerRepo.update({
    id: input.profileId,
    providerType: input.protocol,
    displayName: input.label,
    baseUrl: input.baseUrl,
    model: input.model,
    enabled: input.enabled,
    updatedAt: clock.now(),
  });

  const updated = providerRepo.getById(input.profileId);
  if (!updated) {
    throw new ProviderNotConfiguredError();
  }
  return toProviderPublicState(deps, updated);
}

/**
 * 删除 provider profile。
 *
 * 先删 DB 行，再删 Keychain secret（幂等、最佳努力，失败不影响已完成的 DB 删除）。
 * 若删除的是当前默认且仍有其它 profile，把剩余中创建时间最早的一条设为默认。
 */
export async function deleteProvider(
  deps: ProviderProfileDeps,
  profileId: string,
): Promise<ReadonlyArray<ProviderPublicState>> {
  const { providerRepo, secretStore } = deps;

  const existing = providerRepo.getById(profileId);
  if (!existing) {
    throw new ProviderNotConfiguredError();
  }

  const wasDefault = existing.isDefault;
  providerRepo.delete(profileId);

  try {
    await secretStore.deleteSecret(existing.keychainService, existing.keychainAccount);
  } catch {
    // 最佳努力：Keychain 清理失败不得让整个操作失败，DB 层删除已经生效。
  }

  if (wasDefault) {
    const remaining = providerRepo.list();
    if (remaining.length > 0) {
      const earliest = [...remaining].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      providerRepo.setDefault(earliest.id);
    }
  }

  return listProviders(deps);
}

/** 将指定 profile 设为全局默认（D6 路由第一层） */
export async function setDefaultProvider(
  deps: ProviderProfileDeps,
  profileId: string,
): Promise<ReadonlyArray<ProviderPublicState>> {
  const { providerRepo } = deps;

  const existing = providerRepo.getById(profileId);
  if (!existing) {
    throw new ProviderNotConfiguredError();
  }

  providerRepo.setDefault(profileId);
  return listProviders(deps);
}

/**
 * 嵌入模型的路由键（D-B23-3）。
 *
 * 这不是一个任务类型——没有 STORY_GRAPH_EMBED 任务，tasks.task_type 的 CHECK
 * 也不含它；它只是 provider_routes 里选嵌入模型用的伪键。
 */
export const STORY_GRAPH_EMBED_ROUTE_KEY = 'STORY_GRAPH_EMBED';

/**
 * D6 两层路由：按任务类型覆盖优先，其次全局默认，都没有则抛错。
 * 不做第三层、不做 fallback 轮询。
 *
 * **例外：STORY_GRAPH_EMBED 不回落全局默认**（D-B23-3）。全局默认是聊天模型，
 * 拿它去打 /v1/embeddings 只会得到 404 或一段没有意义的文本——嵌入模型必须显式
 * 配置。没有显式路由时按"未配置"抛错，向量层据此整体关闭，别名/FTS 主干照常。
 */
export function resolveProviderForTask(
  deps: { readonly providerRepo: ProviderProfileRepository },
  taskType: string,
): ProviderProfileData {
  const { providerRepo } = deps;

  const routedId = providerRepo.getRoute(taskType);
  if (routedId) {
    const routed = providerRepo.getById(routedId);
    if (routed && routed.enabled) {
      return routed;
    }
  }

  if (taskType === STORY_GRAPH_EMBED_ROUTE_KEY) {
    throw new ProviderNotConfiguredError();
  }

  const fallback = providerRepo.getDefault();
  if (fallback) {
    return fallback;
  }

  throw new ProviderNotConfiguredError();
}
