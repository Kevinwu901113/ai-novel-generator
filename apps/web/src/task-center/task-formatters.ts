/**
 * 任务中心数值与时间格式化工具。
 *
 * null、NaN、Infinity 不得进入 UI。
 */

/**
 * 安全数值转换。
 * null / NaN / Infinity → null。
 */
export function safeNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * 格式化数字为 zh-CN 本地化字符串。
 * 无效值返回 '—'。
 */
export function formatNumber(v: unknown): string {
  const n = safeNumber(v);
  if (n === null) return '—';
  return n.toLocaleString('zh-CN');
}

/**
 * 格式化延迟。
 * < 1000ms → "Nms"
 * ≥ 1000ms → "N.Ns"
 * 无效值 → '—'
 */
export function formatLatency(ms: unknown): string {
  const n = safeNumber(ms);
  if (n === null) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/**
 * 格式化任务短 ID（前 8 字符）。
 */
export function formatTaskShortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * 格式化 ISO 时间为 zh-CN 本地字符串。
 * null → '—'
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
