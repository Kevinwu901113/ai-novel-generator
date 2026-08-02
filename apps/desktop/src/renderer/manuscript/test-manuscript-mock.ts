/**
 * 稿件工作台测试用内存版 mock 后端（MV1-B）。
 *
 * 在 Renderer 测试中模拟 window.desktop.manuscript.* 的真实后端语义：
 * - 单 active 稿件、章节（position 排序）、版本（不可变 + current 指针）；
 * - CAS（expectedCurrentVersionId / expectedUpdatedAt）与 MANUSCRIPT_VERSION_CONFLICT；
 * - 归档 / 恢复；重排（append / insert-before，返回 active 列表）；
 * - 便于测试直接调用 store 方法模拟「另一客户端」推进 current。
 */

const HEX64 = 'a'.repeat(64);

interface MockManuscript {
  id: string;
  projectId: string;
  title: string;
  status: 'active' | 'archived';
  creationContractVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MockChapter {
  id: string;
  projectId: string;
  manuscriptId: string;
  position: number;
  currentVersionId: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

interface MockVersion {
  id: string;
  projectId: string;
  chapterId: string;
  versionNumber: number;
  title: string;
  content: string;
  contentHash: string;
  parentVersionId: string | null;
  sourceType: 'USER';
  createdByTaskId: null;
  invocationId: null;
  creationContractVersionId: null;
  createdAt: string;
}

interface StoreError extends Error {
  code: string;
}

function err(code: string, message: string): StoreError {
  const e = new Error(message) as StoreError;
  e.code = code;
  return e;
}

const byPosition = (a: MockChapter, b: MockChapter): number =>
  a.position - b.position || a.id.localeCompare(b.id);

export function createManuscriptStore() {
  let manuscript: MockManuscript | null = null;
  const chapters: MockChapter[] = [];
  const versions: MockVersion[] = [];
  let chapterSeq = 0;
  let versionSeq = 0;
  const now = (): string => new Date().toISOString();

  const msPublic = (): MockManuscript | null => (manuscript ? { ...manuscript } : null);

  const summaryOf = (c: MockChapter) => {
    const cur = c.currentVersionId ? versions.find((v) => v.id === c.currentVersionId) : null;
    return {
      id: c.id,
      projectId: c.projectId,
      manuscriptId: c.manuscriptId,
      position: c.position,
      currentVersionId: c.currentVersionId,
      status: c.status,
      currentTitle: cur ? cur.title : null,
      versionCount: versions.filter((v) => v.chapterId === c.id).length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  };

  const chapterPublicOf = (c: MockChapter) => {
    const cur = c.currentVersionId ? versions.find((v) => v.id === c.currentVersionId) : null;
    return {
      id: c.id,
      projectId: c.projectId,
      manuscriptId: c.manuscriptId,
      position: c.position,
      currentVersionId: c.currentVersionId,
      status: c.status,
      currentVersion: cur
        ? {
            id: cur.id,
            chapterId: cur.chapterId,
            versionNumber: cur.versionNumber,
            title: cur.title,
            sourceType: cur.sourceType,
            createdAt: cur.createdAt,
            parentVersionId: cur.parentVersionId,
            creationContractVersionId: cur.creationContractVersionId,
            contentHash: cur.contentHash,
          }
        : null,
      versionCount: versions.filter((v) => v.chapterId === c.id).length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  };

  const versionSummaryOf = (v: MockVersion) => ({
    id: v.id,
    chapterId: v.chapterId,
    versionNumber: v.versionNumber,
    title: v.title,
    sourceType: v.sourceType,
    createdAt: v.createdAt,
    parentVersionId: v.parentVersionId,
    creationContractVersionId: v.creationContractVersionId,
    contentHash: v.contentHash,
  });

  const findChapter = (chapterId: string): MockChapter | null =>
    chapters.find((c) => c.id === chapterId) ?? null;

  const desktop = {
    getOrCreateManuscript: async (input: { projectId: string; title?: string }) => {
      if (!manuscript) {
        manuscript = {
          id: 'ms-1',
          projectId: input.projectId,
          title: input.title ?? '未命名稿件',
          status: 'active',
          creationContractVersionId: null,
          createdAt: now(),
          updatedAt: now(),
        };
      }
      return msPublic()!;
    },
    getManuscript: async (input: { projectId: string; manuscriptId: string }) => {
      if (!manuscript || manuscript.id !== input.manuscriptId)
        throw err('MANUSCRIPT_NOT_FOUND', '稿件不存在');
      return msPublic()!;
    },
    listChapters: async (input: {
      projectId: string;
      manuscriptId: string;
      includeArchived?: boolean;
    }) => {
      if (!manuscript) throw err('MANUSCRIPT_NOT_FOUND', '稿件不存在');
      return chapters
        .filter(
          (c) =>
            c.manuscriptId === input.manuscriptId &&
            (input.includeArchived || c.status === 'active'),
        )
        .sort(byPosition)
        .map(summaryOf);
    },
    getChapter: async (input: { projectId: string; manuscriptId: string; chapterId: string }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      return chapterPublicOf(c);
    },
    getCurrentChapterVersion: async (input: { projectId: string; chapterId: string }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      if (!c.currentVersionId) return null;
      const v = versions.find((x) => x.id === c.currentVersionId);
      return v ? { ...v } : null;
    },
    listChapterVersions: async (input: { projectId: string; chapterId: string }) => {
      return versions
        .filter((v) => v.chapterId === input.chapterId)
        .sort((a, b) => b.versionNumber - a.versionNumber || a.id.localeCompare(b.id))
        .map(versionSummaryOf);
    },
    getChapterVersion: async (input: {
      projectId: string;
      chapterId: string;
      versionId: string;
    }) => {
      const v = versions.find((x) => x.id === input.versionId && x.chapterId === input.chapterId);
      if (!v) throw err('CHAPTER_VERSION_NOT_FOUND', '版本不存在');
      return { ...v };
    },
    createChapter: async (input: {
      projectId: string;
      manuscriptId: string;
      insertBeforeChapterId: string | null;
    }) => {
      if (!manuscript) throw err('MANUSCRIPT_NOT_FOUND', '稿件不存在');
      const same = chapters.filter((c) => c.manuscriptId === input.manuscriptId);
      const maxPos = same.reduce((m, c) => Math.max(m, c.position), 0);
      const ch: MockChapter = {
        id: `ch-${++chapterSeq}`,
        projectId: input.projectId,
        manuscriptId: input.manuscriptId,
        position: maxPos === 0 ? 2048 : maxPos + 1024,
        currentVersionId: null,
        status: 'active',
        createdAt: now(),
        updatedAt: now(),
      };
      chapters.push(ch);
      manuscript.updatedAt = now();
      return chapterPublicOf(ch);
    },
    createChapterVersion: async (input: {
      projectId: string;
      chapterId: string;
      title: string;
      content: string;
      expectedCurrentVersionId: string | null;
    }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      if (c.status !== 'active') throw err('MANUSCRIPT_STATE_CONFLICT', '归档章节不能保存');
      if (c.currentVersionId !== input.expectedCurrentVersionId) {
        throw err('MANUSCRIPT_VERSION_CONFLICT', '版本冲突');
      }
      const maxNum = versions
        .filter((v) => v.chapterId === input.chapterId)
        .reduce((m, v) => Math.max(m, v.versionNumber), 0);
      const v: MockVersion = {
        id: `ver-${++versionSeq}`,
        projectId: input.projectId,
        chapterId: input.chapterId,
        versionNumber: maxNum + 1,
        title: input.title,
        content: input.content,
        contentHash: HEX64,
        parentVersionId: c.currentVersionId,
        sourceType: 'USER',
        createdByTaskId: null,
        invocationId: null,
        creationContractVersionId: null,
        createdAt: now(),
      };
      versions.push(v);
      c.currentVersionId = v.id;
      c.updatedAt = now();
      if (manuscript) manuscript.updatedAt = now();
      return { ...v };
    },
    promoteChapterVersion: async (input: {
      projectId: string;
      chapterId: string;
      versionId: string;
      expectedCurrentVersionId: string | null;
    }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      if (c.currentVersionId !== input.expectedCurrentVersionId) {
        throw err('MANUSCRIPT_VERSION_CONFLICT', '版本冲突');
      }
      const v = versions.find((x) => x.id === input.versionId && x.chapterId === input.chapterId);
      if (!v) throw err('CHAPTER_VERSION_NOT_FOUND', '版本不存在');
      c.currentVersionId = v.id;
      c.updatedAt = now();
      if (manuscript) manuscript.updatedAt = now();
      return { ...v };
    },
    updateChapterOrder: async (input: {
      projectId: string;
      manuscriptId: string;
      chapterId: string;
      insertBeforeChapterId: string | null;
    }) => {
      const active = chapters
        .filter((c) => c.manuscriptId === input.manuscriptId && c.status === 'active')
        .sort(byPosition);
      const M = active.find((c) => c.id === input.chapterId);
      if (!M) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      const rest = active.filter((c) => c.id !== input.chapterId);
      let next: MockChapter[];
      if (input.insertBeforeChapterId === null) {
        next = [...rest, M];
      } else {
        const T = rest.find((c) => c.id === input.insertBeforeChapterId);
        if (!T) throw err('CHAPTER_NOT_FOUND', '章节不存在');
        const idx = rest.indexOf(T);
        next = [...rest.slice(0, idx), M, ...rest.slice(idx)];
      }
      next.forEach((c, i) => {
        c.position = (i + 1) * 2048;
        c.updatedAt = now();
      });
      return next.map(summaryOf);
    },
    archiveChapter: async (input: {
      projectId: string;
      chapterId: string;
      expectedCurrentVersionId: string | null;
    }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      if (c.currentVersionId !== input.expectedCurrentVersionId) {
        throw err('MANUSCRIPT_VERSION_CONFLICT', '版本冲突');
      }
      c.status = 'archived';
      c.updatedAt = now();
      if (manuscript) manuscript.updatedAt = now();
      return chapterPublicOf(c);
    },
    restoreChapter: async (input: {
      projectId: string;
      chapterId: string;
      expectedCurrentVersionId: string | null;
    }) => {
      const c = findChapter(input.chapterId);
      if (!c) throw err('CHAPTER_NOT_FOUND', '章节不存在');
      if (c.currentVersionId !== input.expectedCurrentVersionId) {
        throw err('MANUSCRIPT_VERSION_CONFLICT', '版本冲突');
      }
      c.status = 'active';
      c.updatedAt = now();
      if (manuscript) manuscript.updatedAt = now();
      return chapterPublicOf(c);
    },
    updateManuscriptTitle: async (input: {
      projectId: string;
      manuscriptId: string;
      title: string;
      expectedUpdatedAt: string;
    }) => {
      if (!manuscript || manuscript.updatedAt !== input.expectedUpdatedAt) {
        throw err('MANUSCRIPT_VERSION_CONFLICT', '标题冲突');
      }
      manuscript.title = input.title;
      manuscript.updatedAt = now();
      return msPublic()!;
    },
  };

  return {
    desktop,
    store: {
      getManuscript: (): MockManuscript | null => manuscript,
      chapters,
      versions,
      now,
    },
  };
}
