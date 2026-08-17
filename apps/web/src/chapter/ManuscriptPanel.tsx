/**
 * 稿件工作区（GE-7，成稿阶段的第二个视图）。
 *
 * 章节列表 + 正文编辑 + 导出。写入走 CAS：保存时回传加载到的版本号，服务端拒绝
 * 覆盖期间落地的新版本；冲突时**不丢用户输入**，给出"重新加载"的明确出路。
 *
 * D-B16-2：正文阅读区（标题输入 + 正文文本域）是产品核心体验，不套 shadcn
 * 卡片视觉——字号/行高/限宽等排版参数原值平移，只把颜色/边框换成 token。
 */

import type { ManuscriptExportFormatDto, ManuscriptVersionSummaryDto } from '@ai-novel/contracts';
import { useManuscript } from './useManuscript';
import { InlineError } from '@/components/InlineError';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

/** 版本来源的中文说明（界面上不出现 AI_GENERATION 这类工程标识） */
function versionSourceLabel(source: ManuscriptVersionSummaryDto['source']): string {
  switch (source) {
    case 'USER':
      return '你写的';
    case 'AI_GENERATION':
      return 'AI 生成';
    case 'AI_REWRITE':
      return 'AI 改写';
    case 'IMPORT':
      return '导入';
    case 'RESTORE':
      return '恢复';
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** 自动保存时间只显示 HH:MM，避免长 ISO 串挤坏编辑器操作区 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface ManuscriptPanelProps {
  readonly projectId: string;
}

export function ManuscriptPanel({ projectId }: ManuscriptPanelProps) {
  const {
    workspace,
    selectedChapterId,
    chapter,
    draft,
    dirty,
    loading,
    saving,
    error,
    saveError,
    exportNotice,
    versions,
    persistedDraft,
    autosaveStatus,
    actions,
  } = useManuscript(projectId);

  const exportAs = (format: ManuscriptExportFormatDto) => () => {
    void actions.exportManuscript(format);
  };

  return (
    <div className="flex w-full max-w-[760px] flex-col gap-3">
      {error && (
        <InlineError>
          <div className="flex flex-wrap items-center gap-2">
            <span>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void actions.refresh()}
              disabled={loading}
            >
              重试
            </Button>
          </div>
        </InlineError>
      )}

      {exportNotice && (
        <div
          className="rounded-lg border border-border bg-secondary px-4 py-3 text-sm"
          role="status"
        >
          {exportNotice}
        </div>
      )}

      {loading && workspace === null && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          正在加载稿件…
        </div>
      )}

      {workspace !== null && workspace.manuscriptId === null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          稿件还是空的。在"生成"里写完一章并采用后，正文会出现在这里。
        </div>
      )}

      {workspace !== null && workspace.manuscriptId !== null && (
        <>
          {/* B18（D-B18-2）：flex-wrap——375pt 实测坐实 justify-between 下标题被
              固定宽的导出按钮组压到 0 宽竖排、按钮溢出视口；换行化后窄屏标题
              整行、按钮组换行，宽屏单行不变。 */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className="min-w-0 font-semibold">{workspace.title}</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={exportAs('txt')}>
                导出 TXT
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={exportAs('markdown')}>
                导出 Markdown
              </Button>
            </div>
          </div>

          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {workspace.chapters.map((item) => (
              <li
                key={item.chapterId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-secondary px-3.5 py-2.5"
              >
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <span className="font-semibold">{item.title}</span>
                  <span className="text-[13px] text-muted-foreground">{item.wordCount} 字</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    actions.select(selectedChapterId === item.chapterId ? null : item.chapterId)
                  }
                >
                  {selectedChapterId === item.chapterId ? '收起' : '编辑'}
                </Button>
              </li>
            ))}
          </ul>

          {chapter !== null && persistedDraft !== null && (
            <div
              className="space-y-2 rounded-lg border border-status-attention/30 bg-status-attention/10 px-4 py-3 text-sm text-status-attention"
              role="status"
              aria-live="polite"
            >
              <p>有一份未保存的草稿（{new Date(persistedDraft.updatedAt).toLocaleString()}）</p>
              {persistedDraft.stale && (
                <p>正文在此期间已被更新（AI 写入或版本恢复），这份草稿基于更早的版本。</p>
              )}
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => actions.restoreDraft()}>
                  恢复到草稿
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void actions.discardDraft()}
                >
                  丢弃草稿
                </Button>
              </div>
            </div>
          )}

          {chapter !== null && draft !== null && (
            <section
              className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3.5"
              aria-label="章节正文编辑"
            >
              <Label className="text-[13px]" htmlFor="manuscript-title">
                章节标题
              </Label>
              {/* D-B16-2：正文阅读区专用排版——字号/行高原值平移，不用 shadcn
                  Input/Textarea 的默认卡片视觉，只把边框/背景颜色接到 token。 */}
              <input
                id="manuscript-title"
                className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-primary"
                value={draft.title}
                maxLength={200}
                onChange={(e) => actions.edit({ ...draft, title: e.target.value })}
                disabled={saving}
              />

              <Label className="text-[13px]" htmlFor="manuscript-content">
                正文
              </Label>
              {/* B18（D-B18-1）：编辑与阅读同规格（.reading-prose：17px/1.9/40em），
                  字数直觉一致；w-full 保留，容器窄于 40em 时跟随容器。 */}
              <textarea
                id="manuscript-content"
                className="reading-prose w-full resize-y rounded-md border border-border bg-transparent px-2 py-1.5 outline-none focus-visible:border-primary"
                value={draft.content}
                rows={18}
                onChange={(e) => actions.edit({ ...draft, content: e.target.value })}
                disabled={saving}
              />

              <div className="text-sm text-muted-foreground" role="status" aria-live="polite">
                {autosaveStatus?.kind === 'saving' && '正在自动保存…'}
                {autosaveStatus?.kind === 'saved' &&
                  `已自动保存于 ${formatTime(autosaveStatus.at)}`}
                {autosaveStatus?.kind === 'error' && `自动保存失败：${autosaveStatus.message}`}
              </div>

              {saveError && (
                <InlineError>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{saveError}</span>
                    {/* 冲突时的明确出路：重新加载服务端当前版本（会丢弃本地修改，
                        故文案如实说明），用户也可以先把正文复制走。 */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void actions.reload()}
                      disabled={saving}
                    >
                      放弃本地修改并重新加载
                    </Button>
                  </div>
                </InlineError>
              )}

              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="w-fit border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
                  onClick={() => void actions.toggleVersions()}
                  aria-expanded={versions !== null}
                >
                  {versions !== null
                    ? '收起版本历史'
                    : `查看版本历史（共 ${chapter.versionCount} 版）`}
                </button>
                {versions !== null && (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {versions.map((version) => (
                      <li key={version.versionId} className="flex items-center gap-2.5 text-[13px]">
                        <span className="text-muted-foreground">
                          第 {version.versionNumber} 版 · {versionSourceLabel(version.source)}
                          {version.isCurrent ? ' · 当前' : ''}
                        </span>
                        {!version.isCurrent && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void actions.restore(version.versionId)}
                            disabled={saving}
                          >
                            恢复到这一版
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  恢复只是把"当前版本"指回那一版，任何一版都不会被删除。
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void actions.save()}
                  disabled={saving || !dirty}
                >
                  {saving ? '保存中…' : '保存为新版本'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  当前第 {chapter.versionNumber ?? 0} 版 · 共 {chapter.versionCount} 版
                  {dirty ? ' · 有未保存修改' : ''}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                保存会追加一个新版本，旧版本不会被删除或覆盖。
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
