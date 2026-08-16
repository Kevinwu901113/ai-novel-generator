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

  // ── 搜索服务（调研）相关 ─────────────────────────────────────────
  SEARCH_KEY_REQUIRED: '请先配置搜索服务 API Key',
  SEARCH_KEY_READ_FAILED: '无法读取搜索服务 API Key',

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

  // ── Graph 运行（创作旅程）相关 ───────────────────────────────────
  // B8/D-B8-4 第二道防线：失效蓝图的 accept 被后端 fail-closed 拒绝时（D-B7-8）
  // 抛的就是 GRAPH_RUN_STATE_CONFLICT。UI 已按 blueprintInvalidated 提前禁用按钮，
  // 这里的映射只兜住"禁用生效之前的竞态窗口"，避免落到通用兜底文案。
  // 该承诺能生效的前提：main 侧 forwardToWorker 把 code 编进 message 文本
  // （encodeErrorCode），renderer 侧 safe-error.ts 的 extractCode 从（可能被
  // Electron 包裹过的）message 里解码回 code（decodeErrorCode）——因为
  // Electron 的 ipcMain.handle 跨边界只回传 error.toString()，Error 上的
  // 自定义 `.code` 属性在 preload 侧就已丢失，不能指望它直接透传到这里。
  GRAPH_RUN_NOT_FOUND: '创作旅程记录不存在',
  GRAPH_RUN_STATE_CONFLICT: '创作旅程状态已变化，请刷新后重新确认',
  GRAPH_RUN_VERSION_CONFLICT: '创作旅程已在其他操作中更新，数据已自动刷新',
  GRAPH_RUN_INTERRUPTED: '创作旅程在上次运行中被中断',

  // ── 通用 ─────────────────────────────────────────────────────────
  NETWORK_UNAVAILABLE: '网络不可用',
  WORKER_UNAVAILABLE: '数据服务不可用',
  INTERNAL_ERROR: '内部错误',
  NOT_FOUND: '请求的资源不存在',
  PERMISSION_DENIED: '权限不足',
} as const;
