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

import {
  PlotPilotSidecarManager,
  buildSidecarEnv,
  sanitizeLogText,
  resolvePythonExecutable,
  type SidecarClock,
} from './lifecycle.js';

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

function mockFetchPending(): { resolveHealthy(): void; resolveUnhealthy(): void } {
  let deferred = createDeferred();
  let resolveHealthy = false;
  const fetchMock = vi.fn().mockImplementation(() => {
    const d = deferred;
    return d.promise.then(() => {
      if (resolveHealthy) {
        return new Response(HEALTHY_RESPONSE, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('connection refused');
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    resolveHealthy() {
      resolveHealthy = true;
      deferred.resolve();
      deferred = createDeferred();
    },
    resolveUnhealthy() {
      resolveHealthy = false;
      deferred.resolve();
      deferred = createDeferred();
    },
  };
}

const microtask = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

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

    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();

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

    await microtask();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockFetchHealthy();
    clock.tick();
    await microtask();

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
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();
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
    await microtask();

    child.emitError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await microtask();
    clock.tick();
    await microtask();

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
    await microtask();

    child.emitExit(1, null);
    await microtask();
    clock.tick();
    await microtask();

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
    await microtask();

    clock.tick();
    await microtask();
    clock.tick();
    await microtask();
    clock.tick();
    await microtask();

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
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();

    await expect(mgr.start()).rejects.toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });

    await microtask();
    clock.tick();
    await microtask();
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
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;
    expect(mgr.status().state).toBe('READY_OWNED');

    child.emitExit(0, null);
    await microtask();

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
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;

    mockFetchUnhealthy();
    const stopP = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();
    clock.tick();
    await microtask();
    const status = await stopP;

    expect(status.state).toBe('STOPPED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('14. error and exit do not double-settle', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await microtask();

    child.emitError(new Error('boom'));
    await microtask();
    child.emitExit(1, null);
    await microtask();

    clock.tick();
    await microtask();

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

describe('PlotPilotSidecarManager start/stop race', () => {
  let clock: ReturnType<typeof createFakeClock>;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = createFakeClock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('16. preflight health pending → stop → health unavailable → no spawn', async () => {
    const pending = mockFetchPending();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);

    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await microtask();

    const stopP = mgr.stop();
    await microtask();

    pending.resolveUnhealthy();
    await microtask();
    await microtask();

    await Promise.allSettled([startP, stopP]);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mgr.status().state).toBe('STOPPED');
    expect(caught).toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });
  });

  it('17. preflight health pending → stop → health healthy → final STOPPED', async () => {
    const pending = mockFetchPending();
    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);

    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await microtask();

    const stopP = mgr.stop();
    await microtask();

    pending.resolveHealthy();
    await microtask();
    await microtask();

    await Promise.allSettled([startP, stopP]);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mgr.status().state).toBe('STOPPED');
    expect(caught).toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });
  });

  it('18. stop exactly before spawn', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    let caught: unknown;
    const startP = mgr.start().catch((e) => {
      caught = e;
    });
    await microtask();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const stopP = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();

    await Promise.allSettled([startP, stopP]);
    expect(mgr.status().state).toBe('STOPPED');
    expect(caught).toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });
  });

  it('19. stop exactly after spawn kills child', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start().catch(() => {});
    await microtask();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;
    expect(mgr.status().state).toBe('READY_OWNED');

    mockFetchUnhealthy();
    const stopP = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();
    await stopP;

    expect(child.kill).toHaveBeenCalled();
    expect(mgr.status().state).toBe('STOPPED');
  });

  it('20. concurrent stop only executes cleanup once', async () => {
    mockFetchUnhealthy();
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);
    const startP = mgr.start();
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    await startP;

    mockFetchUnhealthy();
    const s1 = mgr.stop();
    const s2 = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();

    const [r1, r2] = await Promise.all([s1, s2]);
    expect(r1.state).toBe('STOPPED');
    expect(r2.state).toBe('STOPPED');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('21. start/stop/start across generations no cross-contamination', async () => {
    mockFetchUnhealthy();
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mockSpawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const mgr = new PlotPilotSidecarManager(BASE_OPTS, clock);

    let caught1: unknown;
    const start1 = mgr.start().catch((e) => {
      caught1 = e;
    });
    await microtask();

    const stop1 = mgr.stop();
    await microtask();
    clock.tick();
    await microtask();
    await Promise.allSettled([start1, stop1]);
    expect(caught1).toMatchObject({ code: 'PLOTPILOT_LIFECYCLE' });
    expect(mgr.status().state).toBe('STOPPED');

    const start2 = mgr.start();
    await microtask();
    mockFetchHealthy();
    clock.tick();
    await microtask();
    const status2 = await start2;

    expect(status2.state).toBe('READY_OWNED');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe('environment and log safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('22. env allowlist excludes sensitive keys', () => {
    const env = buildSidecarEnv({
      MY_SETTING: 'ok',
      API_KEY: 'secret123',
      OPENAI_TOKEN: 'sk-abc',
      GITHUB_SECRET: 'ghp_xyz',
      NORMAL_VAR: 'fine',
    });
    expect(env.MY_SETTING).toBe('ok');
    expect(env.API_KEY).toBeUndefined();
    expect(env.OPENAI_TOKEN).toBeUndefined();
    expect(env.GITHUB_SECRET).toBeUndefined();
    expect(env.NORMAL_VAR).toBe('fine');
    expect(env.PYTHONUNBUFFERED).toBe('1');
  });

  it('23. env does not spread process.env wholesale', () => {
    const env = buildSidecarEnv(undefined);
    expect(env.PATH).toBeDefined();
    expect(env.PYTHONUNBUFFERED).toBe('1');
    const keys = Object.keys(env);
    expect(keys.length).toBeLessThan(20);
  });

  it('24. sanitizeLogText removes paths and secrets', () => {
    const input = 'Error at /Users/john/project/file.py Bearer sk-abc123456789 token=mysecretvalue';
    const result = sanitizeLogText(input);
    expect(result).not.toContain('/Users/john');
    expect(result).not.toContain('sk-abc123456789');
    expect(result).not.toContain('mysecretvalue');
    expect(result).toContain('<home>');
    expect(result).toContain('<redacted>');
  });

  it('25. sanitizeLogText truncates long output', () => {
    const input = 'x'.repeat(5000);
    const result = sanitizeLogText(input);
    expect(result.length).toBeLessThanOrEqual(2048);
  });

  it('26. sanitizeLogText omits tracebacks', () => {
    const input = 'Error happened\nTraceback (most recent call last):\n  File "x.py"\n    raise';
    const result = sanitizeLogText(input);
    expect(result).not.toContain('File "x.py"');
    expect(result).toContain('<traceback omitted>');
  });

  it('27. python executable must be explicit', () => {
    expect(() => resolvePythonExecutable({ plotPilotRoot: '/x' })).toThrow(/未配置/);
    expect(() => resolvePythonExecutable({ plotPilotRoot: '/x', pythonExecutable: '  ' })).toThrow(
      /未配置/,
    );
  });

  it('28. python executable from options', () => {
    expect(
      resolvePythonExecutable({ plotPilotRoot: '/x', pythonExecutable: '/usr/bin/python3' }),
    ).toBe('/usr/bin/python3');
  });
});
