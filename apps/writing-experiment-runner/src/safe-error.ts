/**
 * 安全错误边界。
 *
 * 公开错误只能包含：
 * - command / caseId 的安全简短值；
 * - provider ID；
 * - 固定安全错误码。
 *
 * 公开错误不得包含：API Key / Authorization / Keychain secret / 完整 URL query /
 * 绝对路径 / provider raw body / provider raw errorMessage / candidate text /
 * 完整 prompt / stack。
 */

import { EvaluationValidationError } from '@ai-novel/writing-evaluation';

/** 用户输入 / 用法错误（safe message，可直接展示）。 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** 实验运行时错误（safe message，可直接展示；可携带固定错误码）。 */
export class ExperimentError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'ExperimentError';
    this.code = code;
  }
}

/** 固定安全错误码 → 用户可理解中文消息（不含上游 body / 技术细节）。 */
export const PROVIDER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  PROVIDER_AUTH_FAILED: 'API Key 认证失败',
  PROVIDER_ACCESS_DENIED: '访问被拒绝',
  PROVIDER_MODEL_UNAVAILABLE: '模型不可用',
  PROVIDER_RATE_LIMITED: '请求频率超限',
  PROVIDER_TIMEOUT: '连接超时',
  NETWORK_UNAVAILABLE: '网络连接失败',
  PROVIDER_CONNECTION_FAILED: '连接失败',
  PROVIDER_RESPONSE_INVALID: '响应格式异常',
  MODEL_RESPONSE_INVALID: '模型输出不符合结构要求',
  KEYCHAIN_NOT_CONFIGURED: 'Keychain 中未配置 API Key',
};

/** 安全错误码 → 固定中文消息（未知码一律固定文本）。 */
export function safeErrorMessageForCode(code: string | null): string {
  if (code !== null) {
    const message = PROVIDER_ERROR_MESSAGES[code];
    if (message !== undefined) return message;
  }
  return '生成失败';
}

/** 公共错误只输出白名单错误类型；任何原始 Error 的 message 都不进入 stdout/stderr。 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof CliUsageError) return err.message;
  if (err instanceof ExperimentError) return err.message;
  if (err instanceof EvaluationValidationError) return err.message;
  return '内部错误（详见本地日志）';
}

/** 公共错误中只显示文件名/目录名，不暴露绝对路径。 */
export function safeDisplayPath(p: string): string {
  const base = p.split('/').filter(Boolean).pop() ?? '';
  return base.length > 0 ? base : '<path>';
}

export const LIVE_BLOCKED_KEY_NOT_CONFIGURED = 'LIVE_BLOCKED_KEY_NOT_CONFIGURED';
export const LIVE_OPT_IN_REQUIRED = 'LIVE_OPT_IN_REQUIRED';
