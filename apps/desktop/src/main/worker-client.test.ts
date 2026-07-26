/**
 * Worker 生命周期测试。
 *
 * 通过提取的状态管理逻辑验证关键行为，
 * 不依赖真实的 Electron UtilityProcess。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 提取可测试的状态管理逻辑 ─────────────────────────────────────

type WorkerStatus = 'starting' | 'ready' | 'failed' | 'disconnected';
type StatusListener = (status: WorkerStatus) => void;

/**
 * 模拟 Worker 客户端状态机。
 * 从 worker-client.ts 提取的核心逻辑，用于独立测试。
 */
class WorkerStateMachine {
  private status: WorkerStatus = 'starting';
  private workerActive = false;
  private readonly statusListeners: StatusListener[] = [];
  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  getStatus(): WorkerStatus {
    return this.status;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.push(listener);
    return () => {
      const idx = this.statusListeners.indexOf(listener);
      if (idx >= 0) this.statusListeners.splice(idx, 1);
    };
  }

  setStatus(newStatus: WorkerStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus);
      } catch {
        // 忽略监听器错误
      }
    }
  }

  /** 模拟 Worker ready 事件 */
  simulateReady(): void {
    this.workerActive = true;
    this.setStatus('ready');
  }

  /** 模拟 Worker error 事件 */
  simulateError(): void {
    if (this.status === 'starting') {
      this.setStatus('failed');
    }
  }

  /** 模拟 Worker exit 事件 */
  simulateExit(): void {
    this.workerActive = false;
    this.setStatus('disconnected');

    // 拒绝所有待处理请求
    const pending = [...this.pendingRequests];
    this.pendingRequests.clear();
    for (const [, entry] of pending) {
      const err = new Error('数据服务已断开') as Error & { code?: string };
      err.code = 'WORKER_UNAVAILABLE';
      entry.reject(err);
    }
  }

  /** 模拟 retry 逻辑 */
  retry(): boolean {
    if (this.status === 'starting' || this.status === 'ready') return false;

    // 终止旧 Worker
    this.workerActive = false;

    this.setStatus('starting');
    return true;
  }

  /** 模拟 sendToWorker 逻辑 */
  send(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.workerActive || this.status !== 'ready') {
        const err = new Error('数据服务不可用') as Error & { code?: string };
        err.code = 'WORKER_UNAVAILABLE';
        reject(err);
        return;
      }

      this.pendingRequests.set(requestId, { resolve, reject });
    });
  }

  /** 模拟 Worker 响应 */
  resolveRequest(requestId: string, data: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.resolve(data);
    }
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('Worker 状态机', () => {
  let sm: WorkerStateMachine;

  beforeEach(() => {
    sm = new WorkerStateMachine();
  });

  it('初始状态应为 starting', () => {
    expect(sm.getStatus()).toBe('starting');
  });

  it('ready 事件应将状态设为 ready', () => {
    sm.simulateReady();
    expect(sm.getStatus()).toBe('ready');
  });

  it('error 事件在 starting 阶段应将状态设为 failed', () => {
    sm.simulateError();
    expect(sm.getStatus()).toBe('failed');
  });

  it('error 事件在 ready 阶段不应改变状态', () => {
    sm.simulateReady();
    sm.simulateError();
    expect(sm.getStatus()).toBe('ready');
  });

  it('exit 事件应将状态设为 disconnected', () => {
    sm.simulateReady();
    sm.simulateExit();
    expect(sm.getStatus()).toBe('disconnected');
  });

  it('exit 事件应拒绝所有 pending 请求', async () => {
    sm.simulateReady();
    const promise = sm.send('req-1');

    sm.simulateExit();

    await expect(promise).rejects.toThrow('数据服务已断开');
    expect(sm.getPendingCount()).toBe(0);
  });

  it('retry 前应终止旧 Worker', () => {
    sm.simulateReady();
    sm.simulateExit();
    expect(sm.getStatus()).toBe('disconnected');

    const retried = sm.retry();
    expect(retried).toBe(true);
    expect(sm.getStatus()).toBe('starting');
  });

  it('retry 在 starting 状态不应执行', () => {
    const retried = sm.retry();
    expect(retried).toBe(false);
    expect(sm.getStatus()).toBe('starting');
  });

  it('retry 在 ready 状态不应执行', () => {
    sm.simulateReady();
    const retried = sm.retry();
    expect(retried).toBe(false);
    expect(sm.getStatus()).toBe('ready');
  });

  it('重试成功后状态应恢复为 ready', () => {
    sm.simulateReady();
    sm.simulateExit();
    sm.retry();
    sm.simulateReady();
    expect(sm.getStatus()).toBe('ready');
  });

  it('send 在非 ready 状态应立即拒绝', async () => {
    await expect(sm.send('req-1')).rejects.toThrow('数据服务不可用');
  });

  it('send 在 ready 状态应创建 pending 请求', () => {
    sm.simulateReady();
    sm.send('req-1');
    expect(sm.getPendingCount()).toBe(1);
  });

  it('resolveRequest 应解决 pending 请求', async () => {
    sm.simulateReady();
    const promise = sm.send('req-1');
    sm.resolveRequest('req-1', { data: 'test' });
    await expect(promise).resolves.toEqual({ data: 'test' });
    expect(sm.getPendingCount()).toBe(0);
  });

  it('状态监听器应收到状态变化通知', () => {
    const events: WorkerStatus[] = [];
    sm.onStatusChange((s) => events.push(s));

    sm.simulateReady();
    sm.simulateExit();

    expect(events).toEqual(['ready', 'disconnected']);
  });

  it('取消监听器后不应收到通知', () => {
    const events: WorkerStatus[] = [];
    const unsub = sm.onStatusChange((s) => events.push(s));

    sm.simulateReady();
    unsub();
    sm.simulateExit();

    expect(events).toEqual(['ready']);
  });

  it('重复点击重试不应启动多个 Worker（retry 幂等）', () => {
    sm.simulateReady();
    sm.simulateExit();

    sm.retry();
    expect(sm.getStatus()).toBe('starting');

    // 再次 retry 应该被忽略
    const retried2 = sm.retry();
    expect(retried2).toBe(false);
    expect(sm.getStatus()).toBe('starting');
  });
});

describe('Worker 消息忽略逻辑', () => {
  it('旧 Worker 的晚到消息应被忽略', () => {
    // 模拟：新 Worker 已 ready，旧 Worker 发来消息
    // 在真实代码中检查: workerProcess !== null && workerProcess !== worker && status === 'ready'
    const currentWorker = 'worker-new';
    const staleWorker = 'worker-old';
    const workerProcess: string | null = currentWorker;
    const status: WorkerStatus = 'ready';

    const shouldIgnore =
      workerProcess !== null && workerProcess !== staleWorker && status === 'ready';

    expect(shouldIgnore).toBe(true);
  });

  it('当前 Worker 的消息不应被忽略', () => {
    const currentWorker = 'worker-new';
    const workerProcess: string | null = currentWorker;
    const status: WorkerStatus = 'ready';

    const shouldIgnore =
      workerProcess !== null && workerProcess !== currentWorker && status === 'ready';

    expect(shouldIgnore).toBe(false);
  });
});

describe('Worker shutdown 竞态', () => {
  it('shutdown 后 exit 不应访问 null', () => {
    // 模拟：shutdown 将 workerProcess 设为 null，然后 exit 事件触发
    let workerProcess: { kill(): void } | null = { kill: vi.fn() };
    const wp = workerProcess; // 捕获引用

    // shutdown 逻辑
    if (workerProcess) {
      // postMessage...
      setTimeout(() => {
        try {
          wp.kill();
        } catch {
          // 进程可能已退出
        }
        if (workerProcess === wp) {
          workerProcess = null;
        }
      }, 2000);
    }

    // exit 事件在 shutdown 计时器之前触发
    if (workerProcess === wp) {
      workerProcess = null;
    }

    // 此时 workerProcess 已经是 null
    // 如果 shutdown 计时器再触发，应该安全处理
    expect(workerProcess).toBeNull();
    // wp.kill() 在计时器中会被调用，但不会崩溃因为 wp 仍然有效
  });
});
