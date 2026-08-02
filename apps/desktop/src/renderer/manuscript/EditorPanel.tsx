/**
 * EditorPanel —— 稿件工作台中栏编辑器（MV1-B）。
 *
 * 显示：稿件标题（显式保存，expectedUpdatedAt CAS）、章节标题输入框、
 * 正文 textarea、当前 version 编号与保存时间、未保存修改状态、「保存新版本」按钮。
 *
 * 属性约束（§8.3）：
 * - 章节标题 aria-label="章节标题"；正文 aria-label="正文编辑"；
 * - 保存中 aria-busy="true" 且按钮 disabled；
 * - 正文允许空字符串；标题 ≤200 UTF-16 units 且 trim 非空；
 * - 不自动保存。
 */

import { useRef } from 'react';
import type { ChapterSummary, ManuscriptPublicData } from '@ai-novel/contracts';
import { useFocusOnMount } from '../accessibility/useFocusOnMount';
import { formatDateTime } from './manuscript-labels';

interface EditorPanelProps {
  readonly manuscript: ManuscriptPublicData | null;
  readonly manuscriptTitleInput: string;
  readonly isManuscriptTitleDirty: boolean;
  readonly isSavingTitle: boolean;
  readonly onManuscriptTitleChange: (value: string) => void;
  readonly onSaveManuscriptTitle: () => void;
  readonly selectedChapter: ChapterSummary | null;
  readonly editorTitle: string;
  readonly editorContent: string;
  readonly dirty: boolean;
  readonly currentVersion: { versionNumber: number; createdAt: string } | null;
  readonly isSaving: boolean;
  readonly isLoading: boolean;
  readonly onEditorTitleChange: (value: string) => void;
  readonly onEditorContentChange: (value: string) => void;
  readonly onSaveChapterVersion: () => void;
}

export function EditorPanel({
  manuscript,
  manuscriptTitleInput,
  isManuscriptTitleDirty,
  isSavingTitle,
  onManuscriptTitleChange,
  onSaveManuscriptTitle,
  selectedChapter,
  editorTitle,
  editorContent,
  dirty,
  currentVersion,
  isSaving,
  isLoading,
  onEditorTitleChange,
  onEditorContentChange,
  onSaveChapterVersion,
}: EditorPanelProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // 章节切换后 focus 进入标题输入框或编辑区
  useFocusOnMount(titleInputRef, selectedChapter !== null && !isLoading);

  const isArchived = selectedChapter?.status === 'archived';
  const canEdit = selectedChapter !== null && !isArchived;

  return (
    <div className="editor-panel">
      {/* 稿件标题 */}
      <div className="manuscript-title-section">
        <label className="manuscript-title-label" htmlFor="manuscript-title-input">
          稿件标题
        </label>
        <div className="manuscript-title-row">
          <input
            id="manuscript-title-input"
            className="manuscript-title-input"
            value={manuscriptTitleInput}
            onChange={(e) => onManuscriptTitleChange(e.target.value)}
            disabled={isSavingTitle || manuscript === null}
            maxLength={200}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={onSaveManuscriptTitle}
            disabled={
              isSavingTitle ||
              manuscript === null ||
              !isManuscriptTitleDirty ||
              manuscriptTitleInput.trim().length === 0
            }
            aria-busy={isSavingTitle}
          >
            {isSavingTitle ? '保存中…' : '保存标题'}
          </button>
        </div>
      </div>

      {selectedChapter === null ? (
        <div className="editor-empty" role="status">
          {isLoading ? '加载中…' : '从左侧选择一个章节，或新建章节开始写作。'}
        </div>
      ) : (
        <div className="editor-body">
          {isArchived && (
            <p className="editor-archived-notice" role="status">
              该章节已归档，恢复后可编辑。
            </p>
          )}
          <label className="chapter-title-label" htmlFor="chapter-title-input">
            章节标题
          </label>
          <input
            ref={titleInputRef}
            id="chapter-title-input"
            className="chapter-title-input"
            aria-label="章节标题"
            value={editorTitle}
            onChange={(e) => onEditorTitleChange(e.target.value)}
            disabled={!canEdit}
            maxLength={200}
          />
          <label className="chapter-content-label" htmlFor="chapter-content-textarea">
            正文
          </label>
          <textarea
            ref={bodyRef}
            id="chapter-content-textarea"
            className="chapter-content-textarea"
            aria-label="正文编辑"
            value={editorContent}
            onChange={(e) => onEditorContentChange(e.target.value)}
            disabled={!canEdit}
            spellCheck={false}
          />

          <div className="editor-status-row">
            <span className="editor-version-info" role="status">
              {currentVersion
                ? `当前版本 #${currentVersion.versionNumber} · 保存于 ${formatDateTime(currentVersion.createdAt)}`
                : '当前章节尚无版本'}
            </span>
            {dirty && (
              <span className="editor-dirty-indicator" role="status">
                有未保存的修改
              </span>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary save-version-btn"
            onClick={onSaveChapterVersion}
            disabled={!canEdit || isSaving}
            aria-busy={isSaving}
          >
            {isSaving ? '保存中…' : '保存新版本'}
          </button>
        </div>
      )}
    </div>
  );
}
