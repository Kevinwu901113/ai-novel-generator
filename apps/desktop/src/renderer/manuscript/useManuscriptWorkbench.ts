/**
 * useManuscriptWorkbench —— Minimal Manuscript Renderer 主 hook（MV1-B）。
 *
 * 职责：
 * - 首次进入 getOrCreateManuscript + 加载章节列表（不得在 render 期间重复创建稿件）；
 * - 章节选择 / 创建 / 上移下移 / 归档 / 恢复；
 * - 编辑器 buffer（title/content）+ dirty 状态（相对最后成功加载/保存/promote 的快照）；
 * - 显式保存新版本 / promote 历史版本（CAS payload，single-flight，无自动重试）；
 * - CAS 冲突（MANUSCRIPT_VERSION_CONFLICT）：保留本地 buffer、刷新服务器 current、
 *   不覆盖、不自动重试，由用户决定「基于新 current 再保存」或「放弃本地修改」；
 * - 稿件标题编辑（expectedUpdatedAt CAS，冲突刷新服务器 title，不覆盖用户输入）；
 * - 离开保护：beforeunload + 章节切换守卫 + App 项目切换守卫（共享 leave-guard）；
 * - 竞态失效（generation + load sequence）+ 全部 mutation in-flight 锁；
 * - 安全错误（toSafeUserError + MANUSCRIPT_* 中文标签）。
 *
 * 后端返回值是事实来源：保存/promote 成功直接使用返回的权威版本替换本地状态；
 * 重排成功后以返回列表刷新顺序（失败保留原顺序）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ManuscriptPublicData,
  ChapterSummary,
  ChapterVersionPublicData,
  ChapterVersionSummary,
} from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';
import { registerManuscriptLeaveGuard } from './manuscript-leave-guard';

/** CAS 冲突刷新状态：loading / ready / error 三态，不得用 serverCurrent=null 同时表达 loading/error/合法 null */
export type ConflictRefreshStatus = 'loading' | 'ready' | 'error';

/** CAS 冲突状态：保留本地 buffer，保存刷新后的服务器 current 供用户决策 */
export interface ManuscriptConflict {
  readonly chapterId: string;
  readonly refreshStatus: ConflictRefreshStatus;
  readonly serverCurrent: ChapterVersionPublicData | null;
}

/** 待确认的破坏性导航动作（章节切换 / 创建章节） */
export interface PendingLeaveAction {
  readonly run: () => void;
}

function extractCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export interface UseManuscriptWorkbenchResult {
  // 稿件
  readonly manuscript: ManuscriptPublicData | null;
  readonly manuscriptTitleInput: string;
  readonly setManuscriptTitleInput: (value: string) => void;
  readonly isManuscriptTitleDirty: boolean;
  readonly isSavingTitle: boolean;
  readonly saveManuscriptTitle: () => Promise<boolean>;
  // 章节
  readonly allChapters: ReadonlyArray<ChapterSummary>;
  readonly chapters: ReadonlyArray<ChapterSummary>;
  readonly includeArchived: boolean;
  readonly setIncludeArchived: (value: boolean) => void;
  readonly selectedChapterId: string | null;
  readonly selectedChapter: ChapterSummary | null;
  readonly selectChapter: (chapterId: string) => void;
  readonly createChapter: () => void;
  readonly isCreatingChapter: boolean;
  readonly moveChapter: (chapterId: string, direction: 'up' | 'down') => Promise<boolean>;
  readonly isReordering: boolean;
  readonly archiveChapter: (chapterId: string) => Promise<boolean>;
  readonly isArchiving: boolean;
  readonly restoreChapter: (chapterId: string) => Promise<boolean>;
  readonly isRestoring: boolean;
  // 编辑器
  readonly editorTitle: string;
  readonly setEditorTitle: (value: string) => void;
  readonly editorContent: string;
  readonly setEditorContent: (value: string) => void;
  readonly dirty: boolean;
  readonly currentVersion: ChapterVersionPublicData | null;
  readonly isLoadingCurrent: boolean;
  readonly isSaving: boolean;
  readonly saveChapterVersion: () => Promise<boolean>;
  // 版本历史
  readonly chapterVersions: ReadonlyArray<ChapterVersionSummary>;
  readonly isLoadingVersions: boolean;
  readonly promoteChapterVersion: (versionId: string) => Promise<boolean>;
  readonly isPromoting: boolean;
  // CAS 冲突
  readonly conflict: ManuscriptConflict | null;
  readonly saveAfterConflict: () => Promise<boolean>;
  readonly discardLocalChanges: () => void;
  readonly clearConflict: () => void;
  readonly retryRefreshConflict: () => void;
  // 离开确认
  readonly pendingLeave: PendingLeaveAction | null;
  readonly confirmLeave: () => void;
  readonly cancelLeave: () => void;
  // 异步状态
  readonly isLoading: boolean;
  readonly isMutationInFlight: boolean;
  readonly error: string | null;
  readonly clearError: () => void;
  readonly successMessage: string | null;
  readonly isDirty: boolean;
}

export function useManuscriptWorkbench(projectId: string): UseManuscriptWorkbenchResult {
  // ── 状态 ──────────────────────────────────────────────────────────
  const [manuscript, setManuscript] = useState<ManuscriptPublicData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [allChapters, setAllChapters] = useState<ReadonlyArray<ChapterSummary>>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [chapterVersions, setChapterVersions] = useState<ReadonlyArray<ChapterVersionSummary>>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<ChapterVersionPublicData | null>(null);
  const [isLoadingCurrent, setIsLoadingCurrent] = useState(false);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [lastSnapshot, setLastSnapshot] = useState<{ title: string; content: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ManuscriptConflict | null>(null);
  const [manuscriptTitleInput, setManuscriptTitleInput] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isCreatingChapter, setIsCreatingChapter] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeaveAction | null>(null);

  // ── 竞态 token ────────────────────────────────────────────────────
  const generationRef = useRef(0);
  const loadSeqRef = useRef(0);
  /** 用户在章节数据加载期间是否已编辑 editor buffer（防止加载结果覆盖用户输入） */
  const userEditedRef = useRef(false);

  // ── 最新值 refs（避免 stale closure）──────────────────────────────
  const manuscriptRef = useRef<ManuscriptPublicData | null>(null);
  manuscriptRef.current = manuscript;
  const allChaptersRef = useRef<ReadonlyArray<ChapterSummary>>(allChapters);
  allChaptersRef.current = allChapters;
  const selectedChapterIdRef = useRef<string | null>(null);
  selectedChapterIdRef.current = selectedChapterId;
  const currentVersionRef = useRef<ChapterVersionPublicData | null>(null);
  currentVersionRef.current = currentVersion;
  const conflictRef = useRef<ManuscriptConflict | null>(null);
  conflictRef.current = conflict;
  const editorTitleRef = useRef('');
  editorTitleRef.current = editorTitle;
  const editorContentRef = useRef('');
  editorContentRef.current = editorContent;

  // 编辑器输入 setter（用户编辑标记，防止加载结果覆盖用户输入）
  const updateEditorTitle = useCallback((value: string) => {
    userEditedRef.current = true;
    setEditorTitle(value);
  }, []);
  const updateEditorContent = useCallback((value: string) => {
    userEditedRef.current = true;
    setEditorContent(value);
  }, []);

  const refreshChaptersRef = useRef<(gen: number) => Promise<void>>(() => Promise.resolve());
  const loadChapterDataRef = useRef<(gen: number, chapterId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  // ── dirty 派生 ────────────────────────────────────────────────────
  const dirty = useMemo(() => {
    if (!lastSnapshot) return false;
    return editorTitle !== lastSnapshot.title || editorContent !== lastSnapshot.content;
  }, [editorTitle, editorContent, lastSnapshot]);

  const isManuscriptTitleDirty = manuscript !== null && manuscriptTitleInput !== manuscript.title;
  const isDirty = dirty || isManuscriptTitleDirty;

  const dirtyRef = useRef(false);
  dirtyRef.current = isDirty;

  // ── 全局 mutation 锁：任一 mutation 进行中时禁止启动第二个 ──────
  const isMutationInFlight =
    isSaving ||
    isSavingTitle ||
    isCreatingChapter ||
    isReordering ||
    isArchiving ||
    isRestoring ||
    isPromoting;
  const isMutationInFlightRef = useRef(false);
  isMutationInFlightRef.current = isMutationInFlight;

  // ── 章节列表（按 includeArchived 过滤显示）────────────────────────
  const chapters = useMemo(() => {
    if (includeArchived) return allChapters;
    return allChapters.filter((c) => c.status === 'active');
  }, [allChapters, includeArchived]);

  const selectedChapter = useMemo(
    () => allChapters.find((c) => c.id === selectedChapterId) ?? null,
    [allChapters, selectedChapterId],
  );

  // ── 刷新章节列表 ──────────────────────────────────────────────────
  const refreshChapters = useCallback(
    async (gen: number): Promise<void> => {
      if (!manuscriptRef.current || gen !== generationRef.current) return;
      try {
        const list = await window.desktop.manuscript.listChapters({
          projectId,
          manuscriptId: manuscriptRef.current.id,
          includeArchived: true,
        });
        if (gen !== generationRef.current) return;
        setAllChapters(list);
      } catch {
        // 非关键：保留现有列表
      }
    },
    [projectId],
  );
  refreshChaptersRef.current = refreshChapters;

  // ── 加载章节数据（current 版本 + 版本历史）────────────────────────
  const loadChapterData = useCallback(
    async (gen: number, chapterId: string): Promise<void> => {
      if (gen !== generationRef.current) return;
      const seq = ++loadSeqRef.current;
      // 本次加载开始后，若用户在加载期间编辑 buffer，则不得用加载结果覆盖
      userEditedRef.current = false;
      setSelectedChapterId(chapterId);
      setConflict(null);
      setError(null);
      setSuccessMessage(null);
      setIsLoadingCurrent(true);
      setIsLoadingVersions(true);
      try {
        const [current, versions] = await Promise.all([
          window.desktop.manuscript.getCurrentChapterVersion({ projectId, chapterId }),
          window.desktop.manuscript.listChapterVersions({ projectId, chapterId }),
        ]);
        if (gen !== generationRef.current || seq !== loadSeqRef.current) return;
        setCurrentVersion(current);
        setChapterVersions(versions);
        if (!userEditedRef.current) {
          if (current) {
            setEditorTitle(current.title);
            setEditorContent(current.content);
            setLastSnapshot({ title: current.title, content: current.content });
          } else {
            setEditorTitle('');
            setEditorContent('');
            setLastSnapshot({ title: '', content: '' });
          }
        }
      } catch (err) {
        if (gen !== generationRef.current || seq !== loadSeqRef.current) return;
        setError(toSafeUserError(err, '章节加载失败').message);
      } finally {
        if (gen === generationRef.current && seq === loadSeqRef.current) {
          setIsLoadingCurrent(false);
          setIsLoadingVersions(false);
        }
      }
    },
    [projectId],
  );
  loadChapterDataRef.current = loadChapterData;

  // ── 刷新版本历史（保留当前版本不变）──────────────────────────────
  const refreshVersions = useCallback(
    async (gen: number, chapterId: string): Promise<void> => {
      if (gen !== generationRef.current) return;
      try {
        const versions = await window.desktop.manuscript.listChapterVersions({
          projectId,
          chapterId,
        });
        if (gen !== generationRef.current) return;
        setChapterVersions(versions);
      } catch {
        // 非关键
      }
    },
    [projectId],
  );

  // ── CAS 冲突处理：保留本地 buffer，刷新服务器 current ────────────
  const handleConflict = useCallback(
    async (chapterId: string, gen: number): Promise<void> => {
      setConflict({ chapterId, refreshStatus: 'loading', serverCurrent: null });
      try {
        const serverCurrent = await window.desktop.manuscript.getCurrentChapterVersion({
          projectId,
          chapterId,
        });
        if (gen !== generationRef.current) return;
        // 归属检查：刷新期间用户已切换章节则丢弃结果，不显示针对旧章节的冲突
        if (selectedChapterIdRef.current !== chapterId) return;
        setConflict({ chapterId, refreshStatus: 'ready', serverCurrent });
        void refreshVersions(gen, chapterId);
      } catch {
        if (gen !== generationRef.current) return;
        if (selectedChapterIdRef.current !== chapterId) return;
        // error 态：明确失败，不得永久停留在「正在刷新」
        setConflict({ chapterId, refreshStatus: 'error', serverCurrent: null });
      }
    },
    [projectId, refreshVersions],
  );

  /** 手动重新刷新冲突后的服务器 current（error 态提供重试） */
  const retryRefreshConflict = useCallback((): void => {
    const c = conflictRef.current;
    if (!c) return;
    void handleConflict(c.chapterId, generationRef.current);
  }, [handleConflict]);

  // ── 初始加载 ──────────────────────────────────────────────────────
  useEffect(() => {
    const gen = ++generationRef.current;
    loadSeqRef.current = 0;
    setManuscript(null);
    setAllChapters([]);
    setSelectedChapterId(null);
    setChapterVersions([]);
    setCurrentVersion(null);
    setEditorTitle('');
    setEditorContent('');
    setLastSnapshot(null);
    setError(null);
    setSuccessMessage(null);
    setConflict(null);
    setManuscriptTitleInput('');
    setPendingLeave(null);
    setIsSaving(false);
    setIsSavingTitle(false);
    setIsCreatingChapter(false);
    setIsReordering(false);
    setIsArchiving(false);
    setIsRestoring(false);
    setIsPromoting(false);
    setIsLoading(true);

    let cancelled = false;
    void (async () => {
      try {
        const ms = await window.desktop.manuscript.getOrCreateManuscript({ projectId });
        if (cancelled || gen !== generationRef.current) return;
        setManuscript(ms);
        setManuscriptTitleInput(ms.title);
        const list = await window.desktop.manuscript.listChapters({
          projectId,
          manuscriptId: ms.id,
          includeArchived: true,
        });
        if (cancelled || gen !== generationRef.current) return;
        setAllChapters(list);
        if (list.length > 0) {
          await loadChapterData(gen, list[0].id);
        }
      } catch (err) {
        if (cancelled || gen !== generationRef.current) return;
        setError(toSafeUserError(err, '稿件加载失败').message);
      } finally {
        if (!cancelled && gen === generationRef.current) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loadChapterData]);

  // ── 离开保护：beforeunload（关闭窗口）────────────────────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      // mutation 进行中也要阻止关闭（dirtyRef / isMutationInFlightRef 为 ref，闭包稳定）
      if (dirtyRef.current || isMutationInFlightRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, []);

  // ── 离开保护：共享 leave-guard（App 切换项目前检查）──────────────
  useEffect(() => {
    if (!projectId) return;
    return registerManuscriptLeaveGuard({
      isDirty: () => dirtyRef.current,
      isBusy: () => isMutationInFlightRef.current,
    });
  }, [projectId]);

  // ── 统一破坏性导航守卫：dirty 时弹出离开确认，run 在确认后执行 ──
  const navigateWithGuard = useCallback((run: () => void): void => {
    if (dirtyRef.current) {
      setPendingLeave({ run });
      return;
    }
    run();
  }, []);

  // ── 章节切换（dirty 守卫；mutation 期间由 UI 禁用 + 归属检查兜底）─
  const selectChapter = useCallback(
    (chapterId: string) => {
      if (chapterId === selectedChapterIdRef.current) return;
      navigateWithGuard(() => {
        void loadChapterData(generationRef.current, chapterId);
      });
    },
    [navigateWithGuard, loadChapterData],
  );

  const confirmLeave = useCallback(() => {
    if (pendingLeave) {
      const action = pendingLeave;
      setPendingLeave(null);
      action.run();
    }
  }, [pendingLeave]);

  const cancelLeave = useCallback(() => {
    setPendingLeave(null);
  }, []);

  // ── 保存新版本（核心；也用于冲突后基于新 current 再保存）─────────
  const saveChapterVersion = useCallback(async (): Promise<boolean> => {
    const ms = manuscriptRef.current;
    const chapter = allChaptersRef.current.find((c) => c.id === selectedChapterIdRef.current);
    if (!ms || !chapter || isMutationInFlightRef.current) return false;
    if (chapter.status !== 'active') {
      setError('归档章节不能保存新版本');
      return false;
    }
    if (editorTitleRef.current.trim().length === 0) {
      setError('章节标题不能为空');
      return false;
    }
    // 冲突期间：仅在 ready 时允许保存；strict 使用 serverCurrent?.id ?? null，不得 fallback 旧 current
    const conflictState = conflictRef.current;
    let expected: string | null;
    if (conflictState) {
      if (conflictState.refreshStatus !== 'ready') return false;
      expected = conflictState.serverCurrent?.id ?? null;
    } else {
      expected = currentVersionRef.current?.id ?? null;
    }
    const opGen = generationRef.current;
    const opChapterId = chapter.id;
    const opSeq = loadSeqRef.current;
    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const version = await window.desktop.manuscript.createChapterVersion({
        projectId,
        chapterId: opChapterId,
        title: editorTitleRef.current,
        content: editorContentRef.current,
        expectedCurrentVersionId: expected,
      });
      if (
        opGen !== generationRef.current ||
        opSeq !== loadSeqRef.current ||
        selectedChapterIdRef.current !== opChapterId
      ) {
        // 归属检查：结果仍属于该章节，但用户已离开当前章节。
        // 后端成功结果保留，不写入其他章节 buffer；只刷新列表（不刷新
        // 版本历史，避免覆盖当前选中章节的版本历史面板）。
        void refreshChapters(opGen);
        return false;
      }
      // 后端返回值即事实来源
      setCurrentVersion(version);
      setEditorTitle(version.title);
      setEditorContent(version.content);
      setLastSnapshot({ title: version.title, content: version.content });
      setConflict(null);
      setSuccessMessage(`已保存新版本 #${version.versionNumber}`);
      void refreshChapters(opGen);
      void refreshVersions(opGen, opChapterId);
      return true;
    } catch (err) {
      if (opGen !== generationRef.current || opSeq !== loadSeqRef.current) return false;
      if (extractCode(err) === 'MANUSCRIPT_VERSION_CONFLICT') {
        // 保留本地 buffer，刷新服务器 current，不自动重试
        setError(null);
        await handleConflict(opChapterId, opGen);
      } else {
        setError(toSafeUserError(err, '保存失败').message);
      }
      return false;
    } finally {
      // 无论归属如何，mutation 锁必须释放（除非项目已切换）
      if (opGen === generationRef.current) setIsSaving(false);
    }
  }, [projectId, refreshChapters, refreshVersions, handleConflict]);

  const saveAfterConflict = useCallback((): Promise<boolean> => {
    const c = conflictRef.current;
    // 非 ready 时确定性返回 false，且不得调用 IPC
    if (!c || c.refreshStatus !== 'ready') return Promise.resolve(false);
    return saveChapterVersion();
  }, [saveChapterVersion]);

  // ── 放弃本地修改并加载服务器版本（仅 ready 状态允许）─────────────
  const discardLocalChanges = useCallback(() => {
    const c = conflictRef.current;
    if (!c || c.refreshStatus !== 'ready') return;
    if (c.serverCurrent) {
      setEditorTitle(c.serverCurrent.title);
      setEditorContent(c.serverCurrent.content);
      setLastSnapshot({ title: c.serverCurrent.title, content: c.serverCurrent.content });
      setCurrentVersion(c.serverCurrent);
    } else {
      setEditorTitle('');
      setEditorContent('');
      setLastSnapshot({ title: '', content: '' });
      setCurrentVersion(null);
    }
    setConflict(null);
    setSuccessMessage('已加载服务器当前版本');
  }, []);

  const clearConflict = useCallback(() => {
    setConflict(null);
  }, []);

  // ── promote 历史版本 ─────────────────────────────────────────────
  const promoteChapterVersion = useCallback(
    async (versionId: string): Promise<boolean> => {
      const chapter = allChaptersRef.current.find((c) => c.id === selectedChapterIdRef.current);
      if (!chapter || isMutationInFlightRef.current) return false;
      // 冲突期间：仅在 ready 时允许 promote，strict expected，不得 fallback 旧 current
      const conflictState = conflictRef.current;
      let expected: string | null;
      if (conflictState) {
        if (conflictState.refreshStatus !== 'ready') return false;
        expected = conflictState.serverCurrent?.id ?? null;
      } else {
        expected = currentVersionRef.current?.id ?? null;
      }
      const opGen = generationRef.current;
      const opChapterId = chapter.id;
      const opSeq = loadSeqRef.current;
      setIsPromoting(true);
      setError(null);
      setSuccessMessage(null);
      try {
        const version = await window.desktop.manuscript.promoteChapterVersion({
          projectId,
          chapterId: opChapterId,
          versionId,
          expectedCurrentVersionId: expected,
        });
        if (
          opGen !== generationRef.current ||
          opSeq !== loadSeqRef.current ||
          selectedChapterIdRef.current !== opChapterId
        ) {
          // 归属检查：仅刷新列表，不覆盖当前选中章节的版本历史面板
          void refreshChapters(opGen);
          return false;
        }
        // promote 成功后编辑器加载被 promote 版本，dirty 重置
        setCurrentVersion(version);
        setEditorTitle(version.title);
        setEditorContent(version.content);
        setLastSnapshot({ title: version.title, content: version.content });
        setConflict(null);
        setSuccessMessage(`已将版本 #${version.versionNumber} 设为当前版本`);
        void refreshChapters(opGen);
        void refreshVersions(opGen, opChapterId);
        return true;
      } catch (err) {
        if (opGen !== generationRef.current || opSeq !== loadSeqRef.current) return false;
        if (extractCode(err) === 'MANUSCRIPT_VERSION_CONFLICT') {
          setError(null);
          await handleConflict(opChapterId, opGen);
        } else {
          setError(toSafeUserError(err, '切换版本失败').message);
        }
        return false;
      } finally {
        if (opGen === generationRef.current) setIsPromoting(false);
      }
    },
    [projectId, refreshChapters, refreshVersions, handleConflict],
  );

  // ── 创建章节（append）────────────────────────────────────────────
  const performCreateChapter = useCallback(async (): Promise<boolean> => {
    const ms = manuscriptRef.current;
    if (!ms || isMutationInFlightRef.current) return false;
    const opGen = generationRef.current;
    setIsCreatingChapter(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const chapter = await window.desktop.manuscript.createChapter({
        projectId,
        manuscriptId: ms.id,
        insertBeforeChapterId: null,
      });
      if (opGen !== generationRef.current) return false;
      setSuccessMessage('已创建新章节');
      await refreshChapters(opGen);
      if (opGen !== generationRef.current) return false;
      await loadChapterData(opGen, chapter.id);
      return true;
    } catch (err) {
      if (opGen !== generationRef.current) return false;
      // 创建失败：不切换章节，原章节 buffer 保留
      setError(toSafeUserError(err, '创建章节失败').message);
      return false;
    } finally {
      if (opGen === generationRef.current) setIsCreatingChapter(false);
    }
  }, [projectId, refreshChapters, loadChapterData]);

  /** 新建章节入口：dirty 时弹离开确认，mutation 进行中直接拒绝 */
  const requestCreateChapter = useCallback((): void => {
    if (isMutationInFlightRef.current) {
      setError('稿件操作正在进行，请完成后再试');
      return;
    }
    navigateWithGuard(() => {
      void performCreateChapter();
    });
  }, [navigateWithGuard, performCreateChapter]);

  // ── 上移/下移（仅 active 序列；archived 只影响展示，永不影响计算）──
  const moveChapter = useCallback(
    async (chapterId: string, direction: 'up' | 'down'): Promise<boolean> => {
      const ms = manuscriptRef.current;
      if (!ms || isMutationInFlightRef.current) return false;
      // 移动语义只作用于 active 子序列，与 includeArchived 展示开关无关
      const activeOrder = allChaptersRef.current.filter((c) => c.status === 'active');
      const idx = activeOrder.findIndex((c) => c.id === chapterId);
      if (idx < 0) return false; // 移动章节必须 active
      if (direction === 'up' && idx === 0) return false; // 边界 no-op
      if (direction === 'down' && idx === activeOrder.length - 1) return false; // 边界 no-op
      // 上移目标必须 active；下移目标必须 active 或 null；archived 永不为 insertBefore
      const insertBeforeChapterId =
        direction === 'up'
          ? activeOrder[idx - 1].id
          : idx + 2 < activeOrder.length
            ? activeOrder[idx + 2].id
            : null;
      const opGen = generationRef.current;
      setIsReordering(true);
      setError(null);
      setSuccessMessage(null);
      try {
        await window.desktop.manuscript.updateChapterOrder({
          projectId,
          manuscriptId: ms.id,
          chapterId,
          insertBeforeChapterId,
        });
        if (opGen !== generationRef.current) return false;
        // 成功后始终以后端返回的完整全序列为准（listChapters includeArchived=true）
        await refreshChapters(opGen);
        if (opGen !== generationRef.current) return false;
        setSuccessMessage('章节顺序已更新');
        return true;
      } catch (err) {
        if (opGen !== generationRef.current) return false;
        // 失败保留原顺序并显示错误
        setError(toSafeUserError(err, '重排失败').message);
        return false;
      } finally {
        if (opGen === generationRef.current) setIsReordering(false);
      }
    },
    [projectId, refreshChapters],
  );

  // ── 归档 / 恢复 ──────────────────────────────────────────────────
  const archiveChapter = useCallback(
    async (chapterId: string): Promise<boolean> => {
      const chapter = allChaptersRef.current.find((c) => c.id === chapterId);
      if (!chapter || isMutationInFlightRef.current) return false;
      const opGen = generationRef.current;
      setIsArchiving(true);
      setError(null);
      setSuccessMessage(null);
      try {
        await window.desktop.manuscript.archiveChapter({
          projectId,
          chapterId,
          expectedCurrentVersionId: chapter.currentVersionId,
        });
        if (opGen !== generationRef.current) return false;
        setSuccessMessage('章节已归档');
        await refreshChapters(opGen);
        return true;
      } catch (err) {
        if (opGen !== generationRef.current) return false;
        setError(toSafeUserError(err, '归档失败').message);
        return false;
      } finally {
        if (opGen === generationRef.current) setIsArchiving(false);
      }
    },
    [projectId, refreshChapters],
  );

  const restoreChapter = useCallback(
    async (chapterId: string): Promise<boolean> => {
      const chapter = allChaptersRef.current.find((c) => c.id === chapterId);
      if (!chapter || isMutationInFlightRef.current) return false;
      const opGen = generationRef.current;
      setIsRestoring(true);
      setError(null);
      setSuccessMessage(null);
      try {
        await window.desktop.manuscript.restoreChapter({
          projectId,
          chapterId,
          expectedCurrentVersionId: chapter.currentVersionId,
        });
        if (opGen !== generationRef.current) return false;
        setSuccessMessage('章节已恢复');
        await refreshChapters(opGen);
        return true;
      } catch (err) {
        if (opGen !== generationRef.current) return false;
        setError(toSafeUserError(err, '恢复失败').message);
        return false;
      } finally {
        if (opGen === generationRef.current) setIsRestoring(false);
      }
    },
    [projectId, refreshChapters],
  );

  // ── 稿件标题（expectedUpdatedAt CAS）─────────────────────────────
  const saveManuscriptTitle = useCallback(async (): Promise<boolean> => {
    const ms = manuscriptRef.current;
    if (!ms || isMutationInFlightRef.current) return false;
    const title = manuscriptTitleInput.trim();
    if (title.length === 0) {
      setError('稿件标题不能为空');
      return false;
    }
    const opGen = generationRef.current;
    setIsSavingTitle(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const updated = await window.desktop.manuscript.updateManuscriptTitle({
        projectId,
        manuscriptId: ms.id,
        title,
        expectedUpdatedAt: ms.updatedAt,
      });
      if (opGen !== generationRef.current) return false;
      setManuscript(updated);
      setManuscriptTitleInput(updated.title);
      setSuccessMessage('稿件标题已保存');
      return true;
    } catch (err) {
      if (opGen !== generationRef.current) return false;
      if (extractCode(err) === 'MANUSCRIPT_VERSION_CONFLICT') {
        // 冲突：刷新服务器 title，但不得覆盖用户未提交输入
        try {
          const fresh = await window.desktop.manuscript.getOrCreateManuscript({ projectId });
          if (opGen === generationRef.current) {
            setManuscript(fresh);
            setError('稿件标题已被其他操作更新，请确认后再次保存');
          }
        } catch {
          setError(toSafeUserError(err, '保存标题失败').message);
        }
      } else {
        setError(toSafeUserError(err, '保存标题失败').message);
      }
      return false;
    } finally {
      if (opGen === generationRef.current) setIsSavingTitle(false);
    }
  }, [projectId, manuscriptTitleInput]);

  const clearError = useCallback(() => setError(null), []);

  return {
    manuscript,
    manuscriptTitleInput,
    setManuscriptTitleInput,
    isManuscriptTitleDirty,
    isSavingTitle,
    saveManuscriptTitle,
    allChapters,
    chapters,
    includeArchived,
    setIncludeArchived,
    selectedChapterId,
    selectedChapter,
    selectChapter,
    createChapter: requestCreateChapter,
    isCreatingChapter,
    moveChapter,
    isReordering,
    archiveChapter,
    isArchiving,
    restoreChapter,
    isRestoring,
    editorTitle,
    setEditorTitle: updateEditorTitle,
    editorContent,
    setEditorContent: updateEditorContent,
    dirty,
    currentVersion,
    isLoadingCurrent,
    isSaving,
    saveChapterVersion,
    chapterVersions,
    isLoadingVersions,
    promoteChapterVersion,
    isPromoting,
    conflict,
    saveAfterConflict,
    discardLocalChanges,
    clearConflict,
    retryRefreshConflict,
    pendingLeave,
    confirmLeave,
    cancelLeave,
    isLoading,
    isMutationInFlight,
    error,
    clearError,
    successMessage,
    isDirty,
  };
}
