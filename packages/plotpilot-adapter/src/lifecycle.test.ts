import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { PlotPilotSidecarManager, type SidecarClock } from './lifecycle.js';

function createFakeChild(): ChildProcess & {
  emitExit(code: number | null, signal: string | null): void;
  emitError(err: Error): void;
} {
  const emitter = new EventEmitter() as ChildProcess & {
    emitExit(code: number | null, signal: string | null): void;
    emitError(err: Error): void;
  };
  let exitCode: number | null = null;
  let signalCode: string | null = null;

  Object.defineProperty(emitter, 'exitCode', { get: () => exitCode, configurable: true });
  Object.defineProperty(emitter, 'signalCode', { get: () => signalCode, configurable: true });
  Object.defineProperty(emitter, 'pid', { value: 12345, configurable: true });
  const fakeStdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const fakeStderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  Object.defineProperty(emitter, 'stdout', { value: fakeStdout, configurable: true });
  Object.defineProperty(emitter, 'stderr', { value: fakeStderr, configurable: true });

  emitter.kill = vi.fn((sig?: string) => {
    if (sig === 'SIGKILL' || sig === 'SIGTERM') {
      signalCode = sig;
      queueMicrotask(() => emitter.emit('exit', null, sig));
    }
    return true;
  }) as ChildProcess['kill'];

  emitter.emitExit = (code, signal) => {
    exitCode = code;
    signalCode = signal;
    emitter.emit('exit', code, signal);
  };
  emitter.emitError = (err) => emitter.emit('error', err);

  return emitter;
}

function createFakeClock(): SidecarClock & { tick(): void } {
  let time = 0;
  let pendingDelay: (() => void) | null = null;
  return {
    now: () => time,
    delay: () =>
      new Promise<void>((r) => {
        pendingDelay = r;
      }),
    tick: () => {
      time += 100;
      if (pendingDelay) {
        const fn = pendingDelay;
        pendingDelay = null;
        fn();
      }
    },
  };
}

const HEALTHY_RESPONSE = JSON.stringify({
  status: 'healthy',
  version: '1.0.0',
  build_id: 'test',
  uptime_seconds: 1,
  daemon_process: { running: false, pid: null },
});

function mockFetchHealthy(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(HEALTHY_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function mockFetchUnhealthy(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const BASE_OPTS = {
  plotPilotRoot: '/fake/plotpilot',
  pythonExecutable: '/usr/bin/python3',
  port: 8005,
  startupTimeoutMs: 5000,
  pollIntervalMs: 100,
  stopTimeoutMs: 1000,
};

describe('PlotPilotSidecarManager lifecycle', () => {
  let clock: ReturnType<typeof createFakeClock>;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = createFakeClock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. concurrent start only spawns once', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const p1 = mgr.start();
    const p2 = mgr.start();

    await flush();
    mockFetchHealthy();
    clock.tick();
    await flush();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(r1.state).toBe('READY_OWNED');
    expect(r2.state).toBe('READY_OWNED');
  });

  it('2. READY start does not spawn again', async () => {
    mockFetchHealthy();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    await mgr.start();
    expect(mgr.status().state).toBe('READY_EXTERNAL');

    await mgr.start();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('3. external service ready → READY_EXTERNAL', async () => {
    mockFetchHealthy();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const status = await mgr.start();
    expect(status.state).toBe('READY_EXTERNAL');
    expect(status.pid).toBeNull();
  });

  it('4. READY_EXTERNAL stop does not kill', async () => {
    mockFetchHealthy();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    await mgr.start();
    expect(mgr.status().state).toBe('READY_EXTERNAL');

    const status = await mgr.stop();
    expect(status.state).toBe('STOPPED');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('5. owned ready → READY_OWNED', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start();

    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockFetchHealthy();
    clock.tick();
    await flush();

    const status = await startP;
    expect(status.state).toBe('READY_OWNED');
    expect(status.pid).toBe(12345);
  });

  it('6. READY_OWNED stop kills only once', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start();
    await flush();
    mockFetchHealthy();
    clock.tick();
    await flush();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();
    await flush();
    clock.tick();
    await flush();
    await stopP;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mgr.status().state).toBe('STOPPED');
  });

  it('7. spawn ENOENT fails safely', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await flush();

    child.emitError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await flush();

    clock.tick();
    await flush();

    await startP;
    expect(caught).toMatchObject({ code: 'PLOTPILOT_UNAVAILABLE' });
    expect(mgr.status().state).toBe('FAILED');
  });

  it('8. child exits before readiness', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await flush();

    child.emitExit(1, null);
    await flush();
    clock.tick();
    await flush();

    await startP;
    expect(caught).toMatchObject({ code: 'PLOTPILOT_UNAVAILABLE' });
    expect(mgr.status().state).toBe('FAILED');
  });

  it('9. readiness timeout reclaims child', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager({ ...BASE_OPTS, startupTimeoutMs: 250 }, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await flush();

    clock.tick();
    await flush();
    clock.tick();
    await flush();
    clock.tick();
    await flush();

    await startP;
    expect(caught).toMatchObject({ code: 'PLOTPILOT_TIMEOUT' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mgr.status().state).toBe('FAILED');
  });

  it('10. start during STOPPING throws lifecycle error', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start();
    await flush();
    mockFetchHealthy();
    clock.tick();
    await flush();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();

    await expect(mgr.start()).rejects.toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });

    await flush();
    clock.tick();
    await flush();
    await stopP;
  });

  it('11. repeated stop is idempotent', async () => {
    mockFetchHealthy();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    await mgr.start();

    const s1 = await mgr.stop();
    const s2 = await mgr.stop();
    expect(s1.state).toBe('STOPPED');
    expect(s2.state).toBe('STOPPED');
  });

  it('12. child self-exit clears reference', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start();
    await flush();
    mockFetchHealthy();
    clock.tick();
    await flush();
    await startP;
    expect(mgr.status().state).toBe('READY_OWNED');

    child.emitExit(0, null);
    await flush();

    expect(mgr.status().state).toBe('FAILED');
    expect(mgr.status().pid).toBeNull();
  });

  it('13. stop timeout produces deterministic state', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => true);
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager({ ...BASE_OPTS, stopTimeoutMs: 100 }, clock);
    const startP = mgr.start();
    await flush();
    mockFetchHealthy();
    clock.tick();
    await flush();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();
    await flush();
    clock.tick();
    await flush();
    clock.tick();
    await flush();
    const status = await stopP;

    expect(status.state).toBe('STOPPED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('14. error/exit/close do not double-settle', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await flush();

    child.emitError(new Error('boom'));
    await flush();
    child.emitExit(1, null);
    child.emit('close', 1, null);
    await flush();

    clock.tick();
    await flush();

    await startP;
    expect(caught).toMatchObject({ code: 'PLOTPILOT_UNAVAILABLE' });
    expect(mgr.status().lastError).toBe('PlotPilot sidecar 进程启动失败');
  });

  it('15. timers and listeners are cleaned up after stop', async () => {
    mockFetchHealthy();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    await mgr.start();
    await mgr.stop();

    expect(mgr.status().state).toBe('STOPPED');
    expect(mgr.status().pid).toBeNull();
    expect(mgr.status().health).toBeNull();
  });
});
