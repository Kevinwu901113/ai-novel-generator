/**
 * Web Research V1 安全边界（GE-4）。
 *
 * - 仅允许 http/https 协议；
 * - 拒绝 URL credentials（userinfo）；
 * - 拒绝 localhost / loopback / private / link-local 目标（含 IP 字面量解析；
 *   IPv6 字面量全量展开判定，覆盖 IPv4-mapped/compatible/NAT64/6to4 内嵌还原）；
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

/**
 * 裸 IPv4 与 IPv6 内嵌 IPv4 共用的统一封禁判定（避免两套规则漂移）。
 * 覆盖：10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、198.18/15、
 * 0/8（当前网络）、224/4（组播）、240/4（保留，含 255.255.255.255）。
 */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 0) return true; // 0.0.0.0/8 当前网络
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含广播）
  return false;
}

/**
 * 把 IPv6 字符串展开为 8 组 16-bit 数值。
 * 处理 `::` 压缩、末尾内嵌点分 IPv4（`::ffff:1.2.3.4`）、纯十六进制组。
 * 含 zone id（%）或任何解析失败 → 返回 null（调用方按不可信处理）。
 */
function expandIpv6Groups(raw: string): ReadonlyArray<number> | null {
  if (raw.includes('%')) return null; // zone id 不可信
  const compressAt = raw.indexOf('::');
  if (compressAt !== raw.lastIndexOf('::')) return null; // 多个 '::' 非法
  const hasCompress = compressAt !== -1;
  const head = hasCompress ? raw.slice(0, compressAt) : raw;
  const tail = hasCompress ? raw.slice(compressAt + 2) : '';

  const parseSide = (side: string, allowTrailingIpv4: boolean): number[] | null => {
    if (side === '') return [];
    const groups: number[] = [];
    const parts = side.split(':');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '') return null;
      if (p.includes('.')) {
        // 内嵌点分 IPv4：只允许作为最后一段
        if (!allowTrailingIpv4 || i !== parts.length - 1) return null;
        const nums = p.split('.').map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : Number.NaN));
        if (nums.length !== 4 || nums.some((n) => Number.isNaN(n) || n > 255)) return null;
        groups.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
        groups.push(Number.parseInt(p, 16));
      }
    }
    return groups;
  };

  const headGroups = parseSide(head, !hasCompress);
  const tailGroups = parseSide(tail, true);
  if (headGroups === null || tailGroups === null) return null;
  if (hasCompress) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
  }
  return headGroups.length === 8 ? headGroups : null;
}

/** 从两个相邻 16-bit 组还原内嵌 IPv4 点分表示 */
function embeddedIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  if (lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal')) return true;
  // IPv6 字面量（含方括号形式）在 URL 校验层就走完整私网判定，
  // 不依赖 safe-web-fetch 兜底（B5 复查 B-1 入口收口）
  if (lower.replace(/^\[|\]$/g, '').includes(':')) {
    return isPrivateResolvedAddress(lower);
  }
  if (isBlockedIpv4(lower)) return true;
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

/**
 * DNS 解析后的地址校验（B5/D-B5-5，B5 复查 B-1 修复）：解析出的每个地址都必须通过本函数，
 * 否则整个请求拒绝。IPv6 先全量展开为 8 组 16-bit 再判定（WHATWG URL 会把
 * `[::ffff:127.0.0.1]` 归一化为十六进制 `[::ffff:7f00:1]`，点分正则不可靠），覆盖：
 * - unspecified `::`、loopback `::1`；
 * - IPv4-mapped `::ffff:0:0/96`、IPv4-compatible `::/96`、NAT64 `64:ff9b::/96`、
 *   6to4 `2002::/16` → 还原内嵌 IPv4 走统一 isBlockedIpv4 复检；
 * - link-local fe80::/10、ULA fc00::/7、multicast ff00::/8；
 * - zone id（%）或解析失败 → 按不可信处理（返回 true）。
 * IPv4 与内嵌还原共用 isBlockedIpv4（含 0/8、224/4、240/4）。
 * 纯函数：入参是 IP 字面量（node:dns lookup 结果或 URL hostname），不发起网络请求。
 */
export function isPrivateResolvedAddress(address: string): boolean {
  const raw = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (raw.length === 0) return true; // 空地址视为不可信
  if (!raw.includes(':')) {
    return isBlockedIpv4(raw);
  }
  const g = expandIpv6Groups(raw);
  if (g === null) return true; // zone id / 解析失败按不可信处理
  const leadingZeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  // unspecified :: 与 loopback ::1
  if (leadingZeros(7) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96 → 还原内嵌 IPv4 复检
  if (leadingZeros(5) && g[5] === 0xffff) return isBlockedIpv4(embeddedIpv4(g[6], g[7]));
  // IPv4-compatible ::/96（已排除 ::/::1）→ 还原内嵌 IPv4 复检
  if (leadingZeros(6)) return isBlockedIpv4(embeddedIpv4(g[6], g[7]));
  // NAT64 64:ff9b::/96 → 还原内嵌 IPv4 复检
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(embeddedIpv4(g[6], g[7]));
  }
  // 6to4 2002::/16 → 还原组 2、3 中的内嵌 IPv4 复检
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedIpv4(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}
