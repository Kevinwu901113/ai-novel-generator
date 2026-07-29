/**
 * Grill 问题规划面板组件。
 *
 * 职责：
 * - 显示"请求问题规划"按钮
 * - 显示任务状态
 * - 显示问题规划提案列表
 * - 提供显式接受按钮
 * - 处理 stale 状态
 * - 焦点管理和 ARIA
 */

import { useRef, useEffect } from 'react';
import type {
  GrillQuestionPlanProposalPublicData,
  GrillPlannedQuestionPublicData,
  GrillPlannedDependencyPublicData,
  TaskPublicData,
} from '@ai-novel/contracts';
import { proposalStatusLabel } from './status-labels';

/** 任务终态集合 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

/** 任务状态中文标签 */
const TASK_STATUS_LABELS: Record<string, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  STALE: '已过期',
};

/** 任务短 ID 显示 */
function shortTaskId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8) + '…';
}

/** 依赖类型中文标签 */
function dependencyLabel(dep: GrillPlannedDependencyPublicData): string {
  if (dep.kind === 'existing') {
    return `已有问题${dep.questionId ? ` (${dep.questionId.slice(0, 8)})` : ''}`;
  }
  return `计划问题${dep.questionKey ? ` (${dep.questionKey})` : ''}`;
}

/** 从 proposal 列表生成稳定的 batch key */
function proposalBatchKey(proposals: ReadonlyArray<GrillQuestionPlanProposalPublicData>): string {
  if (proposals.length === 0) return '';
  return proposals
    .map((p) => p.id)
    .sort()
    .join(',');
}

interface GrillQuestionPlanPanelProps {
  contextKey: string;
  sessionIsActive: boolean;
  hasSession: boolean;
  task: TaskPublicData | null;
  isPolling: boolean;
  onRequestPlan: () => void;
  isRequesting: boolean;
  proposals: ReadonlyArray<GrillQuestionPlanProposalPublicData>;
  isLoadingProposals: boolean;
  onAcceptProposal: (proposalId: string) => void;
  isAccepting: boolean;
  isLoading: boolean;
  error: string | null;
  onClearError: () => void;
}

export function GrillQuestionPlanPanel({
  contextKey,
  sessionIsActive,
  hasSession,
  task,
  isPolling,
  onRequestPlan,
  isRequesting,
  proposals,
  isLoadingProposals,
  onAcceptProposal,
  isAccepting,
  isLoading,
  error,
  onClearError,
}: GrillQuestionPlanPanelProps) {
  // ── 焦点管理 refs ──────────────────────────────────────────────
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const proposalHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusedTaskIdRef = useRef<string | null>(null);
  const lastFocusedProposalBatchRef = useRef<string>('');
  const taskRafRef = useRef<number | null>(null);
  const proposalRafRef = useRef<number | null>(null);

  // ── 清理所有 RAF ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (taskRafRef.current !== null) {
        cancelAnimationFrame(taskRafRef.current);
        taskRafRef.current = null;
      }
      if (proposalRafRef.current !== null) {
        cancelAnimationFrame(proposalRafRef.current);
        proposalRafRef.current = null;
      }
    };
  }, []);

  // ── contextKey 变化时重置焦点身份和 RAF ──────────────────────
  useEffect(() => {
    lastFocusedTaskIdRef.current = null;
    lastFocusedProposalBatchRef.current = '';
    if (taskRafRef.current !== null) {
      cancelAnimationFrame(taskRafRef.current);
      taskRafRef.current = null;
    }
    if (proposalRafRef.current !== null) {
      cancelAnimationFrame(proposalRafRef.current);
      proposalRafRef.current = null;
    }
  }, [contextKey]);

  // ── task 首次出现时聚焦 task heading（按 task.id 追踪） ────────
  useEffect(() => {
    if (!task) return;
    if (task.id === lastFocusedTaskIdRef.current) return;
    lastFocusedTaskIdRef.current = task.id;

    if (taskRafRef.current !== null) {
      cancelAnimationFrame(taskRafRef.current);
    }
    taskRafRef.current = requestAnimationFrame(() => {
      taskRafRef.current = null;
      taskHeadingRef.current?.focus();
    });
  }, [task]);

  // ── proposal batch 首次出现时聚焦 proposal heading ────────────
  useEffect(() => {
    const batchKey = proposalBatchKey(proposals);
    if (!batchKey) return;
    if (batchKey === lastFocusedProposalBatchRef.current) return;
    lastFocusedProposalBatchRef.current = batchKey;

    if (proposalRafRef.current !== null) {
      cancelAnimationFrame(proposalRafRef.current);
    }
    proposalRafRef.current = requestAnimationFrame(() => {
      proposalRafRef.current = null;
      proposalHeadingRef.current?.focus();
    });
  }, [proposals]);

  // ── disabled 条件 ────────────────────────────────────────────────
  const canRequest = hasSession && sessionIsActive && !isRequesting && !isPolling && !isLoading;

  const showTaskStatus = task !== null;
  const showProposals = proposals.length > 0 || isLoadingProposals;

  return (
    <div className="grill-question-plan-panel">
      {/* 请求按钮区域 */}
      <div className="grill-plan-request-section">
        <button
          className="btn-primary grill-plan-request-btn"
          onClick={onRequestPlan}
          disabled={!canRequest}
          aria-busy={isRequesting}
        >
          {isRequesting ? '请求中…' : '请求问题规划'}
        </button>
        {!hasSession && <span className="grill-plan-hint">请先选择一个 Grill 会话</span>}
        {hasSession && !sessionIsActive && (
          <span className="grill-plan-hint">会话需要处于进行中状态</span>
        )}
      </div>

      {/* 错误提示（role=alert，唯一） */}
      {error && (
        <div className="grill-plan-error" role="alert">
          <span>{error}</span>
          <button onClick={onClearError} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      {/* 任务状态区域 */}
      {showTaskStatus && (
        <div
          className="grill-plan-task-status"
          role="status"
          aria-busy={isPolling && !TERMINAL_TASK_STATUSES.has(task.status)}
        >
          <h4 ref={taskHeadingRef} tabIndex={-1} className="grill-plan-task-heading">
            问题规划任务
          </h4>
          <div className="grill-plan-task-info">
            <span className="grill-plan-task-id">{shortTaskId(task.id)}</span>
            <span className={`grill-plan-task-status-badge status-${task.status.toLowerCase()}`}>
              {TASK_STATUS_LABELS[task.status] ?? task.status}
            </span>
            {isPolling && !TERMINAL_TASK_STATUSES.has(task.status) && (
              <span className="grill-plan-polling-indicator" aria-hidden="true">
                ⏳
              </span>
            )}
          </div>
          {task.status === 'FAILED' && task.errorCode && (
            <div className="grill-plan-task-error">错误：{task.errorCode}</div>
          )}
          <div className="grill-plan-task-hint">
            <span>可在任务活动中心查看详细状态</span>
          </div>
        </div>
      )}

      {/* 提案列表区域 */}
      {showProposals && (
        <div className="grill-plan-proposals-section" aria-busy={isLoadingProposals}>
          <h4 ref={proposalHeadingRef} tabIndex={-1} className="grill-plan-proposals-heading">
            问题规划提案
          </h4>

          {isLoadingProposals && proposals.length === 0 ? (
            <div className="grill-plan-loading">加载提案中…</div>
          ) : (
            <ul className="grill-plan-proposal-list">
              {proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  onAccept={onAcceptProposal}
                  isAccepting={isAccepting}
                  isLoading={isLoading}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 提案卡片组件 */
interface ProposalCardProps {
  proposal: GrillQuestionPlanProposalPublicData;
  onAccept: (proposalId: string) => void;
  isAccepting: boolean;
  isLoading: boolean;
}

function ProposalCard({ proposal, onAccept, isAccepting, isLoading }: ProposalCardProps) {
  const isStale = proposal.status === 'SUPERSEDED';
  const isAcceptable = proposal.status === 'PROPOSED';

  return (
    <li
      className={`grill-plan-proposal-card ${isStale ? 'grill-plan-proposal-stale' : ''}`}
      aria-label={`问题规划提案：${proposal.questionCount} 个问题`}
    >
      <div className="grill-plan-proposal-header">
        <span className={`grill-status-badge status-${proposal.status.toLowerCase()}`}>
          {proposalStatusLabel(proposal.status)}
        </span>
        {isStale && (
          <span className="grill-plan-stale-label" aria-label="此提案已过期">
            已过期
          </span>
        )}
      </div>

      <div className="grill-plan-proposal-meta">
        <span>问题数量：{proposal.questionCount}</span>
        <span>基础版本：v{proposal.baseSessionVersion}</span>
        <span>Schema 版本：{proposal.schemaVersion}</span>
      </div>

      <div className="grill-plan-proposal-time">
        <span>创建时间：{formatTime(proposal.createdAt)}</span>
        {proposal.reviewedAt && <span>审核时间：{formatTime(proposal.reviewedAt)}</span>}
      </div>

      {proposal.questions.length > 0 && (
        <div className="grill-plan-questions">
          <h5>规划问题</h5>
          <ul className="grill-plan-question-list">
            {proposal.questions.map((q) => (
              <PlannedQuestionCard key={q.key} question={q} />
            ))}
          </ul>
        </div>
      )}

      <div className="grill-plan-proposal-actions">
        <button
          className="btn-primary btn-small"
          onClick={() => onAccept(proposal.id)}
          disabled={!isAcceptable || isAccepting || isLoading}
          aria-busy={isAccepting}
        >
          {isAccepting ? '接受中…' : '接受此规划'}
        </button>
        {!isAcceptable && !isStale && (
          <span className="grill-plan-action-hint">此提案当前无法接受</span>
        )}
      </div>
    </li>
  );
}

interface PlannedQuestionCardProps {
  question: GrillPlannedQuestionPublicData;
}

function PlannedQuestionCard({ question }: PlannedQuestionCardProps) {
  return (
    <li className="grill-plan-question-item">
      <div className="grill-plan-question-header">
        <span className="grill-plan-question-key">{question.key}</span>
        <span className="grill-plan-question-topic">{question.topic}</span>
      </div>
      <p className="grill-plan-question-text">{question.text}</p>
      <p className="grill-plan-question-rationale">
        <strong>理由：</strong>
        {question.rationale}
      </p>
      {question.dependencies.length > 0 && (
        <div className="grill-plan-question-dependencies">
          <strong>依赖：</strong>
          <ul>
            {question.dependencies.map((dep, i) => (
              <li key={i} className={`grill-plan-dep grill-plan-dep-${dep.kind}`}>
                {dependencyLabel(dep)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
