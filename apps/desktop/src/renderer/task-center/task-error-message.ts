/**
 * 任务错误消息安全映射。
 *
 * 不直接显示 Error.message 中的路径、stack 或数据库信息。
 * 优先根据 errorCode 映射稳定中文消息。
 */

const ERROR_CODE_MESSAGES: Record<string, string> = {
  TASK_INTERRUPTED: '任务在上次运行中被中断',
  TASK_EXECUTION_FAILED: '任务执行失败',
  TASK_STATE_CONFLICT: '任务状态冲突，请刷新后重试',
  PROVIDER_NOT_CONFIGURED: '模型提供商未配置',
  API_KEY_REQUIRED: '请先配置 API Key',
  API_KEY_READ_FAILED: '无法读取 API Key',
  PROVIDER_CONNECTION_FAILED: '连接模型服务失败',
  PROVIDER_AUTH_FAILED: '认证失败，请检查 API Key',
  PROVIDER_RATE_LIMITED: '请求频率超限，请稍后重试',
  PROVIDER_TIMEOUT: '模型服务连接超时',
  MODEL_RESPONSE_INVALID: '模型返回了无效响应',
};

/** 清理错误消息中的敏感信息。 */
export function sanitizeErrorMessage(msg: string): string {
  if (!msg) return '未知错误';

  // 包含绝对路径或 stack frame 时替换为通用提示
  const sensitivePatterns = [
    /\/Users\//,
    /\/home\//,
    /file:\/\//,
    /\.sqlite/,
    /node_modules/,
    /\s+at\s+/,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(msg)) {
      return '任务执行出现错误';
    }
  }

  return msg;
}

/**
 * 获取安全的任务错误消息。
 * 优先使用 errorCode 映射，其次清理后的 errorMessage。
 */
export function taskErrorMessage(errorCode: string | null, rawMessage: string | null): string {
  if (errorCode && ERROR_CODE_MESSAGES[errorCode]) {
    return ERROR_CODE_MESSAGES[errorCode];
  }
  if (rawMessage) {
    return sanitizeErrorMessage(rawMessage);
  }
  if (errorCode) {
    return `错误：${errorCode}`;
  }
  return '未知错误';
}
