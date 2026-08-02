/**
 * @ai-novel/contracts - Manuscript DTO / 严格输入验证 / ErrorCode 测试
 *
 * 覆盖：
 * - 6 个新 ErrorCode 加入 union 且 isAppError 识别；
 * - 全部稿件输入 validator：合法输入通过、多余/未知/继承字段被拒、
 *   ID/position/versionNumber/title/content/null 语义严格；
 * - Renderer 输入不含新 ID / now / sourceType / taskId / invocationId；
 * - 公开数据 validator。
 */

import { describe, it, expect } from 'vitest';
import {
  isAppError,
  isValidGetOrCreateManuscriptInput,
  isValidGetManuscriptInput,
  isValidListChaptersInput,
  isValidGetChapterInput,
  isValidGetCurrentChapterVersionInput,
  isValidListChapterVersionsInput,
  isValidGetChapterVersionInput,
  isValidCreateChapterInput,
  isValidCreateChapterVersionInput,
  isValidPromoteChapterVersionInput,
  isValidUpdateChapterOrderInput,
  isValidArchiveChapterInput,
  isValidRestoreChapterInput,
  isValidUpdateManuscriptTitleInput,
  isValidManuscriptPublicData,
  isValidChapterSummary,
  isValidChapterPublicData,
  isValidChapterVersionSummary,
  isValidChapterVersionPublicData,
  type ErrorCode,
} from './index.js';

describe('manuscript ErrorCode', () => {
  it('isAppError 识别全部新 manuscript 错误码', () => {
    for (const code of [
      'MANUSCRIPT_NOT_FOUND',
      'MANUSCRIPT_STATE_CONFLICT',
      'MANUSCRIPT_VERSION_CONFLICT',
      'MANUSCRIPT_POSITION_OVERFLOW',
      'CHAPTER_NOT_FOUND',
      'CHAPTER_VERSION_NOT_FOUND',
    ]) {
      expect(isAppError({ code, message: 'x' })).toBe(true);
    }
  });

  it('code 是合法 ErrorCode 联合成员', () => {
    const code: ErrorCode = 'MANUSCRIPT_POSITION_OVERFLOW';
    expect(code).toBe('MANUSCRIPT_POSITION_OVERFLOW');
    const invalid: ErrorCode = 'INTERNAL_ERROR';
    expect(invalid).toBe('INTERNAL_ERROR');
  });
});

describe('Renderer 输入不含注入字段', () => {
  it('createChapterVersion 拒绝 sourceType / taskId / invocationId / now / newVersionId', () => {
    const base = {
      projectId: 'p1',
      chapterId: 'c1',
      title: '章一',
      content: '正文',
      expectedCurrentVersionId: null,
    };
    expect(isValidCreateChapterVersionInput(base)).toBe(true);
    expect(isValidCreateChapterVersionInput({ ...base, sourceType: 'USER' })).toBe(false);
    expect(isValidCreateChapterVersionInput({ ...base, taskId: 't1' })).toBe(false);
    expect(isValidCreateChapterVersionInput({ ...base, invocationId: 'i1' })).toBe(false);
    expect(isValidCreateChapterVersionInput({ ...base, now: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(isValidCreateChapterVersionInput({ ...base, newVersionId: 'v9' })).toBe(false);
  });
});

describe('getOrCreateManuscript', () => {
  it('合法输入通过', () => {
    expect(isValidGetOrCreateManuscriptInput({ projectId: 'p1' })).toBe(true);
    expect(isValidGetOrCreateManuscriptInput({ projectId: 'p1', title: '我的小说' })).toBe(true);
  });

  it('拒绝多余 / 继承字段', () => {
    expect(isValidGetOrCreateManuscriptInput({ projectId: 'p1', extra: 1 })).toBe(false);
    const inherited = Object.create({ title: 'inherited' });
    inherited.projectId = 'p1';
    expect(isValidGetOrCreateManuscriptInput(inherited)).toBe(false);
  });

  it('拒绝非法 title / projectId', () => {
    expect(isValidGetOrCreateManuscriptInput({ projectId: 'p1', title: '   ' })).toBe(false);
    expect(isValidGetOrCreateManuscriptInput({ projectId: 'p1', title: 'x'.repeat(201) })).toBe(
      false,
    );
    expect(isValidGetOrCreateManuscriptInput({ projectId: '' })).toBe(false);
    expect(isValidGetOrCreateManuscriptInput({ projectId: 5 })).toBe(false);
  });
});

describe('read 输入 validator', () => {
  it('getManuscript', () => {
    expect(isValidGetManuscriptInput({ projectId: 'p1', manuscriptId: 'm1' })).toBe(true);
    expect(isValidGetManuscriptInput({ projectId: 'p1' })).toBe(false);
    expect(isValidGetManuscriptInput({ projectId: 'p1', manuscriptId: 'm1', x: 1 })).toBe(false);
  });

  it('listChapters', () => {
    expect(isValidListChaptersInput({ projectId: 'p1', manuscriptId: 'm1' })).toBe(true);
    expect(
      isValidListChaptersInput({ projectId: 'p1', manuscriptId: 'm1', includeArchived: true }),
    ).toBe(true);
    expect(
      isValidListChaptersInput({ projectId: 'p1', manuscriptId: 'm1', includeArchived: 1 }),
    ).toBe(false);
    expect(isValidListChaptersInput({ projectId: 'p1' })).toBe(false);
  });

  it('getChapter', () => {
    expect(isValidGetChapterInput({ projectId: 'p1', manuscriptId: 'm1', chapterId: 'c1' })).toBe(
      true,
    );
    expect(
      isValidGetChapterInput({ projectId: 'p1', manuscriptId: 'm1', chapterId: 'c1', n: 1 }),
    ).toBe(false);
  });

  it('getCurrentChapterVersion / listChapterVersions / getChapterVersion', () => {
    expect(isValidGetCurrentChapterVersionInput({ projectId: 'p1', chapterId: 'c1' })).toBe(true);
    expect(isValidListChapterVersionsInput({ projectId: 'p1', chapterId: 'c1' })).toBe(true);
    expect(
      isValidGetChapterVersionInput({ projectId: 'p1', chapterId: 'c1', versionId: 'v1' }),
    ).toBe(true);
    expect(isValidGetChapterVersionInput({ projectId: 'p1', chapterId: 'c1' })).toBe(false);
  });
});

describe('write 输入 validator', () => {
  it('createChapter', () => {
    expect(
      isValidCreateChapterInput({
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: null,
      }),
    ).toBe(true);
    expect(
      isValidCreateChapterInput({
        projectId: 'p1',
        manuscriptId: 'm1',
        insertBeforeChapterId: 'c5',
      }),
    ).toBe(true);
    expect(isValidCreateChapterInput({ projectId: 'p1', manuscriptId: 'm1' })).toBe(false);
    // insertBeforeChapterId 必须显式为 null 或 ID
    expect(
      isValidCreateChapterInput({ projectId: 'p1', manuscriptId: 'm1', insertBeforeChapterId: 3 }),
    ).toBe(false);
  });

  it('createChapterVersion', () => {
    const valid = {
      projectId: 'p1',
      chapterId: 'c1',
      title: '章一',
      content: '正文',
      expectedCurrentVersionId: null,
    };
    expect(isValidCreateChapterVersionInput(valid)).toBe(true);
    expect(
      isValidCreateChapterVersionInput({
        ...valid,
        expectedCurrentVersionId: 'v1',
        creationContractVersionId: 'cv1',
      }),
    ).toBe(true);
    expect(isValidCreateChapterVersionInput({ ...valid, title: '  ' })).toBe(false);
    expect(isValidCreateChapterVersionInput({ ...valid, content: 'x'.repeat(1_000_001) })).toBe(
      false,
    );
    expect(isValidCreateChapterVersionInput({ ...valid, content: '' })).toBe(true);
  });

  it('promoteChapterVersion', () => {
    expect(
      isValidPromoteChapterVersionInput({
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v2',
        expectedCurrentVersionId: 'v1',
      }),
    ).toBe(true);
    expect(
      isValidPromoteChapterVersionInput({
        projectId: 'p1',
        chapterId: 'c1',
        versionId: 'v2',
        expectedCurrentVersionId: null,
      }),
    ).toBe(true);
    expect(
      isValidPromoteChapterVersionInput({ projectId: 'p1', chapterId: 'c1', versionId: 'v2' }),
    ).toBe(false);
  });

  it('updateChapterOrder', () => {
    expect(
      isValidUpdateChapterOrderInput({
        projectId: 'p1',
        manuscriptId: 'm1',
        chapterId: 'c1',
        insertBeforeChapterId: 'c3',
      }),
    ).toBe(true);
    expect(
      isValidUpdateChapterOrderInput({ projectId: 'p1', manuscriptId: 'm1', chapterId: 'c1' }),
    ).toBe(false);
  });

  it('archiveChapter / restoreChapter', () => {
    expect(
      isValidArchiveChapterInput({
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: null,
      }),
    ).toBe(true);
    expect(
      isValidRestoreChapterInput({
        projectId: 'p1',
        chapterId: 'c1',
        expectedCurrentVersionId: 'v1',
      }),
    ).toBe(true);
    expect(isValidArchiveChapterInput({ projectId: 'p1', chapterId: 'c1' })).toBe(false);
  });

  it('updateManuscriptTitle', () => {
    expect(
      isValidUpdateManuscriptTitleInput({
        projectId: 'p1',
        manuscriptId: 'm1',
        title: '新标题',
        expectedUpdatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toBe(true);
    expect(
      isValidUpdateManuscriptTitleInput({
        projectId: 'p1',
        manuscriptId: 'm1',
        title: '新标题',
        expectedUpdatedAt: '   ',
      }),
    ).toBe(false);
    expect(
      isValidUpdateManuscriptTitleInput({ projectId: 'p1', manuscriptId: 'm1', title: '新标题' }),
    ).toBe(false);
  });
});

describe('public data validator', () => {
  it('isValidManuscriptPublicData', () => {
    const m = {
      id: 'm1',
      projectId: 'p1',
      title: '我的小说',
      status: 'active',
      creationContractVersionId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(isValidManuscriptPublicData(m)).toBe(true);
    expect(isValidManuscriptPublicData({ ...m, status: 'deleted' })).toBe(false);
    expect(isValidManuscriptPublicData({ ...m, extra: 1 })).toBe(false);
  });

  it('isValidChapterVersionSummary 不含 content', () => {
    const s = {
      id: 'v1',
      chapterId: 'c1',
      versionNumber: 1,
      title: '章一',
      sourceType: 'USER',
      createdAt: '2026-01-01T00:00:00Z',
      parentVersionId: null,
      creationContractVersionId: null,
      contentHash: 'a'.repeat(64),
    };
    expect(isValidChapterVersionSummary(s)).toBe(true);
    expect(isValidChapterVersionSummary({ ...s, content: 'x' })).toBe(false);
  });

  it('isValidChapterVersionPublicData 含 content', () => {
    const v = {
      id: 'v1',
      projectId: 'p1',
      chapterId: 'c1',
      versionNumber: 1,
      title: '章一',
      content: '正文',
      contentHash: 'a'.repeat(64),
      parentVersionId: null,
      sourceType: 'USER',
      createdByTaskId: null,
      invocationId: null,
      creationContractVersionId: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(isValidChapterVersionPublicData(v)).toBe(true);
    expect(isValidChapterVersionPublicData({ ...v, contentHash: 'zz' })).toBe(false);
  });

  it('isValidChapterSummary / isValidChapterPublicData', () => {
    const summary = {
      id: 'c1',
      projectId: 'p1',
      manuscriptId: 'm1',
      position: 2048,
      currentVersionId: 'v1',
      status: 'active',
      currentTitle: '章一',
      versionCount: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(isValidChapterSummary(summary)).toBe(true);
    expect(isValidChapterSummary({ ...summary, position: 0 })).toBe(false);

    const full = {
      id: 'c1',
      projectId: 'p1',
      manuscriptId: 'm1',
      position: 2048,
      currentVersionId: 'v1',
      status: 'active',
      currentVersion: {
        id: 'v1',
        chapterId: 'c1',
        versionNumber: 1,
        title: '章一',
        sourceType: 'USER',
        createdAt: '2026-01-01T00:00:00Z',
        parentVersionId: null,
        creationContractVersionId: null,
        contentHash: 'a'.repeat(64),
      },
      versionCount: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(isValidChapterPublicData(full)).toBe(true);
    expect(isValidChapterPublicData({ ...full, currentVersion: null })).toBe(true);
    expect(isValidChapterPublicData({ ...full, currentTitle: '章一' })).toBe(false);
  });
});
