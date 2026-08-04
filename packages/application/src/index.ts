/**
 * @ai-novel/application
 *
 * 应用用例和流程接口。
 * 不依赖 Electron UI、React 或 node:sqlite。
 */

// ── 端口接口 ──────────────────────────────────────────────────────

export type {
  IdGenerator,
  Clock,
  ProjectIndexData,
  ProjectIndexRow,
  ProjectIndexRepository,
  ProjectCreationRow,
  ProjectCreationRepository,
  CreationPhase,
  ProjectMetadataData,
  ProjectMetadataRow,
  ProjectMetadataStore,
  ProjectFileSystem,
  SecretStore,
  ProviderProfileData,
  ProviderProfileRepository,
  TaskData,
  CreateTaskInput,
  TaskRepositoryPort,
  ModelInvocationData,
  CreateInvocationInput,
  InvocationSuccessResult,
  InvocationStatsData,
  ModelInvocationRepositoryPort,
} from './types.js';

// ── 错误 ──────────────────────────────────────────────────────────

export {
  AppError,
  ValidationError,
  ProjectNotFoundError,
  ProjectDirectoryMissingError,
  ProjectDatabaseInvalidError,
  DatabaseVersionUnsupportedError,
  ProjectCreateFailedError,
  WorkerUnavailableError,
  ProviderNotConfiguredError,
  ApiKeyRequiredError,
  ApiKeyStoreFailedError,
  ApiKeyReadFailedError,
  ApiKeyDeleteFailedError,
  GrillSessionNotFoundError,
  GrillQuestionNotFoundError,
  GrillAnswerNotFoundError,
  GrillProposalNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  GrillValidationError,
  GrillPlanAlreadyRunningError,
  GrillPlanStaleError,
  GrillPlanSchemaInvalidError,
  GrillPlanReferenceInvalidError,
  GrillPlanCycleDetectedError,
  GrillPlanProposalNotFoundError,
  GrillPlanProposalNotAcceptableError,
  TaskDedupeConflictError,
} from './errors.js';

// ── 用例 ──────────────────────────────────────────────────────────

export { createProject } from './create-project.js';
export type { CreateProjectDeps, CreateProjectInput } from './create-project.js';

export { listProjects } from './list-projects.js';
export type { ListProjectsDeps, ProjectListItem } from './list-projects.js';

export { openProject } from './open-project.js';
export type { OpenProjectDeps, OpenProjectInput } from './open-project.js';

export { getProviderState } from './get-provider-state.js';
export type { GetProviderStateDeps } from './get-provider-state.js';

export { saveProviderApiKey } from './save-provider-api-key.js';
export type { SaveProviderApiKeyDeps, SaveProviderApiKeyInput } from './save-provider-api-key.js';

export { deleteProviderApiKey } from './delete-provider-api-key.js';
export type { DeleteProviderApiKeyDeps } from './delete-provider-api-key.js';

export { testProviderConnection } from './test-provider-connection.js';
export type { TestProviderConnectionDeps } from './test-provider-connection.js';

// ── Grill-me 端口和用例 ───────────────────────────────────────────

export type {
  GrillSessionData,
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
  CreateGrillSessionInput,
  CreateGrillQuestionInput,
  CreateGrillAnswerInput,
  CreateGrillProposalInput,
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillProposalRepositoryPort,
  GrillQuestionPlanProposalData,
  CreateGrillQuestionPlanProposalInput,
  GrillQuestionPlanProposalRepositoryPort,
} from './grill-types.js';

export {
  createGrillSession,
  getGrillSession,
  listGrillSessions,
  startGrillSession,
  pauseGrillSession,
  resumeGrillSession,
  completeGrillSession,
  abandonGrillSession,
  addGrillQuestions,
  markQuestionAsked,
  answerGrillQuestion,
  skipGrillQuestion,
  supersedeGrillQuestion,
  getCurrentAnswers,
  listAnswerHistory,
  createGrillProposal,
  reviewGrillProposal,
  listGrillProposals,
} from './grill-session.js';
export type {
  GrillSessionDeps,
  AddGrillQuestionsInput,
  AnswerGrillQuestionInput,
  CreateGrillProposalInput2,
  ReviewGrillProposalInput,
} from './grill-session.js';

export {
  requestGrillQuestionPlan,
  acceptGrillQuestionPlanProposal,
  getGrillQuestionPlanProposal,
  listGrillQuestionPlanProposals,
  validateStoredPlan,
  existingDepsFromQuestions,
} from './grill-question-plan.js';
export type {
  GrillQuestionPlanDeps,
  GrillQuestionPlanRequestDeps,
  RequestGrillQuestionPlanInput,
  RequestGrillQuestionPlanResult,
  AcceptGrillQuestionPlanProposalInput,
  AcceptGrillQuestionPlanProposalResult,
} from './grill-question-plan.js';

// ── 创作契约端口和用例 ────────────────────────────────────────

export type { ProposalStatus, ContractVersionCreatedBy } from '@ai-novel/domain';

export {
  ContractVersionConflictError,
  ContractProposalStaleError,
  ContractProposalNotFoundError,
  ContractProposalNotAcceptableError,
  ContractLockConflictError,
  ContractModelLockViolationError,
  ContractSchemaUnsupportedError,
  ContractValidationError,
  ContractDataCorruptionError,
  ContractTransactionBusyError,
  ContractNestedTransactionError,
  ContractTransactionError,
  ContractAsyncTransactionCallbackError,
  ContractDraftAlreadyRunningError,
} from './errors.js';

export type {
  CreationContractProposalData,
  CreationContractVersionData,
  CreationContractCurrentData,
  CreationContractLockEventData,
  CreateCreationContractProposalInput,
  CreateCreationContractVersionInput,
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  CreationContractLockEventRepositoryPort,
  GrillSessionVersionReadPort,
  ProjectExistsReadPort,
  CreationContractTransactionRepositories,
  CreationContractTransactionPort,
  AcceptCreationContractProposalInput,
  RejectCreationContractProposalInput,
  UpdateCreationContractByUserInput,
  LockCreationContractFieldInput,
  UnlockCreationContractFieldInput,
  Sha256Port,
} from './creation-contract-types.js';

export { parseProvenanceArray, validateIso8601Timestamp } from './creation-contract-validation.js';

export {
  validateAuthoritativeContractVersionSnapshot,
  assertValidExistingLockSet,
} from './creation-contract-snapshot-validation.js';
export type { ValidatedAuthoritativeContractSnapshot } from './creation-contract-snapshot-validation.js';

export {
  getCurrentCreationContract,
  listCreationContractVersions,
  getCreationContractProposal,
  listCreationContractProposals,
} from './creation-contract.js';
export type {
  CreationContractQueryDeps,
  GetCurrentCreationContractInput,
  ListCreationContractVersionsInput,
  GetCreationContractProposalInput,
  ListCreationContractProposalsInput,
} from './creation-contract.js';

export {
  acceptCreationContractProposal,
  rejectCreationContractProposal,
  validateProposalAgainstLocks,
  getFieldValueByPath,
  collectAllFieldPaths,
  requireSha256Digest,
  parseSectionsJson,
  parseLockedFieldPathsJson,
} from './creation-contract-mutations.js';
export type { CreationContractMutationDeps } from './creation-contract-mutations.js';

export {
  updateCreationContractByUser,
  lockCreationContractField,
  unlockCreationContractField,
} from './creation-contract-user-mutations.js';

export { requestCreationContractProposal } from './creation-contract-request.js';
export type {
  RequestCreationContractProposalDeps,
  RequestCreationContractProposalInput,
  RequestCreationContractProposalCommand,
  RequestCreationContractProposalResult,
} from './creation-contract-request.js';

// ── 稿件 / 章节 / 章节版本端口和用例 ────────────────────────────

export {
  ManuscriptNotFoundError,
  ManuscriptStateConflictError,
  ManuscriptVersionConflictError,
  ManuscriptPositionOverflowError,
  ChapterNotFoundError,
  ChapterVersionNotFoundError,
  ManuscriptTransactionBusyError,
  ManuscriptNestedTransactionError,
  ManuscriptTransactionError,
  ManuscriptAsyncTransactionCallbackError,
} from './errors.js';

export type {
  ManuscriptData,
  ChapterData,
  ChapterVersionData,
  ChapterVersionSummaryData,
  CreateManuscriptInput,
  CreateChapterInput,
  CreateChapterVersionInput,
  ManuscriptRepositoryPort,
  ChapterRepositoryPort,
  ChapterVersionRepositoryPort,
  ManuscriptTransactionRepositories,
  ManuscriptTransactionPort,
  GetOrCreateManuscriptCommand,
  GetManuscriptCommand,
  ListChaptersCommand,
  GetChapterCommand,
  GetCurrentChapterVersionCommand,
  ListChapterVersionsCommand,
  GetChapterVersionCommand,
  CreateChapterCommand,
  CreateChapterVersionCommand,
  PromoteChapterVersionCommand,
  UpdateChapterOrderCommand,
  ArchiveChapterCommand,
  RestoreChapterCommand,
  UpdateManuscriptTitleCommand,
} from './manuscript-types.js';

export {
  getManuscript,
  listChapters,
  getChapter,
  getCurrentChapterVersion,
  listChapterVersions,
  getChapterVersion,
} from './manuscript.js';
export type {
  ManuscriptQueryDeps,
  GetManuscriptInput,
  ListChaptersInput,
  GetChapterInput,
  GetCurrentChapterVersionInput,
  ListChapterVersionsInput,
  GetChapterVersionInput,
} from './manuscript.js';

export {
  getOrCreateManuscript,
  createChapter,
  createChapterVersion,
  promoteChapterVersion,
  updateChapterOrder,
  archiveChapter,
  restoreChapter,
  updateManuscriptTitle,
} from './manuscript-mutations.js';
export type { ManuscriptMutationDeps } from './manuscript-mutations.js';

export { rebalanceManuscript, computeTargetPosition } from './manuscript-position.js';
export type { PositionContext } from './manuscript-position.js';

export { chapterVersionPortFrom } from './manuscript-conversion.js';

// ── Graph Run Runtime（GE-1）────────────────────────────────────

export type {
  GraphRunKind,
  GraphRunStateRecord,
  GraphRunCommandRecord,
  GraphRunRepositoryPort,
  GraphRunCommandLogPort,
  IdeaIntakeAnswerPort,
  GraphRunTransactionRepositories,
  GraphRunTransactionPort,
} from './graph-run-types.js';

export {
  GraphRunNotFoundError,
  GraphRunVersionConflictError,
  GraphRunStateConflictError,
  GraphRunValidationError,
  GraphRunIdempotencyConflictError,
  GraphRunInterruptedError,
  GraphRunNestedTransactionError,
  GraphRunTransactionBusyError,
  GraphRunTransactionError,
  GraphRunAsyncTransactionCallbackError,
} from './graph-run-errors.js';

export type { GraphRunDeps } from './graph-run.js';
export type {
  CreateProjectRunInput,
  CreateChapterRunInput,
  GetRunProgressInput,
  AdvanceNodeInput,
  FailNodeInput,
  RequestHumanDecisionInput,
  ApplyHumanDecisionInput,
  ListRunsInput,
  GraphRunTransitionResult,
} from './graph-run.js';

export {
  createProjectRun,
  createChapterRun,
  getRunProgress,
  advanceNode,
  failNode,
  applyArtifactChange,
  requestHumanDecision,
  applyHumanDecision,
  listRuns,
  recoverInFlightRuns,
} from './graph-run.js';
export type { ApplyArtifactChangeInput } from './graph-run.js';

// ── Idea Intake（GE-3）──────────────────────────────────────────

export type { IdeaIntakeDeps, PropagateSpecInvalidationResult } from './idea-intake.js';
export {
  createIntakeSessionFromIdea,
  getActiveIntakeSession,
  propagateCreationSpecInvalidation,
} from './idea-intake.js';

// ── Web Research（GE-4）─────────────────────────────────────────

export type {
  ResearchBundleRepositoryPort,
  ExecuteResearchDeps,
  ExecuteResearchInput,
} from './research.js';
export { executeResearch, getResearchBundle } from './research.js';

// ── StoryBlueprint（GE-5）────────────────────────────────────────

export type {
  StoryBlueprintRepositoryPort,
  BlueprintDeps,
  GenerateBlueprintInput,
} from './blueprint.js';
export {
  generateBlueprint,
  getBlueprint,
  acceptBlueprint,
  listBlueprintChapters,
} from './blueprint.js';

// ── Graph Walking Skeleton（GE-2）────────────────────────────────

export type { FakeNodeBehavior, FakeExecutorConfig, RunFakeStop } from './graph-skeleton.js';
export { fakeProducerForNode, runFakeUntilHumanOrTerminal } from './graph-skeleton.js';

// ── RW-1 Durable Node Execution & Settlement ─────────────────────

export type {
  NodeExecutorKind,
  NodeRecoveryPolicy,
  NodeExecutorDescriptor,
  ExecutorKey,
  NodeExecutionStatus,
  NodeExecutionRecord,
  CreateNodeExecutionInput,
  NodeExecutionRepositoryPort,
  NodeTaskSpec,
  StrictNodeOutcome,
  NodeExecutionResultEnvelope,
  NodeExecutionResultStorePort,
  ArtifactPayload,
  PersistedArtifactReceipt,
  NodeOutput,
  ArtifactResolverPort,
  ArtifactResolveInput,
  NodeSettlementResult,
  NodeExecutionInputContext,
  NodeExecutorRunner,
  SyncNodeExecutor,
  TaskBackedNodeExecutor,
} from './node-execution-types.js';
export {
  INFRA_MAX_ATTEMPTS,
  INFRA_RETRYABLE_CODES,
  SYNC_LEASE_MS,
} from './node-execution-types.js';
export { canonicalJson } from './canonical-json.js';
export { computeNodeInputSnapshot, inputHashOf, serializeInputSnapshot } from './node-input.js';

export { ExecutorRegistry } from './executor-registry.js';

export {
  settleNodeExecution,
  failExecutionAndNodeInTransaction,
  NodeSettlementError,
} from './node-settlement.js';
export type { NodeSettlementDeps, SettleNodeExecutionInput } from './node-settlement.js';

export { driveRun, runTerminalStatusOf } from './node-runner.js';
export type { NodeDispatchResult, NodeRunnerDeps } from './node-runner.js';

export {
  applyTransitionInTransaction,
  parkHumanNodes,
  failNodeInTransaction,
} from './graph-run.js';
