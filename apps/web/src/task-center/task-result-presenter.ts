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
 * CREATION_CONTRACT_DRAFT 的 result 安全白名单。
 * 只允许读取 proposalId / schemaVersion / baseGrillSessionVersion /
 * baseContractVersion / sectionCount 五个安全字段，不 stringify 未知结果。
 */
interface CreationContractDraftResult {
  readonly proposalId: string;
  readonly schemaVersion: number;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly sectionCount: number;
}

/**
 * 验证 CREATION_CONTRACT_DRAFT 的 result 是否符合白名单。
 *
 * 规则：
 * - proposalId 必须 string
 * - schemaVersion / baseGrillSessionVersion 必须正安全整数
 * - baseContractVersion 必须 null 或正安全整数
 * - sectionCount 必须非负安全整数
 * - 不允许额外字段
 */
function isValidCreationContractDraftResult(r: unknown): r is CreationContractDraftResult {
  if (r === null || typeof r !== 'object') return false;
  const obj = r as Record<string, unknown>;
  if (typeof obj.proposalId !== 'string') return false;
  if (
    typeof obj.schemaVersion !== 'number' ||
    !Number.isSafeInteger(obj.schemaVersion) ||
    obj.schemaVersion < 1
  ) {
    return false;
  }
  if (
    typeof obj.baseGrillSessionVersion !== 'number' ||
    !Number.isSafeInteger(obj.baseGrillSessionVersion) ||
    obj.baseGrillSessionVersion < 1
  ) {
    return false;
  }
  if (
    obj.baseContractVersion !== null &&
    (typeof obj.baseContractVersion !== 'number' ||
      !Number.isSafeInteger(obj.baseContractVersion) ||
      obj.baseContractVersion < 1)
  ) {
    return false;
  }
  if (
    typeof obj.sectionCount !== 'number' ||
    !Number.isSafeInteger(obj.sectionCount) ||
    obj.sectionCount < 0
  ) {
    return false;
  }
  // 不允许额外字段
  if (Object.keys(obj).length !== 5) return false;
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

  if (taskType === 'CREATION_CONTRACT_DRAFT') {
    if (isValidCreationContractDraftResult(result)) {
      return `创作契约草案已生成（${result.sectionCount} 个 section）`;
    }
    return null;
  }

  // 未知类型
  if (result !== null && result !== undefined) {
    return '任务结果已保存';
  }
  return null;
}
