/**
 * Grill-me 表单验证工具。
 *
 * 纯函数，仅做 UX 级验证。
 * 后端继续严格验证业务规则。
 */

/** 验证会话目标 */
export function validateGoal(goal: string): string | null {
  const trimmed = goal.trim();
  if (trimmed.length === 0) return '会话目标不能为空';
  return null;
}

/** 验证问题主题 */
export function validateTopic(topic: string): string | null {
  const trimmed = topic.trim();
  if (trimmed.length === 0) return '问题主题不能为空';
  return null;
}

/** 验证问题文本 */
export function validateQuestionText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '问题内容不能为空';
  return null;
}

/** 验证回答文本 */
export function validateAnswer(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '回答内容不能为空';
  return null;
}

/** 验证提案 key */
export function validateProposalKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return '提案 key 不能为空';
  return null;
}

/** 验证提案 value（必须是有效 JSON） */
export function validateProposalValueJson(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '提案值不能为空';
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return '提案值必须是有效 JSON';
  }
}

/** 验证 confidence（0-1） */
export function validateConfidence(c: number): string | null {
  if (Number.isNaN(c)) return '置信度不能为空';
  if (c < 0 || c > 1) return '置信度必须在 0 到 1 之间';
  return null;
}

/** 验证 basedOnAnswerIds（至少一个） */
export function validateBasedOnAnswerIds(ids: ReadonlyArray<string>): string | null {
  const nonEmpty = ids.filter((id) => id.trim().length > 0);
  if (nonEmpty.length === 0) return '至少需要选择一个回答';
  return null;
}

/** 验证 expectedVersion（正整数） */
export function validateExpectedVersion(v: number): string | null {
  if (!Number.isInteger(v) || v < 1) return '版本号必须为正整数';
  return null;
}
