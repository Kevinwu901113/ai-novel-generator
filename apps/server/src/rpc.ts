/**
 * RPC 命令处理（B11 / D11）。
 *
 * 单一入口 `POST /api/rpc`，请求体 `{command, payload}`；响应复用 worker 的信封语义
 * `{success, data}` / `{success:false, error:{code, message}}`（requestId 由服务端生成，
 * HTTP 自带请求边界，客户端无需携带）。
 *
 * 三个服务端本地命令（镜像原 Electron main 进程的本地 handler）：
 * - `app.healthCheck`        → HealthCheckResponse
 * - `app.dataServiceStatus`  → DataServiceStatusResponse（starting/ready/failed）
 * - `app.dataServiceRetry`   → 触发重新初始化（非阻塞，语义与原 retryWorker 一致）
 *
 * 业务命令：必须在 `RPC_COMMAND_VALIDATORS` 表内且通过校验（原 main 进程的 82 个
 * ipcMain.handle 前置校验搬到这里强制执行——research 域 handler 内部零校验，
 * 这层是真实的安全边界，不是形式），ready 前一律返回 WORKER_UNAVAILABLE。
 *
 * 业务错误一律 HTTP 200 + 信封（与既有 renderer 错误处理对齐）；HTTP 状态码只表达
 * 传输层问题（401 未认证、404 路径、405 方法、413 过大、400 JSON 损坏）。
 */

import { randomUUID } from 'node:crypto';
import {
  RPC_COMMAND_VALIDATORS,
  SERVER_COMMANDS,
  type DataServiceStatusResponse,
  type HealthCheckResponse,
  type RpcCommand,
} from '@ai-novel/contracts';
import { dispatchCommand } from '@ai-novel/worker';

export type DataServiceState = 'starting' | 'ready' | 'failed';

export interface RpcEnvelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RpcDeps {
  readonly getStatus: () => DataServiceState;
  /** 非阻塞触发重新初始化，返回触发后的即时状态（renderer 随后轮询） */
  readonly requestRetry: () => DataServiceState;
  readonly version: string;
}

function failure(code: string, message: string): RpcEnvelope {
  return { success: false, error: { code, message } };
}

function isRpcCommand(command: string): command is RpcCommand {
  return Object.prototype.hasOwnProperty.call(RPC_COMMAND_VALIDATORS, command);
}

export async function handleRpcRequest(body: unknown, deps: RpcDeps): Promise<RpcEnvelope> {
  if (typeof body !== 'object' || body === null) {
    return failure('VALIDATION_ERROR', '无效的请求信封');
  }
  const { command, payload } = body as { command?: unknown; payload?: unknown };
  if (typeof command !== 'string' || command.length === 0) {
    return failure('VALIDATION_ERROR', '缺少 command');
  }

  // ── 服务端本地命令 ──────────────────────────────────────────
  if (command === SERVER_COMMANDS.HEALTH_CHECK) {
    const data: HealthCheckResponse = {
      ok: true,
      timestamp: new Date().toISOString(),
      version: deps.version,
    };
    return { success: true, data };
  }
  if (command === SERVER_COMMANDS.DATA_SERVICE_STATUS) {
    const data: DataServiceStatusResponse = { status: deps.getStatus() };
    return { success: true, data };
  }
  if (command === SERVER_COMMANDS.DATA_SERVICE_RETRY) {
    const data: DataServiceStatusResponse = { status: deps.requestRetry() };
    return { success: true, data };
  }

  // ── 业务命令（worker dispatch）────────────────────────────
  if (!isRpcCommand(command)) {
    return failure('VALIDATION_ERROR', `未知命令: ${command}`);
  }
  if (deps.getStatus() !== 'ready') {
    return failure('WORKER_UNAVAILABLE', '数据服务尚未就绪');
  }

  const validator = RPC_COMMAND_VALIDATORS[command];
  if (validator === null) {
    if (payload !== undefined && payload !== null) {
      return failure('VALIDATION_ERROR', `命令 ${command} 不接受参数`);
    }
  } else if (!validator(payload)) {
    return failure('VALIDATION_ERROR', '无效的请求输入');
  }

  const response = await dispatchCommand({ requestId: randomUUID(), command, payload });
  if (response.success) {
    return { success: true, data: response.data };
  }
  return {
    success: false,
    error: response.error ?? { code: 'INTERNAL_ERROR', message: '操作失败' },
  };
}
