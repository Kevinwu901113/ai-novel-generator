/**
 * RESEARCH_ESCALATION 人工决策面板（B6）。
 *
 * 镜像 IntakeRegion 的 escalation Gate 写法：RESEARCH_ESCALATION_OPTIONS
 * 五选项渲染为按钮列表，点击经 useResearch 的 chooseEscalation 走
 * graph.applyHumanDecision（nodeId 固定为 'RESEARCH_ESCALATION'）。
 */

import { RESEARCH_ESCALATION_OPTIONS } from './research-logic';

export interface ResearchEscalationPanelProps {
  readonly busy: boolean;
  readonly onChoose: (outcome: string) => void | Promise<void>;
}

export function ResearchEscalationPanel({ busy, onChoose }: ResearchEscalationPanelProps) {
  return (
    <div className="research-escalation">
      <p>调研遇到了需要你决定的情况，接下来想怎么做？</p>
      <div className="research-escalation-options">
        {RESEARCH_ESCALATION_OPTIONS.map((opt) => (
          <button
            key={opt.outcome}
            className="research-escalation-option"
            onClick={() => void onChoose(opt.outcome)}
            disabled={busy}
          >
            <strong>{opt.label}</strong>
            <span>{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
