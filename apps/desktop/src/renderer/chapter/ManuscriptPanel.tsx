/**
 * 稿件工作区（GE-7，成稿阶段的第二个视图）。
 *
 * 章节列表 + 正文编辑 + 导出。写入走 CAS：保存时回传加载到的版本号，服务端拒绝
 * 覆盖期间落地的新版本；冲突时**不丢用户输入**，给出"重新加载"的明确出路。
 */

import type { ManuscriptExportFormatDto } from '@ai-novel/contracts';
import { useManuscript } from './useManuscript';

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
    actions,
  } = useManuscript(projectId);

  const exportAs = (format: ManuscriptExportFormatDto) => () => {
    void actions.exportManuscript(format);
  };

  return (
    <div className="manuscript-panel">
      {error && (
        <div className="chapter-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn-retry-inline"
            onClick={() => void actions.refresh()}
            disabled={loading}
          >
            重试
          </button>
        </div>
      )}

      {exportNotice && (
        <div className="chapter-info-card" role="status">
          {exportNotice}
        </div>
      )}

      {loading && workspace === null && (
        <div className="chapter-status" role="status" aria-live="polite">
          正在加载稿件…
        </div>
      )}

      {workspace !== null && workspace.manuscriptId === null && (
        <div className="chapter-status" role="status">
          稿件还是空的。在"生成"里写完一章并采用后，正文会出现在这里。
        </div>
      )}

      {workspace !== null && workspace.manuscriptId !== null && (
        <>
          <div className="manuscript-toolbar">
            <span className="manuscript-title">{workspace.title}</span>
            <div className="manuscript-export">
              <button type="button" onClick={exportAs('txt')}>
                导出 TXT
              </button>
              <button type="button" onClick={exportAs('markdown')}>
                导出 Markdown
              </button>
            </div>
          </div>

          <ul className="chapter-list">
            {workspace.chapters.map((item) => (
              <li key={item.chapterId} className="chapter-list-row">
                <div className="chapter-list-main">
                  <span className="chapter-list-title">{item.title}</span>
                  <span className="chapter-list-goal">{item.wordCount} 字</span>
                </div>
                <div className="chapter-list-actions">
                  <button
                    type="button"
                    onClick={() =>
                      actions.select(selectedChapterId === item.chapterId ? null : item.chapterId)
                    }
                  >
                    {selectedChapterId === item.chapterId ? '收起' : '编辑'}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {chapter !== null && draft !== null && (
            <section className="manuscript-editor" aria-label="章节正文编辑">
              <label className="candidate-feedback-label" htmlFor="manuscript-title">
                章节标题
              </label>
              <input
                id="manuscript-title"
                className="manuscript-title-input"
                value={draft.title}
                maxLength={200}
                onChange={(e) => actions.edit({ ...draft, title: e.target.value })}
                disabled={saving}
              />

              <label className="candidate-feedback-label" htmlFor="manuscript-content">
                正文
              </label>
              <textarea
                id="manuscript-content"
                className="manuscript-content-input"
                value={draft.content}
                rows={18}
                onChange={(e) => actions.edit({ ...draft, content: e.target.value })}
                disabled={saving}
              />

              {saveError && (
                <div className="chapter-error" role="alert">
                  <span>{saveError}</span>
                  {/* 冲突时的明确出路：重新加载服务端当前版本（会丢弃本地修改，
                      故文案如实说明），用户也可以先把正文复制走。 */}
                  <button
                    type="button"
                    className="btn-retry-inline"
                    onClick={() => void actions.reload()}
                    disabled={saving}
                  >
                    放弃本地修改并重新加载
                  </button>
                </div>
              )}

              <div className="manuscript-editor-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void actions.save()}
                  disabled={saving || !dirty}
                >
                  {saving ? '保存中…' : '保存为新版本'}
                </button>
                <span className="candidate-meta">
                  当前第 {chapter.versionNumber ?? 0} 版 · 共 {chapter.versionCount} 版
                  {dirty ? ' · 有未保存修改' : ''}
                </span>
              </div>
              <p className="candidate-gate-desc">保存会追加一个新版本，旧版本不会被删除或覆盖。</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
