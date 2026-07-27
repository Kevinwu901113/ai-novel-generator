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
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
