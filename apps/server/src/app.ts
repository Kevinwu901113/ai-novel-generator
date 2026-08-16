/**
 * 服务组装（B11）。CLI 入口在 index.ts；本模块保持普通 import 零副作用
 * （与 worker 的纪律一致：集成测试直接 import 组装函数起真服务）。
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initialize } from '@ai-novel/worker';
import { loadOrCreateToken } from './auth.js';
import { createAppServer } from './http-server.js';
import { handleRpcRequest, type DataServiceState } from './rpc.js';

export interface StartServerOptions {
  readonly dataRoot: string;
  readonly host: string;
  /** 0 = 随机端口（测试用） */
  readonly port: number;
  readonly webRoot: string | null;
  readonly version: string;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly token: string;
  readonly getStatus: () => DataServiceState;
  /** 初始化完成（ready 或 failed 均 resolve；供测试与启动日志 await） */
  readonly initialization: Promise<DataServiceState>;
  readonly close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  // worker 的 getDataRoot() 只认环境变量——必须在 initialize() 之前设置
  process.env.AI_NOVEL_DATA_ROOT = options.dataRoot;

  const token = loadOrCreateToken(options.dataRoot);

  let status: DataServiceState = 'starting';
  let initInFlight: Promise<DataServiceState> | null = null;

  const runInitialize = (): Promise<DataServiceState> => {
    if (initInFlight) return initInFlight;
    status = 'starting';
    const run = initialize()
      .then((): DataServiceState => {
        status = 'ready';
        return status;
      })
      .catch((err: unknown): DataServiceState => {
        status = 'failed';
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[server] 数据服务初始化失败：${message}`);
        return status;
      })
      .finally(() => {
        initInFlight = null;
      });
    initInFlight = run;
    return run;
  };

  const server = createAppServer({
    token,
    webRoot: options.webRoot,
    handleRpc: (body) =>
      handleRpcRequest(body, {
        getStatus: () => status,
        // 与原 Electron main 的 retryWorker 语义一致：非阻塞触发，返回即时状态，
        // renderer 随后轮询 dataServiceStatus。ready 状态下重复触发是无害幂等。
        requestRetry: () => {
          if (status !== 'ready') {
            void runInitialize();
          }
          return status;
        },
        version: options.version,
      }),
  });

  const initialization = runInitialize();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    port: address.port,
    token,
    getStatus: () => status,
    initialization,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((err) => (err ? rejectPromise(err) : resolvePromise()));
      }),
  };
}
