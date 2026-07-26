import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopAPI,
  HealthCheckResponse,
  CreateProjectInput,
  CreateProjectResult,
  ListProjectsResult,
  OpenProjectResult,
  DataServiceStatusResponse,
} from '@ai-novel/contracts';

/**
 * 通过 contextBridge 暴露最小、显式、带类型的 API 给 Renderer。
 * 不暴露 ipcRenderer 整体。
 */
const desktopAPI: DesktopAPI = {
  async healthCheck(): Promise<HealthCheckResponse> {
    return ipcRenderer.invoke('ipc:health-check');
  },

  async getDataServiceStatus(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-status');
  },

  async retryDataService(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-retry');
  },

  projects: {
    async create(input: CreateProjectInput): Promise<CreateProjectResult> {
      return ipcRenderer.invoke('ipc:project-create', input);
    },

    async list(): Promise<ListProjectsResult> {
      return ipcRenderer.invoke('ipc:project-list');
    },

    async open(projectId: string): Promise<OpenProjectResult> {
      return ipcRenderer.invoke('ipc:project-open', projectId);
    },
  },
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
