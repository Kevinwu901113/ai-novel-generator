/**
 * 已知错误码的稳定中文映射。
 *
 * 所有映射均为编译期常量，不依赖运行时环境。
 * 错误码来自 contracts 层定义，保持与此处映射一致。
 */

export const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  // ── Provider 相关 ────────────────────────────────────────────────
  PROVIDER_NOT_CONFIGURED: '模型提供商未配置',
  API_KEY_REQUIRED: '请先配置 API Key',
  API_KEY_STORE_FAILED: '无法保存 API Key',
  API_KEY_READ_FAILED: '无法读取 API Key',
  API_KEY_DELETE_FAILED: '无法删除 API Key',
  PROVIDER_CONNECTION_FAILED: '连接失败',
  PROVIDER_AUTH_FAILED: '认证失败，请检查 API Key',
  PROVIDER_ACCESS_DENIED: '访问被拒绝',
  PROVIDER_MODEL_UNAVAILABLE: '模型不可用',
  PROVIDER_RATE_LIMITED: '请求频率超限，请稍后重试',
  PROVIDER_TIMEOUT: '连接超时',
  PROVIDER_RESPONSE_INVALID: '响应格式异常',

  // ── 任务相关 ─────────────────────────────────────────────────────
  TASK_INTERRUPTED: '任务在上次运行中被中断',
  TASK_EXECUTION_FAILED: '任务执行失败',
  TASK_STATE_CONFLICT: '任务状态冲突，请刷新后重试',
  MODEL_RESPONSE_INVALID: '模型返回了无效响应',

  // ── Grill 相关 ───────────────────────────────────────────────────
  GRILL_VERSION_CONFLICT: '会话已在其他操作中更新，数据已自动刷新',
  GRILL_VALIDATION_ERROR: '输入验证失败',
  GRILL_PLAN_ALREADY_RUNNING: '问题规划任务已在进行中',
  GRILL_PLAN_STALE: '问题规划提案已过期',
  GRILL_PLAN_PROPOSAL_NOT_FOUND: '问题规划提案不存在',
  GRILL_PLAN_PROPOSAL_NOT_ACCEPTABLE: '问题规划提案无法接受',

  // ── 创作契约相关 ─────────────────────────────────────────────────
  CONTRACT_VERSION_CONFLICT: '创作契约已在其他操作中更新，数据已自动刷新',
  CONTRACT_PROPOSAL_STALE: '创作契约提案已过期，请重新生成',
  CONTRACT_PROPOSAL_NOT_FOUND: '创作契约提案不存在',
  CONTRACT_PROPOSAL_NOT_ACCEPTABLE: '创作契约提案无法操作',
  CONTRACT_LOCK_CONFLICT: '操作与锁定字段冲突',
  CONTRACT_MODEL_LOCK_VIOLATION: '模型输出修改了受保护字段',
  CONTRACT_SCHEMA_UNSUPPORTED: '创作契约 schema 版本不支持',
  CONTRACT_VALIDATION_FAILED: '创作契约输入验证失败',
  CONTRACT_DRAFT_ALREADY_RUNNING: '创作契约任务已在进行中',

  // ── 通用 ─────────────────────────────────────────────────────────
  NETWORK_UNAVAILABLE: '网络不可用',
  WORKER_UNAVAILABLE: '数据服务不可用',
  INTERNAL_ERROR: '内部错误',
  NOT_FOUND: '请求的资源不存在',
  PERMISSION_DENIED: '权限不足',
} as const;
