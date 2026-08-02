/**
 * ContractDraftPanel — 创作契约草稿面板。
 *
 * 职责：
 * - 显示"生成创作契约"按钮（非 COMPLETED 会话显示可发现禁用提示）
 * - 显示任务状态（role="status"，轮询中 aria-busy）
 * - 显示最新 PROPOSED 提案（结构化只读展示 + Accept/Reject，double-click 保护）
 * - Accept 成功后展示 Current Contract Version（只读，含锁定字段与来源）
 * - 错误 / 冲突横幅（role="alert"）
 * - 焦点管理与 ARIA（RAF-focus 首次出现，动作完成后恢复/移动焦点）
 */

import { useEffect, useRef } from 'react';
import type {
  TaskPublicData,
  ProposalPublicData,
  ContractVersionPublicData,
} from '@ai-novel/contracts';
import { ContractSectionsView } from './ContractSectionsView';
import {
  labelFor,
  PROPOSAL_STATUS_LABELS,
  CONTRACT_VERSION_CREATED_BY_LABELS,
  PROVENANCE_SOURCE_LABELS,
  formatContractTime,
  formatShortId,
} from './contract-labels';
import { formatFailedTaskLabel } from '../grill/status-labels';

/** 任务终态集合 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

/** 任务状态中文标签 */
const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
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
  return `${id.slice(0, 8)}…`;
}

interface ContractDraftPanelProps {
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly hasSession: boolean;
  readonly sessionStatus: string | null;
  readonly task: TaskPublicData | null;
  readonly isPolling: boolean;
  readonly onRequestDraft: () => void;
  readonly isRequesting: boolean;
  readonly selectedProposal: ProposalPublicData | null;
  readonly isLoadingProposals: boolean;
  readonly currentContract: ContractVersionPublicData | null;
  readonly acceptedVersion: ContractVersionPublicData | null;
  readonly onAcceptProposal: (proposalId: string) => void;
  readonly onRejectProposal: (proposalId: string) => void;
  readonly isAccepting: boolean;
  readonly isRejecting: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly conflictNotice: boolean;
  readonly onClearError: () => void;
  readonly onClearConflictNotice: () => void;
}

export function ContractDraftPanel({
  projectId,
  sessionId,
  hasSession,
  sessionStatus,
  task,
  isPolling,
  onRequestDraft,
  isRequesting,
  selectedProposal,
  isLoadingProposals,
  currentContract,
  acceptedVersion,
  onAcceptProposal,
  onRejectProposal,
  isAccepting,
  isRejecting,
  isLoading,
  error,
  conflictNotice,
  onClearError,
  onClearConflictNotice,
}: ContractDraftPanelProps) {
  // ── 焦点管理 refs ──────────────────────────────────────────────
  const requestBtnRef = useRef<HTMLButtonElement>(null);
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const proposalHeadingRef = useRef<HTMLHeadingElement>(null);
  const currentVersionHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastFocusedTaskIdRef = useRef<string | null>(null);
  const lastFocusedProposalIdRef = useRef<string | null>(null);
  const lastFocusedVersionIdRef = useRef<string | null>(null);
  const taskRafRef = useRef<number | null>(null);
  const proposalRafRef = useRef<number | null>(null);
  const versionRafRef = useRef<number | null>(null);
  const previousRejectingRef = useRef(false);

  const contextKey = `${projectId}:${sessionId ?? ''}`;
  const isCompleted = hasSession && sessionStatus === 'COMPLETED';
  const isTaskActive = task !== null && !TERMINAL_TASK_STATUSES.has(task.status);
  const isAnyMutation = isAccepting || isRejecting;
  const canRequest =
    isCompleted && !isRequesting && !isPolling && !isTaskActive && !isAnyMutation && !isLoading;

  // ── 清理所有 RAF ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (taskRafRef.current !== null) cancelAnimationFrame(taskRafRef.current);
      if (proposalRafRef.current !== null) cancelAnimationFrame(proposalRafRef.current);
      if (versionRafRef.current !== null) cancelAnimationFrame(versionRafRef.current);
    };
  }, []);

  // ── contextKey 变化时重置焦点身份和 RAF ──────────────────────
  useEffect(() => {
    lastFocusedTaskIdRef.current = null;
    lastFocusedProposalIdRef.current = null;
    lastFocusedVersionIdRef.current = null;
    if (taskRafRef.current !== null) cancelAnimationFrame(taskRafRef.current);
    if (proposalRafRef.current !== null) cancelAnimationFrame(proposalRafRef.current);
    if (versionRafRef.current !== null) cancelAnimationFrame(versionRafRef.current);
  }, [contextKey]);

  // ── task 首次出现时聚焦 task heading（按 task.id 追踪） ────────
  useEffect(() => {
    if (!task) return;
    if (task.id === lastFocusedTaskIdRef.current) return;
    lastFocusedTaskIdRef.current = task.id;

    if (taskRafRef.current !== null) cancelAnimationFrame(taskRafRef.current);
    taskRafRef.current = requestAnimationFrame(() => {
      taskRafRef.current = null;
      taskHeadingRef.current?.focus();
    });
  }, [task]);

  // ── proposal 首次出现时聚焦 proposal heading（按 id 追踪） ────
  useEffect(() => {
    if (!selectedProposal) return;
    if (selectedProposal.id === lastFocusedProposalIdRef.current) return;
    lastFocusedProposalIdRef.current = selectedProposal.id;

    if (proposalRafRef.current !== null) cancelAnimationFrame(proposalRafRef.current);
    proposalRafRef.current = requestAnimationFrame(() => {
      proposalRafRef.current = null;
      proposalHeadingRef.current?.focus();
    });
  }, [selectedProposal]);

  // ── current version 首次出现时聚焦 heading（按 id 追踪） ──────
  useEffect(() => {
    if (!acceptedVersion) return;
    if (acceptedVersion.id === lastFocusedVersionIdRef.current) return;
    lastFocusedVersionIdRef.current = acceptedVersion.id;

    if (versionRafRef.current !== null) cancelAnimationFrame(versionRafRef.current);
    versionRafRef.current = requestAnimationFrame(() => {
      versionRafRef.current = null;
      currentVersionHeadingRef.current?.focus();
    });
  }, [acceptedVersion]);

  // ── 拒绝成功（proposal 消失）后恢复焦点到请求按钮 ──────────────
  useEffect(() => {
    const wasRejecting = previousRejectingRef.current;
    previousRejectingRef.current = isRejecting;
    if (wasRejecting && !isRejecting && selectedProposal === null) {
      const id = setTimeout(() => {
        requestBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isRejecting, selectedProposal]);

  const showCurrentVersion = acceptedVersion !== null;
  const version = showCurrentVersion ? acceptedVersion : currentContract;
  const showCurrentHint = currentContract !== null && acceptedVersion === null;

  return (
    <div className="contract-panel">
      <div className="contract-panel-header">
        <h3 id="contract-panel-heading" className="contract-panel-heading">
          创作契约
        </h3>
      </div>

      {/* 版本冲突横幅（可关闭，role=alert） */}
      {conflictNotice && (
        <div className="contract-conflict-banner" role="alert">
          <span>创作契约已在其他操作中更新，数据已自动刷新。</span>
          <button onClick={onClearConflictNotice} aria-label="关闭冲突提示">
            ✕
          </button>
        </div>
      )}

      {/* 错误提示（role=alert，唯一） */}
      {error && (
        <div className="contract-error" role="alert">
          <span>{error}</span>
          <button onClick={onClearError} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      {/* 请求区域 */}
      <div className="contract-request-section">
        <button
          ref={requestBtnRef}
          className="btn-primary contract-request-btn"
          onClick={onRequestDraft}
          disabled={!canRequest}
          aria-busy={isRequesting}
        >
          {isRequesting ? '生成中…' : '生成创作契约'}
        </button>
        {hasSession && !isCompleted && (
          <span className="contract-hint">会话完成后可生成创作契约</span>
        )}
        {!hasSession && <span className="contract-hint">请先选择一个已完成的 Grill 会话</span>}
      </div>

      {/* 任务状态区域 */}
      {task !== null && (
        <div className="contract-task-status" role="status" aria-busy={isPolling && isTaskActive}>
          <h4 ref={taskHeadingRef} tabIndex={-1} className="contract-task-heading">
            创作契约任务
          </h4>
          <div className="contract-task-info">
            <span className="contract-task-id">{shortTaskId(task.id)}</span>
            <span className={`contract-task-status-badge status-${task.status.toLowerCase()}`}>
              {TASK_STATUS_LABELS[task.status] ?? task.status}
            </span>
            {isPolling && isTaskActive && (
              <span className="contract-polling-indicator" aria-hidden="true">
                ⏳
              </span>
            )}
          </div>
          {task.status === 'FAILED' && (
            <div className="contract-task-error">错误：{formatFailedTaskLabel(task.errorCode)}</div>
          )}
          <div className="contract-task-hint">
            <span>可在任务活动中心查看详细状态</span>
          </div>
        </div>
      )}

      {/* 提案加载中（无提案可展示时的反馈） */}
      {isLoadingProposals && selectedProposal === null && (
        <div className="contract-loading" role="status">
          加载提案中…
        </div>
      )}

      {/* 提案审核区域 */}
      {selectedProposal !== null && (
        <div className="contract-proposal-section">
          {showCurrentHint && (
            <div className="contract-current-hint">
              当前契约：v{currentContract?.version}（已存在）
            </div>
          )}
          <h4 ref={proposalHeadingRef} tabIndex={-1} className="contract-proposal-heading">
            创作契约提案
          </h4>
          <div className="contract-proposal-meta">
            <span>
              状态：
              <span
                className={`contract-status-badge status-${selectedProposal.status.toLowerCase()}`}
              >
                {labelFor(PROPOSAL_STATUS_LABELS, selectedProposal.status)}
              </span>
            </span>
            <span>基准会话版本：v{selectedProposal.baseGrillSessionVersion}</span>
            <span>
              基准契约：
              {selectedProposal.baseContractVersion === null
                ? '首次'
                : `v${selectedProposal.baseContractVersion}`}
            </span>
            <span>Schema 版本：{selectedProposal.schemaVersion}</span>
            <span>创建时间：{formatContractTime(selectedProposal.createdAt)}</span>
          </div>

          <ContractSectionsView sections={selectedProposal.sections} />

          <div className="contract-proposal-actions">
            <button
              className="btn-primary btn-small"
              onClick={() => onAcceptProposal(selectedProposal.id)}
              disabled={isAnyMutation}
              aria-busy={isAccepting}
            >
              {isAccepting ? '接受中…' : '接受提案'}
            </button>
            <button
              className="btn-danger btn-small"
              onClick={() => onRejectProposal(selectedProposal.id)}
              disabled={isAnyMutation}
              aria-busy={isRejecting}
            >
              {isRejecting ? '拒绝中…' : '拒绝提案'}
            </button>
          </div>
        </div>
      )}

      {/* Current Version 面板（Accept 成功后） */}
      {showCurrentVersion && version !== null && (
        <div className="contract-current-version-section">
          <h4
            ref={currentVersionHeadingRef}
            tabIndex={-1}
            className="contract-current-version-heading"
          >
            当前创作契约 v{version.version}
          </h4>
          <div className="contract-current-version-meta">
            <span>Schema 版本：{version.schemaVersion}</span>
            <span>创建来源：{labelFor(CONTRACT_VERSION_CREATED_BY_LABELS, version.createdBy)}</span>
            <span>创建时间：{formatContractTime(version.createdAt)}</span>
            <span>
              来源提案：{version.sourceProposalId ? formatShortId(version.sourceProposalId) : '—'}
            </span>
            <span>
              基准会话：
              {version.basedOnGrillSessionId ? formatShortId(version.basedOnGrillSessionId) : '—'}
              {version.basedOnGrillSessionVersion !== null
                ? `（v${version.basedOnGrillSessionVersion}）`
                : ''}
            </span>
          </div>

          <ContractSectionsView
            sections={version.sections}
            lockedFieldPaths={version.lockedFieldPaths}
          />

          {/* 锁定字段 */}
          <div className="contract-locks">
            <h5 className="contract-locks-title">已锁定字段</h5>
            {version.lockedFieldPaths.length > 0 ? (
              <ul className="contract-lock-list">
                {version.lockedFieldPaths.map((path) => (
                  <li key={path} className="contract-lock-tag">
                    {path}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="contract-locks-empty">无锁定字段</span>
            )}
          </div>

          {/* 字段来源（collapsed） */}
          {version.provenance.length > 0 && (
            <details className="contract-provenance">
              <summary>字段来源</summary>
              <ul className="contract-provenance-list">
                {version.provenance.map((entry, i) => (
                  <li key={i} className="contract-provenance-item">
                    <span className="contract-provenance-key">{entry.sectionKey}</span>
                    <span className="contract-provenance-source">
                      {labelFor(PROVENANCE_SOURCE_LABELS, entry.source)}
                    </span>
                    {entry.rationale && (
                      <p className="contract-provenance-rationale">理由：{entry.rationale}</p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* 空状态 */}
      {isCompleted &&
        !isRequesting &&
        !isTaskActive &&
        task === null &&
        selectedProposal === null &&
        !showCurrentVersion && (
          <div className="contract-empty-state">
            <p>尚未生成创作契约</p>
            <p className="empty-hint">点击「生成创作契约」由 AI 起草提案</p>
          </div>
        )}
    </div>
  );
}
