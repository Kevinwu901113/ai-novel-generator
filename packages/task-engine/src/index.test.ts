/**
 * TaskEngine 测试。
 *
 * 使用 mock 依赖测试任务执行流程。
 * 不访问真实数据库或 API。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeModelInvocationTest,
  sha256Hex,
  TaskExecutionError,
  type TaskEngineDeps,
} from './index.js';
import type {
  TaskData,
  TaskRepositoryPort,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  ProviderProfileData,
  IdGenerator,
  Clock,
  CreateInvocationInput,
  InvocationSuccessResult,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';

// ── Mock 工厂 ─────────────────────────────────────────────────────

function createMockTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    taskType: 'MODEL_INVOCATION_TEST',
    status: 'PENDING',
    inputVersionJson: '{}',
    payloadJson: '{"promptHash":"abc","promptLength":10}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: null,
    attemptCount: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function createMockInvocation(overrides: Partial<ModelInvocationData> = {}): ModelInvocationData {
  return {
    id: 'inv-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    providerProfileId: 'mimo-token-plan-cn',
    model: 'mimo-v2.5-pro',
    status: 'PENDING',
    attemptNumber: 1,
    requestKind: 'model_invocation_test',
    promptHash: sha256Hex('测试提示词'),
    requestMetadataJson: '{"promptLength":10}',
    responseMetadataJson: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    latencyMs: null,
    finishReason: null,
    errorCode: null,
    errorMessage: null,
    providerRequestId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function createMockProviderProfile(
  overrides: Partial<ProviderProfileData> = {},
): ProviderProfileData {
  return {
    id: 'mimo-token-plan-cn',
    providerType: 'anthropic-messages',
    displayName: 'Xiaomi MiMo Token Plan CN',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    model: 'mimo-v2.5-pro',
    keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
    keychainAccount: 'api-key',
    enabled: true,
    isDefault: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
    ...overrides,
  };
}

/**
 * 构造 D6 两层路由 ProviderProfileRepository 假实现：
 * getById / getDefault / getRoute 是 resolveProviderForTask 实际依赖的能力；
 * 其余方法（create/update/delete/setRoute/deleteRoute）本引擎不使用，抛错以便
 * 误用时测试立即失败，而不是被 any 掩盖。
 */
function createFakeProviderRepo(
  options: {
    profiles?: ReadonlyArray<ProviderProfileData>;
    defaultId?: string | null;
    routes?: Readonly<Record<string, string>>;
  } = {},
): ProviderProfileRepository {
  const profiles = new Map<string, ProviderProfileData>(
    (options.profiles ?? [createMockProviderProfile()]).map((p) => [p.id, p]),
  );
  const defaultId =
    options.defaultId !== undefined
      ? options.defaultId
      : (options.profiles?.[0]?.id ?? 'mimo-token-plan-cn');
  const routes = new Map<string, string>(Object.entries(options.routes ?? {}));

  return {
    getById: vi.fn((id: string) => profiles.get(id) ?? null),
    list: vi.fn(() => [...profiles.values()]),
    getDefault: vi.fn(() => (defaultId ? (profiles.get(defaultId) ?? null) : null)),
    create: vi.fn(() => {
      throw new Error('未使用：create');
    }),
    update: vi.fn(() => {
      throw new Error('未使用：update');
    }),
    delete: vi.fn(() => {
      throw new Error('未使用：delete');
    }),
    setDefault: vi.fn(() => {
      throw new Error('未使用：setDefault');
    }),
    getRoute: vi.fn((taskType: string) => routes.get(taskType) ?? null),
    setRoute: vi.fn(() => {
      throw new Error('未使用：setRoute');
    }),
    deleteRoute: vi.fn(() => {
      throw new Error('未使用：deleteRoute');
    }),
    updateTestResult: vi.fn(),
  };
}

function createMockSuccessOutput(
  overrides: Partial<ModelInvocationOutput> = {},
): ModelInvocationOutput {
  return {
    text: 'OK',
    providerRequestId: 'msg-001',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 15,
    },
    latencyMs: 500,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function createMockErrorOutput(): ModelInvocationOutput {
  return {
    text: '',
    providerRequestId: null,
    finishReason: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    },
    latencyMs: 1000,
    errorCode: 'PROVIDER_TIMEOUT',
    errorMessage: '连接超时',
  };
}

interface MockDeps {
  taskStore: Map<string, TaskData>;
  invocationStore: Map<string, ModelInvocationData>;
  deps: TaskEngineDeps;
}

function createMockDeps(
  overrides: {
    task?: TaskData;
    invokeResult?: ModelInvocationOutput;
    invokeError?: Error;
    apiKey?: string | null;
    providerRepo?: ProviderProfileRepository;
  } = {},
): MockDeps {
  const task = overrides.task ?? createMockTask();
  const taskStore = new Map([[task.id, { ...task }]]);
  const invocationStore = new Map<string, ModelInvocationData>();

  const taskRepo: TaskRepositoryPort = {
    create: vi.fn(),
    getById: vi.fn((id: string) => taskStore.get(id) ?? null),
    listByProject: vi.fn(() => []),
    listByStatus: vi.fn(() => []),
    claimPending: vi.fn((id: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'PENDING') return false;
      taskStore.set(id, {
        ...t,
        status: 'RUNNING',
        attemptCount: t.attemptCount + 1,
        startedAt: '2024-01-01T00:00:00.000Z',
      });
      return true;
    }),
    completeRunning: vi.fn((id: string, resultJson: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'SUCCEEDED', resultJson });
      return true;
    }),
    failRunning: vi.fn((id: string, errorCode: string, errorMessage: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    }),
    failPending: vi.fn((id: string, errorCode: string, errorMessage: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'PENDING') return false;
      taskStore.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    }),
    markStale: vi.fn(() => true),
    resetToPending: vi.fn(() => true),
    listRunning: vi.fn(() => []),
  };

  const invocationRepo: ModelInvocationRepositoryPort = {
    create: vi.fn((data: CreateInvocationInput) => {
      invocationStore.set(data.id, createMockInvocation({ ...data, status: 'PENDING' }));
    }),
    getById: vi.fn((id: string) => invocationStore.get(id) ?? null),
    listByTask: vi.fn(() => []),
    markRunning: vi.fn((id: string, _expectedStatus: 'PENDING') => {
      const inv = invocationStore.get(id);
      if (!inv || inv.status !== 'PENDING') return false;
      invocationStore.set(id, { ...inv, status: 'RUNNING' });
      return true;
    }),
    markSucceeded: vi.fn(
      (id: string, _expectedStatus: 'RUNNING', result: InvocationSuccessResult) => {
        const inv = invocationStore.get(id);
        if (!inv || inv.status !== 'RUNNING') return false;
        invocationStore.set(id, {
          ...inv,
          status: 'SUCCEEDED',
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
          latencyMs: result.latencyMs,
          finishReason: result.finishReason,
          providerRequestId: result.providerRequestId,
        });
        return true;
      },
    ),
    markFailed: vi.fn(
      (
        id: string,
        expectedStatuses: ReadonlyArray<string>,
        errorCode: string,
        errorMessage: string,
      ) => {
        const inv = invocationStore.get(id);
        if (!inv || !expectedStatuses.includes(inv.status)) return false;
        invocationStore.set(id, { ...inv, status: 'FAILED', errorCode, errorMessage });
        return true;
      },
    ),
    getStatsByProject: vi.fn(() => ({
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    })),
    listRunning: vi.fn(() => []),
  };

  const apiKeyValue: string | null =
    'apiKey' in overrides ? (overrides.apiKey ?? null) : 'test-api-key';
  const secretStore: SecretStore = {
    hasSecret: vi.fn(async () => true),
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async (): Promise<string | null> => apiKeyValue),
    deleteSecret: vi.fn(async () => {}),
  };

  const providerRepo: ProviderProfileRepository =
    overrides.providerRepo ?? createFakeProviderRepo();

  const idGenerator: IdGenerator = {
    generate: vi.fn(() => 'inv-mock-id'),
  };

  const clock: Clock = {
    now: vi.fn(() => '2024-01-01T00:00:00.000Z'),
  };

  const invokeResultValue = overrides.invokeResult ?? createMockSuccessOutput();
  if (overrides.invokeError) {
    const invokeModel = vi.fn(async () => {
      throw overrides.invokeError;
    });
    return {
      taskStore,
      invocationStore,
      deps: {
        taskRepo,
        invocationRepo,
        secretStore,
        providerRepo,
        idGenerator,
        clock,
        invokeModel,
        transaction: <T>(fn: () => T) => fn(),
      },
    };
  }

  const invokeModel = vi.fn(async () => invokeResultValue);

  return {
    taskStore,
    invocationStore,
    deps: {
      taskRepo,
      invocationRepo,
      secretStore,
      providerRepo,
      idGenerator,
      clock,
      invokeModel,
      transaction: <T>(fn: () => T) => fn(),
    },
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('应该返回 64 字符 hex 字符串', () => {
    const hash = sha256Hex('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同输入应该返回相同 hash', () => {
    expect(sha256Hex('test')).toBe(sha256Hex('test'));
  });

  it('不同输入应该返回不同 hash', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('executeModelInvocationTest', () => {
  it('成功执行应该先落库再调用', async () => {
    const { deps } = createMockDeps();

    const result = await executeModelInvocationTest(deps, 'task-1', '测试提示词');

    // 任务应该先被 claim（原子 claim + attempt）
    expect(deps.taskRepo.claimPending).toHaveBeenCalledWith('task-1');

    // invocation 应该被创建并标记 RUNNING
    expect(deps.invocationRepo.create).toHaveBeenCalled();
    expect(deps.invocationRepo.markRunning).toHaveBeenCalled();

    // 模型应该被调用
    expect(deps.invokeModel).toHaveBeenCalled();

    // 结果应该是 SUCCEEDED
    expect(result.task.status).toBe('SUCCEEDED');
  });

  it('prompt 不应该写入数据库', async () => {
    const { deps } = createMockDeps();

    await executeModelInvocationTest(deps, 'task-1', '非常机密的提示词');

    // 验证 invocation 的 requestMetadataJson 不包含 prompt
    const createCall = (deps.invocationRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall).toBeDefined();
    const metadata = JSON.parse(createCall[0].requestMetadataJson);
    expect(metadata.promptLength).toBe(8);
    expect(JSON.stringify(createCall[0])).not.toContain('非常机密的提示词');
  });

  it('result 不应该保存模型正文', async () => {
    const { deps } = createMockDeps({
      invokeResult: createMockSuccessOutput({ text: '很长的模型输出' }),
    });

    const result = await executeModelInvocationTest(deps, 'task-1', '提示词');

    const resultData = JSON.parse(result.task.resultJson!);
    expect(resultData.accepted).toBe(true);
    expect(resultData.textLength).toBe(7);
    expect(result.task.resultJson).not.toContain('很长的模型输出');
  });

  it('claim 应该原子递增 attempt_count', async () => {
    const { deps } = createMockDeps();

    await executeModelInvocationTest(deps, 'task-1', '测试');

    expect(deps.taskRepo.claimPending).toHaveBeenCalledWith('task-1');

    // invocation 的 attemptNumber 应该是 1（claim 后 attemptCount=1）
    const createCall = (deps.invocationRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0].attemptNumber).toBe(1);
  });

  it('API Key 缺失时应该抛出 API_KEY_REQUIRED（claim 前）', async () => {
    const { deps, taskStore } = createMockDeps({ apiKey: null });

    await expect(executeModelInvocationTest(deps, 'task-1', '测试')).rejects.toThrow(
      TaskExecutionError,
    );

    // 不应该 claim（attempt_count 不变）
    expect(deps.taskRepo.claimPending).not.toHaveBeenCalled();
    const task = taskStore.get('task-1')!;
    expect(task.attemptCount).toBe(0);
    expect(task.status).toBe('PENDING');
  });

  it('provider 不存在时应该抛出 PROVIDER_NOT_CONFIGURED（claim 前）', async () => {
    const { deps, taskStore } = createMockDeps({
      providerRepo: createFakeProviderRepo({ profiles: [], defaultId: null }),
    });

    await expect(executeModelInvocationTest(deps, 'task-1', '测试')).rejects.toThrow(
      TaskExecutionError,
    );

    // 不应该 claim（attempt_count 不变）
    expect(deps.taskRepo.claimPending).not.toHaveBeenCalled();
    const task = taskStore.get('task-1')!;
    expect(task.attemptCount).toBe(0);
    expect(task.status).toBe('PENDING');
  });

  it('无任何 provider 时任务按既有失败语义落库：PROVIDER_NOT_CONFIGURED，task 仍 PENDING', async () => {
    const { deps, taskStore } = createMockDeps({
      providerRepo: createFakeProviderRepo({ profiles: [], defaultId: null }),
    });

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('PROVIDER_NOT_CONFIGURED');
    }

    const task = taskStore.get('task-1')!;
    expect(task.status).toBe('PENDING');
    expect(task.attemptCount).toBe(0);
  });

  it('无路由覆盖时使用全局默认 provider，providerProfileId 等于该 profile 的 id', async () => {
    const defaultProfile = createMockProviderProfile({ id: 'provider-default' });
    const { deps } = createMockDeps({
      providerRepo: createFakeProviderRepo({
        profiles: [defaultProfile],
        defaultId: defaultProfile.id,
      }),
    });

    await executeModelInvocationTest(deps, 'task-1', '测试');

    const createCall = (deps.invocationRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0].providerProfileId).toBe('provider-default');
  });

  it('存在任务类型路由覆盖时使用被覆盖的 provider', async () => {
    const defaultProfile = createMockProviderProfile({ id: 'provider-default' });
    const routedProfile = createMockProviderProfile({
      id: 'provider-routed',
      providerType: 'openai-chat',
    });
    const { deps } = createMockDeps({
      providerRepo: createFakeProviderRepo({
        profiles: [defaultProfile, routedProfile],
        defaultId: defaultProfile.id,
        routes: { MODEL_INVOCATION_TEST: routedProfile.id },
      }),
    });

    await executeModelInvocationTest(deps, 'task-1', '测试');

    const createCall = (deps.invocationRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0].providerProfileId).toBe('provider-routed');
  });

  it.each(['anthropic-messages', 'openai-chat'] as const)(
    'protocol 应该正确透传给 invokeModel：%s',
    async (protocol) => {
      const profile = createMockProviderProfile({
        id: 'provider-protocol',
        providerType: protocol,
      });
      const { deps } = createMockDeps({
        providerRepo: createFakeProviderRepo({ profiles: [profile], defaultId: profile.id }),
      });

      await executeModelInvocationTest(deps, 'task-1', '测试');

      expect(deps.invokeModel).toHaveBeenCalledWith(expect.objectContaining({ protocol }));
    },
  );

  it('provider failure 时应该原子提交失败', async () => {
    const { deps } = createMockDeps({ invokeResult: createMockErrorOutput() });

    const result = await executeModelInvocationTest(deps, 'task-1', '测试');

    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(result.invocation!.status).toBe('FAILED');
    expect(result.invocation!.errorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('invokeModel 抛出异常时应该原子提交失败', async () => {
    const { deps } = createMockDeps({ invokeError: new Error('网络错误') });

    const result = await executeModelInvocationTest(deps, 'task-1', '测试');

    expect(result.task.status).toBe('FAILED');
    expect(result.invocation!.status).toBe('FAILED');
    expect(result.invocation!.errorCode).toBe('PROVIDER_CONNECTION_FAILED');
  });

  it('task 不存在时应该抛出 TASK_NOT_FOUND', async () => {
    const { deps } = createMockDeps();
    (deps.taskRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await expect(executeModelInvocationTest(deps, 'nonexistent', '测试')).rejects.toThrow(
      TaskExecutionError,
    );
  });

  it('task 状态不是 PENDING 时应该抛出 TASK_STATE_CONFLICT', async () => {
    const { deps } = createMockDeps({
      task: createMockTask({ status: 'RUNNING' }),
    });

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('TASK_STATE_CONFLICT');
    }
  });

  it('CAS claim 失败时应该抛出 TASK_STATE_CONFLICT', async () => {
    const { deps } = createMockDeps();
    (deps.taskRepo.claimPending as ReturnType<typeof vi.fn>).mockReturnValue(false);

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('TASK_STATE_CONFLICT');
    }
  });

  it('task 和 invocation 应该原子一致（成功）', async () => {
    const { deps } = createMockDeps();

    const result = await executeModelInvocationTest(deps, 'task-1', '测试');

    expect(result.task.status).toBe('SUCCEEDED');
    expect(result.invocation!.status).toBe('SUCCEEDED');
  });

  it('task 和 invocation 应该原子一致（失败）', async () => {
    const { deps } = createMockDeps({ invokeResult: createMockErrorOutput() });

    const result = await executeModelInvocationTest(deps, 'task-1', '测试');

    expect(result.task.status).toBe('FAILED');
    expect(result.invocation!.status).toBe('FAILED');
  });

  it('应该记录 promptHash 而非 prompt', async () => {
    const { deps } = createMockDeps();
    const prompt = '测试提示词';

    await executeModelInvocationTest(deps, 'task-1', prompt);

    const createCall = (deps.invocationRepo.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(createCall[0].promptHash).toBe(sha256Hex(prompt));
    expect(createCall[0].promptHash).toHaveLength(64);
  });

  it('Keychain 读取失败时应该抛出 API_KEY_READ_FAILED（claim 前）', async () => {
    const { deps, taskStore } = createMockDeps();
    (deps.secretStore.getSecret as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('keychain error'),
    );

    await expect(executeModelInvocationTest(deps, 'task-1', '测试')).rejects.toThrow(
      TaskExecutionError,
    );

    // 不应该 claim（attempt_count 不变）
    expect(deps.taskRepo.claimPending).not.toHaveBeenCalled();
    const task = taskStore.get('task-1')!;
    expect(task.attemptCount).toBe(0);
    expect(task.status).toBe('PENDING');
  });

  it('claim 失败不增加 attempt', async () => {
    const { deps, taskStore } = createMockDeps();
    (deps.taskRepo.claimPending as ReturnType<typeof vi.fn>).mockReturnValue(false);

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
    } catch {
      // expected
    }

    // attempt_count 应该不变
    const task = taskStore.get('task-1')!;
    expect(task.attemptCount).toBe(0);
  });

  it('SUCCEEDED task 不可再次执行', async () => {
    const { deps } = createMockDeps({
      task: createMockTask({ status: 'SUCCEEDED' }),
    });

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('TASK_STATE_CONFLICT');
    }
  });

  it('FAILED task 不可直接执行（需先 resetToPending）', async () => {
    const { deps } = createMockDeps({
      task: createMockTask({ status: 'FAILED' }),
    });

    try {
      await executeModelInvocationTest(deps, 'task-1', '测试');
      expect.fail('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('TASK_STATE_CONFLICT');
    }
  });
});
