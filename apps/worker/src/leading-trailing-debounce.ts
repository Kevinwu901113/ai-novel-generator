/**
 * Leading + trailing 防抖执行器（TD-026-2，D-B6-8）。
 *
 * 旧实现（简单 in-flight 布尔丢弃）：扫描在途时，窗口期内的后续触发被直接丢弃、
 * 无尾随重扫。极端时序下（首扫已越过某项目、配置恰在其后补齐）该项目的 PENDING
 * 任务会滞留到下一次触发（下次 provider/search key 操作）或应用重启才被捡起。
 *
 * 本实现：窗口期内的触发不会被丢弃，而是记为"尾随请求"；当前执行结束后如果有
 * 尾随请求，立即补跑一次（合并多次触发为至多一次尾随执行，不排队/不重入）。
 * 失败静默——`run` 的 reject 不会向上抛出，防止 unhandled rejection；调用方应
 * 自行在 `run` 内部吞错或依赖本函数的 catch 兜底。
 */
export function createLeadingTrailingDebouncer(run: () => Promise<void>): () => void {
  let inFlight = false;
  let trailingRequested = false;

  function trigger(): void {
    if (inFlight) {
      trailingRequested = true;
      return;
    }
    inFlight = true;
    void run()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (trailingRequested) {
          trailingRequested = false;
          trigger();
        }
      });
  }

  return trigger;
}
