/**
 * PlotPilot sidecar adapter.
 *
 * This package deliberately exposes a narrow, typed boundary. The Electron
 * renderer must never call PlotPilot directly; calls should be routed through
 * the application's Worker/Main IPC boundary.
 */

export interface PlotPilotAdapterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

export interface PlotPilotHealth {
  readonly status: string;
  readonly version: string;
  readonly buildId: string;
  readonly uptimeSeconds: number;
  readonly daemonRunning: boolean;
  readonly daemonPid: number | null;
}

export type InvocationPolicy =
  | 'DIRECT'
  | 'REVIEW_BEFORE_CALL'
  | 'REVIEW_AFTER_CALL'
  | 'FULL_INTERACTIVE'
  | 'INTERACTIVE_WHEN_AVAILABLE'
  | 'AUTOPILOT_PAUSE';

export interface GenerateChapterInput {
  readonly novelId: string;
  readonly chapterNumber: number;
  readonly outline: string;
  readonly sceneDirectorResult?: Readonly<Record<string, unknown>>;
  readonly invocationPolicy?: InvocationPolicy;
  readonly regenerationGuidance?: string;
  readonly profileId?: string;
  readonly scriptPromptTemplate?: string;
  readonly prosePromptTemplate?: string;
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly allowEvolutionGateBypass?: boolean;
}

export interface HostedWriteInput {
  readonly novelId: string;
  readonly fromChapter: number;
  readonly toChapter: number;
  readonly autoSave: boolean;
  readonly autoOutline: boolean;
}

export type PlotPilotStreamEvent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

export interface StreamHandlers {
  readonly onEvent?: (event: PlotPilotStreamEvent) => void;
  readonly signal?: AbortSignal;
}

export class PlotPilotAdapterError extends Error {
  constructor(
    public readonly code:
      | 'PLOTPILOT_UNAVAILABLE'
      | 'PLOTPILOT_TIMEOUT'
      | 'PLOTPILOT_HTTP_ERROR'
      | 'PLOTPILOT_RESPONSE_INVALID',
    message: string,
    public readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'PlotPilotAdapterError';
  }
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8005';
const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHealth(value: unknown): PlotPilotHealth {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', 'PlotPilot 健康检查响应无效');
  }

  const daemon = isRecord(value.daemon_process) ? value.daemon_process : {};
  return {
    status: value.status,
    version: typeof value.version === 'string' ? value.version : 'unknown',
    buildId: typeof value.build_id === 'string' ? value.build_id : 'unknown',
    uptimeSeconds: typeof value.uptime_seconds === 'number' ? value.uptime_seconds : 0,
    daemonRunning: daemon.running === true,
    daemonPid: typeof daemon.pid === 'number' ? daemon.pid : null,
  };
}

function parseSseFrame(frame: string): PlotPilotStreamEvent[] {
  const events: PlotPilotStreamEvent[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trimStart();
    if (!payload) continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isRecord(parsed) && typeof parsed.type === 'string') {
        events.push(parsed as PlotPilotStreamEvent);
      }
    } catch {
      throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', 'PlotPilot SSE 事件不是有效 JSON');
    }
  }
  return events;
}

export class PlotPilotAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: PlotPilotAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(signal?: AbortSignal): Promise<PlotPilotHealth> {
    const response = await this.request('/health', { method: 'GET', signal });
    return parseHealth(await response.json());
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.request('/internal/shutdown', { method: 'POST', signal });
  }

  async generateChapter(input: GenerateChapterInput, handlers: StreamHandlers = {}): Promise<void> {
    if (!input.novelId.trim() || input.chapterNumber < 1 || !input.outline.trim()) {
      throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', '章节生成参数无效');
    }

    await this.consumeSse(
      `/api/v1/novels/${encodeURIComponent(input.novelId)}/generate-chapter-stream`,
      {
        chapter_number: input.chapterNumber,
        outline: input.outline,
        scene_director_result: input.sceneDirectorResult,
        invocation_policy: input.invocationPolicy,
        regeneration_guidance: input.regenerationGuidance,
        profile_id: input.profileId,
        script_prompt_template: input.scriptPromptTemplate,
        prose_prompt_template: input.prosePromptTemplate,
        prompt_variables: input.promptVariables,
        allow_evolution_gate_bypass: input.allowEvolutionGateBypass ?? false,
      },
      handlers,
    );
  }

  async hostedWrite(input: HostedWriteInput, handlers: StreamHandlers = {}): Promise<void> {
    if (!input.novelId.trim() || input.fromChapter < 1 || input.toChapter < input.fromChapter) {
      throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', '托管写作参数无效');
    }

    await this.consumeSse(
      `/api/v1/novels/${encodeURIComponent(input.novelId)}/hosted-write-stream`,
      {
        from_chapter: input.fromChapter,
        to_chapter: input.toChapter,
        auto_save: input.autoSave,
        auto_outline: input.autoOutline,
      },
      handlers,
    );
  }

  private async consumeSse(
    path: string,
    body: Readonly<Record<string, unknown>>,
    handlers: StreamHandlers,
  ): Promise<void> {
    const response = await this.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: handlers.signal,
      },
      false,
    );

    if (!response.body) {
      throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', 'PlotPilot 未返回流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });

        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          for (const event of parseSseFrame(frame)) handlers.onEvent?.(event);
        }

        if (done) break;
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const event of parseSseFrame(buffer)) handlers.onEvent?.(event);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(path: string, init: RequestInit, useTimeout = true): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = useTimeout
      ? setTimeout(() => timeoutController.abort(), this.requestTimeoutMs)
      : null;

    const combinedSignal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: combinedSignal,
      });
      if (!response.ok) {
        throw new PlotPilotAdapterError(
          'PLOTPILOT_HTTP_ERROR',
          `PlotPilot 请求失败：HTTP ${response.status}`,
          response.status,
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof PlotPilotAdapterError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlotPilotAdapterError('PLOTPILOT_TIMEOUT', 'PlotPilot 请求超时或已取消');
      }
      throw new PlotPilotAdapterError('PLOTPILOT_UNAVAILABLE', '无法连接 PlotPilot sidecar');
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}

export * from './lifecycle.js';
