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
    <div className="max-w-[760px]">
      <p>调研遇到了需要你决定的情况，接下来想怎么做？</p>
      <div className="mt-2 flex flex-col gap-2">
        {RESEARCH_ESCALATION_OPTIONS.map((opt) => (
          <button
            key={opt.outcome}
            type="button"
            className="flex flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2.5 text-left font-[inherit] text-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => void onChoose(opt.outcome)}
            disabled={busy}
          >
            <strong>{opt.label}</strong>
            <span className="text-xs text-muted-foreground">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
