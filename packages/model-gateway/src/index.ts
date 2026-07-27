/**
 * @ai-novel/model-gateway
 *
 * Anthropic-compatible 模型网关。
 *
 * 本阶段支持 MiMo V2.5 Pro 连接测试和通用模型调用。
 * 不安装 Anthropic SDK，使用 Node 24 内置 fetch。
 */

import type { ErrorCode } from '@ai-novel/contracts';

// ── 类型 ──────────────────────────────────────────────────────────

/** 网关依赖（可注入 fetch 和 clock，方便测试） */
export interface ModelGatewayDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly clock: { now(): string };
}

/** 连接测试输入 */
export interface ConnectionTestInput {
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
      if (status >= 500) return 'PROVIDER_CONNECTION_FAILED';
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

// ── 响应验证 ──────────────────────────────────────────────────────

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
}

interface AnthropicResponse {
  readonly id?: string;
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly stop_reason?: string;
}

function isValidAnthropicResponse(data: unknown): data is AnthropicResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return false;
  return true;
}

function hasNonEmptyTextContent(content: ReadonlyArray<AnthropicContentBlock>): boolean {
  return content.some(
    (block) => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0,
  );
}

// ── 通用调用类型 ──────────────────────────────────────────────────

/** 模型调用输入 */
export interface ModelInvocationInput {
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

// ── Anthropic 响应类型 ────────────────────────────────────────────

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface AnthropicFullResponse {
  readonly id?: string;
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly stop_reason?: string;
  readonly usage?: AnthropicUsage;
}

// ── 连接测试 ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 32;
const TEST_PROMPT = '只回复 OK';

/**
 * 测试与 Anthropic-compatible 提供商的连接。
 *
 * 发送最小请求验证 API Key 和服务可用性。
 * 不自动重试，避免重复消耗配额。
 */
export async function testConnection(
  deps: ModelGatewayDeps,
  input: ConnectionTestInput,
): Promise<ConnectionTestOutput> {
  const { fetch } = deps;
  const startTime = Date.now();

  // 构造 URL（从固定 profile，不接受 Renderer URL）
  const url = `${input.baseUrl.replace(/\/+$/, '')}/v1/messages`;

  // 构造请求体
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: TEST_PROMPT }],
  });

  // AbortController 超时
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': input.apiKey,
        'content-type': 'application/json',
      },
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    // 检查 HTTP 状态
    if (!response.ok) {
      // 读取 body 用于内部诊断（不发送给 Renderer）
      try {
        await response.text();
      } catch {
        // 忽略读取错误
      }

      const errorCode = mapHttpStatusToErrorCode(response.status);

      return {
        success: false,
        latencyMs,
        errorCode,
        errorMessage: errorCodeToMessage(errorCode),
      };
    }

    // 解析响应
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        success: false,
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    // 验证响应结构
    if (!isValidAnthropicResponse(data)) {
      return {
        success: false,
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    // 验证至少存在非空 text content
    if (!data.content || !hasNonEmptyTextContent(data.content)) {
      return {
        success: false,
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    return {
      success: true,
      latencyMs,
      errorCode: null,
      errorMessage: null,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    // AbortError → 超时
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        success: false,
        latencyMs,
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: errorCodeToMessage('PROVIDER_TIMEOUT'),
      };
    }

    // 网络错误
    if (err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'))) {
      return {
        success: false,
        latencyMs,
        errorCode: 'NETWORK_UNAVAILABLE',
        errorMessage: errorCodeToMessage('NETWORK_UNAVAILABLE'),
      };
    }

    // 其他错误
    return {
      success: false,
      latencyMs,
      errorCode: 'PROVIDER_CONNECTION_FAILED',
      errorMessage: errorCodeToMessage('PROVIDER_CONNECTION_FAILED'),
    };
  }
}

// ── 通用模型调用 ──────────────────────────────────────────────────

const INVOCATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * 调用 Anthropic-compatible 模型。
 *
 * 发送用户消息，返回安全结果（不含原始响应正文）。
 * 不自动重试。prompt 和 API Key 不进入异常。
 */
export async function invokeModel(
  deps: ModelGatewayDeps,
  input: ModelInvocationInput,
): Promise<ModelInvocationOutput> {
  const { fetch } = deps;
  const startTime = Date.now();

  const url = `${input.baseUrl.replace(/\/+$/, '')}/v1/messages`;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: input.prompt },
  ];

  const requestBody: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };

  if (input.systemPrompt) {
    requestBody.system = input.systemPrompt;
  }
  if (input.temperature !== undefined) {
    requestBody.temperature = input.temperature;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INVOCATION_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': input.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      try {
        await response.text();
      } catch {
        // 忽略
      }

      const errorCode = mapHttpStatusToErrorCode(response.status);
      return {
        text: '',
        providerRequestId: null,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode,
        errorMessage: errorCodeToMessage(errorCode),
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        text: '',
        providerRequestId: null,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    if (!isValidAnthropicResponse(data)) {
      return {
        text: '',
        providerRequestId: null,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    const fullData = data as AnthropicFullResponse;

    // 提取文本
    const textBlocks = fullData.content?.filter((b) => b.type === 'text' && b.text) ?? [];
    const text = textBlocks.map((b) => b.text ?? '').join('');

    if (!text) {
      return {
        text: '',
        providerRequestId: fullData.id ?? null,
        finishReason: fullData.stop_reason ?? null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode: 'PROVIDER_RESPONSE_INVALID',
        errorMessage: errorCodeToMessage('PROVIDER_RESPONSE_INVALID'),
      };
    }

    // 提取 usage
    const usage = fullData.usage;
    const inputTokens = usage?.input_tokens ?? null;
    const outputTokens = usage?.output_tokens ?? null;
    const cacheReadTokens = usage?.cache_read_input_tokens ?? null;
    const cacheWriteTokens = usage?.cache_creation_input_tokens ?? null;
    // total tokens 不自行推断，除非上游明确提供
    const totalTokens =
      inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

    return {
      text,
      providerRequestId: fullData.id ?? null,
      finishReason: fullData.stop_reason ?? null,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
      },
      latencyMs,
      errorCode: null,
      errorMessage: null,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        text: '',
        providerRequestId: null,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: errorCodeToMessage('PROVIDER_TIMEOUT'),
      };
    }

    if (err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'))) {
      return {
        text: '',
        providerRequestId: null,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        latencyMs,
        errorCode: 'NETWORK_UNAVAILABLE',
        errorMessage: errorCodeToMessage('NETWORK_UNAVAILABLE'),
      };
    }

    return {
      text: '',
      providerRequestId: null,
      finishReason: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
      },
      latencyMs,
      errorCode: 'PROVIDER_CONNECTION_FAILED',
      errorMessage: errorCodeToMessage('PROVIDER_CONNECTION_FAILED'),
    };
  }
}
