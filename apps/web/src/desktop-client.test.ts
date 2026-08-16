// @vitest-environment jsdom
/**
 * desktop-client 测试（B12）。
 *
 * mock `globalThis.fetch`，钉住：
 * - payload 包装规则（projects.open 包装 {projectId}；project.list 无 payload 字段）
 * - Authorization 头
 * - 信封 error → 抛出的 Error 经 safe-error 的 toSafeUserError 能还原出 code
 *   （这是 HTTP 客户端与 safe-error 之间的契约，safe-error 本身零改动）
 * - 401 清 token + 派发 auth-required 事件
 * - getDataServiceStatus 网络失败时返回 disconnected 而不抛出
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDesktopClient, AUTH_TOKEN_STORAGE_KEY, AUTH_REQUIRED_EVENT } from './desktop-client';
import { toSafeUserError } from './safety/safe-error';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function parseBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function headersOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('createDesktopClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('projects.open 把 projectId 包装为 {projectId}', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { success: true, data: { id: 'proj-1' } }));
    const client = createDesktopClient();

    await client.projects.open('proj-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body).toEqual({ command: 'project.open', payload: { projectId: 'proj-1' } });
  });

  it('project.list 请求体不带 payload 字段', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { success: true, data: [] }));
    const client = createDesktopClient();

    await client.projects.list();

    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body).toEqual({ command: 'project.list' });
    expect(Object.prototype.hasOwnProperty.call(body, 'payload')).toBe(false);
  });

  it('search.hasApiKey 请求体不带 payload 字段', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { success: true, data: { hasApiKey: false } }),
    );
    const client = createDesktopClient();

    await client.search.hasApiKey();

    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body).toEqual({ command: 'search.hasApiKey' });
  });

  it('请求带 Authorization: Bearer <token> 头，token 从 localStorage 读取', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'test-token-123');
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { success: true, data: { ok: true, timestamp: 't', version: '1.0.0' } }),
    );
    const client = createDesktopClient();

    await client.healthCheck();

    const headers = headersOf(fetchMock.mock.calls[0]);
    expect(headers.Authorization).toBe('Bearer test-token-123');
  });

  it('信封 error 构造的 Error 经 toSafeUserError 还原出原始 code', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        success: false,
        error: { code: 'GRAPH_RUN_STATE_CONFLICT', message: '状态冲突' },
      }),
    );
    const client = createDesktopClient();

    let caught: unknown;
    try {
      await client.graph.getRunProgress({ projectId: 'p1', runId: 'r1' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const safe = toSafeUserError(caught, '兜底文案');
    expect(safe.code).toBe('GRAPH_RUN_STATE_CONFLICT');
  });

  it('HTTP 401 清除 localStorage 中的 token 并派发 auth-required 事件', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'stale-token');
    fetchMock.mockResolvedValueOnce(
      mockResponse(401, {
        success: false,
        error: { code: 'UNAUTHORIZED', message: '访问令牌缺失或无效' },
      }),
    );
    const client = createDesktopClient();
    const listener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);

    await expect(client.healthCheck()).rejects.toThrow();

    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  });

  it('getDataServiceStatus 网络失败时返回 disconnected，不抛出', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network unreachable'));
    const client = createDesktopClient();

    const result = await client.getDataServiceStatus();

    expect(result).toEqual({ status: 'disconnected' });
  });

  it('getDataServiceStatus 非 200 响应时也返回 disconnected', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(500, { success: false, error: { code: 'INTERNAL_ERROR', message: '操作失败' } }),
    );
    const client = createDesktopClient();

    const result = await client.getDataServiceStatus();

    expect(result).toEqual({ status: 'disconnected' });
  });
});
