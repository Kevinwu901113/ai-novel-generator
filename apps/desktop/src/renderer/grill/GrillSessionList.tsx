/**
 * Grill session 列表组件 —— 左栏。
 */

import { useState } from 'react';
import type { GrillSessionPublicData } from '@ai-novel/contracts';
import { sessionStatusLabel } from './status-labels';
import { validateGoal } from './validation';

interface GrillSessionListProps {
  sessions: ReadonlyArray<GrillSessionPublicData>;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (goal: string) => Promise<GrillSessionPublicData | null>;
  isLoading: boolean;
}

export function GrillSessionList({
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  isLoading,
}: GrillSessionListProps) {
  const [showForm, setShowForm] = useState(false);
  const [goal, setGoal] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    const err = validateGoal(goal);
    if (err) {
      setFormError(err);
      return;
    }
    setIsCreating(true);
    setFormError(null);
    const session = await onCreateSession(goal);
    setIsCreating(false);
    if (session) {
      setGoal('');
      setShowForm(false);
      onSelectSession(session.id);
    }
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  };

  return (
    <div className="grill-session-list">
      <div className="grill-session-list-header">
        <h3>Grill 会话</h3>
        <button
          className="btn-small"
          onClick={() => setShowForm(!showForm)}
          disabled={isLoading}
          title="新建会话"
        >
          {showForm ? '取消' : '＋'}
        </button>
      </div>

      {showForm && (
        <div className="grill-session-form">
          <input
            type="text"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setFormError(null);
            }}
            placeholder="会话目标"
            disabled={isCreating}
            maxLength={500}
          />
          {formError && <span className="form-error">{formError}</span>}
          <button
            className="btn-small"
            onClick={handleCreate}
            disabled={isCreating || !goal.trim()}
          >
            {isCreating ? '创建中…' : '创建'}
          </button>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="empty-state-small">
          <p>暂无会话</p>
        </div>
      ) : (
        <ul className="grill-session-items">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`grill-session-item ${selectedSessionId === s.id ? 'active' : ''}`}
              onClick={() => onSelectSession(s.id)}
            >
              <span className="grill-session-item-goal">{s.goal}</span>
              <span className={`grill-status-badge status-${s.status.toLowerCase()}`}>
                {sessionStatusLabel(s.status)}
              </span>
              <span className="grill-session-item-time">{formatTime(s.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
