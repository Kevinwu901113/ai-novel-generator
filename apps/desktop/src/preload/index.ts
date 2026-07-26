import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, HealthCheckResponse } from '@ai-novel/contracts';

// 与 @ai-novel/contracts 中 IPC_CHANNELS.HEALTH_CHECK 保持一致
const HEALTH_CHECK_CHANNEL = 'ipc:health-check';

/**
 * 通过 contextBridge 暴露最小、显式、带类型的 API 给 Renderer。
 * 不暴露 ipcRenderer 整体。
 */
const desktopAPI: DesktopAPI = {
  async healthCheck(): Promise<HealthCheckResponse> {
    return ipcRenderer.invoke(HEALTH_CHECK_CHANNEL);
  },
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
