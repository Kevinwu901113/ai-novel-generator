/**
 * 任务状态与类型标签映射。
 *
 * 未知 taskType 使用安全 fallback，不将任意长字符串写入 UI。
 */

// ── 状态标签 ────────────────────────────────────────────────────────

const TASK_STATUS_LABELS: Record<string, string> = {
  PENDING: '待处理',
  RUNNING: '运行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
  STALE: '已过期',
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/** 判断任务是否处于终态 */
export function isTaskTerminal(status: string): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/** 判断任务是否处于活跃态 */
export function isTaskActive(status: string): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

// ── 类型标签 ────────────────────────────────────────────────────────

const KNOWN_TASK_TYPE_LABELS: Record<string, string> = {
  MODEL_INVOCATION_TEST: '模型调用测试',
  GRILL_QUESTION_PLAN: 'Grill 问题规划',
  CREATION_CONTRACT_DRAFT: '创作契约草案',
};

/**
 * 获取任务类型的中文标签。
 * 未知类型使用安全 fallback：截取下划线前缀或前 12 字符。
 */
export function taskTypeLabel(taskType: string): string {
  if (KNOWN_TASK_TYPE_LABELS[taskType]) {
    return KNOWN_TASK_TYPE_LABELS[taskType];
  }
  // 截取第一段下划线前缀，或前 12 字符
  const underscoreIndex = taskType.indexOf('_');
  const prefix = underscoreIndex > 0 ? taskType.slice(0, underscoreIndex) : taskType;
  const safe = prefix.length > 12 ? prefix.slice(0, 12) : prefix;
  return `未知任务（${safe}…）`;
}

// ── 筛选选项 ────────────────────────────────────────────────────────

export const TASK_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'PENDING', label: '待处理' },
  { value: 'RUNNING', label: '运行中' },
  { value: 'SUCCEEDED', label: '成功' },
  { value: 'FAILED', label: '失败' },
];

export function buildTaskTypeOptions(
  tasks: ReadonlyArray<{ readonly taskType: string }>,
): ReadonlyArray<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [{ value: 'ALL', label: '全部' }];
  for (const t of tasks) {
    if (!seen.has(t.taskType)) {
      seen.add(t.taskType);
      options.push({ value: t.taskType, label: taskTypeLabel(t.taskType) });
    }
  }
  return options;
}
