/**
 * useContractDraft — 创作契约草稿 hook。
 *
 * 职责：
 * - 请求创作契约草稿（requestDraft，single-flight）
 * - 任务轮询（复用 useGrillQuestionPlan 的 unified polling controller）
 * - 加载当前契约与提案（project scope，客户端按 session 过滤）
 * - 接受 / 拒绝提案（CAS payload，single-flight，无自动重试）
 * - 竞态失效（generation token + operation-owned locks + sequence）
 * - 页面可见性管理（hidden 暂停，真实 hidden→visible transition 恢复）
 * - 安全错误（toSafeUserError + 新增 CONTRACT_* 中文标签）
 *
 * 本 hook 不保存权威领域状态：mutations 的成功返回（如 acceptProposal 返回的
 * ContractVersionPublicData）即事实来源，成功后替换本地状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TaskPublicData,
  ProposalPublicData,
  ContractVersionPublicData,
} from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';
import { formatFailedTaskLabel } from '../grill/status-labels';

/** 安全错误回退消息 */
const SAFE_ERROR_FALLBACK = '操作失败，请稍后重试';

/** 任务终态 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

/** 轮询间隔 (ms) */
const POLL_INTERVAL_MS = 2000;

/** 创作契约任务类型 */
const CONTRACT_DRAFT_TASK_TYPE = 'CREATION_CONTRACT_DRAFT';

/** 任务终态错误消息映射 */
function terminalTaskError(status: string, errorCode: string | null): string {
  switch (status) {
    case 'FAILED':
      return formatFailedTaskLabel(errorCode);
    case 'CANCELLED':
      return '创作契约任务已取消';
    case 'STALE':
      return '创作契约任务已过期';
    default:
      return '任务已完成';
  }
}

/** 每次 tasks.get 的唯一 operation token */
interface PollOperation {
  readonly sequence: number;
  readonly generation: number;
  readonly loopGeneration: number;
  readonly projectId: string;
  readonly taskId: string;
}

/** request/accept/reject 的 operation token */
interface MutationOperation {
  readonly generation: number;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface UseContractDraftResult {
  readonly task: TaskPublicData | null;
  readonly isPolling: boolean;
  readonly requestDraft: () => Promise<void>;
  readonly isRequesting: boolean;
  readonly proposals: ReadonlyArray<ProposalPublicData>;
  readonly selectedProposal: ProposalPublicData | null;
  readonly isLoadingProposals: boolean;
  readonly currentContract: ContractVersionPublicData | null;
  readonly isLoading: boolean;
  /** acceptProposal 成功返回的当前版本 —— 面板切换到 Current Version 的事实来源 */
  readonly acceptedVersion: ContractVersionPublicData | null;
  readonly acceptProposal: (proposalId: string) => Promise<boolean>;
  readonly isAccepting: boolean;
  readonly rejectProposal: (proposalId: string) => Promise<boolean>;
  readonly isRejecting: boolean;
  readonly refresh: () => Promise<void>;
  readonly error: string | null;
  readonly conflictNotice: boolean;
  readonly clearError: () => void;
  readonly clearConflictNotice: () => void;
}

/**
 * 确定性选择最新 PROPOSED 提案。
 * 排序：createdAt 降序；createdAt 相同时以稳定 ID 降序作为 tie-break。
 */
export function selectNewestProposedProposal(
  proposals: ReadonlyArray<ProposalPublicData>,
  sessionId: string,
): ProposalPublicData | null {
  const candidates = proposals.filter(
    (p) => p.baseGrillSessionId === sessionId && p.status === 'PROPOSED',
  );
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const timeDiff = b.createdAt.localeCompare(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });
  return sorted[0] ?? null;
}

export function useContractDraft(
  projectId: string | null,
  sessionId: string | null,
  currentSessionVersion: number,
): UseContractDraftResult {
  // ── 状态 ──────────────────────────────────────────────────────────
  const [task, setTask] = useState<TaskPublicData | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [proposals, setProposals] = useState<ReadonlyArray<ProposalPublicData>>([]);
  const [isLoadingProposals, setIsLoadingProposals] = useState(false);
  const [currentContract, setCurrentContract] = useState<ContractVersionPublicData | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<ContractVersionPublicData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState(false);

  // ── refs ────────────────────────────────────────────────────────────
  const generationRef = useRef(0);
  const pollLoopGenRef = useRef(0);
  const pollSequenceRef = useRef(0);
  const activePollRef = useRef<PollOperation | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // terminal latch 归属于当前 loop：仅当记录的 loopGeneration 等于当前值时生效
  const terminalLatchLoopRef = useRef(-1);
  const resumeRequestedRef = useRef(false);
  const isPollingRef = useRef(false);
  const previousHiddenRef = useRef(typeof document !== 'undefined' ? document.hidden : false);
  const requestOpRef = useRef<MutationOperation | null>(null);
  const acceptOpRef = useRef<MutationOperation | null>(null);
  const rejectOpRef = useRef<MutationOperation | null>(null);
  const currentSessionVersionRef = useRef(currentSessionVersion);
  currentSessionVersionRef.current = currentSessionVersion;
  const proposalRequestSeqRef = useRef(0);
  const currentRequestSeqRef = useRef(0);
  const taskRef = useRef<TaskPublicData | null>(null);
  taskRef.current = task;
  const proposalsRef = useRef<ReadonlyArray<ProposalPublicData>>(proposals);
  proposalsRef.current = proposals;
  const currentContractRef = useRef<ContractVersionPublicData | null>(currentContract);
  currentContractRef.current = currentContract;
  const loadInitialRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const loadProposalsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const refreshCurrentRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ── requestPollNow ref（解决循环引用） ────────────────────────────
  const requestPollNowRef = useRef<() => void>(() => {});

  const isTerminalLatched = useCallback(
    () => terminalLatchLoopRef.current === pollLoopGenRef.current,
    [],
  );

  const setPollingState = useCallback((value: boolean) => {
    isPollingRef.current = value;
    setIsPolling(value);
  }, []);

  // ── 停止轮询：使当前 operation token 失效，不依赖旧 promise 结算 ──
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollLoopGenRef.current += 1;
    activePollRef.current = null;
    resumeRequestedRef.current = false;
    setPollingState(false);
  }, [setPollingState]);

  // ── 统一 polling controller ────────────────────────────────────────
  const requestPollNow = useCallback(() => {
    if (isTerminalLatched()) return;
    // hidden 时不得启动 tasks.get，也不得安排 timer
    if (document.hidden) return;
    if (activePollRef.current !== null) {
      // 在途请求返回后最多补一次
      resumeRequestedRef.current = true;
      return;
    }

    const currentTask = taskRef.current;
    if (!currentTask) return;

    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    const token: PollOperation = {
      sequence: ++pollSequenceRef.current,
      generation: generationRef.current,
      loopGeneration: pollLoopGenRef.current,
      projectId: currentTask.projectId,
      taskId: currentTask.id,
    };
    activePollRef.current = token;
    resumeRequestedRef.current = false;

    // 只有该 token 的 owner 可以清除 active poll、应用响应、安排 timer
    const owns = () =>
      activePollRef.current === token &&
      token.loopGeneration === pollLoopGenRef.current &&
      token.generation === generationRef.current;

    Promise.resolve(window.desktop.tasks.get(token.projectId, token.taskId))
      .then((updated) => {
        if (!owns()) return;
        activePollRef.current = null;

        setTask(updated);

        if (TERMINAL_TASK_STATUSES.has(updated.status)) {
          terminalLatchLoopRef.current = pollLoopGenRef.current;
          if (pollTimerRef.current !== null) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          resumeRequestedRef.current = false;
          setPollingState(false);
          if (updated.status === 'SUCCEEDED') {
            void loadProposalsRef.current();
          } else {
            setError(terminalTaskError(updated.status, updated.errorCode));
          }
          return;
        }

        // 非终态且页面 hidden：不安排下一次 timer，等待真实 visible transition
        if (document.hidden) {
          resumeRequestedRef.current = false;
          return;
        }

        pollTimerRef.current = setTimeout(() => {
          requestPollNowRef.current();
        }, POLL_INTERVAL_MS);

        // 在途请求返回后，如果 resume 被请求且页面可见，补一次
        if (resumeRequestedRef.current && !isTerminalLatched()) {
          resumeRequestedRef.current = false;
          requestPollNowRef.current();
        }
      })
      .catch(() => {
        if (!owns()) return;
        activePollRef.current = null;
        if (isTerminalLatched()) return;
        // hidden 时不安排 retry timer
        if (document.hidden) return;
        pollTimerRef.current = setTimeout(() => {
          requestPollNowRef.current();
        }, POLL_INTERVAL_MS);
      });
  }, [isTerminalLatched, setPollingState]);

  requestPollNowRef.current = requestPollNow;

  // ── 开始轮询 ──────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    stopPolling();
    setPollingState(true);

    // hidden 时不安排 timer；真实 visible transition 时恢复
    if (!document.hidden) {
      pollTimerRef.current = setTimeout(() => {
        requestPollNowRef.current();
      }, 0);
    }
  }, [stopPolling, setPollingState]);

  // ── 加载提案（project scope，客户端按 session 过滤） ──────────────
  const loadProposals = useCallback(async () => {
    if (!projectId) return;

    const gen = generationRef.current;
    const seq = ++proposalRequestSeqRef.current;
    setIsLoadingProposals(true);

    try {
      const list = await window.desktop.contract.listProposals({ projectId });
      if (gen !== generationRef.current || seq !== proposalRequestSeqRef.current) return;
      setProposals(list);
    } catch {
      // 非关键错误
    } finally {
      if (gen === generationRef.current && seq === proposalRequestSeqRef.current) {
        setIsLoadingProposals(false);
      }
    }
  }, [projectId]);

  loadProposalsRef.current = loadProposals;

  // ── 刷新当前契约（project scope） ────────────────────────────────
  const refreshCurrent = useCallback(async () => {
    if (!projectId) return;

    const gen = generationRef.current;
    const seq = ++currentRequestSeqRef.current;

    try {
      const current = await window.desktop.contract.getCurrent({ projectId });
      if (gen !== generationRef.current || seq !== currentRequestSeqRef.current) return;
      setCurrentContract(current);
    } catch (err) {
      if (gen !== generationRef.current || seq !== currentRequestSeqRef.current) return;
      setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
    }
  }, [projectId]);

  refreshCurrentRef.current = refreshCurrent;

  // ── 初始加载：getCurrent + listProposals 并行 ─────────────────────
  // 复用 refreshCurrent / loadProposals 的 generation + sequence 守卫，
  // 使旧初始响应永远不会覆盖更新的 proposal / current 数据。
  const loadInitial = useCallback(async () => {
    if (!projectId || !sessionId) return;

    const gen = generationRef.current;
    setIsLoading(true);

    await Promise.allSettled([refreshCurrentRef.current(), loadProposalsRef.current()]);

    if (gen === generationRef.current) {
      setIsLoading(false);
    }
  }, [projectId, sessionId]);

  loadInitialRef.current = loadInitial;

  // ── 手动/冲突刷新：getCurrent + listProposals ─────────────────────
  const refresh = useCallback(async () => {
    await Promise.all([refreshCurrentRef.current(), loadProposalsRef.current()]);
  }, []);

  // ── 请求创作契约草稿 ──────────────────────────────────────────────
  const requestDraft = useCallback(async () => {
    if (!projectId || !sessionId) return;
    if (requestOpRef.current) return;

    const gen = generationRef.current;
    const op: MutationOperation = { generation: gen, projectId, sessionId };
    requestOpRef.current = op;
    setIsRequesting(true);
    setError(null);
    setConflictNotice(false);
    // 新草稿开始后切换到任务视图，收起上一次 accept 的 Current Version 面板
    setAcceptedVersion(null);

    const owns = () => requestOpRef.current === op && gen === generationRef.current;

    try {
      const result = await window.desktop.contract.requestDraft({
        projectId,
        grillSessionId: sessionId,
        expectedGrillSessionVersion: currentSessionVersionRef.current,
        expectedContractVersion: currentContractRef.current?.version ?? null,
      });

      if (!owns()) return;

      const newTask: TaskPublicData = {
        id: result.taskId,
        projectId,
        taskType: CONTRACT_DRAFT_TASK_TYPE,
        status: 'PENDING',
        attemptCount: 0,
        result: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };

      setTask(newTask);
      taskRef.current = newTask;
      startPolling();
    } catch (err) {
      if (!owns()) return;
      setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
    } finally {
      // 只有 owner 可以释放 busy/lock；旧 operation 结算不得释放新 operation
      if (requestOpRef.current === op) {
        requestOpRef.current = null;
        setIsRequesting(false);
      }
    }
  }, [projectId, sessionId, startPolling]);

  // ── 查找提案（使用 ref 避免 stale closure） ───────────────────────
  const findProposal = useCallback(
    (proposalId: string): ProposalPublicData | null =>
      proposalsRef.current.find((p) => p.id === proposalId) ?? null,
    [],
  );

  // ── 接受提案（CAS payload，成功后直接使用返回的当前版本） ─────────
  const acceptProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      if (!projectId || !sessionId) return false;
      if (acceptOpRef.current) return false;

      const proposal = findProposal(proposalId);
      if (!proposal) return false;

      const gen = generationRef.current;
      const op: MutationOperation = { generation: gen, projectId, sessionId };
      acceptOpRef.current = op;
      setIsAccepting(true);
      setError(null);

      const owns = () => acceptOpRef.current === op && gen === generationRef.current;

      try {
        // 提交前刷新一次当前契约，确保 expectedContractVersion 尽可能新（CAS 兜底）
        await refreshCurrentRef.current();
        if (!owns()) return false;

        const version = await window.desktop.contract.acceptProposal({
          projectId,
          proposalId,
          expectedProposalSectionsHash: proposal.sectionsHash,
          expectedGrillSessionVersion: currentSessionVersionRef.current,
          expectedContractVersion: currentContractRef.current?.version ?? null,
          operations: [],
        });

        if (!owns()) return false;

        // 后端返回的版本即事实来源，直接替换本地状态并切换到 Current Version
        setAcceptedVersion(version);
        setCurrentContract(version);
        setConflictNotice(false);
        void loadProposalsRef.current();
        return true;
      } catch (err) {
        if (!owns()) return false;
        const code =
          err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : null;
        if (code === 'CONTRACT_VERSION_CONFLICT') {
          setError(null);
          setConflictNotice(true);
          // 刷新只读数据，但不自动重发 mutation
          void refresh();
        } else {
          setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
        }
        return false;
      } finally {
        // 只有 owner 可以释放 busy/lock；旧 operation 结算不得释放新 operation
        if (acceptOpRef.current === op) {
          acceptOpRef.current = null;
          setIsAccepting(false);
        }
      }
    },
    [projectId, sessionId, findProposal, refresh],
  );

  // ── 拒绝提案（CAS on sectionsHash，成功后允许重新生成） ───────────
  const rejectProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      if (!projectId || !sessionId) return false;
      if (rejectOpRef.current) return false;

      const proposal = findProposal(proposalId);
      if (!proposal) return false;

      const gen = generationRef.current;
      const op: MutationOperation = { generation: gen, projectId, sessionId };
      rejectOpRef.current = op;
      setIsRejecting(true);
      setError(null);

      const owns = () => rejectOpRef.current === op && gen === generationRef.current;

      try {
        await window.desktop.contract.rejectProposal({
          projectId,
          proposalId,
          expectedProposalSectionsHash: proposal.sectionsHash,
        });

        if (!owns()) return false;

        // 拒绝成功后重新加载提案（被拒绝的提案不再是 PROPOSED，自然被过滤）
        await loadProposalsRef.current();
        if (!owns()) return false;
        return true;
      } catch (err) {
        if (!owns()) return false;
        setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
        return false;
      } finally {
        // 只有 owner 可以释放 busy/lock；旧 operation 结算不得释放新 operation
        if (rejectOpRef.current === op) {
          rejectOpRef.current = null;
          setIsRejecting(false);
        }
      }
    },
    [projectId, sessionId, findProposal],
  );

  // ── session/project 切换重置 + 初始加载 ──────────────────────────
  useEffect(() => {
    generationRef.current += 1;
    stopPolling();
    setTask(null);
    setProposals([]);
    setCurrentContract(null);
    setAcceptedVersion(null);
    setError(null);
    setConflictNotice(false);
    setIsRequesting(false);
    setIsLoadingProposals(false);
    setIsAccepting(false);
    setIsRejecting(false);
    requestOpRef.current = null;
    acceptOpRef.current = null;
    rejectOpRef.current = null;
    proposalRequestSeqRef.current = 0;
    currentRequestSeqRef.current = 0;

    if (projectId && sessionId) {
      void loadInitialRef.current();
    }
  }, [projectId, sessionId, stopPolling]);

  // ── 页面可见性管理：只在真实 hidden→visible transition 时恢复 ────
  useEffect(() => {
    const handleVisibility = () => {
      const wasHidden = previousHiddenRef.current;
      const nowHidden = document.hidden;
      previousHiddenRef.current = nowHidden;

      if (nowHidden) {
        // 进入 hidden：取消已安排的 timer；在途请求允许自然结算
        if (pollTimerRef.current !== null) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        return;
      }

      // 页面已经 visible 时的重复事件：不 poll、不设置 resume、不安排 timer
      if (!wasHidden) return;
      if (!isPollingRef.current) return;
      if (isTerminalLatched()) return;
      requestPollNowRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isTerminalLatched]);

  // ── unmount 清理 ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // 使所有在途请求的 generation token 失效，禁止 unmount 后 setState
      generationRef.current += 1;
      stopPolling();
    };
  }, [stopPolling]);

  // ── 派生：确定性最新 PROPOSED 提案（按 session 过滤） ─────────────
  const selectedProposal = useMemo(
    () => selectNewestProposedProposal(proposals, sessionId ?? ''),
    [proposals, sessionId],
  );

  const clearError = useCallback(() => setError(null), []);
  const clearConflictNotice = useCallback(() => setConflictNotice(false), []);

  return {
    task,
    isPolling,
    requestDraft,
    isRequesting,
    proposals,
    selectedProposal,
    isLoadingProposals,
    currentContract,
    isLoading,
    acceptedVersion,
    acceptProposal,
    isAccepting,
    rejectProposal,
    isRejecting,
    refresh,
    error,
    conflictNotice,
    clearError,
    clearConflictNotice,
  };
}
