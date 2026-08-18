/**
 * 相对时间显示（B21，D-B21-3）。
 *
 * 「最近打开 · 2026/8/17 15:58:07」的秒级精度对使用者是噪音；相对时间才回答
 * 「我上次弄到哪了」。完整时间戳由调用方放进 title 悬停保留，信息不丢。
 * `now` 参数仅供测试注入固定时钟。
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const diffMs = now.getTime() - date.getTime();
  // 未来时间（时钟漂移等异常）不硬算「N 分钟后」，直接回落日期。
  if (diffMs < 0) return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)} 天前`;
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
