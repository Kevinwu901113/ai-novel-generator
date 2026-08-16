import type { ManuscriptExportFormatDto } from '@ai-novel/contracts';

const MIME_BY_FORMAT: Record<ManuscriptExportFormatDto, string> = {
  txt: 'text/plain;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
};

/**
 * B12：稿件导出的落盘从原生保存对话框改为浏览器下载。
 * 单独成模块以便测试 mock（jsdom 没有 URL.createObjectURL）。
 */
export function downloadTextFile(
  fileName: string,
  content: string,
  format: ManuscriptExportFormatDto,
): void {
  const blob = new Blob([content], { type: MIME_BY_FORMAT[format] });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 延迟释放：iOS Safari 在 click 后异步读取 blob URL，立即 revoke 会取消下载
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
