/**
 * ChapterList —— 稿件工作台左栏章节列表（MV1-B）。
 *
 * - role="list" / 每项 role="listitem"；当前章节 aria-current="page"；
 * - 显示当前版本标题（空章节显示「未命名章节」）+ 版本数量；
 * - 新建章节；上移/下移（不做拖拽）；归档 / 恢复；
 * - 「显示已归档章节」开关；归档章节显示角标；
 * - 键盘可达：列表方向键（ArrowUp/ArrowDown）导航选择。
 */

import { useCallback } from 'react';
import type { ChapterSummary } from '@ai-novel/contracts';
import { chapterDisplayTitle } from './manuscript-labels';

interface ChapterListProps {
  readonly chapters: ReadonlyArray<ChapterSummary>;
  readonly includeArchived: boolean;
  readonly selectedChapterId: string | null;
  readonly isLoading: boolean;
  /** 全局 mutation 锁：进行中时禁用章节选择/创建/移动/归档/恢复 */
  readonly isBusy: boolean;
  readonly isCreating: boolean;
  readonly isReordering: boolean;
  readonly isArchiving: boolean;
  readonly isRestoring: boolean;
  readonly onSelect: (chapterId: string) => void;
  readonly onCreate: () => void;
  readonly onMove: (chapterId: string, direction: 'up' | 'down') => void;
  readonly onArchive: (chapterId: string) => void;
  readonly onRestore: (chapterId: string) => void;
  readonly onToggleArchived: () => void;
}

export function ChapterList({
  chapters,
  includeArchived,
  selectedChapterId,
  isLoading,
  isBusy,
  isCreating,
  isReordering,
  isArchiving,
  isRestoring,
  onSelect,
  onCreate,
  onMove,
  onArchive,
  onRestore,
  onToggleArchived,
}: ChapterListProps) {
  // 方向键导航：在可见列表内移动选中
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (chapters.length === 0) return;
      // mutation 进行中禁用键盘切换章节
      if (isBusy) return;
      e.preventDefault();
      const idx = chapters.findIndex((c) => c.id === selectedChapterId);
      let next = idx;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % chapters.length;
      else next = idx <= 0 ? chapters.length - 1 : idx - 1;
      onSelect(chapters[next].id);
    },
    [chapters, selectedChapterId, onSelect, isBusy],
  );

  return (
    <div className="chapter-list-panel">
      <div className="chapter-list-header">
        <h3 className="chapter-list-heading">章节</h3>
        <div className="chapter-list-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={onCreate}
            disabled={isCreating || isLoading || isBusy}
            aria-busy={isCreating}
          >
            {isCreating ? '创建中…' : '新建章节'}
          </button>
        </div>
      </div>
      <label className="chapter-archive-toggle">
        <input type="checkbox" checked={includeArchived} onChange={onToggleArchived} />
        显示已归档章节
      </label>
      {chapters.length === 0 ? (
        <p className="chapter-list-empty">还没有章节，点击「新建章节」创建第一章。</p>
      ) : (
        <ul
          className="chapter-list"
          role="list"
          aria-label="章节列表"
          onKeyDown={handleListKeyDown}
        >
          {chapters.map((chapter) => {
            const isSelected = chapter.id === selectedChapterId;
            const isActive = chapter.status === 'active';
            const label = chapterDisplayTitle(chapter.currentTitle);
            return (
              <li key={chapter.id} role="listitem" className="chapter-list-item">
                <div className="chapter-list-item-main">
                  <button
                    type="button"
                    className="chapter-list-item-button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => onSelect(chapter.id)}
                    disabled={isBusy}
                  >
                    <span className="chapter-title-text">{label}</span>
                    {chapter.status === 'archived' && (
                      <span className="chapter-archived-badge" aria-label="已归档">
                        已归档
                      </span>
                    )}
                    <span className="chapter-version-count">{chapter.versionCount} 个版本</span>
                  </button>
                  <div className="chapter-list-item-actions">
                    {isActive ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`上移章节：${label}`}
                          onClick={() => onMove(chapter.id, 'up')}
                          disabled={isReordering || isArchiving || isRestoring || isBusy}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`下移章节：${label}`}
                          onClick={() => onMove(chapter.id, 'down')}
                          disabled={isReordering || isArchiving || isRestoring || isBusy}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-muted"
                          aria-label={`归档章节：${label}`}
                          onClick={() => onArchive(chapter.id)}
                          disabled={isReordering || isArchiving || isRestoring || isBusy}
                        >
                          归档
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`恢复章节：${label}`}
                        onClick={() => onRestore(chapter.id)}
                        disabled={isReordering || isArchiving || isRestoring || isBusy}
                      >
                        恢复
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
