import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './format-relative-time';

const NOW = new Date('2026-08-18T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('空值与非法输入不抛错', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—');
    expect(formatRelativeTime(undefined, NOW)).toBe('—');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('not-a-date');
  });

  it('一分钟内是「刚刚」', () => {
    expect(formatRelativeTime('2026-08-18T11:59:30.000Z', NOW)).toBe('刚刚');
  });

  it('小时内按分钟、当天内按小时、月内按天', () => {
    expect(formatRelativeTime('2026-08-18T11:15:00.000Z', NOW)).toBe('45 分钟前');
    expect(formatRelativeTime('2026-08-18T04:00:00.000Z', NOW)).toBe('8 小时前');
    expect(formatRelativeTime('2026-08-15T12:00:00.000Z', NOW)).toBe('3 天前');
  });

  it('超过 30 天与未来时间回落到日期', () => {
    expect(formatRelativeTime('2026-06-01T00:00:00.000Z', NOW)).toMatch(/2026/);
    expect(formatRelativeTime('2026-09-01T00:00:00.000Z', NOW)).toMatch(/2026/);
  });
});
