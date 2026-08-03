/**
 * Web Research V1 安全边界（GE-4）。
 *
 * - 仅允许 http/https 协议；
 * - 拒绝 URL credentials（userinfo）；
 * - 拒绝 localhost / loopback / private / link-local 目标（含 IP 字面量解析）；
 * - 重定向后必须重新校验（调用方在 fetch 层对每次重定向调用本函数）；
 * - 限制连接/读取超时（调用方）。
 *
 * 纯函数，不发起网络请求。
 */

import { URL } from 'node:url';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '0.0.0.0',
  '[::1]',
  '[::]',
  '[0:0:0:0:0:0:0:1]',
  '[0:0:0:0:0:0:0:0]',
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 198.18/15
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  if (lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal')) return true;
  if (isPrivateIpv4(lower)) return true;
  return false;
}

/**
 * 校验研究目标 URL。合法返回规范化 URL 字符串；非法抛 Error。
 * 调用方必须在每次 fetch（含重定向后）之前调用。
 */
export function validateResearchTargetUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`非法 URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅允许 http/https 协议: ${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('URL 不允许包含 credentials');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`拒绝访问目标: ${parsed.hostname}`);
  }
  return parsed.toString();
}

/** 校验是否为合法 http/https 来源 URL（供来源记录/展示） */
export function isSafeSourceUrl(raw: string): boolean {
  try {
    validateResearchTargetUrl(raw);
    return true;
  } catch {
    return false;
  }
}
