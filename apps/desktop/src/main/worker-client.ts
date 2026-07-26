/**
 * Utility Process 客户端。
 *
 * 管理 Worker 生命周期和 RPC 通信。
 * 不阻塞窗口创建——Worker 在后台启动。
 */

import { app, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppError } from '@ai-novel/contracts';
import { mark } from './startup-timeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 类型 ──────────────────────────────────────────────────────────

export type WorkerStatus = 'starting' | 'ready' | 'failed' | 'disconnected';

interface RPCRequest {
  readonly requestId: string;
  readonly command: string;
  readonly payload: unknown;
}

interface RPCResponse {
  readonly requestId: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: AppError;
}

type StatusListener = (status: WorkerStatus) => void;

// ── 状态 ──────────────────────────────────────────────────────────

let workerProcess: Electron.UtilityProcess | null = null;
let status: WorkerStatus = 'starting';
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void }
>();
const statusListeners: StatusListener[] = [];

// ── 日志 ──────────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.log('[worker-client]', ...args);
const logError = (...args: unknown[]) => console.error('[worker-client]', ...args);

// ── 状态管理 ──────────────────────────────────────────────────────

function setStatus(newStatus: WorkerStatus): void {
  if (status === newStatus) return;
  log(`status: ${status} → ${newStatus}`);
  status = newStatus;
  for (const listener of statusListeners) {
    try {
      listener(newStatus);
    } catch {
      // 忽略监听器错误
    }
  }
}

export function getWorkerStatus(): WorkerStatus {
  return status;
}

export function onWorkerStatusChange(listener: StatusListener): () => void {
  statusListeners.push(listener);
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx >= 0) statusListeners.splice(idx, 1);
  };
}

// ── 启动 ──────────────────────────────────────────────────────────

export function startWorker(): void {
  mark('worker-spawn-start');

  const workerPath = path.join(__dirname, '../worker/index.js');
  log('forking worker from:', workerPath);

  const worker = utilityProcess.fork(workerPath, [], {
    env: {
      ...process.env,
      AI_NOVEL_DATA_ROOT: app.getPath('userData'),
    },
  });

  worker.on('message', (message: unknown) => {
    // 忽略旧 Worker 的晚到消息
    if (workerProcess !== null && workerProcess !== worker && status === 'ready') {
      log('ignoring stale message from old worker');
      return;
    }

    const msg = message as { type?: string; requestId?: string };

    if (msg.type === 'ready') {
      mark('worker-ready');
      setStatus('ready');
      workerProcess = worker;
      return;
    }

    if (msg.type === 'error') {
      const errMsg = (msg as { message?: string }).message || 'Worker 初始化失败';
      logError('worker error:', errMsg);
      mark('worker-failed');
      setStatus('failed');
      return;
    }

    // RPC 响应
    if (msg.requestId) {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        const response = msg as unknown as RPCResponse;
        if (response.success) {
          pending.resolve(response.data);
        } else {
          const err = new Error(response.error?.message || '操作失败') as Error & {
            code?: string;
          };
          err.code = response.error?.code;
          pending.reject(err);
        }
      }
    }
  });

  worker.on('exit', (code) => {
    logError('worker exited with code:', code);
    if (workerProcess === worker) {
      workerProcess = null;
    }
    setStatus('disconnected');

    // 拒绝所有待处理请求（先复制再清空，避免迭代中修改）
    const pending = [...pendingRequests];
    pendingRequests.clear();
    for (const [, entry] of pending) {
      const err = new Error('数据服务已断开，请重启应用') as Error & { code?: string };
      err.code = 'WORKER_UNAVAILABLE';
      entry.reject(err);
    }
  });

  worker.on('error', (err) => {
    logError('worker process error:', err);
    if (status === 'starting') {
      setStatus('failed');
    }
  });

  // Worker 就绪超时（不阻塞窗口，只是标记状态）
  const timeoutId = setTimeout(() => {
    if (status === 'starting' && workerProcess === null) {
      logError('worker ready timeout (30s)');
      setStatus('failed');
    }
  }, 30_000);

  // Worker 就绪后清除超时
  const clearOnReady = (newStatus: WorkerStatus): void => {
    if (newStatus === 'ready' || newStatus === 'failed') {
      clearTimeout(timeoutId);
      const idx = statusListeners.indexOf(clearOnReady);
      if (idx >= 0) statusListeners.splice(idx, 1);
    }
  };
  statusListeners.push(clearOnReady);
}

// ── RPC ───────────────────────────────────────────────────────────

export function sendToWorker(request: RPCRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!workerProcess || status !== 'ready') {
      const err = new Error('数据服务不可用') as Error & { code?: string };
      err.code = 'WORKER_UNAVAILABLE';
      reject(err);
      return;
    }

    pendingRequests.set(request.requestId, { resolve, reject });
    workerProcess.postMessage(request);

    // 请求超时
    setTimeout(() => {
      if (pendingRequests.has(request.requestId)) {
        pendingRequests.delete(request.requestId);
        const err = new Error('请求超时') as Error & { code?: string };
        err.code = 'WORKER_UNAVAILABLE';
        reject(err);
      }
    }, 30_000);
  });
}

// ── 关闭 ──────────────────────────────────────────────────────────

export function shutdownWorker(): void {
  // 清理之前的关闭计时器
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  const wp = workerProcess;
  if (!wp) return;

  try {
    wp.postMessage({ type: 'shutdown' });
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      try {
        wp.kill();
      } catch {
        // 进程可能已退出
      }
      if (workerProcess === wp) {
        workerProcess = null;
      }
    }, 2_000);
  } catch {
    try {
      wp.kill();
    } catch {
      // 忽略
    }
    if (workerProcess === wp) {
      workerProcess = null;
    }
  }
}

// ── 重试 ──────────────────────────────────────────────────────────

export function retryWorker(): void {
  if (status === 'starting' || status === 'ready') return;
  log('retrying worker startup');

  // 先终止旧 Worker（防止并发写入数据库）
  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch {
      // 进程可能已退出
    }
    workerProcess = null;
  }

  setStatus('starting');
  startWorker();
}
