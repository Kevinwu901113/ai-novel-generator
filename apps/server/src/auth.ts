/**
 * 访问认证（B11 / D11）。
 *
 * - 访问令牌：首次启动生成 32 字节随机值（base64url），写入 `${dataRoot}/auth-token`
 *   （0600）。令牌保护的是局域网访问面，不是高价值秘密，故不入 Keychain——文件形态
 *   对未来上云/换宿主友好。
 * - 校验：`Authorization: Bearer <token>`，经 SHA-256 摘要后 timingSafeEqual 比对
 *   （摘要归一化长度，避免长度差异泄漏时序信息）。**localhost 不豁免**：豁免会把
 *   攻击面交给"浏览器同源模型 + DNS rebinding"的组合，统一要求令牌成本极低。
 * - Host 白名单：防 DNS rebinding（攻击者域名解析到局域网 IP 时 Host 头会暴露其域名）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

export function loadOrCreateToken(dataRoot: string): string {
  mkdirSync(dataRoot, { recursive: true });
  const tokenPath = join(dataRoot, 'auth-token');
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) {
      return existing;
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 校验 Authorization 头。恒定时间比对，缺头/格式错一律拒绝。 */
export function isAuthorized(authorizationHeader: string | undefined, token: string): boolean {
  if (typeof authorizationHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return false;
  const presented = authorizationHeader.slice(prefix.length).trim();
  if (presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

/** 本机全部非 internal IPv4/IPv6 地址（绑定 0.0.0.0 时用户会以这些地址访问） */
export function localAddresses(): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.add(entry.address);
    }
  }
  return addresses;
}

/** 从 Host 头提取主机名（去端口；IPv6 字面量去方括号） */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** Host 头白名单：localhost / 环回 / *.local / 本机地址。 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) return false;
  const hostname = hostnameOf(hostHeader).toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.local')) return true;
  return localAddresses().has(hostname);
}
