/**
 * SafeWebFetch —— 真实 WebFetchPort 实现（B5/D-B5-5，V1 安全边界运行时补全）。
 *
 * 在纯函数校验（security.ts）之上补齐：
 * 1. 请求前 validateResearchTargetUrl（协议/credentials/主机名黑名单/IP 字面量）；
 * 2. DNS 解析后校验：每个解析地址过 isPrivateResolvedAddress，任一命中即拒绝；
 * 3. 重定向手动跟随（≤ maxRedirects），每跳重新走 1+2；
 * 4. content-type 白名单；
 * 5. 响应字节上限（流式截断，不整段缓冲超限内容）；
 * 6. 连接/读取统一超时（AbortController 覆盖整个请求含 body 读取）。
 *
 * 已知残余风险（设计记录 D-B5-5）：解析与连接之间的 DNS rebinding TOCTOU 窗口，
 * V1 不做 IP 钉连。resolveHost / fetchImpl / clock 可注入以便确定性测试。
 */

import { URL } from 'node:url';
import { lookup } from 'node:dns/promises';
import type { FetchedDocument, WebFetchPort } from './research-types.js';
import { isPrivateResolvedAddress, validateResearchTargetUrl } from './security.js';

export interface SafeWebFetchOptions {
  /** 解析主机名 → 全部地址（默认 node:dns lookup all；测试注入 fake） */
  readonly resolveHost?: (hostname: string) => Promise<ReadonlyArray<string>>;
  /** fetch 实现（默认 globalThis.fetch；测试注入 fake） */
  readonly fetchImpl?: typeof fetch;
  /** 时钟（fetchedAt；默认系统时间） */
  readonly clock?: { now(): string };
  /** 最大重定向跳数（默认 3） */
  readonly maxRedirects?: number;
  /** 响应字节上限（默认 512 KiB，超出截断） */
  readonly maxBytes?: number;
  /** content-type 前缀白名单 */
  readonly allowedContentTypes?: ReadonlyArray<string>;
}

const DEFAULT_ALLOWED_CONTENT_TYPES: ReadonlyArray<string> = [
  'text/html',
  'text/plain',
  'application/xhtml+xml',
  'application/json',
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return bare.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
}

async function defaultResolveHost(hostname: string): Promise<ReadonlyArray<string>> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** V1 最简正文提取：剥 script/style/注释/标签，压缩空白 */
function extractText(contentType: string, body: string): string {
  if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml')) {
    return body.trim();
  }
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(contentType: string, body: string, fallback: string): string {
  if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml')) {
    const m = body.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m && m[1].trim().length > 0) return m[1].trim();
  }
  return fallback;
}

/** 读取响应体（流式，至多 maxBytes；超出截断） */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** 每跳都要过的完整前置校验（字面量 + DNS 解析后） */
async function assertHopAllowed(
  url: string,
  resolveHost: (hostname: string) => Promise<ReadonlyArray<string>>,
): Promise<string> {
  const validated = validateResearchTargetUrl(url);
  const hostname = new URL(validated).hostname;
  if (isIpLiteral(hostname)) {
    // IPv4 字面量 validateResearchTargetUrl 已覆盖；IPv6 字面量在此统一复检
    if (isPrivateResolvedAddress(hostname)) {
      throw new Error(`拒绝访问目标（私有地址字面量）: ${hostname}`);
    }
    return validated;
  }
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0) {
    throw new Error(`目标主机无法解析: ${hostname}`);
  }
  for (const addr of addresses) {
    if (isPrivateResolvedAddress(addr)) {
      throw new Error(`拒绝访问目标（解析到私有地址）: ${hostname} → ${addr}`);
    }
  }
  return validated;
}

export function createSafeWebFetch(options: SafeWebFetchOptions = {}): WebFetchPort {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;

  return {
    async fetch(input: { url: string; timeoutMs: number }): Promise<FetchedDocument> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        let currentUrl = await assertHopAllowed(input.url, resolveHost);
        for (let hop = 0; ; hop++) {
          const response = await fetchImpl(currentUrl, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { accept: allowedContentTypes.join(', ') },
          });
          if (REDIRECT_STATUSES.has(response.status)) {
            if (hop >= maxRedirects) {
              throw new Error(`重定向超过上限 ${maxRedirects}: ${input.url}`);
            }
            const location = response.headers.get('location');
            if (!location) throw new Error(`重定向缺少 Location: ${currentUrl}`);
            // 消费/取消残余 body，避免连接泄漏
            await response.body?.cancel().catch(() => {});
            const next = new URL(location, currentUrl).toString();
            currentUrl = await assertHopAllowed(next, resolveHost);
            continue;
          }
          if (!response.ok) {
            throw new Error(`抓取失败 HTTP ${response.status}: ${currentUrl}`);
          }
          const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
          if (!allowedContentTypes.some((t) => contentType.startsWith(t))) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`content-type 不在白名单: ${contentType || '(缺失)'}`);
          }
          const body = await readBodyCapped(response, maxBytes);
          return {
            url: currentUrl,
            title: extractTitle(contentType, body, currentUrl),
            extractedText: extractText(contentType, body),
            fetchedAt: clock.now(),
          };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
