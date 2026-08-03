/**
 * ManuscriptWorkbench —— Minimal Manuscript Renderer 工作台根组件（MV1-B）。
 *
 * 三栏布局（复用现有 .workspace 结构，center 面板内再分三栏）：
 * - 左栏：章节列表（ChapterList）；
 * - 中栏：编辑器（EditorPanel）；
 * - 右栏：版本历史（VersionHistory）。
 *
 * 全局反馈：CAS 冲突横幅（role="alert"）、错误横幅（role="alert"）、
 * 成功 live-region（role="status"）、章节切换离开确认对话框。
 */

import { useCallback } from 'react';
import { ManuscriptLeaveDialog } from './ManuscriptLeaveDialog';
import { ChapterList } from './ChapterList';
import { EditorPanel } from './EditorPanel';
import { VersionHistory } from './VersionHistory';
import { useManuscriptWorkbench } from './useManuscriptWorkbench';
import { LiveRegion } from '../accessibility/LiveRegion';

interface ManuscriptWorkbenchProps {
  projectId: string;
}

export function ManuscriptWorkbench({ projectId }: ManuscriptWorkbenchProps) {
  const wb = useManuscriptWorkbench(projectId);

  const handleToggleArchived = useCallback(() => {
    wb.setIncludeArchived(!wb.includeArchived);
  }, [wb.includeArchived, wb.setIncludeArchived]);

  const editorTitle = wb.selectedChapter ? wb.editorTitle : '';
  const editorContent = wb.selectedChapter ? wb.editorContent : '';

  return (
    <div className="manuscript-workbench">
      <h2 className="manuscript-workbench-heading">稿件</h2>

      {/* 全局错误 */}
      {wb.error && (
        <div className="manuscript-error-banner" role="alert">
          <span>{wb.error}</span>
          <button onClick={wb.clearError} aria-label="关闭错误提示" type="button">
            ✕
          </button>
        </div>
      )}

      {/* CAS 冲突横幅：保留本地 buffer，刷新状态三态（loading/ready/error），不自动重试；
          不可 dismiss 回旧 expected——只能重存/放弃/合法切换结束冲突 */}
      {wb.conflict && (
        <div className="manuscript-conflict-banner" role="alert">
          <p className="manuscript-conflict-title">稿件已在其他操作中更新。</p>
          <p className="manuscript-conflict-info">
            {wb.conflict.refreshStatus === 'loading' && '正在刷新服务器当前版本…'}
            {wb.conflict.refreshStatus === 'ready' &&
              (wb.conflict.serverCurrent
                ? `服务器当前版本 #${wb.conflict.serverCurrent.versionNumber} · ${wb.conflict.serverCurrent.title}（已刷新）`
                : '服务器当前版本为空（已刷新；该章节尚无版本）')}
            {wb.conflict.refreshStatus === 'error' && '服务器版本刷新失败，请重试。'}
          </p>
          <div className="manuscript-conflict-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void wb.saveAfterConflict()}
              disabled={wb.isSaving || wb.conflict.refreshStatus !== 'ready'}
              aria-busy={wb.isSaving}
            >
              基于新版本再保存
            </button>
            <button
              type="button"
              className="btn btn-small btn-muted"
              onClick={wb.discardLocalChanges}
              disabled={wb.conflict.refreshStatus !== 'ready'}
            >
              放弃本地修改并加载服务器版本
            </button>
            {wb.conflict.refreshStatus === 'error' && (
              <button
                type="button"
                className="btn btn-small btn-muted"
                onClick={wb.retryRefreshConflict}
              >
                重新刷新服务器版本
              </button>
            )}
          </div>
        </div>
      )}

      {/* 成功反馈 */}
      <LiveRegion message={wb.successMessage} politeness="polite" label="操作结果" />

      <div className="manuscript-workbench-columns">
        {/* 左栏：章节列表 */}
        <div className="manuscript-workbench-left">
          <ChapterList
            chapters={wb.chapters}
            includeArchived={wb.includeArchived}
            selectedChapterId={wb.selectedChapterId}
            isLoading={wb.isLoading}
            isBusy={wb.isMutationInFlight}
            isCreating={wb.isCreatingChapter}
            isReordering={wb.isReordering}
            isArchiving={wb.isArchiving}
            isRestoring={wb.isRestoring}
            onSelect={wb.selectChapter}
            onCreate={wb.createChapter}
            onMove={(chapterId, direction) => void wb.moveChapter(chapterId, direction)}
            onArchive={(chapterId) => void wb.archiveChapter(chapterId)}
            onRestore={(chapterId) => void wb.restoreChapter(chapterId)}
            onToggleArchived={handleToggleArchived}
          />
        </div>

        {/* 中栏：编辑器 */}
        <div className="manuscript-workbench-center">
          {wb.isLoading ? (
            <div className="editor-loading" role="status">
              稿件加载中…
            </div>
          ) : (
            <EditorPanel
              manuscript={wb.manuscript}
              manuscriptTitleInput={wb.manuscriptTitleInput}
              isManuscriptTitleDirty={wb.isManuscriptTitleDirty}
              isSavingTitle={wb.isSavingTitle}
              onManuscriptTitleChange={wb.setManuscriptTitleInput}
              onSaveManuscriptTitle={() => void wb.saveManuscriptTitle()}
              selectedChapter={wb.selectedChapter}
              editorTitle={editorTitle}
              editorContent={editorContent}
              dirty={wb.dirty}
              currentVersion={wb.currentVersion}
              isSaving={wb.isSaving}
              isBusy={wb.isMutationInFlight}
              isBufferLocked={wb.isChapterBufferLocked}
              isLoading={wb.isLoadingCurrent}
              onEditorTitleChange={wb.setEditorTitle}
              onEditorContentChange={wb.setEditorContent}
              onSaveChapterVersion={() => void wb.saveChapterVersion()}
            />
          )}
        </div>

        {/* 右栏：版本历史 */}
        <div className="manuscript-workbench-right">
          <VersionHistory
            versions={wb.chapterVersions}
            currentVersionId={wb.currentVersion?.id ?? null}
            isPromoting={wb.isPromoting}
            isBusy={wb.isMutationInFlight}
            isLoading={wb.isLoadingVersions}
            hasChapter={wb.selectedChapter !== null}
            onPromote={wb.promoteChapterVersion}
          />
        </div>
      </div>

      {/* 章节切换离开确认 */}
      {wb.pendingLeave && (
        <ManuscriptLeaveDialog
          title="未保存的修改"
          message="当前章节有未保存的修改，离开后将丢失这些修改。"
          onContinue={wb.cancelLeave}
          onDiscard={wb.confirmLeave}
        />
      )}
    </div>
  );
}
