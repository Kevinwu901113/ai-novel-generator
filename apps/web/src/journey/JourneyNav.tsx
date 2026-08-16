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
 */

import { JOURNEY_STAGES, type JourneyStage } from '../intake/intake-logic';

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
    <nav className="journey-nav" aria-label="创作旅程阶段">
      <ol>
        {JOURNEY_STAGES.map((stage, i) => {
          const reached = reachedStages.has(stage.id);
          const isFrontier = stage.id === frontierStage;
          const isViewed = stage.id === viewStage;
          return (
            <li
              key={stage.id}
              className={`journey-step ${
                i < frontierIndex ? 'done' : i === frontierIndex ? 'current' : 'upcoming'
              }${isViewed ? ' viewing' : ''}`}
            >
              <button
                type="button"
                className="journey-step-btn"
                disabled={!reached}
                aria-disabled={!reached}
                aria-current={isFrontier ? 'step' : undefined}
                aria-pressed={reached ? isViewed : undefined}
                onClick={() => {
                  if (reached) onSelectStage(stage.id);
                }}
              >
                <span className="journey-step-index" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="journey-step-label">{stage.label}</span>
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
