/**
 * @ai-novel/contracts
 *
 * Main、Preload、Renderer 和 Worker 共用的 IPC 类型及运行时验证边界。
 */

/** 健康检查响应 */
export interface HealthCheckResponse {
  readonly ok: boolean;
  readonly timestamp: string;
  readonly version: string;
}

/** IPC 频道定义 */
export const IPC_CHANNELS = {
  HEALTH_CHECK: 'ipc:health-check',
} as const;

/** 桌面 API 接口 —— 通过 contextBridge 暴露给 Renderer */
export interface DesktopAPI {
  healthCheck(): Promise<HealthCheckResponse>;
}

/** 验证健康检查响应结构 */
export function isValidHealthCheckResponse(data: unknown): data is HealthCheckResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.ok === 'boolean' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.version === 'string'
  );
}
