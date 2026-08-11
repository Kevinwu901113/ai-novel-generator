import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC channel 常量 — 与 packages/contracts 保持一致。
 * Preload 编译为自包含 CJS，不得运行时导入 workspace ESM 包。
 */
const IPC_CHANNELS = {
  HEALTH_CHECK: 'ipc:health-check',
  PROJECT_CREATE: 'ipc:project-create',
  PROJECT_LIST: 'ipc:project-list',
  PROJECT_OPEN: 'ipc:project-open',
  PROVIDER_LIST: 'ipc:provider-list',
  PROVIDER_CREATE: 'ipc:provider-create',
  PROVIDER_UPDATE: 'ipc:provider-update',
  PROVIDER_DELETE: 'ipc:provider-delete',
  PROVIDER_SET_DEFAULT: 'ipc:provider-set-default',
  PROVIDER_SAVE_API_KEY: 'ipc:provider-save-api-key',
  PROVIDER_DELETE_API_KEY: 'ipc:provider-delete-api-key',
  PROVIDER_TEST_CONNECTION: 'ipc:provider-test-connection',
  TASK_CREATE_MODEL_INVOCATION_TEST: 'ipc:task-create-model-invocation-test',
  TASK_GET: 'ipc:task-get',
  TASK_LIST: 'ipc:task-list',
  TASK_GET_STATS: 'ipc:task-get-stats',
  GRILL_CREATE_SESSION: 'ipc:grill-create-session',
  GRILL_GET_SESSION: 'ipc:grill-get-session',
  GRILL_LIST_SESSIONS: 'ipc:grill-list-sessions',
  GRILL_LIST_QUESTIONS: 'ipc:grill-list-questions',
  GRILL_START_SESSION: 'ipc:grill-start-session',
  GRILL_PAUSE_SESSION: 'ipc:grill-pause-session',
  GRILL_RESUME_SESSION: 'ipc:grill-resume-session',
  GRILL_COMPLETE_SESSION: 'ipc:grill-complete-session',
  GRILL_ABANDON_SESSION: 'ipc:grill-abandon-session',
  GRILL_ADD_QUESTIONS: 'ipc:grill-add-questions',
  GRILL_MARK_QUESTION_ASKED: 'ipc:grill-mark-question-asked',
  GRILL_ANSWER_QUESTION: 'ipc:grill-answer-question',
  GRILL_SKIP_QUESTION: 'ipc:grill-skip-question',
  GRILL_SUPERSEDE_QUESTION: 'ipc:grill-supersede-question',
  GRILL_GET_CURRENT_ANSWERS: 'ipc:grill-get-current-answers',
  GRILL_LIST_ANSWER_HISTORY: 'ipc:grill-list-answer-history',
  GRILL_CREATE_PROPOSAL: 'ipc:grill-create-proposal',
  GRILL_REVIEW_PROPOSAL: 'ipc:grill-review-proposal',
  GRILL_LIST_PROPOSALS: 'ipc:grill-list-proposals',
  GRILL_REQUEST_QUESTION_PLAN: 'ipc:grill-request-question-plan',
  GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL: 'ipc:grill-accept-question-plan-proposal',
  GRILL_LIST_QUESTION_PLAN_PROPOSALS: 'ipc:grill-list-question-plan-proposals',
  GRILL_GET_QUESTION_PLAN_PROPOSAL: 'ipc:grill-get-question-plan-proposal',
  CONTRACT_GET_CURRENT: 'ipc:contract-get-current',
  CONTRACT_LIST_VERSIONS: 'ipc:contract-list-versions',
  CONTRACT_GET_PROPOSAL: 'ipc:contract-get-proposal',
  CONTRACT_LIST_PROPOSALS: 'ipc:contract-list-proposals',
  CONTRACT_REQUEST_DRAFT: 'ipc:contract-request-draft',
  CONTRACT_ACCEPT_PROPOSAL: 'ipc:contract-accept-proposal',
  CONTRACT_REJECT_PROPOSAL: 'ipc:contract-reject-proposal',
  CONTRACT_UPDATE_BY_USER: 'ipc:contract-update-by-user',
  CONTRACT_LOCK_FIELD: 'ipc:contract-lock-field',
  CONTRACT_UNLOCK_FIELD: 'ipc:contract-unlock-field',
  GRAPH_CREATE_PROJECT_RUN: 'ipc:graph-create-project-run',
  GRAPH_CREATE_CHAPTER_RUN: 'ipc:graph-create-chapter-run',
  GRAPH_GET_RUN_PROGRESS: 'ipc:graph-get-run-progress',
  GRAPH_APPLY_HUMAN_DECISION: 'ipc:graph-apply-human-decision',
  GRAPH_LIST_RUNS: 'ipc:graph-list-runs',
  INTAKE_GET_ACTIVE_SESSION: 'ipc:intake-get-active-session',
  INTAKE_PROPAGATE_SPEC_INVALIDATION: 'ipc:intake-propagate-spec-invalidation',
  SEARCH_SAVE_API_KEY: 'ipc:search-save-api-key',
  SEARCH_DELETE_API_KEY: 'ipc:search-delete-api-key',
  SEARCH_HAS_API_KEY: 'ipc:search-has-api-key',
  RESEARCH_GET_RESEARCH_STATE: 'ipc:research-get-research-state',
  RESEARCH_GET_BUNDLE: 'ipc:research-get-bundle',
  RESEARCH_LIST_BUNDLES: 'ipc:research-list-bundles',
  RESEARCH_SET_SOURCE_EXCLUSION: 'ipc:research-set-source-exclusion',
  RESEARCH_LIST_SOURCE_EXCLUSIONS: 'ipc:research-list-source-exclusions',
  BLUEPRINT_GET_STATE: 'ipc:blueprint-get-state',
  BLUEPRINT_GET_BLUEPRINT: 'ipc:blueprint-get-blueprint',
} as const;

/**
 * 类型声明 — import type 在编译后被擦除，不会产生 require() 调用。
 * 运行时仅依赖 electron 的 contextBridge 和 ipcRenderer。
 */
import type {
  DesktopAPI,
  HealthCheckResponse,
  CreateProjectInput,
  CreateProjectResult,
  ListProjectsResult,
  OpenProjectResult,
  DataServiceStatusResponse,
  ProviderPublicState,
  CreateProviderProfileInput,
  UpdateProviderProfileInput,
  ProviderProfileIdInput,
  SaveApiKeyInput,
  ConnectionTestResult,
  CreateModelInvocationTestInput,
  TaskPublicData,
  TaskStatsPublicData,
  GrillCreateSessionInput,
  GrillSessionVersionInput,
  GrillAddQuestionsInput,
  GrillAnswerQuestionInput,
  GrillQuestionActionInput,
  GrillCreateProposalInput,
  GrillReviewProposalInput,
  GrillListProposalsInput,
  GrillListAnswerHistoryInput,
  GrillListQuestionsInput,
  GrillRequestQuestionPlanInput,
  GrillAcceptQuestionPlanProposalInput,
  GrillListQuestionPlanProposalsInput,
  GrillQuestionPlanProposalIdInput,
  GrillSessionPublicData,
  GrillQuestionPublicData,
  GrillAnswerPublicData,
  GrillProposalPublicData,
  GrillRequestQuestionPlanResult,
  GrillQuestionPlanProposalPublicData,
  GetCurrentCreationContractInput,
  ListCreationContractVersionsInput,
  GetCreationContractProposalInput,
  ListCreationContractProposalsInput,
  RequestContractDraftInput,
  RequestContractDraftResult,
  AcceptContractProposalInput,
  RejectContractProposalInput,
  UpdateContractByUserInput,
  LockContractFieldInput,
  UnlockContractFieldInput,
  ContractVersionPublicData,
  ContractVersionSummary,
  ProposalPublicData,
  CreateProjectRunInputDto,
  CreateChapterRunInputDto,
  GetRunProgressInputDto,
  ApplyHumanDecisionInputDto,
  ListRunsInputDto,
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
  GetActiveIntakeSessionInputDto,
  PropagateSpecInvalidationInputDto,
  SpecInvalidationResultDto,
  SaveSearchApiKeyInputDto,
  SearchKeyStateDto,
  GetResearchStateInputDto,
  GetResearchBundleInputDto,
  ListResearchBundlesInputDto,
  SetSourceExclusionInputDto,
  ListSourceExclusionsInputDto,
  ResearchStateDto,
  ResearchBundleDto,
  GetBlueprintStateInputDto,
  BlueprintStateDto,
  GetBlueprintInputDto,
  StoryBlueprintDto,
} from '@ai-novel/contracts';

/**
 * 通过 contextBridge 暴露最小、显式、带类型的 API 给 Renderer。
 * 不暴露 ipcRenderer 整体。
 */
const desktopAPI: DesktopAPI = {
  async healthCheck(): Promise<HealthCheckResponse> {
    return ipcRenderer.invoke(IPC_CHANNELS.HEALTH_CHECK);
  },

  async getDataServiceStatus(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-status');
  },

  async retryDataService(): Promise<DataServiceStatusResponse> {
    return ipcRenderer.invoke('ipc:data-service-retry');
  },

  projects: {
    async create(input: CreateProjectInput): Promise<CreateProjectResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input);
    },

    async list(): Promise<ListProjectsResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST);
    },

    async open(projectId: string): Promise<OpenProjectResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, projectId);
    },
  },

  provider: {
    async list(): Promise<ReadonlyArray<ProviderPublicState>> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST);
    },

    async create(input: CreateProviderProfileInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_CREATE, input);
    },

    async update(input: UpdateProviderProfileInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_UPDATE, input);
    },

    async remove(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE, input);
    },

    async setDefault(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SET_DEFAULT, input);
    },

    async saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_API_KEY, input);
    },

    async deleteApiKey(input: ProviderProfileIdInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE_API_KEY, input);
    },

    async testConnection(input: ProviderProfileIdInput): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_TEST_CONNECTION, input);
    },
  },

  tasks: {
    async createModelInvocationTest(
      input: CreateModelInvocationTestInput,
    ): Promise<TaskPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE_MODEL_INVOCATION_TEST, input);
    },

    async get(projectId: string, taskId: string): Promise<TaskPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, { projectId, taskId });
    },

    async list(projectId: string): Promise<ReadonlyArray<TaskPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST, { projectId });
    },

    async getStats(projectId: string): Promise<TaskStatsPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_STATS, { projectId });
    },
  },

  grill: {
    async createSession(input: GrillCreateSessionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_CREATE_SESSION, input);
    },

    async getSession(projectId: string, sessionId: string): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_GET_SESSION, { projectId, sessionId });
    },

    async listSessions(projectId: string): Promise<ReadonlyArray<GrillSessionPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_SESSIONS, { projectId });
    },

    async listQuestions(
      input: GrillListQuestionsInput,
    ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_QUESTIONS, input);
    },

    async startSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_START_SESSION, input);
    },

    async pauseSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_PAUSE_SESSION, input);
    },

    async resumeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_RESUME_SESSION, input);
    },

    async completeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_COMPLETE_SESSION, input);
    },

    async abandonSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_ABANDON_SESSION, input);
    },

    async addQuestions(
      input: GrillAddQuestionsInput,
    ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_ADD_QUESTIONS, input);
    },

    async markQuestionAsked(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_MARK_QUESTION_ASKED, input);
    },

    async answerQuestion(input: GrillAnswerQuestionInput): Promise<GrillAnswerPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_ANSWER_QUESTION, input);
    },

    async skipQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_SKIP_QUESTION, input);
    },

    async supersedeQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_SUPERSEDE_QUESTION, input);
    },

    async getCurrentAnswers(
      projectId: string,
      sessionId: string,
    ): Promise<ReadonlyArray<GrillAnswerPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_GET_CURRENT_ANSWERS, { projectId, sessionId });
    },

    async listAnswerHistory(
      input: GrillListAnswerHistoryInput,
    ): Promise<ReadonlyArray<GrillAnswerPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_ANSWER_HISTORY, input);
    },

    async createProposal(input: GrillCreateProposalInput): Promise<GrillProposalPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_CREATE_PROPOSAL, input);
    },

    async reviewProposal(input: GrillReviewProposalInput): Promise<GrillProposalPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_REVIEW_PROPOSAL, input);
    },

    async listProposals(
      input: GrillListProposalsInput,
    ): Promise<ReadonlyArray<GrillProposalPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_PROPOSALS, input);
    },

    async requestQuestionPlan(
      input: GrillRequestQuestionPlanInput,
    ): Promise<GrillRequestQuestionPlanResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_REQUEST_QUESTION_PLAN, input);
    },

    async acceptQuestionPlanProposal(
      input: GrillAcceptQuestionPlanProposalInput,
    ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL, input);
    },

    async listQuestionPlanProposals(
      input: GrillListQuestionPlanProposalsInput,
    ): Promise<ReadonlyArray<GrillQuestionPlanProposalPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_QUESTION_PLAN_PROPOSALS, input);
    },

    async getQuestionPlanProposal(
      input: GrillQuestionPlanProposalIdInput,
    ): Promise<GrillQuestionPlanProposalPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRILL_GET_QUESTION_PLAN_PROPOSAL, input);
    },
  },

  contract: {
    async getCurrent(
      input: GetCurrentCreationContractInput,
    ): Promise<ContractVersionPublicData | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_GET_CURRENT, input);
    },

    async listVersions(
      input: ListCreationContractVersionsInput,
    ): Promise<ReadonlyArray<ContractVersionSummary>> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_LIST_VERSIONS, input);
    },

    async getProposal(input: GetCreationContractProposalInput): Promise<ProposalPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_GET_PROPOSAL, input);
    },

    async listProposals(
      input: ListCreationContractProposalsInput,
    ): Promise<ReadonlyArray<ProposalPublicData>> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_LIST_PROPOSALS, input);
    },

    async requestDraft(input: RequestContractDraftInput): Promise<RequestContractDraftResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_REQUEST_DRAFT, input);
    },

    async acceptProposal(input: AcceptContractProposalInput): Promise<ContractVersionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_ACCEPT_PROPOSAL, input);
    },

    async rejectProposal(input: RejectContractProposalInput): Promise<ProposalPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_REJECT_PROPOSAL, input);
    },

    async updateByUser(input: UpdateContractByUserInput): Promise<ContractVersionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_UPDATE_BY_USER, input);
    },

    async lockField(input: LockContractFieldInput): Promise<ContractVersionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_LOCK_FIELD, input);
    },

    async unlockField(input: UnlockContractFieldInput): Promise<ContractVersionPublicData> {
      return ipcRenderer.invoke(IPC_CHANNELS.CONTRACT_UNLOCK_FIELD, input);
    },
  },

  graph: {
    async createProjectRun(input: CreateProjectRunInputDto): Promise<GraphProgressProjectionDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRAPH_CREATE_PROJECT_RUN, input);
    },

    async createChapterRun(input: CreateChapterRunInputDto): Promise<GraphProgressProjectionDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRAPH_CREATE_CHAPTER_RUN, input);
    },

    async getRunProgress(input: GetRunProgressInputDto): Promise<GraphProgressProjectionDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRAPH_GET_RUN_PROGRESS, input);
    },

    async applyHumanDecision(
      input: ApplyHumanDecisionInputDto,
    ): Promise<GraphProgressProjectionDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRAPH_APPLY_HUMAN_DECISION, input);
    },

    async listRuns(input: ListRunsInputDto): Promise<ReadonlyArray<GraphRunSummaryDto>> {
      return ipcRenderer.invoke(IPC_CHANNELS.GRAPH_LIST_RUNS, input);
    },
  },

  intake: {
    async getActiveIntakeSession(
      input: GetActiveIntakeSessionInputDto,
    ): Promise<GrillSessionPublicData | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.INTAKE_GET_ACTIVE_SESSION, input);
    },

    async propagateSpecInvalidation(
      input: PropagateSpecInvalidationInputDto,
    ): Promise<ReadonlyArray<SpecInvalidationResultDto>> {
      return ipcRenderer.invoke(IPC_CHANNELS.INTAKE_PROPAGATE_SPEC_INVALIDATION, input);
    },
  },

  search: {
    async saveApiKey(input: SaveSearchApiKeyInputDto): Promise<SearchKeyStateDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SAVE_API_KEY, input);
    },

    async deleteApiKey(): Promise<SearchKeyStateDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_DELETE_API_KEY);
    },

    async hasApiKey(): Promise<SearchKeyStateDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_HAS_API_KEY);
    },
  },

  research: {
    async getResearchState(input: GetResearchStateInputDto): Promise<ResearchStateDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_GET_RESEARCH_STATE, input);
    },

    async getBundle(input: GetResearchBundleInputDto): Promise<ResearchBundleDto | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_GET_BUNDLE, input);
    },

    async listBundles(
      input: ListResearchBundlesInputDto,
    ): Promise<ReadonlyArray<ResearchBundleDto>> {
      return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_LIST_BUNDLES, input);
    },

    async setSourceExclusion(input: SetSourceExclusionInputDto): Promise<ReadonlyArray<string>> {
      return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_SET_SOURCE_EXCLUSION, input);
    },

    async listSourceExclusions(
      input: ListSourceExclusionsInputDto,
    ): Promise<ReadonlyArray<string>> {
      return ipcRenderer.invoke(IPC_CHANNELS.RESEARCH_LIST_SOURCE_EXCLUSIONS, input);
    },
  },

  blueprint: {
    async getState(input: GetBlueprintStateInputDto): Promise<BlueprintStateDto> {
      return ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_STATE, input);
    },
    async getBlueprint(input: GetBlueprintInputDto): Promise<StoryBlueprintDto | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_BLUEPRINT, input);
    },
  },
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
