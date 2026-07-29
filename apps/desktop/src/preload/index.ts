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
  PROVIDER_GET_STATE: 'ipc:provider-get-state',
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
    async getState(): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_GET_STATE);
    },

    async saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_API_KEY, input);
    },

    async deleteApiKey(): Promise<ProviderPublicState> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE_API_KEY);
    },

    async testConnection(): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_TEST_CONNECTION);
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
};

contextBridge.exposeInMainWorld('desktop', desktopAPI);
