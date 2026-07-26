'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const electron_1 = require('electron');
// 与 @ai-novel/contracts 中 IPC_CHANNELS.HEALTH_CHECK 保持一致
const HEALTH_CHECK_CHANNEL = 'ipc:health-check';
/**
 * 通过 contextBridge 暴露最小、显式、带类型的 API 给 Renderer。
 * 不暴露 ipcRenderer 整体。
 */
const desktopAPI = {
  async healthCheck() {
    return electron_1.ipcRenderer.invoke(HEALTH_CHECK_CHANNEL);
  },
};
electron_1.contextBridge.exposeInMainWorld('desktop', desktopAPI);
//# sourceMappingURL=index.js.map
