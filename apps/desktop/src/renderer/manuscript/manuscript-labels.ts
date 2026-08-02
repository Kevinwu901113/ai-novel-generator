/**
 * 稿件工作台中文标签与格式化工具（MV1-B）。
 * 纯展示逻辑，不含任何业务状态。
 */

export const UNNAMED_CHAPTER_LABEL = '未命名章节';

export const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  USER: '用户保存',
  AI_GENERATION: 'AI 生成',
  AI_REWRITE: 'AI 重写',
  IMPORT: '导入',
  RESTORE: '恢复',
};

export function formatSourceType(sourceType: string): string {
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN');
}

/** 章节列表显示标题：空章节显示占位「未命名章节」 */
export function chapterDisplayTitle(currentTitle: string | null): string {
  return currentTitle === null || currentTitle.trim().length === 0
    ? UNNAMED_CHAPTER_LABEL
    : currentTitle;
}
