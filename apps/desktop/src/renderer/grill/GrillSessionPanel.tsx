/**
 * Grill session 详情面板 —— 中栏。
 *
 * 显示 session 状态、version、操作按钮、问题列表、添加问题表单。
 */

import { useState, useRef, useEffect } from 'react';
import type { GrillSessionPublicData, GrillQuestionPublicData } from '@ai-novel/contracts';
import {
  sessionStatusLabel,
  questionStatusLabel,
  isTerminalSession,
  isPausedSession,
  isQuestionSkippable,
  isQuestionSupersedable,
} from './status-labels';
import { validateTopic, validateQuestionText } from './validation';

interface GrillSessionPanelProps {
  session: GrillSessionPublicData;
  questions: ReadonlyArray<GrillQuestionPublicData>;
  isLoading: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onComplete: () => void;
  onAbandon: () => void;
  onAddQuestions: (
    questions: ReadonlyArray<{ topic: string; text: string; rationale: string }>,
  ) => Promise<boolean>;
  onMarkAsked: (questionId: string) => void;
  onSkip: (questionId: string) => void;
  onSupersede: (questionId: string) => void;
  onSelectQuestion: (questionId: string) => void;
  selectedQuestionId: string | null;
  /** 增量时聚焦问题列表标题（接受成功后触发） */
  questionListFocusToken?: number;
}

export function GrillSessionPanel({
  session,
  questions,
  isLoading,
  onStart,
  onPause,
  onResume,
  onComplete,
  onAbandon,
  onAddQuestions,
  onMarkAsked,
  onSkip,
  onSupersede,
  onSelectQuestion,
  selectedQuestionId,
  questionListFocusToken = 0,
}: GrillSessionPanelProps) {
  const questionListHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusTokenRef = useRef(0);

  // 接受成功后聚焦问题列表标题
  useEffect(() => {
    if (questionListFocusToken > 0 && questionListFocusToken !== lastFocusTokenRef.current) {
      lastFocusTokenRef.current = questionListFocusToken;
      requestAnimationFrame(() => {
        questionListHeadingRef.current?.focus();
      });
    }
  }, [questionListFocusToken]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [topic, setTopic] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [rationale, setRationale] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isAdding, setIsAdding] = useState(false);

  const terminal = isTerminalSession(session.status);
  const paused = isPausedSession(session.status);
  const isActive = session.status === 'ACTIVE';

  const handleAdd = async () => {
    const errors: Record<string, string> = {};
    const topicErr = validateTopic(topic);
    if (topicErr) errors.topic = topicErr;
    const textErr = validateQuestionText(questionText);
    if (textErr) errors.text = textErr;
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    setIsAdding(true);
    const ok = await onAddQuestions([{ topic, text: questionText, rationale }]);
    setIsAdding(false);
    if (ok) {
      setTopic('');
      setQuestionText('');
      setRationale('');
      setFormErrors({});
      setShowAddForm(false);
    }
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  };

  return (
    <div className="grill-session-panel">
      {/* 会话头部信息 */}
      <div className="grill-session-header">
        <div className="grill-session-info">
          <h3 title={session.goal}>{session.goal}</h3>
          <div className="grill-session-meta">
            <span className={`grill-status-badge status-${session.status.toLowerCase()}`}>
              {sessionStatusLabel(session.status)}
            </span>
            <span className="grill-version">v{session.version}</span>
          </div>
        </div>
      </div>

      {/* 版本冲突提示 */}
      {/* 由父组件 GrillWorkbench 统一处理 */}

      {/* 状态操作按钮 */}
      <div className="grill-session-actions">
        {session.status === 'DRAFT' && (
          <button className="btn-primary" onClick={onStart} disabled={isLoading}>
            启动
          </button>
        )}
        {isActive && (
          <>
            <button onClick={onPause} disabled={isLoading}>
              暂停
            </button>
            <button onClick={onComplete} disabled={isLoading}>
              完成
            </button>
          </>
        )}
        {paused && (
          <button className="btn-primary" onClick={onResume} disabled={isLoading}>
            恢复
          </button>
        )}
        {!terminal && (
          <button className="btn-danger" onClick={onAbandon} disabled={isLoading}>
            放弃
          </button>
        )}
      </div>

      {/* 问题列表 */}
      <div className="grill-questions-section">
        <div className="grill-section-header">
          <h4 ref={questionListHeadingRef} tabIndex={-1}>
            问题列表
          </h4>
          {isActive && (
            <button
              className="btn-small"
              onClick={() => setShowAddForm(!showAddForm)}
              disabled={isLoading}
            >
              {showAddForm ? '取消' : '添加问题'}
            </button>
          )}
        </div>

        {showAddForm && isActive && (
          <div className="grill-add-question-form">
            <div className="form-field">
              <label>主题</label>
              <input
                type="text"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setFormErrors((p) => ({ ...p, topic: '' }));
                }}
                placeholder="问题主题"
                disabled={isAdding}
                maxLength={200}
              />
              {formErrors.topic && <span className="form-error">{formErrors.topic}</span>}
            </div>
            <div className="form-field">
              <label>内容</label>
              <textarea
                value={questionText}
                onChange={(e) => {
                  setQuestionText(e.target.value);
                  setFormErrors((p) => ({ ...p, text: '' }));
                }}
                placeholder="问题详细内容"
                rows={3}
                disabled={isAdding}
                maxLength={5000}
              />
              {formErrors.text && <span className="form-error">{formErrors.text}</span>}
            </div>
            <div className="form-field">
              <label>理由</label>
              <input
                type="text"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="为什么需要这个问题（可选）"
                disabled={isAdding}
                maxLength={500}
              />
            </div>
            <button
              className="btn-primary btn-small"
              onClick={handleAdd}
              disabled={isAdding || !topic.trim() || !questionText.trim()}
            >
              {isAdding ? '添加中…' : '确认添加'}
            </button>
          </div>
        )}

        {questions.length === 0 ? (
          <div className="empty-state-small">
            <p>暂无问题</p>
          </div>
        ) : (
          <ul className="grill-question-items">
            {questions.map((q) => (
              <li
                key={q.id}
                className={`grill-question-item ${selectedQuestionId === q.id ? 'active' : ''}`}
                onClick={() => onSelectQuestion(q.id)}
              >
                <div className="grill-question-item-main">
                  <span className="grill-question-topic">{q.topic}</span>
                  <span className={`grill-status-badge status-${q.status.toLowerCase()}`}>
                    {questionStatusLabel(q.status)}
                  </span>
                </div>
                <div className="grill-question-item-actions" onClick={(e) => e.stopPropagation()}>
                  {q.status === 'PLANNED' && isActive && (
                    <button
                      className="btn-small"
                      onClick={() => onMarkAsked(q.id)}
                      disabled={isLoading}
                      title="标记已提问"
                    >
                      提问
                    </button>
                  )}
                  {isQuestionSkippable(q.status) && isActive && (
                    <button
                      className="btn-small"
                      onClick={() => onSkip(q.id)}
                      disabled={isLoading}
                      title="跳过"
                    >
                      跳过
                    </button>
                  )}
                  {isQuestionSupersedable(q.status) && isActive && (
                    <button
                      className="btn-small btn-danger"
                      onClick={() => onSupersede(q.id)}
                      disabled={isLoading}
                      title="废弃"
                    >
                      废弃
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 时间信息 */}
      <div className="grill-session-timestamps">
        <span>创建：{formatTime(session.createdAt)}</span>
        {session.startedAt && <span>启动：{formatTime(session.startedAt)}</span>}
        {session.completedAt && <span>完成：{formatTime(session.completedAt)}</span>}
        {session.abandonedAt && <span>放弃：{formatTime(session.abandonedAt)}</span>}
      </div>
    </div>
  );
}
