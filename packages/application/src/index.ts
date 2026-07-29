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
