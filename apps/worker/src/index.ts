/**
 * @ai-novel/worker
 *
 * 独立 Worker 入口。
 * 本阶段仅建立结构，不实现长期运行的 Worker。
 */

import type { HealthCheckResponse } from '@ai-novel/contracts';

/** Worker 健康检查 */
export function workerHealthCheck(): HealthCheckResponse {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    version: '0.0.0',
  };
}
