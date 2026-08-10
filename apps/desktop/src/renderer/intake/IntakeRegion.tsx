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

import { useCallback, useEffect, useState } from 'react';
import { ESCALATION_OPTIONS, journeyStageFromPhase, type JourneyStage } from './intake-logic';
import { useIntake } from './useIntake';
import { CreationSpecPanel } from './CreationSpecPanel';

export interface IntakeRegionProps {
  readonly projectId: string;
  /** 旅程阶段回报（App shell 导航高亮，D-B4-1） */
  readonly onStageChange?: (stage: JourneyStage) => void;
}

export function IntakeRegion({ projectId, onStageChange }: IntakeRegionProps) {
  const intake = useIntake(projectId);
  const [answerText, setAnswerText] = useState('');

  const stage = journeyStageFromPhase(intake.phase);
  useEffect(() => {
    onStageChange?.(stage);
  }, [stage, onStageChange]);

  const handleSubmit = useCallback(async () => {
    const text = answerText.trim();
    if (text.length === 0) return;
    await intake.submitAnswer(text);
    setAnswerText('');
  }, [answerText, intake]);

  const { phase } = intake;

  return (
    <div className="intake-region">
      <div className="intake-header">
        <h2 id="intake-heading">创作访谈</h2>
      </div>

      {intake.error && (
        <div className="intake-error" role="alert">
          {intake.error}
        </div>
      )}

      {/* 消息流 */}
      <div className="intake-messages" role="log" aria-label="访谈记录">
        {intake.messages.map((msg, i) =>
          msg.kind === 'goal' ? (
            <div key={`goal-${i}`} className="intake-msg intake-msg-goal">
              <span className="intake-msg-label">你的想法</span>
              <p>{msg.text}</p>
            </div>
          ) : (
            <div key={msg.questionId} className="intake-msg intake-msg-question">
              <span className="intake-msg-label">追问</span>
              <p>{msg.text}</p>
              {msg.answer !== null && (
                <div className="intake-msg-answer">
                  <span className="intake-msg-label">你的回答</span>
                  <p>{msg.answer}</p>
                </div>
              )}
              {msg.skipped && <p className="intake-msg-skipped">（已跳过）</p>}
            </div>
          ),
        )}
      </div>

      {/* 相位区 */}
      {phase.kind === 'awaiting-answer' && intake.pendingQuestion && (
        <div className="intake-answer-area">
          <label htmlFor="intake-answer-input" className="sr-only">
            回答当前问题
          </label>
          <textarea
            id="intake-answer-input"
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="输入你的回答；也可以直接粘贴大段设定文字"
            rows={4}
            disabled={intake.busy}
          />
          <div className="intake-answer-actions">
            <button
              className="btn-primary"
              onClick={() => void handleSubmit()}
              disabled={intake.busy || answerText.trim().length === 0}
            >
              回答
            </button>
            <button
              className="btn-secondary"
              onClick={() => void intake.skipQuestion()}
              disabled={intake.busy}
            >
              跳过这个问题
            </button>
            <button
              className="btn-secondary"
              onClick={() => void intake.finishInterview()}
              disabled={intake.busy}
            >
              我说完了，就这样整理
            </button>
          </div>
        </div>
      )}

      {(phase.kind === 'extracting' || phase.kind === 'working') && (
        <div className="intake-status" role="status" aria-live="polite">
          <span className="intake-spinner" aria-hidden="true">
            ⟳
          </span>
          正在整理你的创作要求…
        </div>
      )}

      {phase.kind === 'no-run' && (
        <div className="intake-status" role="status">
          访谈还没有开始。
          <button
            className="btn-primary"
            onClick={() => void intake.restartInterview()}
            disabled={intake.busy}
          >
            开始访谈
          </button>
        </div>
      )}

      {phase.kind === 'escalation' && (
        <div className="intake-escalation">
          <p>访谈遇到了需要你决定的情况，接下来想怎么做？</p>
          <div className="intake-escalation-options">
            {ESCALATION_OPTIONS.map((opt) => (
              <button
                key={opt.outcome}
                className="intake-escalation-option"
                onClick={() => void intake.chooseEscalation(opt.outcome)}
                disabled={intake.busy}
              >
                <strong>{opt.label}</strong>
                <span>{opt.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase.kind === 'terminal' && phase.status === 'failed' && (
        <div className="intake-failed" role="alert">
          <p>这次访谈中断了。别担心，你的想法和已整理的创作要求都还在。</p>
          <button
            className="btn-primary"
            onClick={() => void intake.restartInterview()}
            disabled={intake.busy}
          >
            重新开始访谈
          </button>
        </div>
      )}

      {phase.kind === 'terminal' && phase.status !== 'failed' && (
        <div className="intake-status" role="status">
          {phase.status === 'cancelled' ? '访谈已取消。' : '访谈已结束。'}
          <button
            className="btn-secondary"
            onClick={() => void intake.restartInterview()}
            disabled={intake.busy}
          >
            重新开始访谈
          </button>
        </div>
      )}

      {phase.kind === 'beyond-intake' && (
        <div className="intake-status" role="status">
          创作要求整理完成。后续阶段（调研、蓝图、成稿）将在后续版本逐步开放。
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
