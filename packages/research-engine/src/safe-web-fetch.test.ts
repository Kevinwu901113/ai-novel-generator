/**
 * SafeWebFetch V1 安全边界测试（B5/D-B5-5）。
 * 全部注入 fake resolver/fetch，确定性、无网络。
 */

import { describe, it, expect, vi } from 'vitest';
import { createSafeWebFetch } from './safe-web-fetch.js';
import { isPrivateResolvedAddress } from './security.js';

const CLOCK = { now: () => '2026-08-10T00:00:00.000Z' };

function okResponse(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const PUBLIC_RESOLVE = async () => ['93.184.216.34'];

describe('isPrivateResolvedAddress', () => {
  it('IPv4 私网段与 0/8 全部命中', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1',
      '198.18.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateResolvedAddress(ip), ip).toBe(true);
    }
    expect(isPrivateResolvedAddress('93.184.216.34')).toBe(false);
    expect(isPrivateResolvedAddress('8.8.8.8')).toBe(false);
  });

  it('IPv6 loopback/unspecified/link-local/ULA/IPv4-mapped 全部命中', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'febf::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateResolvedAddress(ip), ip).toBe(true);
    }
    expect(isPrivateResolvedAddress('2001:db8::1')).toBe(false);
    expect(isPrivateResolvedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('IPv6 十六进制内嵌 IPv4（mapped/compatible/NAT64/6to4）与 multicast 全部命中（B5 复查 B-1）', () => {
    for (const ip of [
      '::ffff:7f00:1', // IPv4-mapped 127.0.0.1（WHATWG URL 归一化产物）
      '[::ffff:7f00:1]',
      '::ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254（云元数据）
      '::ffff:a00:1', // IPv4-mapped 10.0.0.1
      '::7f00:1', // IPv4-compatible 127.0.0.1
      '64:ff9b::7f00:1', // NAT64 内嵌 127.0.0.1
      '2002:7f00:1::', // 6to4 内嵌 127.0.0.1
      'ff02::1', // IPv6 multicast ff00::/8
    ]) {
      expect(isPrivateResolvedAddress(ip), ip).toBe(true);
    }
    expect(isPrivateResolvedAddress('2607:f8b0::1')).toBe(false);
    expect(isPrivateResolvedAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  it('IPv4 组播 224/4 与保留 240/4 判封禁', () => {
    for (const ip of ['224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
      expect(isPrivateResolvedAddress(ip), ip).toBe(true);
    }
    expect(isPrivateResolvedAddress('8.8.8.8')).toBe(false);
  });

  it('zone id 或无法解析的 IPv6 按不可信处理', () => {
    expect(isPrivateResolvedAddress('fe80::1%eth0')).toBe(true);
    expect(isPrivateResolvedAddress('1::2::3')).toBe(true);
    expect(isPrivateResolvedAddress('nonsense::zz')).toBe(true);
  });
});

describe('createSafeWebFetch', () => {
  it('正常抓取：HTML 提取标题与正文，DNS 解析校验通过', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          '<html><head><title>测试页</title></head><body><p>正文内容</p><script>evil()</script></body></html>',
        ),
      );
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    const doc = await port.fetch({ url: 'https://example.com/page', timeoutMs: 5000 });
    expect(doc.title).toBe('测试页');
    expect(doc.extractedText).toContain('正文内容');
    expect(doc.extractedText).not.toContain('evil');
    expect(doc.fetchedAt).toBe('2026-08-10T00:00:00.000Z');
    // 加固：不携带任何凭据
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('DNS 解析到私网地址 → 拒绝（不发起 fetch）', async () => {
    const fetchImpl = vi.fn();
    const port = createSafeWebFetch({
      resolveHost: async () => ['93.184.216.34', '10.0.0.5'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'https://rebind.example/', timeoutMs: 5000 })).rejects.toThrow(
      /私有地址/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('IPv4-mapped IPv6 字面量（URL 归一化为十六进制形式）在触达 fetch 前拒绝（B5 复查 B-1）', async () => {
    const fetchImpl = vi.fn();
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(
      port.fetch({ url: 'http://[::ffff:127.0.0.1]/', timeoutMs: 5000 }),
    ).rejects.toThrow();
    await expect(
      port.fetch({ url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', timeoutMs: 5000 }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('IPv6 私网字面量 → 拒绝（validateResearchTargetUrl 之外的补口）', async () => {
    const fetchImpl = vi.fn();
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'http://[fd00::1]/x', timeoutMs: 5000 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('重定向：每跳重新校验；重定向到私网 → 拒绝', async () => {
    const resolveHost = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34']) // 首跳
      .mockResolvedValueOnce(['192.168.0.10']); // 重定向目标解析到私网
    const fetchImpl = vi.fn().mockResolvedValue(redirectResponse('https://internal.example/'));
    const port = createSafeWebFetch({
      resolveHost: resolveHost as never,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'https://example.com/', timeoutMs: 5000 })).rejects.toThrow(
      /私有地址/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('重定向超过上限 → 拒绝', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirectResponse('https://example.com/next'));
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
      maxRedirects: 2,
    });
    await expect(port.fetch({ url: 'https://example.com/', timeoutMs: 5000 })).rejects.toThrow(
      /重定向超过上限/,
    );
  });

  it('content-type 不在白名单 → 拒绝', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse('binary', 'application/octet-stream'));
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'https://example.com/bin', timeoutMs: 5000 })).rejects.toThrow(
      /content-type/,
    );
  });

  it('响应超过字节上限 → 截断而非失败', async () => {
    const big = 'a'.repeat(2048);
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(big, 'text/plain'));
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
      maxBytes: 100,
    });
    const doc = await port.fetch({ url: 'https://example.com/big', timeoutMs: 5000 });
    expect(doc.extractedText.length).toBeLessThanOrEqual(100);
  });

  it('非 http/https、URL credentials、私网 IPv4 字面量在请求前拒绝', async () => {
    const fetchImpl = vi.fn();
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'file:///etc/passwd', timeoutMs: 5000 })).rejects.toThrow();
    await expect(
      port.fetch({ url: 'https://user:pass@example.com/', timeoutMs: 5000 }),
    ).rejects.toThrow();
    await expect(port.fetch({ url: 'http://127.0.0.1/x', timeoutMs: 5000 })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('超时中止（AbortController 覆盖 fetch 与 body 读取，不含 DNS 解析阶段）', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const port = createSafeWebFetch({
      resolveHost: PUBLIC_RESOLVE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: CLOCK,
    });
    await expect(port.fetch({ url: 'https://example.com/slow', timeoutMs: 30 })).rejects.toThrow(
      /aborted/,
    );
  });
});
