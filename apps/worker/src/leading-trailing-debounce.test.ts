/**
 * Leading + trailing 防抖执行器回归测试（TD-026-2，D-B6-8）。
 *
 * 覆盖 redriveAfterProviderConfig 的旧 bug：简单 in-flight 布尔丢弃模式下，
 * 扫描在途时的第二次触发会被直接丢弃、无尾随重扫——本测试证明新实现会补跑。
 */

import { describe, it, expect, vi } from 'vitest';
import { createLeadingTrailingDebouncer } from './leading-trailing-debounce.js';

/** 手动可控的 deferred promise：模拟"扫描仍在途" */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createLeadingTrailingDebouncer', () => {
  it('单次触发：run 恰好执行一次', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const trigger = createLeadingTrailingDebouncer(run);

    trigger();
    await Promise.resolve();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('尾随重扫：扫描在途时的第二次触发不会被丢弃，会在首次执行结束后补跑一次', async () => {
    const first = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createLeadingTrailingDebouncer(run);

    // 首次触发：leading 执行开始（仍在途，first.promise 未 resolve）
    trigger();
    expect(run).toHaveBeenCalledTimes(1);

    // 在途期间的第二次触发：旧实现（简单 in-flight 布尔丢弃）会在此处丢失——
    // run 永远不会再被调用，PENDING 任务滞留到下次触发或重启。
    trigger();
    expect(run).toHaveBeenCalledTimes(1); // 尾随请求已记录，但还没跑

    // 首次执行结束
    first.resolve();
    await first.promise;
    // finally 回调是微任务，多等几轮让尾随触发落地
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 新实现：尾随重扫发生——run 被再调用一次（TD-026-2 修复的核心断言）
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('在途期间多次触发只合并为一次尾随执行（不排队、不重入）', async () => {
    const first = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const trigger = createLeadingTrailingDebouncer(run);

    trigger();
    trigger();
    trigger();
    trigger();
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 多次触发合并为至多一次尾随执行：总计 2 次，不是 5 次
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('run 失败（reject）不阻断尾随重扫、不向上抛出', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce(undefined);
    const trigger = createLeadingTrailingDebouncer(run);

    trigger();
    trigger(); // 记为尾随请求

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('首次执行结束后无尾随请求：不会多跑一次', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const trigger = createLeadingTrailingDebouncer(run);

    trigger();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);

    // 执行已结束后再触发一次，应重新开始一次新的 leading 执行
    trigger();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
