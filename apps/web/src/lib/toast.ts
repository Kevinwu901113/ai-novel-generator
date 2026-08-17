import { toast } from 'sonner';

/**
 * 统一错误提示（B15，D-B15-3）：sonner 默认 toast 持续 5s 自动消失，错误类
 * 显式覆盖为不自动消失（`duration: Infinity`），需要用户关闭或被同 id 的新
 * 结果覆盖。传 `id` 可让同一来源的错误"更新在原地"而不是无限堆叠（如轮询/
 * 重试反复失败时），并配合 `dismissToast` 在动作重新发起或成功时清掉旧提示。
 */
export function toastError(message: string, id?: string): void {
  toast.error(message, { duration: Infinity, id });
}

/** 按 id 主动清除一条提示（配合 toastError 的 id 使用）。 */
export function dismissToast(id: string): void {
  toast.dismiss(id);
}
