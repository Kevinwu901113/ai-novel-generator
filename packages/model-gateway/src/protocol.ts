/**
 * 协议适配层（B1 / D6）。
 *
 * 把"如何构造请求 / 如何解析响应"从"如何发请求 / 如何归一化错误"里分离出来：
 * - `ProtocolAdapter` 只做纯函数式的请求构造与响应解析，不碰 fetch、不碰计时、不抛异常；
 * - HTTP 执行、超时、错误归一化在 `index.ts` 中只实现一次，两种协议共用。
 *
 * 支持的协议（D6 明确只做最小形态，不做负载均衡 / 自动 fallback / 流式 / 复杂路由）：
 * - `anthropic-messages`：`POST {baseUrl}/v1/messages`，鉴权头双发 `api-key`（MiMo 兼容）
 *   与 `x-api-key` + `anthropic-version`（标准 Anthropic 协议端点，含 DeepSeek /anthropic）；
 * - `openai-chat`：`POST {baseUrl}/chat/completions`，鉴权头 `authorization: Bearer`，
 *   覆盖 OpenAI 及其兼容端点（DeepSeek 等）。
 *
 * baseUrl 约定（两种协议不同，UI 与文档必须说明）：
 * - `anthropic-messages` 的 baseUrl **不含** `/v1`，由适配器补 `/v1/messages`（与既有 MiMo 配置一致）；
 * - `openai-chat` 的 baseUrl **应含**版本段（如 `https://api.deepseek.com/v1`），适配器只补
 *   `/chat/completions`。这样兼容端点的版本路径差异由用户配置表达，适配器不做猜测。
 *
 * 安全：适配器不记录、不返回 apiKey 与响应正文；解析失败一律返回 null，由调用方归一化为
 * `PROVIDER_RESPONSE_INVALID`。
 */

import type { ProviderProtocol } from '@ai-novel/contracts';

// ── 适配器契约 ────────────────────────────────────────────────────

/** 构造好的 HTTP 请求（不含执行语义） */
export interface ProtocolRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 协议无关的请求参数 */
export interface ProtocolRequestInput {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly systemPrompt?: string;
  readonly temperature?: number;
}

/** 归一化后的 token 用量（上游缺失一律 null，不自行推断） */
export interface NormalizedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
}

/** 归一化后的成功响应 */
export interface ParsedInvocation {
  readonly text: string;
  readonly providerRequestId: string | null;
  readonly finishReason: string | null;
  readonly usage: NormalizedUsage;
}

/**
 * 协议适配器：纯函数，无副作用。
 * `parse` 对任何不符合协议约定的结构返回 null（调用方归一化为 PROVIDER_RESPONSE_INVALID）。
 */
export interface ProtocolAdapter {
  readonly protocol: ProviderProtocol;
  buildRequest(input: ProtocolRequestInput): ProtocolRequest;
  parse(data: unknown): ParsedInvocation | null;
}

// ── 公共工具 ──────────────────────────────────────────────────────

export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 仅接受有限非负整数；其余（null / undefined / NaN / 负数 / 非数字）一律 null */
function asTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function sumTokens(input: number | null, output: number | null): number | null {
  return input !== null && output !== null ? input + output : null;
}

// ── anthropic-messages ────────────────────────────────────────────

interface AnthropicContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: 'anthropic-messages',

  buildRequest(input) {
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages: [{ role: 'user', content: input.prompt }],
    };
    if (input.systemPrompt) body.system = input.systemPrompt;
    if (input.temperature !== undefined) body.temperature = input.temperature;

    return {
      url: `${trimTrailingSlashes(input.baseUrl)}/v1/messages`,
      headers: {
        // 双发鉴权头：`api-key` 保持与既有 MiMo profile 一致（已验证可用），
        // `x-api-key` + `anthropic-version` 覆盖标准 Anthropic 协议端点
        // （含 DeepSeek 的 /anthropic）。端点各取所需，互不干扰。
        'api-key': input.apiKey,
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  },

  parse(data) {
    const root = asRecord(data);
    if (!root) return null;
    if (!Array.isArray(root.content)) return null;

    const blocks = root.content as ReadonlyArray<AnthropicContentBlock>;
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (text.length === 0) return null;

    const usage = asRecord(root.usage) ?? {};
    const inputTokens = asTokenCount(usage.input_tokens);
    const outputTokens = asTokenCount(usage.output_tokens);

    return {
      text,
      providerRequestId: typeof root.id === 'string' ? root.id : null,
      finishReason: typeof root.stop_reason === 'string' ? root.stop_reason : null,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: asTokenCount(usage.cache_read_input_tokens),
        cacheWriteTokens: asTokenCount(usage.cache_creation_input_tokens),
        totalTokens: sumTokens(inputTokens, outputTokens),
      },
    };
  },
};

// ── openai-chat ───────────────────────────────────────────────────

export const openAiChatAdapter: ProtocolAdapter = {
  protocol: 'openai-chat',

  buildRequest(input) {
    const messages: Array<{ role: string; content: string }> = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages,
      // 显式关闭流式（D6：不做流式）
      stream: false,
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;

    return {
      url: `${trimTrailingSlashes(input.baseUrl)}/chat/completions`,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };
  },

  parse(data) {
    const root = asRecord(data);
    if (!root) return null;
    if (!Array.isArray(root.choices) || root.choices.length === 0) return null;

    const choice = asRecord(root.choices[0]);
    if (!choice) return null;
    const message = asRecord(choice.message);
    if (!message) return null;

    // 严格解析：content 必须是非空字符串（tool_calls-only / content=null 视为非法响应）
    if (typeof message.content !== 'string' || message.content.length === 0) return null;

    const usage = asRecord(root.usage) ?? {};
    const inputTokens = asTokenCount(usage.prompt_tokens);
    const outputTokens = asTokenCount(usage.completion_tokens);
    // 缓存命中：DeepSeek 用 prompt_cache_hit_tokens；OpenAI 用 prompt_tokens_details.cached_tokens
    const promptDetails = asRecord(usage.prompt_tokens_details) ?? {};
    const cacheReadTokens =
      asTokenCount(usage.prompt_cache_hit_tokens) ?? asTokenCount(promptDetails.cached_tokens);

    return {
      text: message.content,
      providerRequestId: typeof root.id === 'string' ? root.id : null,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        // OpenAI 兼容协议没有"缓存写入"概念
        cacheWriteTokens: null,
        totalTokens: asTokenCount(usage.total_tokens) ?? sumTokens(inputTokens, outputTokens),
      },
    };
  },
};

// ── 查找 ──────────────────────────────────────────────────────────

const ADAPTERS: Readonly<Record<ProviderProtocol, ProtocolAdapter>> = {
  'anthropic-messages': anthropicMessagesAdapter,
  'openai-chat': openAiChatAdapter,
};

export function adapterFor(protocol: ProviderProtocol): ProtocolAdapter {
  return ADAPTERS[protocol];
}
