import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { PlotPilotAdapter, PlotPilotAdapterError, type PlotPilotHealth } from './index.js';

export interface PlotPilotSidecarOptions {
  readonly plotPilotRoot: string;
  readonly pythonExecutable?: string;
  readonly host?: string;
  readonly port?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly onLog?: (entry: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export type PlotPilotSidecarState = 'stopped' | 'starting' | 'ready' | 'failed' | 'stopping';

export interface PlotPilotSidecarStatus {
  readonly state: PlotPilotSidecarState;
  readonly pid: number | null;
  readonly health: PlotPilotHealth | null;
  readonly lastError: string | null;
}

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
};

export class PlotPilotSidecarManager {
  private readonly options: Required<
    Pick<
      PlotPilotSidecarOptions,
      'pythonExecutable' | 'host' | 'port' | 'startupTimeoutMs' | 'pollIntervalMs'
    >
  > &
    PlotPilotSidecarOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private state: PlotPilotSidecarState = 'stopped';
  private lastError: string | null = null;
  private healthSnapshot: PlotPilotHealth | null = null;

  constructor(options: PlotPilotSidecarOptions) {
    this.options = {
      ...options,
      pythonExecutable: options.pythonExecutable ?? 'python',
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 8005,
      startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
      pollIntervalMs: options.pollIntervalMs ?? 500,
    };
  }

  get adapter(): PlotPilotAdapter {
    return new PlotPilotAdapter({ baseUrl: `http://${this.options.host}:${this.options.port}` });
  }

  status(): PlotPilotSidecarStatus {
    return {
      state: this.state,
      pid: this.process?.pid ?? null,
      health: this.healthSnapshot,
      lastError: this.lastError,
    };
  }

  async start(): Promise<PlotPilotSidecarStatus> {
    if (this.state === 'ready' || this.state === 'starting') return this.status();

    const existing = await this.tryHealth();
    if (existing) {
      this.state = 'ready';
      this.healthSnapshot = existing;
      this.lastError = null;
      return this.status();
    }

    this.state = 'starting';
    this.lastError = null;
    const root = resolve(this.options.plotPilotRoot);
    const child = spawn(
      this.options.pythonExecutable,
      [
        '-m',
        'uvicorn',
        'interfaces.main:app',
        '--host',
        this.options.host,
        '--port',
        String(this.options.port),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...this.options.environment,
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.process = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => this.options.onLog?.({ stream: 'stdout', text }));
    child.stderr.on('data', (text: string) => this.options.onLog?.({ stream: 'stderr', text }));
    child.once('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      this.healthSnapshot = null;
      if (this.state !== 'stopping' && this.state !== 'stopped') {
        this.state = 'failed';
        this.lastError = `PlotPilot sidecar 已退出（code=${String(code)}, signal=${String(signal)}）`;
      } else {
        this.state = 'stopped';
      }
    });

    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const health = await this.tryHealth();
      if (health) {
        this.state = 'ready';
        this.healthSnapshot = health;
        return this.status();
      }
      await delay(this.options.pollIntervalMs);
    }

    this.state = 'failed';
    this.lastError = 'PlotPilot sidecar 启动超时';
    child.kill();
    throw new PlotPilotAdapterError('PLOTPILOT_TIMEOUT', this.lastError);
  }

  async stop(): Promise<PlotPilotSidecarStatus> {
    if (this.state === 'stopped') return this.status();
    this.state = 'stopping';

    try {
      await this.adapter.shutdown();
    } catch {
      this.process?.kill();
    }

    const processToStop = this.process;
    if (processToStop) {
      const deadline = Date.now() + 5_000;
      while (this.process === processToStop && Date.now() < deadline) await delay(100);
      if (this.process === processToStop) processToStop.kill('SIGKILL');
    }

    this.process = null;
    this.state = 'stopped';
    this.healthSnapshot = null;
    this.lastError = null;
    return this.status();
  }

  private async tryHealth(): Promise<PlotPilotHealth | null> {
    try {
      return await new PlotPilotAdapter({
        baseUrl: `http://${this.options.host}:${this.options.port}`,
        requestTimeoutMs: 1_000,
      }).health();
    } catch {
      return null;
    }
  }
}
