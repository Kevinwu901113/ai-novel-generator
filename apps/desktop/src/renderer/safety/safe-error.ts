/**
 * 安全错误处理模块。
 *
 * 将任意错误转换为 SafeUserError，确保：
 * - 已知错误码使用稳定中文映射
 * - 不泄露路径、stack、secret 等敏感信息
 * - 不把原始 Error 对象写入 React state
 * - 不在 production console 输出原始错误
 */

import { ERROR_CODE_LABELS } from './error-code-labels';

export interface SafeUserError {
  readonly code: string | null;
  readonly message: string;
}

/** 最大允许的用户可见消息长度。 */
const MAX_MESSAGE_LENGTH = 200;

/**
 * 敏感信息正则模式列表。
 * 匹配任意一项即认为消息包含敏感信息。
 */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\/Users\//,
  /\/home\//,
  /file:\/\//,
  /\.sqlite/,
  /node_modules/,
  /\s+at\s+/, // JS stack frame: "    at Foo.bar (file.ts:10:5)"
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
  /Bearer\s+\S+/i, // Bearer token
  /\bsk-[a-zA-Z0-9_-]{8,}/i, // sk- API key prefix
  /\bapi[_-]?key\s*[:=]\s*\S+/i, // api_key / apikey patterns
  /\bkeychain\b/i, // Keychain service/account
];

/**
 * 检查消息是否包含敏感信息。
 */
function containsSensitiveInfo(msg: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(msg));
}

/**
 * 截断消息到安全长度。
 * 超长时返回 null，调用方应使用 fallback。
 */
function truncateMessage(msg: string): string | null {
  if (msg.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  return msg;
}

/**
 * 从错误对象中提取 code。
 */
function extractCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return null;
}

/**
 * 从错误对象中提取消息。
 */
function extractMessage(err: unknown): string | null {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return null;
}

/**
 * 将任意错误转换为安全的用户可见错误。
 *
 * 处理优先级：
 * 1. 已知错误码 → 使用 ERROR_CODE_LABELS 中的稳定中文映射
 * 2. 消息包含敏感信息 → 使用 fallback
 * 3. 消息超长 → 使用 fallback
 * 4. 消息为空 → 使用 fallback
 * 5. 短消息且无敏感信息 → 直接显示
 *
 * @param error 任意错误对象
 * @param fallback 当无法安全显示时使用的回退消息
 */
export function toSafeUserError(error: unknown, fallback: string): SafeUserError {
  const code = extractCode(error);
  const rawMessage = extractMessage(error);

  // 优先使用已知错误码
  if (code && ERROR_CODE_LABELS[code]) {
    return { code, message: ERROR_CODE_LABELS[code] };
  }

  // 检查消息是否安全
  if (rawMessage && rawMessage.trim().length > 0) {
    const trimmed = rawMessage.trim();

    // 包含敏感信息 → 使用 fallback
    if (containsSensitiveInfo(trimmed)) {
      return { code, message: fallback };
    }

    // 超长消息 → 使用 fallback
    const truncated = truncateMessage(trimmed);
    if (truncated === null) {
      return { code, message: fallback };
    }

    // 短消息且无敏感信息 → 直接显示
    return { code, message: truncated };
  }

  // 无消息 → 使用 fallback
  return { code, message: fallback };
}
