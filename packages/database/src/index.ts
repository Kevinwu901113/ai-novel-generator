/**
 * @ai-novel/database
 *
 * SQLite 数据持久化层。
 *
 * 使用 node:sqlite（Node.js 内置）作为驱动。
 * 所有同步 SQLite 调用只在 Worker/Utility Process 中运行。
 * 领域层和应用层通过此包导出的接口与数据库交互，
 * 不直接导入 node:sqlite。
 */

// 导出类型（供应用层使用）
export type {
  Migration,
  Migrator,
  ProjectIndexRow,
  CreateProjectIndexData,
  ProjectIndexRepository,
  ProjectMetadataRow,
  CreateProjectMetadataData,
  ProjectMetadataRepository,
  ProjectCreationRow,
  CreateProjectCreationData,
  CreationPhase,
  ProjectCreationRepository,
  ProviderProfileRow,
  ProviderProfileRepository,
  AppDatabaseManager,
  ProjectDatabaseManager,
  TaskRepository,
  TaskRow,
  CreateTaskData,
  DbTaskStatus,
  DbTaskType,
  ModelInvocationRepository,
  ModelInvocationRow,
  CreateInvocationData,
  DbInvocationStatus,
  InvocationStats,
  GrillSessionRepository,
  GrillSessionRow,
  CreateGrillSessionData,
  DbGrillSessionStatus,
  GrillQuestionRepository,
  GrillQuestionRow,
  CreateGrillQuestionData,
  DbGrillQuestionStatus,
  GrillAnswerRepository,
  GrillAnswerRow,
  CreateGrillAnswerData,
  DbGrillAnswerSource,
  GrillProposalRepository,
  GrillProposalRow,
  CreateGrillProposalData,
  DbGrillProposalStatus,
  GrillQuestionPlanProposalRepository,
  GrillQuestionPlanProposalRow,
  CreateGrillQuestionPlanProposalData,
  DbGrillQuestionPlanProposalStatus,
  DbProposalStatus,
  DbContractVersionCreatedBy,
  CreationContractProposalRow,
  CreateCreationContractProposalData,
  CreationContractProposalRepository,
  CreationContractVersionRow,
  CreateCreationContractVersionData,
  CreationContractVersionRepository,
  CreationContractCurrentRow,
  CreationContractCurrentRepository,
  CreationContractLockEventRow,
  CreateCreationContractLockEventData,
  CreationContractLockEventRepository,
  ManuscriptRow,
  CreateManuscriptData,
  ManuscriptRepository,
  ChapterRow,
  CreateChapterData,
  ChapterRepository,
  ChapterVersionRow,
  ChapterVersionSummaryRow,
  CreateChapterVersionData,
  ChapterVersionRepository,
  ChapterDraftRow,
  ChapterDraftRepository,
} from './types.js';

// 导出实现（供 Worker 使用）
export { AppDatabase, FIXED_PROVIDER_PROFILE } from './app-database.js';
export { ProjectDatabase, checkProjectDatabaseVersion } from './project-database.js';
export { SQLiteMigrator } from './migrator.js';
export { CreationContractTransactionPortImpl } from './creation-contract-transaction.js';
export { ManuscriptTransactionPortImpl } from './manuscript-transaction.js';
export { ChapterVersionReadPortImpl } from './manuscript-repositories.js';
export {
  ManuscriptRepositoryImpl,
  ChapterRepositoryImpl,
  ChapterVersionRepositoryImpl,
} from './manuscript-repositories.js';
export { ChapterDraftRepositoryImpl } from './chapter-draft-repositories.js';
export {
  GraphRunRepositoryImpl,
  GraphRunCommandLogRepositoryImpl,
  IdeaIntakeAnswerPortImpl,
} from './graph-run-repositories.js';
export { GraphRunTransactionPortImpl } from './graph-run-transaction.js';
export {
  ResearchBundleRepositoryImpl,
  ResearchSourceExclusionRepositoryImpl,
} from './research-repositories.js';
export { StoryBlueprintRepositoryImpl } from './blueprint-repositories.js';
export {
  ChapterScenePlanRepositoryImpl,
  ChapterCandidateRepositoryImpl,
  ChapterCritiqueRepositoryImpl,
  ChapterRewriteFeedbackRepositoryImpl,
  ManuscriptChapterLinkRepositoryImpl,
} from './chapter-repositories.js';
export {
  NodeExecutionRepositoryImpl,
  NodeExecutionResultStoreImpl,
} from './node-execution-repositories.js';
export { sha256Utf8 } from './creation-contract-repositories.js';
