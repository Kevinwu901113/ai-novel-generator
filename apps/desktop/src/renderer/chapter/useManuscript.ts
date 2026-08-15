/**
 * 稿件工作区数据 hook（GE-7）。
 *
 * 与 useChapter（生成侧）分开：稿件是**已接受正文的权威存储**，只在用户打开稿件页
 * 或保存后刷新，不做轮询——它只会因为用户自己的编辑、或一次 MANUSCRIPT_COMMIT 而
 * 变化，前者本 hook 自己知道，后者由用户切回稿件页时刷新拿到。
 *
 * 保存走 CAS：加载时拿到的 `currentVersionId` 原样回传，服务端据此拒绝覆盖期间
 * 落地的新版本（不静默覆盖用户正文）。冲突时**不丢用户输入**——保留编辑框内容，
 * 让用户自行决定重新加载还是复制走。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChapterDraftDto,
  ManuscriptChapterDetailDto,
  ManuscriptExportFormatDto,
  ManuscriptVersionSummaryDto,
  ManuscriptWorkspaceDto,
} from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';

export interface ManuscriptDraft {
  readonly title: string;
  readonly content: string;
}

export type AutosaveStatus =
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: string }
  | { readonly kind: 'error'; readonly message: string };

export interface ManuscriptActions {
  select(chapterId: string | null): void;
  edit(draft: ManuscriptDraft): void;
  save(): Promise<void>;
  /** 放弃本地修改，重新加载服务端当前版本（冲突后的出路之一） */
  reload(): Promise<void>;
  exportManuscript(format: ManuscriptExportFormatDto): Promise<void>;
  /** 展开/收起版本历史（展开时按需拉取） */
  toggleVersions(): Promise<void>;
  /** 恢复到某个历史版本（只移动 current 指针，不删除任何版本） */
  restore(versionId: string): Promise<void>;
  /** 把已存在的持久化草稿恢复到编辑器缓冲区（不自动套用） */
  restoreDraft(): void;
  /** 丢弃当前章节的持久化草稿 */
  discardDraft(): Promise<void>;
  refresh(): Promise<void>;
}

export interface UseManuscriptReturn {
  readonly workspace: ManuscriptWorkspaceDto | null;
  readonly selectedChapterId: string | null;
  readonly chapter: ManuscriptChapterDetailDto | null;
  readonly draft: ManuscriptDraft | null;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly saveError: string | null;
  /** 导出结果提示（成功路径也要有反馈，否则用户不知道存到哪了） */
  readonly exportNotice: string | null;
  readonly versions: ReadonlyArray<ManuscriptVersionSummaryDto> | null;
  /** 服务端持久化草稿（与编辑器缓冲区 ManuscriptDraft 严格区分） */
  readonly persistedDraft: ChapterDraftDto | null;
  readonly autosaveStatus: AutosaveStatus | null;
  readonly actions: ManuscriptActions;
}

export function useManuscript(projectId: string): UseManuscriptReturn {
  const [workspace, setWorkspace] = useState<ManuscriptWorkspaceDto | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<ManuscriptChapterDetailDto | null>(null);
  const [draft, setDraft] = useState<ManuscriptDraft | null>(null);
  const [persistedDraft, setPersistedDraft] = useState<ChapterDraftDto | null>(null);
  const [draftBaseVersionId, setDraftBaseVersionId] = useState<string | null>(null);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [versions, setVersions] = useState<ReadonlyArray<ManuscriptVersionSummaryDto> | null>(null);

  const generationRef = useRef(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 持久化草稿是否与权威正文有可见差异。title 为 null 表示 v20 旧草稿
   * （当时还没存标题），此时只看正文；否则标题或正文任一不同都算有草稿。
   */
  function hasVisibleDraftChanges(
    persisted: ChapterDraftDto,
    current: ManuscriptChapterDetailDto,
  ): boolean {
    return (
      persisted.content !== current.content ||
      (persisted.title !== null && persisted.title !== current.title)
    );
  }

  const loadWorkspace = useCallback(async (): Promise<void> => {
    const currentGen = generationRef.current;
    try {
      const next = await window.desktop.manuscript.getWorkspace({ projectId });
      if (generationRef.current !== currentGen) return;
      setWorkspace(next);
      setError(null);
    } catch (err) {
      if (generationRef.current !== currentGen) return;
      setError(toSafeUserError(err, '加载稿件失败').message);
    } finally {
      if (generationRef.current === currentGen) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    generationRef.current += 1;
    setWorkspace(null);
    setSelectedChapterId(null);
    setChapter(null);
    setDraft(null);
    setPersistedDraft(null);
    setDraftBaseVersionId(null);
    setAutosaveStatus(null);
    setError(null);
    setSaveError(null);
    setExportNotice(null);
    setLoading(true);
    void loadWorkspace();
  }, [projectId, loadWorkspace]);

  const loadChapter = useCallback(
    async (chapterId: string): Promise<void> => {
      const currentGen = generationRef.current;
      try {
        const detail = await window.desktop.manuscript.getChapter({ projectId, chapterId });
        if (generationRef.current !== currentGen) return;
        setChapter(detail);
        setDraft(detail ? { title: detail.title, content: detail.content } : null);
        setDraftBaseVersionId(detail?.currentVersionId ?? null);
        setPersistedDraft(null);
        setAutosaveStatus(null);
        setSaveError(null);
        setVersions(null);

        if (!detail) return;
        try {
          const persisted = await window.desktop.manuscript.getDraft({ projectId, chapterId });
          if (generationRef.current !== currentGen) return;
          setPersistedDraft(
            persisted !== null && hasVisibleDraftChanges(persisted, detail) ? persisted : null,
          );
        } catch (err) {
          if (generationRef.current !== currentGen) return;
          setError(toSafeUserError(err, '检查草稿失败').message);
        }
      } catch (err) {
        if (generationRef.current !== currentGen) return;
        setError(toSafeUserError(err, '加载章节正文失败').message);
      }
    },
    [projectId],
  );

  const select = useCallback(
    (chapterId: string | null) => {
      generationRef.current += 1;
      setSelectedChapterId(chapterId);
      setChapter(null);
      setDraft(null);
      setPersistedDraft(null);
      setDraftBaseVersionId(null);
      setAutosaveStatus(null);
      setSaveError(null);
      setExportNotice(null);
      setVersions(null);
      if (chapterId !== null) void loadChapter(chapterId);
    },
    [loadChapter],
  );

  const edit = useCallback((next: ManuscriptDraft) => {
    setDraft(next);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (!chapter || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await window.desktop.manuscript.saveChapter({
        projectId,
        chapterId: chapter.chapterId,
        title: draft.title,
        content: draft.content,
        expectedCurrentVersionId: chapter.currentVersionId,
      });
      setChapter(updated);
      setDraft({ title: updated.title, content: updated.content });
      setDraftBaseVersionId(updated.currentVersionId);
      // 后端已在同一事务里清掉草稿，前端同步清掉本地持久化草稿状态与横幅。
      setPersistedDraft(null);
      setAutosaveStatus(null);
      await loadWorkspace();
    } catch (err) {
      // 冲突（或任何失败）时保留用户输入——draft 不动，用户可以复制走或重新加载
      setSaveError(toSafeUserError(err, '保存失败').message);
    } finally {
      setSaving(false);
    }
  }, [chapter, draft, projectId, loadWorkspace]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!chapter || !draft || selectedChapterId === null) return;
    if (saving) return;
    const currentGen = generationRef.current;
    setAutosaveStatus({ kind: 'saving' });
    try {
      await window.desktop.manuscript.saveDraft({
        projectId,
        chapterId: chapter.chapterId,
        title: draft.title,
        content: draft.content,
        baseVersionId: draftBaseVersionId,
      });
      if (generationRef.current !== currentGen) return;
      setAutosaveStatus({ kind: 'saved', at: new Date().toISOString() });
    } catch (err) {
      // 失败不丢用户输入、不阻塞显式保存；只给出可见且可被读屏感知的提示。
      if (generationRef.current !== currentGen) return;
      setAutosaveStatus({ kind: 'error', message: toSafeUserError(err, '自动保存失败').message });
    }
  }, [chapter, draft, selectedChapterId, saving, projectId, draftBaseVersionId]);

  const restoreDraft = useCallback(() => {
    if (!chapter || !persistedDraft) return;
    setDraft({
      title: persistedDraft.title ?? chapter.title,
      content: persistedDraft.content,
    });
    setDraftBaseVersionId(persistedDraft.baseVersionId);
    setAutosaveStatus(null);
    setSaveError(null);
  }, [chapter, persistedDraft]);

  const discardDraft = useCallback(async (): Promise<void> => {
    if (!chapter || selectedChapterId === null) return;
    const currentGen = generationRef.current;
    setSaveError(null);
    try {
      await window.desktop.manuscript.discardDraft({
        projectId,
        chapterId: chapter.chapterId,
      });
      if (generationRef.current !== currentGen) return;
      const discarded = persistedDraft;
      setPersistedDraft(null);
      setAutosaveStatus(null);
      // 如果用户先「恢复到草稿」再丢弃，且没有继续修改，就把编辑器拉回权威正文；
      // 否则丢弃后 autosave 会立刻把同一份草稿又写回去，丢弃等于白点。
      if (
        discarded !== null &&
        draft !== null &&
        draft.title === (discarded.title ?? chapter.title) &&
        draft.content === discarded.content
      ) {
        setDraft({ title: chapter.title, content: chapter.content });
        setDraftBaseVersionId(chapter.currentVersionId);
      }
    } catch (err) {
      setSaveError(toSafeUserError(err, '丢弃草稿失败').message);
    }
  }, [chapter, selectedChapterId, projectId, persistedDraft, draft]);

  const reload = useCallback(async (): Promise<void> => {
    if (selectedChapterId === null) return;
    await loadChapter(selectedChapterId);
  }, [selectedChapterId, loadChapter]);

  const exportManuscript = useCallback(
    async (format: ManuscriptExportFormatDto): Promise<void> => {
      setExportNotice(null);
      setError(null);
      try {
        const result = await window.desktop.manuscript.exportManuscript({ projectId, format });
        setExportNotice(
          result.saved
            ? `已导出 ${String(result.chapterCount)} 章到 ${result.filePath ?? result.fileName}`
            : '已取消导出',
        );
      } catch (err) {
        setError(toSafeUserError(err, '导出失败').message);
      }
    },
    [projectId],
  );

  const toggleVersions = useCallback(async (): Promise<void> => {
    if (versions !== null) {
      setVersions(null);
      return;
    }
    if (selectedChapterId === null) return;
    try {
      const list = await window.desktop.manuscript.listVersions({
        projectId,
        chapterId: selectedChapterId,
      });
      setVersions(list);
    } catch (err) {
      setSaveError(toSafeUserError(err, '加载版本历史失败').message);
    }
  }, [versions, selectedChapterId, projectId]);

  const restore = useCallback(
    async (versionId: string): Promise<void> => {
      if (!chapter) return;
      const currentGen = generationRef.current;
      setSaving(true);
      setSaveError(null);
      try {
        const updated = await window.desktop.manuscript.restoreVersion({
          projectId,
          chapterId: chapter.chapterId,
          versionId,
          expectedCurrentVersionId: chapter.currentVersionId,
        });
        if (generationRef.current !== currentGen) return;
        setChapter(updated);
        setDraft({ title: updated.title, content: updated.content });
        setDraftBaseVersionId(updated.currentVersionId);
        const list = await window.desktop.manuscript.listVersions({
          projectId,
          chapterId: chapter.chapterId,
        });
        setVersions(list);
        await loadWorkspace();
        try {
          const persisted = await window.desktop.manuscript.getDraft({
            projectId,
            chapterId: chapter.chapterId,
          });
          if (generationRef.current !== currentGen) return;
          setPersistedDraft(
            persisted !== null && hasVisibleDraftChanges(persisted, updated) ? persisted : null,
          );
        } catch (err) {
          if (generationRef.current !== currentGen) return;
          setError(toSafeUserError(err, '检查草稿失败').message);
        }
      } catch (err) {
        if (generationRef.current !== currentGen) return;
        setSaveError(toSafeUserError(err, '恢复版本失败').message);
      } finally {
        if (generationRef.current === currentGen) setSaving(false);
      }
    },
    [chapter, projectId, loadWorkspace],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    await loadWorkspace();
    if (selectedChapterId !== null) await loadChapter(selectedChapterId);
  }, [loadWorkspace, loadChapter, selectedChapterId]);

  const dirty =
    chapter !== null &&
    draft !== null &&
    (draft.title !== chapter.title || draft.content !== chapter.content);

  useEffect(() => {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    // 只自动保存有差异的缓冲区；显式保存进行中绝不触发，避免两个写路径互相干扰。
    if (!dirty || saving || chapter === null || draft === null || selectedChapterId === null) {
      return;
    }

    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveDraft();
    }, 2000);

    return () => {
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [chapter, dirty, draft, saveDraft, saving, selectedChapterId]);

  return {
    workspace,
    selectedChapterId,
    chapter,
    draft,
    dirty,
    loading,
    saving,
    error,
    saveError,
    exportNotice,
    versions,
    persistedDraft,
    autosaveStatus,
    actions: {
      select,
      edit,
      save,
      reload,
      exportManuscript,
      toggleVersions,
      restore,
      restoreDraft,
      discardDraft,
      refresh,
    },
  };
}
