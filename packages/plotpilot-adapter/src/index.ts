export interface PlotPilotAdapterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly maxEventBytes?: number;
  readonly maxTotalBytes?: number;
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

export type PlotPilotErrorCode =
  | 'PLOTPILOT_UNAVAILABLE'
  | 'PLOTPILOT_TIMEOUT'
  | 'PLOTPILOT_ABORTED'
  | 'PLOTPILOT_HTTP_ERROR'
  | 'PLOTPILOT_RESPONSE_INVALID'
  | 'PLOTPILOT_BUFFER_OVERFLOW'
  | 'PLOTPILOT_CONFIG_INVALID'
  | 'PLOTPILOT_LIFECYCLE';

export class PlotPilotAdapterError extends Error {
  constructor(
    public readonly code: PlotPilotErrorCode,
    message: string,
    public readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'PlotPilotAdapterError';
  }
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8005';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
const DEFAULT_MAX_TOTAL_BYTES = 67_108_864;

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

interface SseParsedFrame {
  data: string;
  event: string | null;
  id: string | null;
  retry: number | null;
}

function parseSseBlock(block: string): SseParsedFrame | null {
  let data = '';
  let hasData = false;
  let event: string | null = null;
  let id: string | null = null;
  let retry: number | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith(':')) continue;
    if (line === '') continue;

    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIndex === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'data':
        hasData = true;
        data += (data ? '\n' : '') + value;
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) retry = n;
        break;
      }
      default:
        break;
    }
  }

  if (!hasData && event === null && id === null && retry === null) return null;
  return { data, event, id, retry };
}

function frameToStreamEvent(frame: SseParsedFrame): PlotPilotStreamEvent | null {
  if (!frame.data) return null;
  if (frame.data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    if (isRecord(parsed) && typeof parsed.type === 'string') {
      return parsed as PlotPilotStreamEvent;
    }
    return null;
  } catch {
    throw new PlotPilotAdapterError(
      'PLOTPILOT_RESPONSE_INVALID',
      'PlotPilot SSE 事件不是有效 JSON',
    );
  }
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; maxEventBytes?: number; maxTotalBytes?: number } = {},
): AsyncGenerator<PlotPilotStreamEvent> {
  const maxEvent = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) {
      reader.releaseLock();
      throw new PlotPilotAdapterError('PLOTPILOT_ABORTED', 'PlotPilot 流式请求已取消');
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxTotal) {
          throw new PlotPilotAdapterError(
            'PLOTPILOT_BUFFER_OVERFLOW',
            'PlotPilot SSE 流超出总大小限制',
          );
        }
        buffer += decoder.decode(value, { stream: true });
      }

      let sepIndex: number;
      while ((sepIndex = findSeparator(buffer)) >= 0) {
        const block = buffer.slice(0, sepIndex);
        const sepLen = buffer[sepIndex] === '\r' ? 4 : 2;
        buffer = buffer.slice(sepIndex + sepLen);

        if (block.length > maxEvent) {
          throw new PlotPilotAdapterError(
            'PLOTPILOT_BUFFER_OVERFLOW',
            'PlotPilot SSE 单事件超出大小限制',
          );
        }

        const frame = parseSseBlock(block);
        if (frame) {
          const event = frameToStreamEvent(frame);
          if (event) yield event;
        }
      }

      if (buffer.length > maxEvent) {
        throw new PlotPilotAdapterError(
          'PLOTPILOT_BUFFER_OVERFLOW',
          'PlotPilot SSE 单事件超出大小限制',
        );
      }

      if (done) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const frame = parseSseBlock(buffer);
      if (frame) {
        const event = frameToStreamEvent(frame);
        if (event) yield event;
      }
    }
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    reader.releaseLock();
  }
}

function findSeparator(buffer: string): number {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  if (lfIndex === -1) return crlfIndex;
  if (crlfIndex === -1) return lfIndex;
  return Math.min(lfIndex, crlfIndex);
}

export class PlotPilotAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxEventBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: PlotPilotAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  async health(signal?: AbortSignal): Promise<PlotPilotHealth> {
    const response = await this.request('/health', { method: 'GET' }, signal, true);
    return parseHealth(await response.json());
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.request('/internal/shutdown', { method: 'POST' }, signal, true);
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
      },
      handlers.signal,
      false,
    );

    if (!response.body) {
      throw new PlotPilotAdapterError('PLOTPILOT_RESPONSE_INVALID', 'PlotPilot 未返回流式响应');
    }

    for await (const event of parseSseStream(response.body, {
      signal: handlers.signal,
      maxEventBytes: this.maxEventBytes,
      maxTotalBytes: this.maxTotalBytes,
    })) {
      handlers.onEvent?.(event);
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    callerSignal: AbortSignal | undefined,
    useTimeout: boolean,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    if (useTimeout) {
      timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    }

    const signals: AbortSignal[] = [timeoutController.signal];
    if (callerSignal) signals.push(callerSignal);
    const combinedSignal = AbortSignal.any(signals);

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
        if (callerSignal?.aborted) {
          throw new PlotPilotAdapterError('PLOTPILOT_ABORTED', 'PlotPilot 请求已取消');
        }
        throw new PlotPilotAdapterError('PLOTPILOT_TIMEOUT', 'PlotPilot 请求超时');
      }
      throw new PlotPilotAdapterError('PLOTPILOT_UNAVAILABLE', '无法连接 PlotPilot sidecar');
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}

export * from './lifecycle.js';
