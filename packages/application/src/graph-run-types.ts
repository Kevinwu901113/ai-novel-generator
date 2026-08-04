/**
 * Graph Run 运行时端口接口（GE-1）。
 *
 * 定义 GraphRunService 依赖的持久化端口与事务契约。
 * 硬不变量：任何 Graph 状态变化只能经 Domain transition，且只在本事务端口内持久化。
 * 应用层不依赖 Electron / React / node:sqlite。
 */

import type { AnyIdeaToNovelRunState } from '@ai-novel/domain';
import type {
  NodeExecutionRepositoryPort,
  NodeExecutionResultStorePort,
} from './node-execution-types.js';
import type { ResearchBundleRepositoryPort } from './research.js';
import type { StoryBlueprintRepositoryPort } from './blueprint.js';
import type { TaskRepositoryPort } from './types.js';
import type { ArtifactProvenanceRepoPort } from './node-execution-types.js';

// ── run 类型 ────────────────────────────────────────────────────

export type GraphRunKind = 'project' | 'chapter';

/** run 状态 + 当前 CAS 版本 */
export interface GraphRunStateRecord {
  readonly kind: GraphRunKind;
  readonly state: AnyIdeaToNovelRunState;
  readonly expectedVersion: number;
}

// ── 幂等命令记录 ────────────────────────────────────────────────

/** 已应用的幂等命令记录（commandId → 指纹） */
export interface GraphRunCommandRecord {
  readonly id: string;
  readonly runId: string;
  readonly commandType: string;
  readonly payloadHash: string;
  readonly appliedExpectedVersion: number;
  readonly appliedAt: string;
}

// ── Graph run 仓库端口（统一表，kind 判别）────────────────────────

export interface GraphRunRepositoryPort {
  /** 插入新 run（expected_version = 1）。必须在事务端口内调用。 */
  create(state: AnyIdeaToNovelRunState, updatedAt: string): void;
  getById(runId: string): GraphRunStateRecord | null;
  listByProject(projectId: string): ReadonlyArray<GraphRunStateRecord>;
  /** 恢复扫描：全部非终态 run */
  listNonTerminal(): ReadonlyArray<GraphRunStateRecord>;
  /** CAS 保存；expectedVersion 不匹配返回 false。必须在事务端口内调用。 */
  saveWithCas(
    runId: string,
    expectedVersion: number,
    next: AnyIdeaToNovelRunState,
    updatedAt: string,
  ): boolean;
}

// ── 幂等命令日志端口 ────────────────────────────────────────────

export interface GraphRunCommandLogPort {
  get(id: string): GraphRunCommandRecord | null;
  /** 插入；主键冲突（并发重复）返回 false */
  insert(record: GraphRunCommandRecord): boolean;
}

// ── Idea Intake 回答权威存储端口 ───────────────────────────────

/** 权威 answer 存储（grill_answers）。answer receipt 契约的写入目标。 */
export interface IdeaIntakeAnswerPort {
  insertAnswer(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly questionId: string;
    readonly text: string;
    readonly createdAt: string;
  }): void;
}

// ── 事务端口 ────────────────────────────────────────────────────

/** 事务内可用的仓库集合 */
export interface GraphRunTransactionRepositories {
  readonly graphRunRepo: GraphRunRepositoryPort;
  readonly commandLog: GraphRunCommandLogPort;
  readonly intakeAnswer: IdeaIntakeAnswerPort;
  readonly nodeExecutionRepo: NodeExecutionRepositoryPort;
  readonly nodeExecutionResultStore: NodeExecutionResultStorePort;
  /** 真实 artifact 权威存储（transaction-scoped resolver 校验 researchBundle） */
  readonly researchBundleRepo: ResearchBundleRepositoryPort;
  /** 真实 artifact 权威存储（transaction-scoped resolver 校验 storyBlueprint） */
  readonly storyBlueprintRepo: StoryBlueprintRepositoryPort;
  /** 任务仓库（execution、task 创建与绑定在同一事务内；Blocker 3） */
  readonly taskRepo: TaskRepositoryPort;
  /** execution→artifact 溯源（Blocker 5；sync 产物的权威 provenance） */
  readonly artifactProvenanceRepo: ArtifactProvenanceRepoPort;
}

/** 原子 transition 辅助：拥有 BEGIN IMMEDIATE / COMMIT / ROLLBACK / 嵌套检测 */
export interface GraphRunTransactionPort {
  runInTransaction<T>(operation: (repos: GraphRunTransactionRepositories) => T): T;
}
