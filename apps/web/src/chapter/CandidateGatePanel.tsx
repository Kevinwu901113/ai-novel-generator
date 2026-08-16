/**
 * 候选确认面板（B10，CANDIDATE_GATE 的三个选项）。
 *
 * D-B10-3：只有"按我的意见改写"带意见输入框，且**意见真的会被后端消费**
 * （提交时先落 chapter_rewrite_feedback，再推进 Graph；REWRITE prompt 读它）。
 * 其余两个选项不显示输入框——B6/B7/B8 各踩过一次"只加 UI 而后端不消费"的空承诺。
 *
 * 次数用尽时按钮**不禁用**，只改文案：耗尽后再提交一次正是进入升级四选项的唯一
 * 入口（图上 gate→escalation 边要求"提交该决策且预算已耗尽"）。
 */

import { useState } from 'react';
import type { ChapterRunStateDto } from '@ai-novel/contracts';
import { MAX_CHAPTER_FEEDBACK_LENGTH } from '@ai-novel/contracts';
import {
  CANDIDATE_GATE_OPTIONS,
  candidateRewriteRemaining,
  regenerateOptionCopy,
  regenerateRemaining,
  rewriteOptionCopy,
} from './chapter-logic';

export interface CandidateGatePanelProps {
  readonly state: ChapterRunStateDto;
  readonly busy: boolean;
  readonly onSubmit: (outcome: string, feedback: string | null) => void;
}

export function CandidateGatePanel({ state, busy, onSubmit }: CandidateGatePanelProps) {
  const [feedback, setFeedback] = useState('');
  const rewriteCopy = rewriteOptionCopy(candidateRewriteRemaining(state));
  const regenerateCopy = regenerateOptionCopy(regenerateRemaining(state));
  const acceptOption = CANDIDATE_GATE_OPTIONS.find((o) => o.outcome === 'accept')!;
  const trimmed = feedback.trim();

  return (
    <section className="candidate-gate" aria-labelledby="candidate-gate-heading">
      <h4 id="candidate-gate-heading">这一版怎么处理？</h4>

      <div className="candidate-gate-option">
        <button
          type="button"
          className="btn-primary"
          onClick={() => onSubmit('accept', null)}
          disabled={busy}
        >
          {acceptOption.label}
        </button>
        <p className="candidate-gate-desc">{acceptOption.description}</p>
      </div>

      <div className="candidate-gate-option">
        <label className="candidate-feedback-label" htmlFor="candidate-feedback">
          你的修改意见（可留空）
        </label>
        <textarea
          id="candidate-feedback"
          className="candidate-feedback"
          value={feedback}
          maxLength={MAX_CHAPTER_FEEDBACK_LENGTH}
          rows={3}
          placeholder="例如：第二场的对话太客气了，两人此时已经撕破脸"
          onChange={(e) => setFeedback(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => onSubmit('request_rewrite', trimmed.length > 0 ? trimmed : null)}
          disabled={busy}
        >
          {rewriteCopy.label}
        </button>
        <p className="candidate-gate-desc">{rewriteCopy.description}</p>
      </div>

      <div className="candidate-gate-option">
        <button type="button" onClick={() => onSubmit('reject', null)} disabled={busy}>
          {regenerateCopy.label}
        </button>
        <p className="candidate-gate-desc">{regenerateCopy.description}</p>
      </div>
    </section>
  );
}
