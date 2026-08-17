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
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

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
    <section
      className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3.5"
      aria-labelledby="candidate-gate-heading"
    >
      <h4 id="candidate-gate-heading" className="text-[15px]">
        这一版怎么处理？
      </h4>

      <div className="flex flex-col items-start gap-1.5">
        <Button type="button" onClick={() => onSubmit('accept', null)} disabled={busy}>
          {acceptOption.label}
        </Button>
        <p className="text-xs text-muted-foreground">{acceptOption.description}</p>
      </div>

      <div className="flex flex-col items-start gap-1.5">
        <Label className="text-[13px]" htmlFor="candidate-feedback">
          你的修改意见（可留空）
        </Label>
        <Textarea
          id="candidate-feedback"
          value={feedback}
          maxLength={MAX_CHAPTER_FEEDBACK_LENGTH}
          rows={3}
          placeholder="例如：第二场的对话太客气了，两人此时已经撕破脸"
          onChange={(e) => setFeedback(e.target.value)}
          disabled={busy}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onSubmit('request_rewrite', trimmed.length > 0 ? trimmed : null)}
          disabled={busy}
        >
          {rewriteCopy.label}
        </Button>
        <p className="text-xs text-muted-foreground">{rewriteCopy.description}</p>
      </div>

      <div className="flex flex-col items-start gap-1.5">
        <Button
          type="button"
          variant="outline"
          onClick={() => onSubmit('reject', null)}
          disabled={busy}
        >
          {regenerateCopy.label}
        </Button>
        <p className="text-xs text-muted-foreground">{regenerateCopy.description}</p>
      </div>
    </section>
  );
}
