/**
 * 稿件工作区（GE-7，成稿阶段的第二个视图）。
 *
 * 章节列表 + 正文编辑 + 导出。写入走 CAS：保存时回传加载到的版本号，服务端拒绝
 * 覆盖期间落地的新版本；冲突时**不丢用户输入**，给出"重新加载"的明确出路。
 */

import type { ManuscriptExportFormatDto, ManuscriptVersionSummaryDto } from '@ai-novel/contracts';
import { useManuscript } from './useManuscript';

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

          {chapter !== null && persistedDraft !== null && (
            <div className="manuscript-draft-banner" role="status" aria-live="polite">
              <p>有一份未保存的草稿（{new Date(persistedDraft.updatedAt).toLocaleString()}）</p>
              {persistedDraft.stale && (
                <p>正文在此期间已被更新（AI 写入或版本恢复），这份草稿基于更早的版本。</p>
              )}
              <div className="manuscript-draft-banner-actions">
                <button type="button" onClick={() => actions.restoreDraft()}>
                  恢复到草稿
                </button>
                <button type="button" onClick={() => void actions.discardDraft()}>
                  丢弃草稿
                </button>
              </div>
            </div>
          )}

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

              <div className="manuscript-autosave-status" role="status" aria-live="polite">
                {autosaveStatus?.kind === 'saving' && '正在自动保存…'}
                {autosaveStatus?.kind === 'saved' &&
                  `已自动保存于 ${formatTime(autosaveStatus.at)}`}
                {autosaveStatus?.kind === 'error' && `自动保存失败：${autosaveStatus.message}`}
              </div>

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

              <div className="manuscript-versions">
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => void actions.toggleVersions()}
                  aria-expanded={versions !== null}
                >
                  {versions !== null
                    ? '收起版本历史'
                    : `查看版本历史（共 ${chapter.versionCount} 版）`}
                </button>
                {versions !== null && (
                  <ul className="manuscript-version-list">
                    {versions.map((version) => (
                      <li key={version.versionId}>
                        <span className="manuscript-version-label">
                          第 {version.versionNumber} 版 · {versionSourceLabel(version.source)}
                          {version.isCurrent ? ' · 当前' : ''}
                        </span>
                        {!version.isCurrent && (
                          <button
                            type="button"
                            onClick={() => void actions.restore(version.versionId)}
                            disabled={saving}
                          >
                            恢复到这一版
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="candidate-gate-desc">
                  恢复只是把"当前版本"指回那一版，任何一版都不会被删除。
                </p>
              </div>

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
