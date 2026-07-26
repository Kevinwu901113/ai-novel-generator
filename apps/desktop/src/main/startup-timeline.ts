/**
 * 启动时间线日志。
 *
 * 使用 process.hrtime.bigint() 记录单调时间，
 * 输出相对于进程启动的毫秒数。
 */

const processStart = process.hrtime.bigint();

interface TimelineEntry {
  readonly label: string;
  readonly ms: number;
}

const entries: TimelineEntry[] = [];

function elapsedMs(): number {
  return Number((process.hrtime.bigint() - processStart) / 1_000_000n);
}

/** 记录一个启动事件 */
export function mark(label: string): void {
  const ms = elapsedMs();
  entries.push({ label, ms });
  console.log(`[timeline] ${label} +${ms}ms`);
}

/** 获取所有时间线条目 */
export function getEntries(): ReadonlyArray<TimelineEntry> {
  return entries;
}

/** 获取总经过时间 */
export function totalElapsed(): number {
  return elapsedMs();
}
