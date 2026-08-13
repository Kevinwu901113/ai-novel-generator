/**
 * @ai-novel/import-export
 *
 * GE-7：稿件导出（TXT / Markdown）。纯函数，无 IO、无外部依赖——
 * 落盘由 main 进程负责（渲染进程不碰文件系统，见 AGENTS.md 安全规则）。
 *
 * 导出的是**权威稿件**（每章 current 版本），不是生成候选：候选未经用户在候选
 * 确认环节接受就不属于稿件（锁定不变量第 5 条）。
 */

/** 导出用的一章（title + 正文；调用方按稿件顺序传入） */
export interface ExportChapter {
  readonly title: string;
  readonly content: string;
}

export interface ExportInput {
  readonly manuscriptTitle: string;
  readonly chapters: ReadonlyArray<ExportChapter>;
}

export type ExportFormat = 'txt' | 'markdown';

const EXPORT_FORMATS: ReadonlySet<string> = new Set<ExportFormat>(['txt', 'markdown']);

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && EXPORT_FORMATS.has(value);
}

/** 正文规范化：统一换行、去掉行尾空白、压缩连续空行到至多一个 */
function normalizeContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * TXT：标题独占一行，章节之间空一行。不加任何装饰字符——TXT 的消费方
 * （阅读器 / 转格式工具）通常按空行分段，多余的分隔符反而会被读进正文。
 */
export function renderManuscriptAsTxt(input: ExportInput): string {
  const parts: string[] = [input.manuscriptTitle.trim()];
  for (const chapter of input.chapters) {
    parts.push(`${chapter.title.trim()}\n\n${normalizeContent(chapter.content)}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Markdown：稿件标题 `#`，章节标题 `##`。正文原样保留（不转义）——用户写的正文
 * 里出现的 `*`、`#` 等字符是他的内容，导出时擅自转义会改动作品本身。
 */
export function renderManuscriptAsMarkdown(input: ExportInput): string {
  const parts: string[] = [`# ${input.manuscriptTitle.trim()}`];
  for (const chapter of input.chapters) {
    parts.push(`## ${chapter.title.trim()}\n\n${normalizeContent(chapter.content)}`);
  }
  return `${parts.join('\n\n')}\n`;
}

export function renderManuscript(format: ExportFormat, input: ExportInput): string {
  return format === 'txt' ? renderManuscriptAsTxt(input) : renderManuscriptAsMarkdown(input);
}

/** 建议文件名（调用方可覆盖）；去掉路径分隔符等不安全字符 */
export function suggestedExportFileName(manuscriptTitle: string, format: ExportFormat): string {
  const safe = manuscriptTitle
    .trim()
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .slice(0, 80);
  const base = safe.length > 0 ? safe : '未命名稿件';
  return `${base}.${format === 'txt' ? 'txt' : 'md'}`;
}
