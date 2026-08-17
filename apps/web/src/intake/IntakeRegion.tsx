/**
 * 对话式 Idea Intake 访谈（B4 中栏主体）。
 *
 * 相位驱动（intake-logic.deriveIntakePhase）：
 * - awaiting-answer：消息流 + 多行输入（支持长文粘贴设定）+ 回答/跳过/我说完了；
 * - extracting / working：整理中提示；
 * - escalation：四选项友好文案；
 * - terminal failed：友好提示 + 重新开始访谈（TD-022/D-B4-2）；
 * - beyond-intake：访谈完成，展示创作要求（可编辑）。
 * 不暴露 session / run / 节点等工程概念（roadmap 锁定约束）。
 */

import { useCallback, useState } from 'react';
import { ESCALATION_OPTIONS } from './intake-logic';
import { useIntake } from './useIntake';
import { CreationSpecPanel } from './CreationSpecPanel';
import { InlineError } from '@/components/InlineError';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface IntakeRegionProps {
  readonly projectId: string;
}

/**
 * D-B8-2：本 Region 不再回报旅程阶段（原 onStageChange）——阶段派生已上提到
 * App 的旅程探针（journey/useJourney），Region 只负责渲染与自身内容拉取。
 */
export function IntakeRegion({ projectId }: IntakeRegionProps) {
  const intake = useIntake(projectId);
  const [answerText, setAnswerText] = useState('');

  const handleSubmit = useCallback(async () => {
    const text = answerText.trim();
    if (text.length === 0) return;
    await intake.submitAnswer(text);
    setAnswerText('');
  }, [answerText, intake]);

  const { phase } = intake;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-[30px_clamp(16px,5vw,64px)]">
      <div>
        <h2 id="intake-heading" className="text-lg font-semibold">
          创作访谈
        </h2>
      </div>

      {intake.error && <InlineError>{intake.error}</InlineError>}

      {/* 消息流 */}
      <div className="flex flex-col gap-2.5" role="log" aria-label="访谈记录">
        {intake.messages.map((msg, i) =>
          msg.kind === 'goal' ? (
            <div
              key={`goal-${i}`}
              className="max-w-[760px] rounded-lg border border-l-2 border-border border-l-primary/50 bg-muted px-3 py-2.5"
            >
              <span className="text-xs text-muted-foreground">你的想法</span>
              <p className="mt-1 whitespace-pre-wrap">{msg.text}</p>
            </div>
          ) : (
            <div
              key={msg.questionId}
              className="max-w-[760px] rounded-lg border border-border bg-muted px-3 py-2.5"
            >
              <span className="text-xs text-muted-foreground">追问</span>
              <p className="mt-1 whitespace-pre-wrap">{msg.text}</p>
              {msg.answer !== null && (
                <div className="mt-2 border-t border-dashed border-border pt-2">
                  <span className="text-xs text-muted-foreground">你的回答</span>
                  <p className="mt-1 whitespace-pre-wrap">{msg.answer}</p>
                </div>
              )}
              {msg.skipped && <p className="mt-1 text-sm text-muted-foreground">（已跳过）</p>}
            </div>
          ),
        )}
      </div>

      {/* 相位区 */}
      {phase.kind === 'awaiting-answer' && intake.pendingQuestion && (
        <div className="flex max-w-[760px] flex-col gap-2">
          <label htmlFor="intake-answer-input" className="sr-only">
            回答当前问题
          </label>
          <Textarea
            id="intake-answer-input"
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="输入你的回答；也可以直接粘贴大段设定文字"
            rows={4}
            disabled={intake.busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void handleSubmit()}
              disabled={intake.busy || answerText.trim().length === 0}
            >
              回答
            </Button>
            <Button
              variant="outline"
              onClick={() => void intake.skipQuestion()}
              disabled={intake.busy}
            >
              跳过这个问题
            </Button>
            <Button
              variant="outline"
              onClick={() => void intake.finishInterview()}
              disabled={intake.busy}
            >
              我说完了，就这样整理
            </Button>
          </div>
        </div>
      )}

      {(phase.kind === 'extracting' || phase.kind === 'working') && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner label={null} size={16} />
          正在整理你的创作要求…
        </div>
      )}

      {phase.kind === 'no-run' && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          访谈还没有开始。
          <Button onClick={() => void intake.restartInterview()} disabled={intake.busy}>
            开始访谈
          </Button>
        </div>
      )}

      {phase.kind === 'escalation' && (
        <div className="max-w-[760px]">
          <p>访谈遇到了需要你决定的情况，接下来想怎么做？</p>
          <div className="mt-2 flex flex-col gap-2">
            {ESCALATION_OPTIONS.map((opt) => (
              <button
                key={opt.outcome}
                type="button"
                className="flex flex-col items-start gap-0.5 rounded-md border border-border bg-muted px-3 py-2.5 text-left font-inherit text-foreground hover:border-primary"
                onClick={() => void intake.chooseEscalation(opt.outcome)}
                disabled={intake.busy}
              >
                <strong>{opt.label}</strong>
                <span className="text-xs text-muted-foreground">{opt.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase.kind === 'terminal' && phase.status === 'failed' && (
        <InlineError className="max-w-[760px]">
          <p>这次访谈中断了。别担心，你的想法和已整理的创作要求都还在。</p>
          <Button
            className="mt-1"
            onClick={() => void intake.restartInterview()}
            disabled={intake.busy}
          >
            重新开始访谈
          </Button>
        </InlineError>
      )}

      {phase.kind === 'terminal' && phase.status !== 'failed' && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {phase.status === 'cancelled' ? '访谈已取消。' : '访谈已结束。'}
          <Button
            variant="outline"
            onClick={() => void intake.restartInterview()}
            disabled={intake.busy}
          >
            重新开始访谈
          </Button>
        </div>
      )}

      {phase.kind === 'beyond-intake' && (
        <div role="status" className="text-sm text-muted-foreground">
          创作要求已整理，正在继续调研与蓝图流程。
        </div>
      )}

      {/* 创作要求：有 current 版本即展示（含访谈进行中的中间版本） */}
      {intake.spec && (
        <CreationSpecPanel
          projectId={projectId}
          spec={intake.spec}
          onSaved={() => void intake.refreshSpec()}
        />
      )}
    </div>
  );
}
