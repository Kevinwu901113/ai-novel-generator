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
import { InlineError } from '@/components/InlineError';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  const canRestart =
    item.phase === 'failed' || item.phase === 'blocked' || item.phase === 'cancelled';
  return (
    // B18（D-B18-2）：flex-wrap + 标题列 basis-48——宽度充足时单行不变；不足时
    // （375pt 实测坐实：固定宽的阶段文案+按钮把 min-w-0 flex-1 的标题列压到
    // 0 宽、中文逐字竖排）标题占满整行，阶段与按钮换到第二行。阶段文案的
    // whitespace-nowrap 一并去掉，避免第二行被它重新撑溢出。
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-secondary px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="font-semibold">{item.title}</span>
        <span className="text-[13px] text-muted-foreground">{item.goal}</span>
      </div>
      <span className="text-[13px] text-muted-foreground">{chapterPhaseLabel(item.phase)}</span>
      <div className="flex items-center gap-2">
        {started ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onOpen} disabled={busy}>
              查看
            </Button>
            {canRestart && (
              <Button type="button" size="sm" onClick={onStart} disabled={busy}>
                重新生成
              </Button>
            )}
          </>
        ) : (
          <Button type="button" size="sm" onClick={onStart} disabled={busy}>
            开始生成
          </Button>
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
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-[clamp(16px,5vw,64px)] py-[30px]">
      <div className="flex items-center justify-between gap-3">
        <h2 id="chapter-heading" className="text-lg">
          成稿
        </h2>
        <div className="flex gap-1" role="tablist" aria-label="成稿视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'generate'}
            className={cn(
              'px-2 py-1 text-sm text-muted-foreground',
              view === 'generate' && 'border-b-2 border-primary font-semibold text-foreground',
            )}
            onClick={() => setView('generate')}
          >
            生成
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'manuscript'}
            className={cn(
              'px-2 py-1 text-sm text-muted-foreground',
              view === 'manuscript' && 'border-b-2 border-primary font-semibold text-foreground',
            )}
            onClick={() => setView('manuscript')}
          >
            稿件
          </button>
        </div>
      </div>

      {view === 'manuscript' && <ManuscriptPanel projectId={projectId} />}

      {view === 'generate' && error && (
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

      {view === 'generate' && loading && overview === null && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Spinner label={null} size={14} />
          正在加载章节状态…
        </div>
      )}

      {view === 'generate' && overview !== null && overview.blueprintId === null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          还不能开始写正文：需要先在"蓝图"阶段接受一份故事蓝图。
        </div>
      )}

      {view === 'generate' &&
        overview !== null &&
        overview.blueprintId !== null &&
        selectedItem === null && (
          <>
            <p className="text-[13px] text-muted-foreground">
              选择一章开始生成。每次生成一章，生成完由你确认。
            </p>
            <ul className="m-0 flex w-full max-w-[820px] list-none flex-col gap-2 p-0">
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
        <div className="flex w-full max-w-[820px] flex-col gap-3">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="w-fit border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
              onClick={() => actions.select(null)}
            >
              ← 返回章节列表
            </button>
            <h3 className="mt-2 text-base">{selectedItem.title}</h3>
            <p className="text-[13px] text-muted-foreground">{selectedItem.goal}</p>
          </div>

          {actionError && <InlineError>{actionError}</InlineError>}

          {runState === null ? (
            selectedItem.runId === null ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
                <p>这一章还没有开始生成。</p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void actions.startRun(selectedItem.blueprintChapterId)}
                  disabled={busy}
                >
                  开始生成
                </Button>
              </div>
            ) : (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                正在加载本章内容…
              </div>
            )
          ) : (
            <>
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {isChapterWorking(runState.phase) && <Spinner label={null} size={14} />}
                {chapterPhaseLabel(runState.phase)}
              </div>

              {runState.phase === 'accepted_pending_commit' && (
                <div
                  className="max-w-[640px] rounded-lg border border-border bg-secondary px-4 py-3 text-sm"
                  role="status"
                >
                  你已采用这一版，正在写入稿件…
                </div>
              )}

              {runState.phase === 'completed' && (
                <div
                  className="max-w-[640px] rounded-lg border border-border bg-secondary px-4 py-3 text-sm"
                  role="status"
                >
                  这一章已写入稿件。切到上方的"稿件"可以继续编辑正文或导出整本。
                </div>
              )}

              {(runState.phase === 'failed' ||
                runState.phase === 'blocked' ||
                runState.phase === 'cancelled') && (
                <div
                  className="max-w-[640px] space-y-2 rounded-lg border border-border bg-secondary px-4 py-3 text-sm"
                  role="status"
                >
                  <p>这次流程已经结束，可以重新发起本章生成。</p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void actions.startRun(selectedItem.blueprintChapterId)}
                    disabled={busy}
                  >
                    重新生成
                  </Button>
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
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
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
