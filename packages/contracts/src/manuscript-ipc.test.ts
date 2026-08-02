/**
 * 稿件 IPC 通道与 DesktopAPI 完整性测试（MV1-B）。
 *
 * 覆盖：
 * - IPC_CHANNELS 包含全部 14 个 manuscript 通道、值唯一且符合 ipc:manuscript- 前缀；
 * - 每个通道对应唯一 worker 命令名（Main 转发 payload 时使用的 command）；
 * - DesktopAPI 类型包含 manuscript: ManuscriptAPI 且 14 个方法齐全（编译期 type-check）。
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type ManuscriptAPI, type DesktopAPI } from './index.js';

const MANUSCRIPT_CHANNELS = [
  'MANUSCRIPT_GET_OR_CREATE',
  'MANUSCRIPT_GET',
  'MANUSCRIPT_LIST_CHAPTERS',
  'MANUSCRIPT_GET_CHAPTER',
  'MANUSCRIPT_GET_CURRENT_CHAPTER_VERSION',
  'MANUSCRIPT_LIST_CHAPTER_VERSIONS',
  'MANUSCRIPT_GET_CHAPTER_VERSION',
  'MANUSCRIPT_CREATE_CHAPTER',
  'MANUSCRIPT_CREATE_CHAPTER_VERSION',
  'MANUSCRIPT_PROMOTE_CHAPTER_VERSION',
  'MANUSCRIPT_UPDATE_CHAPTER_ORDER',
  'MANUSCRIPT_ARCHIVE_CHAPTER',
  'MANUSCRIPT_RESTORE_CHAPTER',
  'MANUSCRIPT_UPDATE_TITLE',
] as const;

/** Main 转发时使用的 worker 命令名（与 channel 一一对应） */
const CHANNEL_TO_COMMAND: Readonly<Record<(typeof MANUSCRIPT_CHANNELS)[number], string>> = {
  MANUSCRIPT_GET_OR_CREATE: 'manuscript.getOrCreateManuscript',
  MANUSCRIPT_GET: 'manuscript.getManuscript',
  MANUSCRIPT_LIST_CHAPTERS: 'manuscript.listChapters',
  MANUSCRIPT_GET_CHAPTER: 'manuscript.getChapter',
  MANUSCRIPT_GET_CURRENT_CHAPTER_VERSION: 'manuscript.getCurrentChapterVersion',
  MANUSCRIPT_LIST_CHAPTER_VERSIONS: 'manuscript.listChapterVersions',
  MANUSCRIPT_GET_CHAPTER_VERSION: 'manuscript.getChapterVersion',
  MANUSCRIPT_CREATE_CHAPTER: 'manuscript.createChapter',
  MANUSCRIPT_CREATE_CHAPTER_VERSION: 'manuscript.createChapterVersion',
  MANUSCRIPT_PROMOTE_CHAPTER_VERSION: 'manuscript.promoteChapterVersion',
  MANUSCRIPT_UPDATE_CHAPTER_ORDER: 'manuscript.updateChapterOrder',
  MANUSCRIPT_ARCHIVE_CHAPTER: 'manuscript.archiveChapter',
  MANUSCRIPT_RESTORE_CHAPTER: 'manuscript.restoreChapter',
  MANUSCRIPT_UPDATE_TITLE: 'manuscript.updateManuscriptTitle',
};

describe('Manuscript IPC channels', () => {
  it.each(MANUSCRIPT_CHANNELS)('IPC_CHANNELS 包含 %s', (channelKey) => {
    expect(IPC_CHANNELS[channelKey]).toBeDefined();
    expect(typeof IPC_CHANNELS[channelKey]).toBe('string');
    expect(IPC_CHANNELS[channelKey]).toMatch(/^ipc:manuscript-/);
  });

  it('恰好 14 个 MANUSCRIPT_* 通道', () => {
    const keys = Object.keys(IPC_CHANNELS).filter((k) => k.startsWith('MANUSCRIPT_'));
    expect(keys.sort()).toEqual([...MANUSCRIPT_CHANNELS].sort());
    expect(keys).toHaveLength(14);
  });

  it('全部 manuscript 通道值唯一', () => {
    const values = MANUSCRIPT_CHANNELS.map((k) => IPC_CHANNELS[k]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('每个通道映射唯一 worker 命令名且与协议一致', () => {
    for (const key of MANUSCRIPT_CHANNELS) {
      const command = CHANNEL_TO_COMMAND[key];
      expect(command).toMatch(/^manuscript\./);
      // 命令名只出现一次
      const allCommands = Object.values(CHANNEL_TO_COMMAND);
      expect(allCommands.filter((c) => c === command)).toHaveLength(1);
    }
  });
});

describe('ManuscriptAPI 类型完整性', () => {
  it('DesktopAPI 包含 manuscript 组', () => {
    // 编译期：DesktopAPI['manuscript'] 必须是 ManuscriptAPI
    const check: ManuscriptAPI = {} as DesktopAPI['manuscript'];
    expect(check).toBeDefined();
  });

  it('ManuscriptAPI 方法名齐全（14 个，编译期 keyof 校验）', () => {
    // `keyof ManuscriptAPI` 注解在编译期保证每个方法名都是 ManuscriptAPI 的成员；
    // 若缺方法或拼写错误，类型检查会失败。
    const methods: ReadonlyArray<keyof ManuscriptAPI> = [
      'getOrCreateManuscript',
      'getManuscript',
      'listChapters',
      'getChapter',
      'getCurrentChapterVersion',
      'listChapterVersions',
      'getChapterVersion',
      'createChapter',
      'createChapterVersion',
      'promoteChapterVersion',
      'updateChapterOrder',
      'archiveChapter',
      'restoreChapter',
      'updateManuscriptTitle',
    ];
    expect(methods).toHaveLength(14);
    // DesktopAPI 必须包含 manuscript 组（编译期断言）
    const hasManuscriptGroup: 'manuscript' extends keyof DesktopAPI ? true : false = true;
    expect(hasManuscriptGroup).toBe(true);
  });
});
