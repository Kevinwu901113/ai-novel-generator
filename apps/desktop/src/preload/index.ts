import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC channel 常量 — 与 packages/contracts 保持一致。
 * Preload 编译为自包含 CJS，不得运行时导入 workspace ESM 包。
 */
const IPC_CHANNELS = {
  HEALTH_CHECK: 'ipc:health-check',
  PROJECT_CREATE: 'ipc:project-create',
  PROJECT_LIST: 'ipc:project-list',
  PROJECT_OPEN: 'ipc:project-open',
  PROVIDER_GET_STATE: 'ipc:provider-get-state',
  PROVIDER_SAVE_API_KEY: 'ipc:provider-save-api-key',
  PROVIDER_DELETE_API_KEY: 'ipc:provider-delete-api-key',
  PROVIDER_TEST_CONNECTION: 'ipc:provider-test-connection',
  TASK_CREATE_MODEL_INVOCATION_TEST: 'ipc:task-create-model-invocation-test',
  TASK_GET: 'ipc:task-get',
  TASK_LIST: 'ipc:task-list',
  TASK_GET_STATS: 'ipc:task-get-stats',
} as const;

/**
 * 类型声明 — import type 在编译后被擦除，不会产生 require() 调用。
 * 运行时仅依赖 electron 的 contextBridge 和 ipcRenderer。
 */
import type {
  DesktopAPI,
  HealthCheckResponse,
  CreateProjectInput,
  CreateProjectResult,
  ListProjectsResult,
  OpenProjectResult,
  DataServiceStatusResponse,
  ProviderPublicState,
  SaveApiKeyInput,
  ConnectionTestResult,
  CreateModelInvocationTestInput,
  TaskPublicData,
  TaskStatsPublicData,
} from '@ai-novel/contracts';

/**
 * 通过 contextBridge 暴露最小、显式、带类型的 API 给 Renderer。
 * 不暴露 ipcRenderer 整体。
 */
const desktopAPI: DesktopAPI = {
  async healthCheck(): Promise<HealthCheckResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.HEALTH_CHECK);
  },

  async getDataServiceStatus(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-status');
  },

  async retryDataService(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-retry');
  },

  projects: {
    async create(input: CreateProjectInput): Promise<CreateProjectResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input);
    },

    async list(): Promise<ListProjectsResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST);
    },

    async open(projectId: string): Promise<OpenProjectResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, projectId);
    },
  },

  provider: {
    async getState(): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_GET_STATE);
    },

    async saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_API_KEY, input);
    },

    async deleteApiKey(): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE_API_KEY);
    },

    async testConnection(): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_TEST_CONNECTION);
    },
  },

  tasks: {
    async createModelInvocationTest(
      input: CreateModelInvocationTestInput,
    ): Promise<TaskPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE_MODEL_INVOCATION_TEST, input);
    },

    async get(projectId: string, taskId: string): Promise<TaskPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, { projectId, taskId });
    },

    async list(projectId: string): Promise<ReadonlyArray<TaskPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST, { projectId });
    },

    async getStats(projectId: string): Promise<TaskStatsPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_STATS, { projectId });
    },
  },
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
