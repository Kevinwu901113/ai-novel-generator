/**
 * Grill 问题详情 —— 右栏。
 *
 * 显示问题详情、回答输入、修订历史、提案列表与审核。
 */

import { useEffect, useState } from 'react';
import type {
  GrillQuestionPublicData,
  GrillAnswerPublicData,
  GrillProposalPublicData,
} from '@ai-novel/contracts';
import {
  questionStatusLabel,
  proposalStatusLabel,
  isQuestionAnswerable,
  isProposalReviewable,
} from './status-labels';
import {
  validateAnswer,
  validateProposalKey,
  validateProposalValueJson,
  validateConfidence,
} from './validation';

interface GrillQuestionDetailProps {
  question: GrillQuestionPublicData;
  sessionIsActive: boolean;
  currentAnswers: ReadonlyArray<GrillAnswerPublicData>;
  proposals: ReadonlyArray<GrillProposalPublicData>;
  isLoading: boolean;
  onAnswer: (questionId: string, text: string) => Promise<boolean>;
  onListAnswerHistory: (questionId: string) => Promise<ReadonlyArray<GrillAnswerPublicData>>;
  onCreateProposal: (input: {
    key: string;
    proposedValueJson: string;
    confidence: number;
    rationale: string;
    basedOnAnswerIds: ReadonlyArray<string>;
  }) => Promise<boolean>;
  onReviewProposal: (proposalId: string, decision: 'ACCEPTED' | 'REJECTED') => Promise<boolean>;
}

export function GrillQuestionDetail({
  question,
  sessionIsActive,
  currentAnswers,
  proposals,
  isLoading,
  onAnswer,
  onListAnswerHistory,
  onCreateProposal,
  onReviewProposal,
}: GrillQuestionDetailProps) {
  const [answerText, setAnswerText] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [isAnswering, setIsAnswering] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ReadonlyArray<GrillAnswerPublicData>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Proposal form state
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [proposalKey, setProposalKey] = useState('');
  const [proposalValue, setProposalValue] = useState('');
  const [proposalConfidence, setProposalConfidence] = useState(0.8);
  const [proposalRationale, setProposalRationale] = useState('');
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>({});
  const [isCreatingProposal, setIsCreatingProposal] = useState(false);

  // Reset form state when question changes
  useEffect(() => {
    setAnswerText('');
    setAnswerError(null);
    setShowHistory(false);
    setHistory([]);
    setShowProposalForm(false);
    setProposalKey('');
    setProposalValue('');
    setProposalConfidence(0.8);
    setProposalRationale('');
    setProposalErrors({});
  }, [question.id]);

  const handleAnswer = async () => {
    const err = validateAnswer(answerText);
    if (err) {
      setAnswerError(err);
      return;
    }
    setIsAnswering(true);
    setAnswerError(null);
    const ok = await onAnswer(question.id, answerText);
    setIsAnswering(false);
    if (ok) setAnswerText('');
  };

  const handleLoadHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setHistoryLoading(true);
    const h = await onListAnswerHistory(question.id);
    setHistory(h);
    setHistoryLoading(false);
    setShowHistory(true);
  };

  const handleCreateProposal = async () => {
    const errors: Record<string, string> = {};
    const keyErr = validateProposalKey(proposalKey);
    if (keyErr) errors.key = keyErr;
    const valErr = validateProposalValueJson(proposalValue);
    if (valErr) errors.value = valErr;
    const confErr = validateConfidence(proposalConfidence);
    if (confErr) errors.confidence = confErr;
    if (Object.keys(errors).length > 0) {
      setProposalErrors(errors);
      return;
    }

    // Find current answer for this question to use as basedOnAnswerIds
    const currentAnswer = currentAnswers.find((a) => a.questionId === question.id);
    if (!currentAnswer) {
      setProposalErrors({ general: '请先回答此问题再创建提案' });
      return;
    }

    setIsCreatingProposal(true);
    const ok = await onCreateProposal({
      key: proposalKey.trim(),
      proposedValueJson: proposalValue.trim(),
      confidence: proposalConfidence,
      rationale: proposalRationale,
      basedOnAnswerIds: [currentAnswer.id],
    });
    setIsCreatingProposal(false);
    if (ok) {
      setProposalKey('');
      setProposalValue('');
      setProposalConfidence(0.8);
      setProposalRationale('');
      setProposalErrors({});
      setShowProposalForm(false);
    }
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  };

  const currentAnswer = currentAnswers.find((a) => a.questionId === question.id);
  const canAnswer = isQuestionAnswerable(question.status) && sessionIsActive;

  return (
    <div className="grill-question-detail">
      {/* 问题信息 */}
      <div className="grill-question-header">
        <h4>{question.topic}</h4>
        <span className={`grill-status-badge status-${question.status.toLowerCase()}`}>
          {questionStatusLabel(question.status)}
        </span>
      </div>
      <p className="grill-question-text">{question.text}</p>
      {question.rationale && (
        <p className="grill-question-rationale">
          <strong>理由：</strong>
          {question.rationale}
        </p>
      )}

      {/* 当前答案 */}
      {currentAnswer && (
        <div className="grill-current-answer">
          <h5>
            当前答案 <span className="grill-revision">revision {currentAnswer.revision}</span>
          </h5>
          <p className="grill-answer-text">{currentAnswer.text}</p>
          <span className="grill-answer-time">{formatTime(currentAnswer.createdAt)}</span>
        </div>
      )}

      {/* 回答输入 */}
      {canAnswer && (
        <div className="grill-answer-form">
          <h5>{currentAnswer ? '修订回答' : '回答问题'}</h5>
          <textarea
            value={answerText}
            onChange={(e) => {
              setAnswerText(e.target.value);
              setAnswerError(null);
            }}
            placeholder={currentAnswer ? '输入新的回答内容…' : '输入回答内容…'}
            rows={4}
            disabled={isAnswering}
            maxLength={10000}
          />
          {answerError && <span className="form-error">{answerError}</span>}
          <div className="grill-answer-actions">
            <button
              className="btn-primary btn-small"
              onClick={handleAnswer}
              disabled={isAnswering || !answerText.trim()}
            >
              {isAnswering ? '提交中…' : currentAnswer ? '修订' : '提交回答'}
            </button>
            <button className="btn-small" onClick={handleLoadHistory} disabled={historyLoading}>
              {showHistory ? '隐藏历史' : historyLoading ? '加载中…' : '查看历史'}
            </button>
          </div>
        </div>
      )}

      {/* 答案历史 */}
      {showHistory && history.length > 0 && (
        <div className="grill-answer-history">
          <h5>答案历史</h5>
          <ul>
            {history.map((a) => (
              <li
                key={a.id}
                className={`grill-history-item ${a.supersededAt ? 'superseded' : 'current'}`}
              >
                <div className="grill-history-meta">
                  <span className="grill-revision">revision {a.revision}</span>
                  {a.supersededAt && <span className="grill-badge-old">已废弃</span>}
                  <span>{formatTime(a.createdAt)}</span>
                </div>
                <p>{a.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 提案列表 */}
      <div className="grill-proposals-section">
        <div className="grill-section-header">
          <h5>推理提案</h5>
          {sessionIsActive && currentAnswer && (
            <button
              className="btn-small"
              onClick={() => setShowProposalForm(!showProposalForm)}
              disabled={isLoading}
            >
              {showProposalForm ? '取消' : '创建提案'}
            </button>
          )}
        </div>

        {showProposalForm && (
          <div className="grill-proposal-form">
            <div className="form-field">
              <label>Key</label>
              <input
                type="text"
                value={proposalKey}
                onChange={(e) => {
                  setProposalKey(e.target.value);
                  setProposalErrors((p) => ({ ...p, key: '' }));
                }}
                placeholder="推理结论的 key"
                disabled={isCreatingProposal}
                maxLength={200}
              />
              {proposalErrors.key && <span className="form-error">{proposalErrors.key}</span>}
            </div>
            <div className="form-field">
              <label>Value（JSON）</label>
              <textarea
                value={proposalValue}
                onChange={(e) => {
                  setProposalValue(e.target.value);
                  setProposalErrors((p) => ({ ...p, value: '' }));
                }}
                placeholder='{"key": "value"}'
                rows={3}
                disabled={isCreatingProposal}
                maxLength={10000}
              />
              {proposalErrors.value && <span className="form-error">{proposalErrors.value}</span>}
            </div>
            <div className="form-field">
              <label>置信度（0-1）</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={proposalConfidence}
                onChange={(e) => {
                  setProposalConfidence(parseFloat(e.target.value) || 0);
                  setProposalErrors((p) => ({ ...p, confidence: '' }));
                }}
                disabled={isCreatingProposal}
              />
              {proposalErrors.confidence && (
                <span className="form-error">{proposalErrors.confidence}</span>
              )}
            </div>
            <div className="form-field">
              <label>理由</label>
              <input
                type="text"
                value={proposalRationale}
                onChange={(e) => setProposalRationale(e.target.value)}
                placeholder="推理理由"
                disabled={isCreatingProposal}
                maxLength={1000}
              />
            </div>
            {proposalErrors.general && <span className="form-error">{proposalErrors.general}</span>}
            <button
              className="btn-primary btn-small"
              onClick={handleCreateProposal}
              disabled={isCreatingProposal}
            >
              {isCreatingProposal ? '创建中…' : '确认创建'}
            </button>
          </div>
        )}

        {proposals.length === 0 ? (
          <div className="empty-state-small">
            <p>暂无提案</p>
          </div>
        ) : (
          <ul className="grill-proposal-items">
            {proposals.map((p) => (
              <li key={p.id} className="grill-proposal-item">
                <div className="grill-proposal-header">
                  <strong>{p.key}</strong>
                  <span className={`grill-status-badge status-${p.status.toLowerCase()}`}>
                    {proposalStatusLabel(p.status)}
                  </span>
                </div>
                <pre className="grill-proposal-value">
                  {typeof p.proposedValue === 'string'
                    ? p.proposedValue
                    : JSON.stringify(p.proposedValue, null, 2)}
                </pre>
                <div className="grill-proposal-meta">
                  <span>置信度：{p.confidence}</span>
                  {p.rationale && <span>理由：{p.rationale}</span>}
                </div>
                {isProposalReviewable(p.status) && (
                  <div className="grill-proposal-actions">
                    <button
                      className="btn-small btn-primary"
                      onClick={() => onReviewProposal(p.id, 'ACCEPTED')}
                      disabled={isLoading}
                    >
                      接受
                    </button>
                    <button
                      className="btn-small btn-danger"
                      onClick={() => onReviewProposal(p.id, 'REJECTED')}
                      disabled={isLoading}
                    >
                      拒绝
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
