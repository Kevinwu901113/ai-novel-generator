/**
 * HTTP 传输层（B11 / D11）：hand-rolled node:http。
 *
 * 本仓库生产运行时外部依赖为零（数据库用 node:sqlite、模型调用不用 SDK、校验器手写），
 * 传输需求只有一个 RPC POST + 静态文件 + 安全 header，不引入 HTTP 框架；
 * 未来需要 SSE/WebSocket 推送时再评估（届时记 decision-log）。
 *
 * 职责边界：只做传输（认证 / Host 校验 / 信封转发 / 静态托管 / 安全 header），
 * 不承载任何业务逻辑——业务一律经 rpc.ts → worker dispatchCommand。
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { isAllowedHost, isAuthorized } from './auth.js';
import type { RpcEnvelope } from './rpc.js';

/** 请求体上限：正文/调研笔记均为文本，20MB 远超实际需要，防误用不防恶意大流量 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** 生产 CSP（原 index.html meta CSP 移到 header 下发；vite dev 环境由 vite 自身托管） */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export interface AppServerDeps {
  readonly token: string;
  /** 前端构建产物目录；null = 尚未接入（B11 阶段），静态路径一律 404 */
  readonly webRoot: string | null;
  readonly handleRpc: (body: unknown) => Promise<RpcEnvelope>;
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  sendJson(res, statusCode, { success: false, error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        resolvePromise(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => rejectPromise(err));
  });
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, deps: AppServerDeps) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'VALIDATION_ERROR', '仅支持 POST');
    return;
  }
  if (!isAuthorized(req.headers.authorization, deps.token)) {
    sendError(res, 401, 'UNAUTHORIZED', '访问令牌缺失或无效');
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    sendError(res, 413, 'VALIDATION_ERROR', '请求体过大');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'VALIDATION_ERROR', '请求体不是有效 JSON');
    return;
  }
  const envelope = await deps.handleRpc(body);
  sendJson(res, 200, envelope);
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, deps: AppServerDeps) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'VALIDATION_ERROR', '仅支持 GET');
    return;
  }
  if (deps.webRoot === null) {
    sendError(res, 404, 'NOT_FOUND', 'Web 前端尚未构建（B12 接入）');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://internal');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(res, 400, 'VALIDATION_ERROR', '无效路径');
    return;
  }
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // 路径穿越防护：解析后必须仍在 webRoot 之内
  const webRoot = resolve(deps.webRoot);
  const filePath = resolve(join(webRoot, pathname));
  if (filePath !== webRoot && !filePath.startsWith(webRoot + sep)) {
    sendError(res, 404, 'NOT_FOUND', '未找到');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(res, 404, 'NOT_FOUND', '未找到');
    return;
  }

  const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  // vite 产物带内容 hash 的 assets 可长缓存；入口 index.html 必须每次取最新
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  const content = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

export function createAppServer(deps: AppServerDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        applySecurityHeaders(res);
        if (!isAllowedHost(req.headers.host)) {
          sendError(res, 403, 'FORBIDDEN', 'Host 不在允许范围');
          return;
        }
        const pathname = (req.url ?? '/').split('?')[0];
        if (pathname === '/api/rpc') {
          await handleRpc(req, res, deps);
          return;
        }
        if (pathname.startsWith('/api/')) {
          sendError(res, 404, 'NOT_FOUND', '未知 API 路径');
          return;
        }
        await handleStatic(req, res, deps);
      } catch {
        // 不泄露内部错误细节（与 worker 信封的 INTERNAL_ERROR 语义一致）
        if (!res.headersSent) {
          sendError(res, 500, 'INTERNAL_ERROR', '操作失败');
        } else {
          res.end();
        }
      }
    })();
  });
}
