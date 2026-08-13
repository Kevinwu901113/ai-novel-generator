/**
 * 候选升级决策面板（B10，CANDIDATE_ESCALATION 的四个选项）。
 *
 * 与 B8 蓝图侧同则：四个选项的文案如实说明各自走向（尤其
 * `modify_requirements` / `continue_later` 都会让本章生成停在终态，需要重新发起），
 * 不许诺界面上不存在的"回来继续"。
 */

import { CANDIDATE_ESCALATION_OPTIONS } from './chapter-logic';

export interface CandidateEscalationPanelProps {
  readonly busy: boolean;
  readonly onSubmit: (outcome: string) => void;
}

export function CandidateEscalationPanel({ busy, onSubmit }: CandidateEscalationPanelProps) {
  return (
    <section className="candidate-escalation" aria-labelledby="candidate-escalation-heading">
      <h4 id="candidate-escalation-heading">改写次数已经用完了，接下来怎么办？</h4>
      <ul className="candidate-escalation-options">
        {CANDIDATE_ESCALATION_OPTIONS.map((option) => (
          <li key={option.outcome}>
            <button type="button" onClick={() => onSubmit(option.outcome)} disabled={busy}>
              {option.label}
            </button>
            <p className="candidate-gate-desc">{option.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
