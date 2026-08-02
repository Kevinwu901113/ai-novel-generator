/**
 * 创作契约渲染的标签与格式化纯工具。
 *
 * 只做字符串映射与格式化，不涉及任何 API 调用或 React 状态。
 * 未知 key 一律回退为原始 key，绝不抛错、绝不下沉为 null。
 */

// ── Section / field 中文标签 ────────────────────────────────────────

/** 顶层 section 中文标签 */
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  premise: '前提',
  genre: '类型',
  tone: '基调',
  themes: '主题',
  targetAudience: '目标读者',
  narrativePov: '叙事视角',
  tense: '时态',
  targetLength: '目标长度',
  structure: '结构',
  protagonist: '主角',
  supportingCharacters: '配角',
  relationships: '人物关系',
  worldRules: '世界规则',
  mustInclude: '必须包含',
  mustAvoid: '必须避免',
  contentBoundaries: '内容边界',
  unresolvedQuestions: '未决问题',
} as const;

/** 字段级中文标签 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  characterKey: '角色标识',
  name: '姓名',
  role: '角色定位',
  motivation: '动机',
  arc: '成长弧线',
  traits: '特质',
  relationship: '与主角关系',
  relationshipKey: '关系标识',
  fromCharacterKey: '从',
  toCharacterKey: '到',
  type: '关系类型',
  dynamic: '动态演变',
  rating: '分级',
  allowedContent: '允许内容',
  prohibitedContent: '禁止内容',
  notes: '备注',
  unit: '单位',
  value: '数值',
} as const;

// ── 枚举值中文标签 ──────────────────────────────────────────────────

/** 叙事视角 */
export const NARRATIVE_POV_LABELS: Readonly<Record<string, string>> = {
  FIRST: '第一人称',
  THIRD_LIMITED: '第三人称有限视角',
  THIRD_OMNISCIENT: '第三人称全知视角',
  SECOND: '第二人称',
  OTHER: '其他',
} as const;

/** 时态 */
export const TENSE_LABELS: Readonly<Record<string, string>> = {
  PAST: '过去时',
  PRESENT: '现在时',
  MIXED: '混合时态',
} as const;

/** 目标长度单位 */
export const TARGET_LENGTH_UNIT_LABELS: Readonly<Record<string, string>> = {
  words: '字',
  chapters: '章',
} as const;

/** 提案状态 */
export const PROPOSAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  PROPOSED: '待审核',
  ACCEPTED: '已接受',
  REJECTED: '已拒绝',
  SUPERSEDED: '已废弃',
  STALE: '已过期',
} as const;

/** 契约版本创建来源 */
export const CONTRACT_VERSION_CREATED_BY_LABELS: Readonly<Record<string, string>> = {
  user: '用户创建',
  'ai-proposal-accepted': '由 AI 提案接受',
  lock: '锁定操作',
  unlock: '解锁操作',
} as const;

/** 字段来源（provenance.source） */
export const PROVENANCE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  GRILL_ANSWER: 'Grill 回答',
  AI_PROPOSAL: 'AI 提案',
  USER_EDIT: '用户修改',
  PREVIOUS_VERSION: '继承自上一版本',
  DEFAULT: '默认',
} as const;

// ── 通用 label 查找（未知 key 回退为原始 key） ──────────────────────

export function labelFor(map: Readonly<Record<string, string>>, key: string): string {
  return map[key] ?? key;
}

// ── 格式化工具 ──────────────────────────────────────────────────────

/** 目标长度："约 80,000 字" / "约 20 章" */
export function formatTargetLength(targetLength: {
  readonly unit: string;
  readonly value: number;
}): string {
  const unitLabel = labelFor(TARGET_LENGTH_UNIT_LABELS, targetLength.unit);
  return `约 ${targetLength.value.toLocaleString('zh-CN')} ${unitLabel}`;
}

/** 短 ID（前 8 字符 + 省略号） */
export function formatShortId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

/**
 * 格式化 ISO 时间为 zh-CN 本地字符串。
 *
 * 与现有 Renderer 时间格式工具（task-formatters.formatTime 及各面板 formatTime）
 * 语义保持一致（zh-CN / Asia/Shanghai）。null → '—'。
 */
export function formatContractTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/**
 * 判断 canonical 字段路径是否命中任一锁定路径。
 * 命中规则：完全相等，或一方是另一方的祖先路径（重叠即视为锁定）。
 */
export function isLockedFieldPath(path: string, lockedFieldPaths: ReadonlyArray<string>): boolean {
  if (lockedFieldPaths.length === 0) return false;
  return lockedFieldPaths.some(
    (locked) => path === locked || path.startsWith(`${locked}/`) || locked.startsWith(`${path}/`),
  );
}
