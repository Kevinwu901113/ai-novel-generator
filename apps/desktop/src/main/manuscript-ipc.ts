/**
 * 稿件 IPC 处理器注册（Minimal Manuscript Renderer，MV1-B）。
 *
 * 与创作契约 IPC 同构：Main 只做
 *   输入 validator → forwardToWorker → 输出 validator → 安全错误
 * 不直接打开 SQLite、不生成业务结果、不绕过 Worker（§5、§6.2）。
 *
 * - 输入 validator 拒绝未知字段与注入字段（new id / now / sourceType / taskId）；
 * - 输出 validator 复用 contracts 公开数据 validator，防止 Worker 返回非法数据；
 * - Worker 不可用 / 项目未打开由 forwardToWorker 上抛 WORKER_UNAVAILABLE 等安全错误；
 * - 返回 cleanup 供测试/热更新移除 handler，重复注册不会泄漏（先 removeHandler 再 handle）。
 */

import crypto from 'node:crypto';
import {
  IPC_CHANNELS,
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
  type ChapterSummary,
  type ChapterVersionSummary,
  type ChapterVersionPublicData,
} from '@ai-novel/contracts';

// ── 依赖注入接口（测试可用 fake ipc / fake forward）──────────────────

export interface ManuscriptIpcIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface ManuscriptIpcDeps {
  ipc: ManuscriptIpcIpc;
  forwardToWorker: (request: {
    requestId: string;
    command: string;
    payload: unknown;
  }) => Promise<unknown>;
}

// ── 错误构造（与既有 index.ts 模式一致：Error + code）────────────────

function validationError(): Error {
  return Object.assign(new Error('无效的稿件请求输入'), { code: 'VALIDATION_ERROR' });
}

function outputError(): Error {
  return Object.assign(new Error('稿件服务返回了无效数据'), { code: 'INTERNAL_ERROR' });
}

// ── 输出 validator 组合 ─────────────────────────────────────────────

function isChapterSummaryArray(data: unknown): data is ReadonlyArray<ChapterSummary> {
  return Array.isArray(data) && data.every((item) => isValidChapterSummary(item));
}

function isChapterVersionSummaryArray(data: unknown): data is ReadonlyArray<ChapterVersionSummary> {
  return Array.isArray(data) && data.every((item) => isValidChapterVersionSummary(item));
}

function isNullableChapterVersionPublicData(
  data: unknown,
): data is ChapterVersionPublicData | null {
  return data === null || isValidChapterVersionPublicData(data);
}

// ── 处理器 ──────────────────────────────────────────────────────────

interface ManuscriptHandlerSpec {
  readonly channel: string;
  readonly command: string;
  readonly validateInput: (data: unknown) => boolean;
  readonly validateOutput: (data: unknown) => boolean;
}

const MANUSCRIPT_HANDLERS: ReadonlyArray<ManuscriptHandlerSpec> = [
  {
    channel: IPC_CHANNELS.MANUSCRIPT_GET_OR_CREATE,
    command: 'manuscript.getOrCreateManuscript',
    validateInput: isValidGetOrCreateManuscriptInput,
    validateOutput: isValidManuscriptPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_GET,
    command: 'manuscript.getManuscript',
    validateInput: isValidGetManuscriptInput,
    validateOutput: isValidManuscriptPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTERS,
    command: 'manuscript.listChapters',
    validateInput: isValidListChaptersInput,
    validateOutput: isChapterSummaryArray,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER,
    command: 'manuscript.getChapter',
    validateInput: isValidGetChapterInput,
    validateOutput: isValidChapterPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_GET_CURRENT_CHAPTER_VERSION,
    command: 'manuscript.getCurrentChapterVersion',
    validateInput: isValidGetCurrentChapterVersionInput,
    validateOutput: isNullableChapterVersionPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTER_VERSIONS,
    command: 'manuscript.listChapterVersions',
    validateInput: isValidListChapterVersionsInput,
    validateOutput: isChapterVersionSummaryArray,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER_VERSION,
    command: 'manuscript.getChapterVersion',
    validateInput: isValidGetChapterVersionInput,
    validateOutput: isValidChapterVersionPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER,
    command: 'manuscript.createChapter',
    validateInput: isValidCreateChapterInput,
    validateOutput: isValidChapterPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER_VERSION,
    command: 'manuscript.createChapterVersion',
    validateInput: isValidCreateChapterVersionInput,
    validateOutput: isValidChapterVersionPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_PROMOTE_CHAPTER_VERSION,
    command: 'manuscript.promoteChapterVersion',
    validateInput: isValidPromoteChapterVersionInput,
    validateOutput: isValidChapterVersionPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_UPDATE_CHAPTER_ORDER,
    command: 'manuscript.updateChapterOrder',
    validateInput: isValidUpdateChapterOrderInput,
    validateOutput: isChapterSummaryArray,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_ARCHIVE_CHAPTER,
    command: 'manuscript.archiveChapter',
    validateInput: isValidArchiveChapterInput,
    validateOutput: isValidChapterPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_RESTORE_CHAPTER,
    command: 'manuscript.restoreChapter',
    validateInput: isValidRestoreChapterInput,
    validateOutput: isValidChapterPublicData,
  },
  {
    channel: IPC_CHANNELS.MANUSCRIPT_UPDATE_TITLE,
    command: 'manuscript.updateManuscriptTitle',
    validateInput: isValidUpdateManuscriptTitleInput,
    validateOutput: isValidManuscriptPublicData,
  },
];

/** 注册全部稿件 IPC 处理器；返回移除这些 handler 的 cleanup（幂等）。 */
export function registerManuscriptIpcHandlers(deps: ManuscriptIpcDeps): () => void {
  for (const spec of MANUSCRIPT_HANDLERS) {
    const listener = async (_event: unknown, input: unknown): Promise<unknown> => {
      if (!spec.validateInput(input)) {
        throw validationError();
      }
      const result = await deps.forwardToWorker({
        requestId: crypto.randomUUID(),
        command: spec.command,
        payload: input,
      });
      if (!spec.validateOutput(result)) {
        throw outputError();
      }
      return result;
    };
    deps.ipc.handle(spec.channel, listener);
  }

  return () => {
    for (const spec of MANUSCRIPT_HANDLERS) {
      deps.ipc.removeHandler(spec.channel);
    }
  };
}
