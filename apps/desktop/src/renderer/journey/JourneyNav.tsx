/**
 * 四阶段旅程导航（B4 App shell）：想法 → 调研 → 蓝图 → 成稿。
 * 纯展示（阶段由 Graph 进度投影派生，D-B4-1）；未到达的阶段不可点击。
 */

import { JOURNEY_STAGES, type JourneyStage } from '../intake/intake-logic';

export interface JourneyNavProps {
  readonly current: JourneyStage;
}

export function JourneyNav({ current }: JourneyNavProps) {
  const currentIndex = JOURNEY_STAGES.findIndex((s) => s.id === current);
  return (
    <nav className="journey-nav" aria-label="创作旅程阶段">
      <ol>
        {JOURNEY_STAGES.map((stage, i) => (
          <li
            key={stage.id}
            className={`journey-step ${
              i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming'
            }`}
            aria-current={i === currentIndex ? 'step' : undefined}
          >
            <span className="journey-step-index" aria-hidden="true">
              {i + 1}
            </span>
            <span className="journey-step-label">{stage.label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
