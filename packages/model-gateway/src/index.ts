/**
 * @ai-novel/model-gateway
 *
 * 多 provider 模型网关（B1 / D6，最小形态）。
 *
 * 协议适配（`protocol.ts`）负责请求构造与响应解析；本文件只负责一次性的
 * HTTP 执行、超时与错误归一化，两种协议共用同一条路径：
 * - `anthropic-messages`（既有 MiMo V2.5 Pro 等）
 * - `openai-chat`（OpenAI 兼容端点，含 DeepSeek）
 *
 * 不安装任何厂商 SDK，使用 Node 内置 fetch。不做流式、自动重试、负载均衡与 fallback。
 *
 * 安全：apiKey 与响应正文都不进入返回值、异常或日志；上游错误 body 读取后丢弃，
 * 只以归一化 ErrorCode + 中文短消息返回。
 */

import type { ErrorCode, ProviderProtocol } from '@ai-novel/contracts';
import { adapterFor, type ParsedInvocation, type ProtocolAdapter } from './protocol.js';

export type {
  ProtocolAdapter,
  ProtocolRequest,
  ProtocolRequestInput,
  ParsedInvocation,
  NormalizedUsage,
} from './protocol.js';
export { adapterFor, anthropicMessagesAdapter, openAiChatAdapter } from './protocol.js';

// ── 类型 ──────────────────────────────────────────────────────────

/** 网关依赖（可注入 fetch 和 clock，方便测试） */
export interface ModelGatewayDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly clock: { now(): string };
}

/**
 * 协议是可选参数：缺省按 `anthropic-messages` 处理。
 * 这保证 B1 之前只认识单一 Anthropic 端点的调用方在迁移期不断。
 */
interface ProtocolSelector {
  readonly protocol?: ProviderProtocol;
}

/** 连接测试输入 */
export interface ConnectionTestInput extends ProtocolSelector {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/** 连接测试输出 */
export interface ConnectionTestOutput {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly errorCode: ErrorCode | null;
  readonly errorMessage: string | null;
}

/** 模型调用输入 */
export interface ModelInvocationInput extends ProtocolSelector {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly systemPrompt?: string;
  readonly temperature?: number;
}

/** 模型调用安全结果 —— 不包含原始响应正文 */
export interface ModelInvocationOutput {
  readonly text: string;
  readonly providerRequestId: string | null;
  readonly finishReason: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly latencyMs: number;
  readonly errorCode: ErrorCode | null;
  readonly errorMessage: string | null;
}

// ── 错误映射 ──────────────────────────────────────────────────────

function mapHttpStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'PROVIDER_AUTH_FAILED';
    case 403:
      return 'PROVIDER_ACCESS_DENIED';
    case 404:
      return 'PROVIDER_MODEL_UNAVAILABLE';
    case 429:
      return 'PROVIDER_RATE_LIMITED';
    default:
      return 'PROVIDER_CONNECTION_FAILED';
  }
}

/** 错误码到用户可理解消息的映射 — 不包含上游 body 或技术细节 */
function errorCodeToMessage(code: ErrorCode): string {
  switch (code) {
    case 'PROVIDER_AUTH_FAILED':
      return 'API Key 认证失败';
    case 'PROVIDER_ACCESS_DENIED':
      return '访问被拒绝';
    case 'PROVIDER_MODEL_UNAVAILABLE':
      return '模型不可用';
    case 'PROVIDER_RATE_LIMITED':
      return '请求频率超限';
    case 'PROVIDER_TIMEOUT':
      return '连接超时';
    case 'NETWORK_UNAVAILABLE':
      return '网络连接失败';
    case 'PROVIDER_CONNECTION_FAILED':
      return '连接失败';
    case 'PROVIDER_RESPONSE_INVALID':
      return '响应格式异常';
    default:
      return '连接失败';
  }
}

function mapThrownToErrorCode(err: unknown): ErrorCode {
  if (err instanceof Error && err.name === 'AbortError') return 'PROVIDER_TIMEOUT';
  if (err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'))) {
    return 'NETWORK_UNAVAILABLE';
  }
  return 'PROVIDER_CONNECTION_FAILED';
}

// ── 共用执行路径 ──────────────────────────────────────────────────

const TEST_TIMEOUT_MS = 20_000;
const INVOCATION_TIMEOUT_MS = 120_000;
const TEST_MAX_TOKENS = 32;
const DEFAULT_MAX_TOKENS = 4096;
const TEST_PROMPT = '只回复 OK';

type ExecuteResult =
  | { readonly ok: true; readonly parsed: ParsedInvocation; readonly latencyMs: number }
  | { readonly ok: false; readonly errorCode: ErrorCode; readonly latencyMs: number };

function selectAdapter(protocol: ProviderProtocol | undefined): ProtocolAdapter {
  return adapterFor(protocol ?? 'anthropic-messages');
}

/**
 * 执行一次非流式模型调用并归一化结果。
 * 无论哪种协议，超时 / 网络 / HTTP 状态 / JSON 解析 / 结构校验的归一化都只在这里发生一次。
 */
async function executeInvocation(
  deps: ModelGatewayDeps,
  adapter: ProtocolAdapter,
  input: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
    readonly prompt: string;
    readonly maxTokens: number;
    readonly systemPrompt?: string;
    readonly temperature?: number;
  },
  timeoutMs: number,
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const request = adapter.buildRequest(input);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await deps.fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers },
      body: request.body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      // 读取并丢弃 body：避免连接悬挂，同时不把上游内容带进返回值
      try {
        await response.text();
      } catch {
        // 忽略读取错误
      }
      return { ok: false, errorCode: mapHttpStatusToErrorCode(response.status), latencyMs };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, errorCode: 'PROVIDER_RESPONSE_INVALID', latencyMs };
    }

    const parsed = adapter.parse(data);
    if (!parsed) {
      return { ok: false, errorCode: 'PROVIDER_RESPONSE_INVALID', latencyMs };
    }
    return { ok: true, parsed, latencyMs };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, errorCode: mapThrownToErrorCode(err), latencyMs: Date.now() - startTime };
  }
}

const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: null,
} as const;

// ── 连接测试 ──────────────────────────────────────────────────────

/**
 * 测试与提供商的连接。
 *
 * 发送最小请求验证 API Key、端点与模型可用性；不自动重试，避免重复消耗配额。
 * 判定成功的条件与调用路径一致：HTTP 成功 + 响应结构合法 + 有非空文本。
 */
export async function testConnection(
  deps: ModelGatewayDeps,
  input: ConnectionTestInput,
): Promise<ConnectionTestOutput> {
  const result = await executeInvocation(
    deps,
    selectAdapter(input.protocol),
    {
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      prompt: TEST_PROMPT,
      maxTokens: TEST_MAX_TOKENS,
    },
    TEST_TIMEOUT_MS,
  );

  if (!result.ok) {
    return {
      success: false,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      errorMessage: errorCodeToMessage(result.errorCode),
    };
  }
  return { success: true, latencyMs: result.latencyMs, errorCode: null, errorMessage: null };
}

// ── 通用模型调用 ──────────────────────────────────────────────────

/**
 * 调用模型（非流式）。
 *
 * 返回安全结果（不含原始响应正文）。不自动重试。prompt 和 API Key 不进入异常。
 */
export async function invokeModel(
  deps: ModelGatewayDeps,
  input: ModelInvocationInput,
): Promise<ModelInvocationOutput> {
  const result = await executeInvocation(
    deps,
    selectAdapter(input.protocol),
    {
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      prompt: input.prompt,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    },
    INVOCATION_TIMEOUT_MS,
  );

  if (!result.ok) {
    return {
      text: '',
      providerRequestId: null,
      finishReason: null,
      usage: EMPTY_USAGE,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      errorMessage: errorCodeToMessage(result.errorCode),
    };
  }

  return {
    text: result.parsed.text,
    providerRequestId: result.parsed.providerRequestId,
    finishReason: result.parsed.finishReason,
    usage: result.parsed.usage,
    latencyMs: result.latencyMs,
    errorCode: null,
    errorMessage: null,
  };
}
