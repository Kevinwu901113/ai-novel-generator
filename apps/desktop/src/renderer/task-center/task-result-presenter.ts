/**
 * 任务结果安全呈现。
 *
 * 不执行 JSON.stringify(task.result)。
 * 对每种已知 taskType 执行严格白名单验证。
 */

interface ModelInvocationResult {
  accepted: boolean;
  textLength: number;
}

/**
 * 验证 MODEL_INVOCATION_TEST 的 result 是否符合白名单。
 *
 * 规则：
 * - accepted 必须 boolean
 * - textLength 必须 Number.isInteger 且 >= 0
 * - 不允许额外字段
 */
function isValidModelInvocationResult(r: unknown): r is ModelInvocationResult {
  if (r === null || typeof r !== 'object') return false;
  const obj = r as Record<string, unknown>;
  if (typeof obj.accepted !== 'boolean') return false;
  if (
    typeof obj.textLength !== 'number' ||
    !Number.isInteger(obj.textLength) ||
    obj.textLength < 0
  ) {
    return false;
  }
  // 不允许额外字段
  const keys = Object.keys(obj);
  if (keys.length !== 2) return false;
  return true;
}

/**
 * 安全呈现任务结果。
 * 返回 null 表示无内容可显示。
 */
export function presentTaskResult(taskType: string, result: unknown): string | null {
  if (taskType === 'MODEL_INVOCATION_TEST') {
    if (isValidModelInvocationResult(result)) {
      return `接受：${result.accepted ? '是' : '否'}，文本长度：${result.textLength.toLocaleString('zh-CN')}`;
    }
    return null;
  }

  if (taskType === 'GRILL_QUESTION_PLAN') {
    return '规划任务结果已保存';
  }

  // 未知类型
  if (result !== null && result !== undefined) {
    return '任务结果已保存';
  }
  return null;
}
