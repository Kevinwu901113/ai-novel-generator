/**
 * Clock 抽象 —— 报告中的 generatedAt 由调用方注入，保证 byte-stable 输出。
 */

export interface Clock {
  now(): string;
}

/** 系统时钟（生产默认）。CLI 可用 --clock 注入固定时间。 */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** 固定时钟（测试与 determinism 场景）。 */
export function fixedClock(isoTimestamp: string): Clock {
  return { now: () => isoTimestamp };
}
