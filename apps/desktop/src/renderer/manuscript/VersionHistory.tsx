/**
 * VersionHistory —— 稿件工作台右栏版本历史（MV1-B）。
 *
 * - role="list" / 每项 role="listitem"；
 * - 显示版本号、标题、sourceType、创建时间、parent 信息；
 * - 当前版本 aria-current="true"；非当前版本提供「设为当前版本」。
 */

import type { ChapterVersionSummary } from '@ai-novel/contracts';
import { formatDateTime, formatSourceType } from './manuscript-labels';

interface VersionHistoryProps {
  readonly versions: ReadonlyArray<ChapterVersionSummary>;
  readonly currentVersionId: string | null;
  readonly isPromoting: boolean;
  /** 全局 mutation 锁：进行中时禁用 promote */
  readonly isBusy: boolean;
  readonly isLoading: boolean;
  readonly hasChapter: boolean;
  readonly onPromote: (versionId: string) => void;
}

export function VersionHistory({
  versions,
  currentVersionId,
  isPromoting,
  isBusy,
  isLoading,
  hasChapter,
  onPromote,
}: VersionHistoryProps) {
  return (
    <div className="version-history-panel">
      <h3 className="version-history-heading">版本历史</h3>
      {!hasChapter ? (
        <p className="version-history-empty">选择章节后查看版本历史。</p>
      ) : isLoading ? (
        <p className="version-history-loading" role="status">
          加载中…
        </p>
      ) : versions.length === 0 ? (
        <p className="version-history-empty">该章节还没有版本。</p>
      ) : (
        <ul className="version-history-list" role="list" aria-label="版本历史列表">
          {versions.map((version) => {
            const isCurrent = version.id === currentVersionId;
            return (
              <li key={version.id} role="listitem" className="version-history-item">
                <div
                  className="version-history-item-body"
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <div className="version-history-item-title">
                    <span className="version-number">#{version.versionNumber}</span>
                    {isCurrent && (
                      <span className="version-current-badge" aria-label="当前版本">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="version-history-item-fields">
                    <span className="version-field-title">{version.title}</span>
                    <span className="version-field-source">
                      来源：{formatSourceType(version.sourceType)}
                    </span>
                    <span className="version-field-time">
                      创建于 {formatDateTime(version.createdAt)}
                    </span>
                    {version.parentVersionId !== null && (
                      <span className="version-field-parent">基于 #{version.parentVersionId}</span>
                    )}
                  </div>
                </div>
                {!isCurrent && (
                  <button
                    type="button"
                    className="btn btn-small btn-muted"
                    onClick={() => onPromote(version.id)}
                    disabled={isPromoting || isBusy}
                  >
                    设为当前版本
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
