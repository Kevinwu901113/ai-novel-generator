/**
 * 章节生成旅程区域（B10 中栏主体，manuscript 阶段）。
 *
 * 两层视图：
 * 1. 章节列表（未选中章节）：蓝图章节 + 每章当前阶段 + "开始生成 / 查看"入口；
 * 2. 单章详情（选中章节）：进度 / 候选正文 / 自查意见 / 候选确认 / 升级决策。
 *
 * 纪律：
 * - 阶段文案全部来自 worker 派生的 `phase`（chapter-logic 只做中文映射），界面上
 *   不出现节点 / 任务 / token 等工程概念；
 * - 只要有候选正文就展示（含生成中、终态、升级决策）——不让用户对着看不见的内容
 *   做决定或失去回看（B6/B8 同族缺陷的通用防线）；
 * - GE-7 起"采用"真的会把这一版写入权威稿件（MANUSCRIPT_COMMIT），完成后可在
 *   同区域的"稿件"视图继续编辑与导出。
 */

import { useState } from 'react';
import type { ChapterOverviewItemDto } from '@ai-novel/contracts';
import { useChapter } from './useChapter';
import { ManuscriptPanel } from './ManuscriptPanel';
import { CandidateView } from './CandidateView';
import { CandidateGatePanel } from './CandidateGatePanel';
import { CandidateEscalationPanel } from './CandidateEscalationPanel';
import { chapterPhaseLabel, isChapterWorking, showsCandidate } from './chapter-logic';

export interface ChapterRegionProps {
  readonly projectId: string;
}

function ChapterListRow({
  item,
  busy,
  onOpen,
  onStart,
}: {
  readonly item: ChapterOverviewItemDto;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onStart: () => void;
}) {
  const started = item.runId !== null;
  return (
    <li className="chapter-list-row">
      <div className="chapter-list-main">
        <span className="chapter-list-title">{item.title}</span>
        <span className="chapter-list-goal">{item.goal}</span>
      </div>
      <span className="chapter-list-phase">{chapterPhaseLabel(item.phase)}</span>
      <div className="chapter-list-actions">
        {started ? (
          <button type="button" onClick={onOpen} disabled={busy}>
            查看
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={onStart} disabled={busy}>
            开始生成
          </button>
        )}
      </div>
    </li>
  );
}

export function ChapterRegion({ projectId }: ChapterRegionProps) {
  const chapter = useChapter(projectId);
  const [showCritiques, setShowCritiques] = useState(false);
  // GE-7：成稿阶段两个视图——"生成"（候选流程）与"稿件"（已采用正文的编辑与导出）。
  const [view, setView] = useState<'generate' | 'manuscript'>('generate');

  const { overview, selectedChapterId, runState, loading, error, actionError, busy, actions } =
    chapter;
  const selectedItem =
    selectedChapterId !== null
      ? (overview?.chapters.find((c) => c.blueprintChapterId === selectedChapterId) ?? null)
      : null;

  return (
    <div className="chapter-region">
      <div className="chapter-region-header">
        <h2 id="chapter-heading">成稿</h2>
        <div className="chapter-view-tabs" role="tablist" aria-label="成稿视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'generate'}
            className={view === 'generate' ? 'tab-active' : undefined}
            onClick={() => setView('generate')}
          >
            生成
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'manuscript'}
            className={view === 'manuscript' ? 'tab-active' : undefined}
            onClick={() => setView('manuscript')}
          >
            稿件
          </button>
        </div>
      </div>

      {view === 'manuscript' && <ManuscriptPanel projectId={projectId} />}

      {view === 'generate' && error && (
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

      {view === 'generate' && loading && overview === null && (
        <div className="chapter-status" role="status" aria-live="polite">
          <span className="intake-spinner" aria-hidden="true">
            ⟳
          </span>
          正在加载章节状态…
        </div>
      )}

      {view === 'generate' && overview !== null && overview.blueprintId === null && (
        <div className="chapter-status" role="status">
          还不能开始写正文：需要先在"蓝图"阶段接受一份故事蓝图。
        </div>
      )}

      {view === 'generate' &&
        overview !== null &&
        overview.blueprintId !== null &&
        selectedItem === null && (
          <>
            <p className="chapter-hint">选择一章开始生成。每次生成一章，生成完由你确认。</p>
            <ul className="chapter-list">
              {overview.chapters.map((item) => (
                <ChapterListRow
                  key={item.blueprintChapterId}
                  item={item}
                  busy={busy}
                  onOpen={() => actions.select(item.blueprintChapterId)}
                  onStart={() => void actions.startRun(item.blueprintChapterId)}
                />
              ))}
            </ul>
          </>
        )}

      {view === 'generate' && selectedItem !== null && (
        <div className="chapter-detail">
          <div className="chapter-detail-header">
            <button type="button" className="btn-link" onClick={() => actions.select(null)}>
              ← 返回章节列表
            </button>
            <h3>{selectedItem.title}</h3>
            <p className="chapter-list-goal">{selectedItem.goal}</p>
          </div>

          {actionError && (
            <div className="chapter-error" role="alert">
              {actionError}
            </div>
          )}

          {runState === null ? (
            selectedItem.runId === null ? (
              <div className="chapter-status" role="status">
                <p>这一章还没有开始生成。</p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void actions.startRun(selectedItem.blueprintChapterId)}
                  disabled={busy}
                >
                  开始生成
                </button>
              </div>
            ) : (
              <div className="chapter-status" role="status" aria-live="polite">
                正在加载本章内容…
              </div>
            )
          ) : (
            <>
              <div className="chapter-phase" role="status" aria-live="polite">
                {isChapterWorking(runState.phase) && (
                  <span className="intake-spinner" aria-hidden="true">
                    ⟳
                  </span>
                )}
                {chapterPhaseLabel(runState.phase)}
              </div>

              {runState.phase === 'accepted_pending_commit' && (
                <div className="chapter-info-card" role="status">
                  你已采用这一版，正在写入稿件…
                </div>
              )}

              {runState.phase === 'completed' && (
                <div className="chapter-info-card" role="status">
                  这一章已写入稿件。切到上方的"稿件"可以继续编辑正文或导出整本。
                </div>
              )}

              {showsCandidate(runState) && (
                <CandidateView
                  candidate={runState.candidate!}
                  critiques={runState.critiques}
                  showCritiques={showCritiques}
                  onToggleCritiques={() => setShowCritiques((v) => !v)}
                />
              )}

              {!showsCandidate(runState) && !isChapterWorking(runState.phase) && (
                <div className="chapter-status" role="status">
                  这一章还没有可查看的正文。
                </div>
              )}

              {runState.gateActive && (
                <CandidateGatePanel
                  state={runState}
                  busy={busy}
                  onSubmit={(outcome, feedback) => void actions.submitGate(outcome, feedback)}
                />
              )}

              {runState.escalationActive && (
                <CandidateEscalationPanel
                  busy={busy}
                  onSubmit={(outcome) => void actions.submitEscalation(outcome)}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
