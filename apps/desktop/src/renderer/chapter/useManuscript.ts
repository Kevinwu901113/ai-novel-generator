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
  ManuscriptChapterDetailDto,
  ManuscriptExportFormatDto,
  ManuscriptWorkspaceDto,
} from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';

export interface ManuscriptDraft {
  readonly title: string;
  readonly content: string;
}

export interface ManuscriptActions {
  select(chapterId: string | null): void;
  edit(draft: ManuscriptDraft): void;
  save(): Promise<void>;
  /** 放弃本地修改，重新加载服务端当前版本（冲突后的出路之一） */
  reload(): Promise<void>;
  exportManuscript(format: ManuscriptExportFormatDto): Promise<void>;
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
  readonly actions: ManuscriptActions;
}

export function useManuscript(projectId: string): UseManuscriptReturn {
  const [workspace, setWorkspace] = useState<ManuscriptWorkspaceDto | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [chapter, setChapter] = useState<ManuscriptChapterDetailDto | null>(null);
  const [draft, setDraft] = useState<ManuscriptDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const generationRef = useRef(0);

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
        setSaveError(null);
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
      setSaveError(null);
      setExportNotice(null);
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
      await loadWorkspace();
    } catch (err) {
      // 冲突（或任何失败）时保留用户输入——draft 不动，用户可以复制走或重新加载
      setSaveError(toSafeUserError(err, '保存失败').message);
    } finally {
      setSaving(false);
    }
  }, [chapter, draft, projectId, loadWorkspace]);

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

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    await loadWorkspace();
    if (selectedChapterId !== null) await loadChapter(selectedChapterId);
  }, [loadWorkspace, loadChapter, selectedChapterId]);

  const dirty =
    chapter !== null &&
    draft !== null &&
    (draft.title !== chapter.title || draft.content !== chapter.content);

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
    actions: { select, edit, save, reload, exportManuscript, refresh },
  };
}
