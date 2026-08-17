/**
 * 四阶段旅程导航（B4 App shell；B6 REWORK 复查 D-B6-10 起可点击回看）：
 * 想法 → 调研 → 蓝图 → 成稿。
 *
 * 展示阶段（viewStage）与推进阶段（frontierStage）分离：frontierStage 标示
 * Graph 真实进度（aria-current="step"）；viewStage 标示中栏当前挂载/展示的是
 * 哪个阶段（aria-pressed）。两者可能不同——例如调研已完成、frontier 已推进到
 * 蓝图，但蓝图尚无 Region，中栏仍展示调研内容。
 *
 * 只有已到达过的阶段（reachedStages，含当前）可点击切换 viewStage；未到达的
 * 阶段保持不可点（disabled + aria-disabled）。
 *
 * B16：迁 Tailwind（视觉与 B15 壳层对齐）。外层容器（居中、底部分隔线、
 * 面板底色）由 App.tsx 的旅程条负责，本组件只负责阶段列表自身。
 */

import { JOURNEY_STAGES, type JourneyStage } from '../intake/intake-logic';
import { cn } from '@/lib/utils';

export interface JourneyNavProps {
  /** 推进阶段：Graph 真实位置，标示"当前进度" */
  readonly frontierStage: JourneyStage;
  /** 展示阶段：中栏当前挂载/展示的是哪个阶段，标示"正在查看" */
  readonly viewStage: JourneyStage;
  /** 已到达过的阶段集合（历史最远 frontier 单调推导）；只有这些阶段可点击回看 */
  readonly reachedStages: ReadonlySet<JourneyStage>;
  /** 点击已到达阶段时回报（App 据此设置 userSelectedStage） */
  readonly onSelectStage: (stage: JourneyStage) => void;
}

export function JourneyNav({
  frontierStage,
  viewStage,
  reachedStages,
  onSelectStage,
}: JourneyNavProps) {
  const frontierIndex = JOURNEY_STAGES.findIndex((s) => s.id === frontierStage);
  return (
    <nav className="w-full max-w-[920px] py-3.5" aria-label="创作旅程阶段">
      <ol className="flex list-none justify-center gap-[clamp(18px,5vw,64px)]">
        {JOURNEY_STAGES.map((stage, i) => {
          const reached = reachedStages.has(stage.id);
          const isFrontier = stage.id === frontierStage;
          const isViewed = stage.id === viewStage;
          const isDone = i < frontierIndex;
          return (
            <li key={stage.id} className="flex">
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground disabled:cursor-default',
                  reached && 'cursor-pointer hover:bg-secondary',
                  isFrontier && 'font-semibold text-foreground',
                  isViewed && 'bg-secondary outline outline-1 outline-primary',
                )}
                disabled={!reached}
                aria-disabled={!reached}
                aria-current={isFrontier ? 'step' : undefined}
                aria-pressed={reached ? isViewed : undefined}
                onClick={() => {
                  if (reached) onSelectStage(stage.id);
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs',
                    isFrontier && 'border-primary bg-primary text-primary-foreground',
                    !isFrontier && isDone && 'border-status-ready bg-status-ready text-white',
                  )}
                >
                  {i + 1}
                </span>
                <span>{stage.label}</span>
                {isFrontier && <span className="sr-only">（当前进度）</span>}
                {isViewed && <span className="sr-only">（正在查看）</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
