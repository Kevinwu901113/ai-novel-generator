/**
 * GE-7 MANUSCRIPT_COMMIT 节点 executor（设计见 docs/development/ge7-manuscript-design.md）。
 *
 * 图上 `MANUSCRIPT_COMMIT` 是 COMMIT kind，契约 `out(null, 'manuscript')`：把用户在
 * 候选 Gate 显式接受的那一版正文写入**权威稿件**，产出 manuscript artifact。
 * 这是锁定不变量第 5 条（"生成候选 ≠ 权威稿件；仅经 MANUSCRIPT_COMMIT 后可写"）
 * 落地的唯一入口——此前该节点无 executor，run 会停在这里（B9/B10 如实标注为
 * `accepted_pending_commit`）。
 *
 * 设计要点：
 *
 * - **D-GE7-1 一个蓝图章节在稿件里始终是同一章**：绑定表 `manuscript_chapter_links`
 *   （migration v19）在首次提交时建立；同一章重新生成后再次提交，是往这一章
 *   **追加新版本**（append-only 版本链），不是新建一章。
 * - **D-GE7-2 提交幂等**：sync executor 的副作用发生在 settlement 事务之外
 *   （RW-1 的结构：execute → settle）。若 settlement 失败后重放，必须不产生第二个
 *   版本。判据是内容摘要：该章当前版本的 `contentHash` 与候选正文一致，即视为
 *   "这一版已经提交过"，直接复用它的 versionId 作为 artifact。
 * - **D-GE7-3 不静默覆盖用户正文**：写入走 `createChapterVersion` 的 CAS
 *   （`expectedCurrentVersionId` = 事务内读到的当前指针），且是**追加新版本 +
 *   移动 current 指针**，用户手写的旧版本一条不删。
 * - **D-GE7-4 AI 来源溯源**：manuscript 域要求 AI 版本必须带 task + invocation +
 *   creationSpec 版本（`assertSourceTypeProvenance`）。候选行自 v19 起记录产出它的
 *   task/invocation（见 chapter-nodes.ts），此处直接透传；缺失（v19 之前的旧行）
 *   时按 `IMPORT` 来源写入并在内容里如实标注，而不是伪造一个 task id。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type {
  Clock,
  ExecutorRegistry,
  IdGenerator,
  NodeExecutionInputContext,
  NodeExecutorDescriptor,
  NodeExecutorRunner,
  NodeOutput,
} from '@ai-novel/application';
import { createChapterVersion, getOrCreateManuscript, createChapter } from '@ai-novel/application';
import type { ChapterGenerationRunState } from '@ai-novel/domain';
import { MANUSCRIPT_COMMIT } from '@ai-novel/domain';
import { sha256Utf8 } from '@ai-novel/database';
import { withProjectDb } from './with-project-db.js';

export interface ManuscriptCommitContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

export const MANUSCRIPT_COMMIT_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'manuscript-commit-v1',
  executorVersion: 'v1',
  graphKind: 'chapter',
  nodeId: MANUSCRIPT_COMMIT as never,
  kind: 'sync',
  // D-GE7-2：写入幂等（同内容视为已提交），故允许重放
  recoveryPolicy: 'replayable',
};

/**
 * 按蓝图章节序定位插入点（D-GE7-7）：返回"蓝图里排在本章之后、且已在稿件里存在"的
 * 第一章对应的稿件章节 id；没有则返回 null（追加到末尾）。
 */
function findInsertBeforeChapterId(
  projDb: ProjectDatabase,
  projectId: string,
  storyBlueprintId: string,
  blueprintChapterId: string,
): string | null {
  const found = projDb.getStoryBlueprintRepository().getById(projectId, storyBlueprintId);
  if (!found) return null;
  const chapters = found.blueprint.chapters;
  const index = chapters.findIndex((c) => c.id === blueprintChapterId);
  if (index < 0) return null;
  const linkRepo = projDb.getManuscriptChapterLinkRepository();
  for (const later of chapters.slice(index + 1)) {
    const link = linkRepo.get(projectId, later.id);
    if (link) return link.chapterId;
  }
  return null;
}

function manuscriptCommitExecute(
  ctx: ManuscriptCommitContext,
  ectx: NodeExecutionInputContext,
): NodeOutput {
  return withProjectDb(ctx.getProjectDb, ectx.projectId, (projDb) => {
    const record = projDb
      .getGraphRunTransaction()
      .runInTransaction((repos) => repos.graphRunRepo.getById(ectx.graphRunId));
    if (!record || record.kind !== 'chapter') {
      throw new Error('MANUSCRIPT_COMMIT：章节 run 不存在');
    }
    const state = record.state as ChapterGenerationRunState;
    const candidate = projDb
      .getChapterCandidateRepository()
      .getLatestByRun(ectx.projectId, ectx.graphRunId);
    if (!candidate) {
      throw new Error('MANUSCRIPT_COMMIT：没有可提交的候选正文');
    }

    const deps = {
      transactionPort: projDb.getManuscriptTransaction(),
      sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
    };
    const now = ctx.clock.now();

    // 1. 稿件（每项目一份；已存在则取回）
    const manuscript = getOrCreateManuscript(deps, {
      projectId: ectx.projectId,
      newManuscriptId: ctx.idGenerator.generate(),
      creationContractVersionId: state.creationSpecVersionId,
      now,
    });

    // 2. 蓝图章节 ↔ 稿件章节绑定（D-GE7-1）
    const linkRepo = projDb.getManuscriptChapterLinkRepository();
    let link = linkRepo.get(ectx.projectId, state.blueprintChapterId);
    if (!link) {
      // D-GE7-7（销 TD-033-1）：新章节按**蓝图章节序**插入，而不是一律追加到末尾。
      // 用户跳着写（先第三章再第一章）时，追加会让稿件顺序变成 3、1——顺序错了的
      // 稿件在导出时就是错的书。定位方式：找蓝图里排在本章之后、且**已经在稿件里
      // 存在**的第一章，插到它前面；找不到（本章是目前最靠后的）才追加到末尾。
      const insertBeforeChapterId = findInsertBeforeChapterId(
        projDb,
        ectx.projectId,
        state.storyBlueprintId,
        state.blueprintChapterId,
      );
      const chapter = createChapter(deps, {
        projectId: ectx.projectId,
        manuscriptId: manuscript.id,
        newChapterId: ctx.idGenerator.generate(),
        insertBeforeChapterId,
        now,
      });
      link = {
        projectId: ectx.projectId,
        blueprintChapterId: state.blueprintChapterId,
        manuscriptId: manuscript.id,
        chapterId: chapter.id,
        createdAt: now,
      };
      linkRepo.save(link);
    }

    // 3. D-GE7-2 幂等：当前版本内容与候选一致 → 这一版已经提交过，复用它
    const chapterRow = projDb
      .getManuscriptTransaction()
      .runInTransaction((repos) => repos.chapterRepo.getById(ectx.projectId, link!.chapterId));
    if (!chapterRow) throw new Error('MANUSCRIPT_COMMIT：绑定的稿件章节不存在');
    const candidateHash = sha256Utf8(candidate.content);
    if (chapterRow.currentVersionId !== null) {
      const current = projDb
        .getManuscriptTransaction()
        .runInTransaction((repos) =>
          repos.chapterVersionRepo.getById(
            ectx.projectId,
            link!.chapterId,
            chapterRow.currentVersionId!,
          ),
        );
      if (current && current.contentHash === candidateHash) {
        return {
          artifact: {
            kind: 'manuscript' as const,
            artifactId: current.id,
            producerNodeId: ectx.nodeId,
            version: current.versionNumber,
          },
        };
      }
    }

    // 4. 追加新版本（CAS + append-only；D-GE7-3）
    const hasAiProvenance =
      candidate.producedByTaskId !== null && candidate.producedByInvocationId !== null;
    const version = createChapterVersion(deps, {
      projectId: ectx.projectId,
      chapterId: link.chapterId,
      newVersionId: ctx.idGenerator.generate(),
      title: candidate.title,
      content: candidate.content,
      expectedCurrentVersionId: chapterRow.currentVersionId,
      sourceType: hasAiProvenance ? 'AI_GENERATION' : 'IMPORT',
      createdByTaskId: hasAiProvenance ? candidate.producedByTaskId : null,
      invocationId: hasAiProvenance ? candidate.producedByInvocationId : null,
      creationContractVersionId: state.creationSpecVersionId,
      now,
    });

    return {
      artifact: {
        kind: 'manuscript' as const,
        artifactId: version.id,
        producerNodeId: ectx.nodeId,
        version: version.versionNumber,
      },
    };
  });
}

/** 注册 GE-7 的 MANUSCRIPT_COMMIT executor（worker 启动时调用一次） */
export function registerManuscriptCommitExecutor(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
  ctx: ManuscriptCommitContext,
): void {
  registry.register(MANUSCRIPT_COMMIT_DESCRIPTOR);
  runners.set(MANUSCRIPT_COMMIT_DESCRIPTOR.executorId, {
    descriptor: MANUSCRIPT_COMMIT_DESCRIPTOR,
    execute: (ectx: NodeExecutionInputContext) => manuscriptCommitExecute(ctx, ectx),
  } as NodeExecutorRunner);
}
