import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PlotPilotAdapter, PlotPilotAdapterError, type PlotPilotHealth } from './index.js';

export type PlotPilotSidecarState =
  'STOPPED' | 'STARTING' | 'READY_OWNED' | 'READY_EXTERNAL' | 'STOPPING' | 'FAILED';

export interface PlotPilotSidecarOptions {
  readonly plotPilotRoot: string;
  readonly pythonExecutable?: string;
  readonly host?: string;
  readonly port?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onLog?: (entry: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface PlotPilotSidecarStatus {
  readonly state: PlotPilotSidecarState;
  readonly pid: number | null;
  readonly health: PlotPilotHealth | null;
  readonly lastError: string | null;
}

export interface SidecarClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

const realClock: SidecarClock = {
  now: () => Date.now(),
  delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'PYTHONUNBUFFERED',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
];

const SENSITIVE_KEY_PATTERN =
  /key|token|secret|bearer|password|credential|auth|api.?key|sk-|openai|anthropic|claude|mimo|github|npm/i;

export function sanitizeLogText(text: string): string {
  let result = text.slice(0, 2048);
  result = result.replace(/\/Users\/[^\s"']+/g, '<home>');
  result = result.replace(/\/home\/[^\s"']+/g, '<home>');
  result = result.replace(/C:\\Users\\[^\s"']+/g, '<home>');
  result = result.replace(/Traceback \(most recent call last\):[\s\S]*$/g, '<traceback omitted>');
  result = result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>');
  result = result.replace(/sk-[A-Za-z0-9_-]{10,}/g, '<redacted>');
  result = result.replace(/(?:key|token|secret|password)\s*[=:]\s*[^\s"']+/gi, '<redacted>');
  return result;
}

export function buildSidecarEnv(
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      env[key] = value;
    }
  }
  env.PYTHONUNBUFFERED = '1';
  return env;
}

export function resolvePythonExecutable(options: PlotPilotSidecarOptions): string {
  const explicit = options.pythonExecutable?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.PLOTPILOT_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  throw new PlotPilotAdapterError('PLOTPILOT_CONFIG_INVALID', '未配置 Python 可执行文件路径');
}

export function validateSidecarConfig(options: PlotPilotSidecarOptions): void {
  const root = resolve(options.plotPilotRoot);
  if (!existsSync(root)) {
    throw new PlotPilotAdapterError('PLOTPILOT_CONFIG_INVALID', 'PlotPilot checkout 目录不存在');
  }
  const entry = join(root, 'interfaces', 'main.py');
  if (!existsSync(entry)) {
    throw new PlotPilotAdapterError('PLOTPILOT_CONFIG_INVALID', 'PlotPilot 入口文件不存在');
  }
  resolvePythonExecutable(options);
  const port = options.port ?? 8005;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PlotPilotAdapterError('PLOTPILOT_CONFIG_INVALID', '端口号无效');
  }
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new PlotPilotAdapterError(
      'PLOTPILOT_CONFIG_INVALID',
      'PlotPilot sidecar 仅允许绑定 loopback 地址',
    );
  }
}

export class PlotPilotSidecarManager {
  private readonly opts: Required<
    Pick<
      PlotPilotSidecarOptions,
      'host' | 'port' | 'startupTimeoutMs' | 'pollIntervalMs' | 'stopTimeoutMs'
    >
  > &
    PlotPilotSidecarOptions;
  private readonly clock: SidecarClock;
  private child: ChildProcess | null = null;
  private state: PlotPilotSidecarState = 'STOPPED';
  private lastError: string | null = null;
  private healthSnapshot: PlotPilotHealth | null = null;
  private startPromise: Promise<PlotPilotSidecarStatus> | null = null;
  private stopPromise: Promise<PlotPilotSidecarStatus> | null = null;
  private generation = 0;

  constructor(options: PlotPilotSidecarOptions, clock: SidecarClock = realClock) {
    this.opts = {
      ...options,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8005,
      startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
      pollIntervalMs: options.pollIntervalMs ?? 500,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
    };
    this.clock = clock;
  }

  get adapter(): PlotPilotAdapter {
    return new PlotPilotAdapter({ baseUrl: `http://${this.opts.host}:${this.opts.port}` });
  }

  status(): PlotPilotSidecarStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      health: this.healthSnapshot,
      lastError: this.lastError,
    };
  }

  async start(): Promise<PlotPilotSidecarStatus> {
    if (this.state === 'STOPPING' || this.stopPromise) {
      throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 正在停止中，无法启动');
    }
    if (this.startPromise) return this.startPromise;
    if (this.state === 'READY_OWNED' || this.state === 'READY_EXTERNAL') {
      return this.status();
    }

    this.state = 'STARTING';
    this.startPromise = this.doStart(++this.generation);
    this.startPromise.catch(() => {});
    try {
      return await this.startPromise;
    } catch (err) {
      if ((this.state as string) === 'STARTING') {
        this.state = 'FAILED';
        this.lastError = err instanceof Error ? err.message : 'PlotPilot 启动失败';
      }
      throw err;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<PlotPilotSidecarStatus> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.doStop(++this.generation);
    this.stopPromise.catch(() => {});
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(gen: number): Promise<PlotPilotSidecarStatus> {
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
    }

    if (this.generation !== gen) return this.status();

    if (this.state === 'READY_EXTERNAL') {
      this.state = 'STOPPED';
      this.healthSnapshot = null;
      this.lastError = null;
      return this.status();
    }

    if (this.state === 'STOPPED' || this.state === 'FAILED') {
      this.state = 'STOPPED';
      this.child = null;
      this.healthSnapshot = null;
      this.lastError = null;
      return this.status();
    }

    this.state = 'STOPPING';
    const childToStop = this.child;

    if (childToStop && childToStop.exitCode === null && childToStop.signalCode === null) {
      try {
        await this.adapter.shutdown();
      } catch {
        // graceful shutdown failed
      }

      if (
        this.child === childToStop &&
        childToStop.exitCode === null &&
        childToStop.signalCode === null
      ) {
        childToStop.kill('SIGTERM');
        const deadline = this.clock.now() + this.opts.stopTimeoutMs;
        while (
          this.child === childToStop &&
          childToStop.exitCode === null &&
          this.clock.now() < deadline
        ) {
          await this.clock.delay(50);
        }
        if (
          this.child === childToStop &&
          childToStop.exitCode === null &&
          childToStop.signalCode === null
        ) {
          childToStop.kill('SIGKILL');
        }
      }
    }

    this.child = null;
    this.state = 'STOPPED';
    this.healthSnapshot = null;
    this.lastError = null;
    return this.status();
  }

  private async doStart(gen: number): Promise<PlotPilotSidecarStatus> {
    validateSidecarConfig(this.opts);
    const pythonExe = resolvePythonExecutable(this.opts);

    if (this.generation !== gen) {
      this.state = 'STOPPED';
      throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
    }

    const existing = await this.tryHealth();

    if (this.generation !== gen) {
      this.state = 'STOPPED';
      throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
    }

    if (existing) {
      this.state = 'READY_EXTERNAL';
      this.healthSnapshot = existing;
      this.lastError = null;
      return this.status();
    }

    this.lastError = null;

    let child: ChildProcess;
    try {
      child = spawn(
        pythonExe,
        [
          '-m',
          'uvicorn',
          'interfaces.main:app',
          '--host',
          this.opts.host,
          '--port',
          String(this.opts.port),
        ],
        {
          cwd: resolve(this.opts.plotPilotRoot),
          env: buildSidecarEnv(this.opts.environment),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        },
      );
    } catch {
      this.state = 'FAILED';
      this.lastError = 'PlotPilot sidecar 进程创建失败';
      throw new PlotPilotAdapterError('PLOTPILOT_UNAVAILABLE', this.lastError);
    }

    if (this.generation !== gen) {
      child.kill('SIGKILL');
      this.state = 'STOPPED';
      throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
    }

    this.child = child;
    let settled = false;

    const settleOnce = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on('error', () => {
      settleOnce(() => {
        if (this.child === child) {
          this.child = null;
          this.healthSnapshot = null;
          if (this.state === 'STARTING' || this.state === 'READY_OWNED') {
            this.state = 'FAILED';
            this.lastError = 'PlotPilot sidecar 进程启动失败';
          }
        }
      });
    });

    child.on('exit', (code, signal) => {
      settleOnce(() => {
        if (this.child === child) {
          this.child = null;
          this.healthSnapshot = null;
          if (this.state !== 'STOPPING' && this.state !== 'STOPPED') {
            this.state = 'FAILED';
            this.lastError = `PlotPilot sidecar 已退出（code=${String(code)}, signal=${String(signal)}）`;
          } else {
            this.state = 'STOPPED';
          }
        }
      });
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) =>
        this.opts.onLog?.({ stream: 'stdout', text: sanitizeLogText(text) }),
      );
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) =>
        this.opts.onLog?.({ stream: 'stderr', text: sanitizeLogText(text) }),
      );
    }

    const deadline = this.clock.now() + this.opts.startupTimeoutMs;
    while (this.clock.now() < deadline) {
      if (this.generation !== gen) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        this.child = null;
        this.state = 'STOPPED';
        throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
      }
      if (this.child !== child) break;
      if (child.exitCode !== null || child.signalCode !== null) break;
      const health = await this.tryHealth();
      if (this.generation !== gen) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        this.child = null;
        this.state = 'STOPPED';
        throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
      }
      if (health) {
        this.state = 'READY_OWNED';
        this.healthSnapshot = health;
        return this.status();
      }
      await this.clock.delay(this.opts.pollIntervalMs);
    }

    if (this.generation !== gen) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      this.child = null;
      this.state = 'STOPPED';
      throw new PlotPilotAdapterError('PLOTPILOT_LIFECYCLE', 'PlotPilot 启动已取消');
    }

    if ((this.state as string) === 'FAILED') {
      throw new PlotPilotAdapterError(
        'PLOTPILOT_UNAVAILABLE',
        this.lastError ?? 'PlotPilot sidecar 启动失败',
      );
    }

    this.state = 'FAILED';
    this.lastError = 'PlotPilot sidecar 启动超时';
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    this.child = null;
    throw new PlotPilotAdapterError('PLOTPILOT_TIMEOUT', this.lastError);
  }

  private async tryHealth(): Promise<PlotPilotHealth | null> {
    try {
      return await new PlotPilotAdapter({
        baseUrl: `http://${this.opts.host}:${this.opts.port}`,
        requestTimeoutMs: 1_000,
      }).health();
    } catch {
      return null;
    }
  }
}
