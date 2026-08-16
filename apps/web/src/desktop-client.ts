/**
 * HTTP 版 `window.desktop` 实现（B12）。
 *
 * 结构照抄 apps/desktop/src/preload/index.ts：同一份 DesktopAPI，方法一一对应，
 * 唯一区别是每个方法不再走 `ipcRenderer.invoke(channel, arg)`，而是发一条
 * `POST /api/rpc`（apps/server/src/rpc.ts 的单一入口），请求体
 * `{command, payload}`，响应信封 `{success:true,data}` / `{success:false,error}`。
 *
 * 错误传播链对齐（关键）：
 * - Electron 旧路径：main 把 `err.code` 编进 message（`encodeErrorCode`），因为
 *   ipcMain.handle 跨 IPC 边界只传 `error.toString()`，会丢失 `.code` 自定义属性
 *   （见 apps/desktop/src/main/index.ts forwardToWorker 的注释）；renderer 侧
 *   `safe-error.ts` 的 `extractCode` 因此既读 `.code`，也从 message 里
 *   `decodeErrorCode` 兜底。
 * - HTTP 新路径：fetch → JSON.parse 不存在这种属性丢失问题——响应体本来就是
 *   `{code, message}` 两个字段的普通数据，不需要经过 Electron 那一跳序列化。
 *   这里直接把 `error.code` 挂到抛出的 Error `.code` 属性上，`safe-error.ts`
 *   的 `extractCode` 优先读 `.code`（在读 message 解码之前），因此零改动即可
 *   拿到与旧路径一致的解码结果——不需要再套一层 `encodeErrorCode`。
 */

import {
  RPC_COMMANDS,
  SERVER_COMMANDS,
  type DesktopAPI,
  type HealthCheckResponse,
  type DataServiceStatusResponse,
  type CreateProjectInput,
  type CreateProjectResult,
  type ListProjectsResult,
  type OpenProjectResult,
  type ProviderPublicState,
  type CreateProviderProfileInput,
  type UpdateProviderProfileInput,
  type ProviderProfileIdInput,
  type SaveApiKeyInput,
  type ConnectionTestResult,
  type CreateModelInvocationTestInput,
  type TaskPublicData,
  type TaskStatsPublicData,
  type GrillCreateSessionInput,
  type GrillSessionVersionInput,
  type GrillAddQuestionsInput,
  type GrillAnswerQuestionInput,
  type GrillQuestionActionInput,
  type GrillCreateProposalInput,
  type GrillReviewProposalInput,
  type GrillListProposalsInput,
  type GrillListAnswerHistoryInput,
  type GrillListQuestionsInput,
  type GrillRequestQuestionPlanInput,
  type GrillAcceptQuestionPlanProposalInput,
  type GrillListQuestionPlanProposalsInput,
  type GrillQuestionPlanProposalIdInput,
  type GrillSessionPublicData,
  type GrillQuestionPublicData,
  type GrillAnswerPublicData,
  type GrillProposalPublicData,
  type GrillRequestQuestionPlanResult,
  type GrillQuestionPlanProposalPublicData,
  type GetCurrentCreationContractInput,
  type ListCreationContractVersionsInput,
  type GetCreationContractProposalInput,
  type ListCreationContractProposalsInput,
  type RequestContractDraftInput,
  type RequestContractDraftResult,
  type AcceptContractProposalInput,
  type RejectContractProposalInput,
  type UpdateContractByUserInput,
  type LockContractFieldInput,
  type UnlockContractFieldInput,
  type ContractVersionPublicData,
  type ContractVersionSummary,
  type ProposalPublicData,
  type CreateProjectRunInputDto,
  type CreateChapterRunInputDto,
  type GetRunProgressInputDto,
  type ApplyHumanDecisionInputDto,
  type ListRunsInputDto,
  type GraphProgressProjectionDto,
  type GraphRunSummaryDto,
  type GetActiveIntakeSessionInputDto,
  type PropagateSpecInvalidationInputDto,
  type SpecInvalidationResultDto,
  type SaveSearchApiKeyInputDto,
  type SearchKeyStateDto,
  type GetResearchStateInputDto,
  type GetResearchBundleInputDto,
  type ListResearchBundlesInputDto,
  type SetSourceExclusionInputDto,
  type ListSourceExclusionsInputDto,
  type ResearchStateDto,
  type ResearchBundleDto,
  type GetBlueprintStateInputDto,
  type BlueprintStateDto,
  type GetBlueprintInputDto,
  type StoryBlueprintDto,
  type GetChapterOverviewInputDto,
  type ChapterOverviewDto,
  type StartChapterRunInputDto,
  type ChapterRunStateDto,
  type GetChapterRunStateInputDto,
  type SubmitChapterDecisionInputDto,
  type GetManuscriptWorkspaceInputDto,
  type ManuscriptWorkspaceDto,
  type GetManuscriptChapterInputDto,
  type ManuscriptChapterDetailDto,
  type SaveManuscriptChapterInputDto,
  type ExportManuscriptInputDto,
  type ExportManuscriptResultDto,
  type ListManuscriptVersionsInputDto,
  type ManuscriptVersionSummaryDto,
  type RestoreManuscriptVersionInputDto,
  type ChapterDraftDto,
  type SaveChapterDraftInputDto,
  type GetChapterDraftInputDto,
  type DiscardChapterDraftInputDto,
} from '@ai-novel/contracts';

/** localStorage 存放访问令牌的 key（TokenGate 写入，本模块每次请求时读取）。 */
export const AUTH_TOKEN_STORAGE_KEY = 'ai-novel.auth-token';

/** token 失效（401）时派发的事件名——TokenGate 监听它回到令牌录入页。 */
export const AUTH_REQUIRED_EVENT = 'ai-novel:auth-required';

function readToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearTokenAndNotifyAuthRequired(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // localStorage 不可用：没有 token 可清，跳过
  }
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

/**
 * 构造一个与信封 `{code,message}` 语义一致的 Error。
 * `.code` 属性挂载后，`safe-error.ts` 的 `extractCode` 会优先命中它。
 */
function rpcError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

interface RpcEnvelopeShape {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function isRpcEnvelope(value: unknown): value is RpcEnvelopeShape {
  return typeof value === 'object' && value !== null && 'success' in value;
}

/**
 * 单一 RPC 发送函数。所有 DesktopAPI 方法最终都经它。
 *
 * `payload` 传 `undefined` 时，`JSON.stringify` 会省略该字段——四个"无 payload"
 * 命令（project.list / provider.list / search.deleteApiKey / search.hasApiKey）
 * 据此满足服务端"payload 必须是 undefined/null"的要求。
 */
async function rpcRequest(command: string, payload?: unknown): Promise<unknown> {
  const token = readToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch('/api/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command, payload }),
    });
  } catch {
    // 网络失败（服务未启动/断网等）：与信封 error 相同的构造路径，兜底码。
    throw rpcError('WORKER_UNAVAILABLE', '无法连接数据服务');
  }

  if (response.status === 401) {
    clearTokenAndNotifyAuthRequired();
    throw rpcError('UNAUTHORIZED', '访问令牌缺失或无效');
  }

  if (!response.ok) {
    // 403/404/405/413/400 等传输层错误：不尝试解析具体业务码，统一走
    // WORKER_UNAVAILABLE（这些状态码本就意味着请求没有到达业务层）。
    throw rpcError('WORKER_UNAVAILABLE', '数据服务不可用');
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw rpcError('WORKER_UNAVAILABLE', '响应格式无效');
  }

  if (!isRpcEnvelope(envelope) || envelope.success !== true) {
    const error = isRpcEnvelope(envelope) ? envelope.error : undefined;
    const code = typeof error?.code === 'string' ? error.code : 'WORKER_UNAVAILABLE';
    const message = typeof error?.message === 'string' ? error.message : '操作失败';
    throw rpcError(code, message);
  }

  return envelope.data;
}

/** 构造浏览器端 `window.desktop` 实现：每个方法把参数包装为 RPC payload 并发请求。 */
export function createDesktopClient(): DesktopAPI {
  return {
    async healthCheck(): Promise<HealthCheckResponse> {
      return (await rpcRequest(SERVER_COMMANDS.HEALTH_CHECK)) as HealthCheckResponse;
    },

    async getDataServiceStatus(): Promise<DataServiceStatusResponse> {
      try {
        return (await rpcRequest(SERVER_COMMANDS.DATA_SERVICE_STATUS)) as DataServiceStatusResponse;
      } catch (err) {
        // 例外：网络失败/传输层错误不抛出，复用 renderer 现成的 disconnected UI 分支。
        // 401（token 失效）仍需正常抛出——clearToken + auth-required 事件已在
        // rpcRequest 内触发，调用方（App 轮询）按现状把它当失败处理即可。
        if (
          err instanceof Error &&
          (err as Error & { code?: string }).code === 'WORKER_UNAVAILABLE'
        ) {
          return { status: 'disconnected' };
        }
        throw err;
      }
    },

    async retryDataService(): Promise<DataServiceStatusResponse> {
      return (await rpcRequest(SERVER_COMMANDS.DATA_SERVICE_RETRY)) as DataServiceStatusResponse;
    },

    projects: {
      async create(input: CreateProjectInput): Promise<CreateProjectResult> {
        return (await rpcRequest(RPC_COMMANDS.PROJECT_CREATE, input)) as CreateProjectResult;
      },

      async list(): Promise<ListProjectsResult> {
        return (await rpcRequest(RPC_COMMANDS.PROJECT_LIST)) as ListProjectsResult;
      },

      async open(projectId: string): Promise<OpenProjectResult> {
        return (await rpcRequest(RPC_COMMANDS.PROJECT_OPEN, { projectId })) as OpenProjectResult;
      },
    },

    provider: {
      async list(): Promise<ReadonlyArray<ProviderPublicState>> {
        return (await rpcRequest(RPC_COMMANDS.PROVIDER_LIST)) as ReadonlyArray<ProviderPublicState>;
      },

      async create(input: CreateProviderProfileInput): Promise<ProviderPublicState> {
        return (await rpcRequest(RPC_COMMANDS.PROVIDER_CREATE, input)) as ProviderPublicState;
      },

      async update(input: UpdateProviderProfileInput): Promise<ProviderPublicState> {
        return (await rpcRequest(RPC_COMMANDS.PROVIDER_UPDATE, input)) as ProviderPublicState;
      },

      async remove(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>> {
        return (await rpcRequest(
          RPC_COMMANDS.PROVIDER_DELETE,
          input,
        )) as ReadonlyArray<ProviderPublicState>;
      },

      async setDefault(input: ProviderProfileIdInput): Promise<ReadonlyArray<ProviderPublicState>> {
        return (await rpcRequest(
          RPC_COMMANDS.PROVIDER_SET_DEFAULT,
          input,
        )) as ReadonlyArray<ProviderPublicState>;
      },

      async saveApiKey(input: SaveApiKeyInput): Promise<ProviderPublicState> {
        return (await rpcRequest(RPC_COMMANDS.PROVIDER_SAVE_API_KEY, input)) as ProviderPublicState;
      },

      async deleteApiKey(input: ProviderProfileIdInput): Promise<ProviderPublicState> {
        return (await rpcRequest(
          RPC_COMMANDS.PROVIDER_DELETE_API_KEY,
          input,
        )) as ProviderPublicState;
      },

      async testConnection(input: ProviderProfileIdInput): Promise<ConnectionTestResult> {
        return (await rpcRequest(
          RPC_COMMANDS.PROVIDER_TEST_CONNECTION,
          input,
        )) as ConnectionTestResult;
      },
    },

    tasks: {
      async createModelInvocationTest(
        input: CreateModelInvocationTestInput,
      ): Promise<TaskPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.TASK_CREATE_MODEL_INVOCATION_TEST,
          input,
        )) as TaskPublicData;
      },

      async get(projectId: string, taskId: string): Promise<TaskPublicData> {
        return (await rpcRequest(RPC_COMMANDS.TASK_GET, {
          projectId,
          taskId,
        })) as TaskPublicData;
      },

      async list(projectId: string): Promise<ReadonlyArray<TaskPublicData>> {
        return (await rpcRequest(RPC_COMMANDS.TASK_LIST, {
          projectId,
        })) as ReadonlyArray<TaskPublicData>;
      },

      async getStats(projectId: string): Promise<TaskStatsPublicData> {
        return (await rpcRequest(RPC_COMMANDS.TASK_GET_STATS, {
          projectId,
        })) as TaskStatsPublicData;
      },
    },

    grill: {
      async createSession(input: GrillCreateSessionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_CREATE_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async getSession(projectId: string, sessionId: string): Promise<GrillSessionPublicData> {
        return (await rpcRequest(RPC_COMMANDS.GRILL_GET_SESSION, {
          projectId,
          sessionId,
        })) as GrillSessionPublicData;
      },

      async listSessions(projectId: string): Promise<ReadonlyArray<GrillSessionPublicData>> {
        return (await rpcRequest(RPC_COMMANDS.GRILL_LIST_SESSIONS, {
          projectId,
        })) as ReadonlyArray<GrillSessionPublicData>;
      },

      async listQuestions(
        input: GrillListQuestionsInput,
      ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_LIST_QUESTIONS,
          input,
        )) as ReadonlyArray<GrillQuestionPublicData>;
      },

      async startSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_START_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async pauseSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_PAUSE_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async resumeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_RESUME_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async completeSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_COMPLETE_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async abandonSession(input: GrillSessionVersionInput): Promise<GrillSessionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_ABANDON_SESSION,
          input,
        )) as GrillSessionPublicData;
      },

      async addQuestions(
        input: GrillAddQuestionsInput,
      ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_ADD_QUESTIONS,
          input,
        )) as ReadonlyArray<GrillQuestionPublicData>;
      },

      async markQuestionAsked(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_MARK_QUESTION_ASKED,
          input,
        )) as GrillQuestionPublicData;
      },

      async answerQuestion(input: GrillAnswerQuestionInput): Promise<GrillAnswerPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_ANSWER_QUESTION,
          input,
        )) as GrillAnswerPublicData;
      },

      async skipQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_SKIP_QUESTION,
          input,
        )) as GrillQuestionPublicData;
      },

      async supersedeQuestion(input: GrillQuestionActionInput): Promise<GrillQuestionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_SUPERSEDE_QUESTION,
          input,
        )) as GrillQuestionPublicData;
      },

      async getCurrentAnswers(
        projectId: string,
        sessionId: string,
      ): Promise<ReadonlyArray<GrillAnswerPublicData>> {
        return (await rpcRequest(RPC_COMMANDS.GRILL_GET_CURRENT_ANSWERS, {
          projectId,
          sessionId,
        })) as ReadonlyArray<GrillAnswerPublicData>;
      },

      async listAnswerHistory(
        input: GrillListAnswerHistoryInput,
      ): Promise<ReadonlyArray<GrillAnswerPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_LIST_ANSWER_HISTORY,
          input,
        )) as ReadonlyArray<GrillAnswerPublicData>;
      },

      async createProposal(input: GrillCreateProposalInput): Promise<GrillProposalPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_CREATE_PROPOSAL,
          input,
        )) as GrillProposalPublicData;
      },

      async reviewProposal(input: GrillReviewProposalInput): Promise<GrillProposalPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_REVIEW_PROPOSAL,
          input,
        )) as GrillProposalPublicData;
      },

      async listProposals(
        input: GrillListProposalsInput,
      ): Promise<ReadonlyArray<GrillProposalPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_LIST_PROPOSALS,
          input,
        )) as ReadonlyArray<GrillProposalPublicData>;
      },

      async requestQuestionPlan(
        input: GrillRequestQuestionPlanInput,
      ): Promise<GrillRequestQuestionPlanResult> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_REQUEST_QUESTION_PLAN,
          input,
        )) as GrillRequestQuestionPlanResult;
      },

      async acceptQuestionPlanProposal(
        input: GrillAcceptQuestionPlanProposalInput,
      ): Promise<ReadonlyArray<GrillQuestionPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL,
          input,
        )) as ReadonlyArray<GrillQuestionPublicData>;
      },

      async listQuestionPlanProposals(
        input: GrillListQuestionPlanProposalsInput,
      ): Promise<ReadonlyArray<GrillQuestionPlanProposalPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_LIST_QUESTION_PLAN_PROPOSALS,
          input,
        )) as ReadonlyArray<GrillQuestionPlanProposalPublicData>;
      },

      async getQuestionPlanProposal(
        input: GrillQuestionPlanProposalIdInput,
      ): Promise<GrillQuestionPlanProposalPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.GRILL_GET_QUESTION_PLAN_PROPOSAL,
          input,
        )) as GrillQuestionPlanProposalPublicData;
      },
    },

    contract: {
      async getCurrent(
        input: GetCurrentCreationContractInput,
      ): Promise<ContractVersionPublicData | null> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_GET_CURRENT,
          input,
        )) as ContractVersionPublicData | null;
      },

      async listVersions(
        input: ListCreationContractVersionsInput,
      ): Promise<ReadonlyArray<ContractVersionSummary>> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_LIST_VERSIONS,
          input,
        )) as ReadonlyArray<ContractVersionSummary>;
      },

      async getProposal(input: GetCreationContractProposalInput): Promise<ProposalPublicData> {
        return (await rpcRequest(RPC_COMMANDS.CONTRACT_GET_PROPOSAL, input)) as ProposalPublicData;
      },

      async listProposals(
        input: ListCreationContractProposalsInput,
      ): Promise<ReadonlyArray<ProposalPublicData>> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_LIST_PROPOSALS,
          input,
        )) as ReadonlyArray<ProposalPublicData>;
      },

      async requestDraft(input: RequestContractDraftInput): Promise<RequestContractDraftResult> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_REQUEST_DRAFT,
          input,
        )) as RequestContractDraftResult;
      },

      async acceptProposal(input: AcceptContractProposalInput): Promise<ContractVersionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_ACCEPT_PROPOSAL,
          input,
        )) as ContractVersionPublicData;
      },

      async rejectProposal(input: RejectContractProposalInput): Promise<ProposalPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_REJECT_PROPOSAL,
          input,
        )) as ProposalPublicData;
      },

      async updateByUser(input: UpdateContractByUserInput): Promise<ContractVersionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_UPDATE_BY_USER,
          input,
        )) as ContractVersionPublicData;
      },

      async lockField(input: LockContractFieldInput): Promise<ContractVersionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_LOCK_FIELD,
          input,
        )) as ContractVersionPublicData;
      },

      async unlockField(input: UnlockContractFieldInput): Promise<ContractVersionPublicData> {
        return (await rpcRequest(
          RPC_COMMANDS.CONTRACT_UNLOCK_FIELD,
          input,
        )) as ContractVersionPublicData;
      },
    },

    graph: {
      async createProjectRun(input: CreateProjectRunInputDto): Promise<GraphProgressProjectionDto> {
        return (await rpcRequest(
          RPC_COMMANDS.GRAPH_CREATE_PROJECT_RUN,
          input,
        )) as GraphProgressProjectionDto;
      },

      async createChapterRun(input: CreateChapterRunInputDto): Promise<GraphProgressProjectionDto> {
        return (await rpcRequest(
          RPC_COMMANDS.GRAPH_CREATE_CHAPTER_RUN,
          input,
        )) as GraphProgressProjectionDto;
      },

      async getRunProgress(input: GetRunProgressInputDto): Promise<GraphProgressProjectionDto> {
        return (await rpcRequest(
          RPC_COMMANDS.GRAPH_GET_RUN_PROGRESS,
          input,
        )) as GraphProgressProjectionDto;
      },

      async applyHumanDecision(
        input: ApplyHumanDecisionInputDto,
      ): Promise<GraphProgressProjectionDto> {
        return (await rpcRequest(
          RPC_COMMANDS.GRAPH_APPLY_HUMAN_DECISION,
          input,
        )) as GraphProgressProjectionDto;
      },

      async listRuns(input: ListRunsInputDto): Promise<ReadonlyArray<GraphRunSummaryDto>> {
        return (await rpcRequest(
          RPC_COMMANDS.GRAPH_LIST_RUNS,
          input,
        )) as ReadonlyArray<GraphRunSummaryDto>;
      },
    },

    intake: {
      async getActiveIntakeSession(
        input: GetActiveIntakeSessionInputDto,
      ): Promise<GrillSessionPublicData | null> {
        return (await rpcRequest(
          RPC_COMMANDS.INTAKE_GET_ACTIVE_SESSION,
          input,
        )) as GrillSessionPublicData | null;
      },

      async propagateSpecInvalidation(
        input: PropagateSpecInvalidationInputDto,
      ): Promise<ReadonlyArray<SpecInvalidationResultDto>> {
        return (await rpcRequest(
          RPC_COMMANDS.INTAKE_PROPAGATE_SPEC_INVALIDATION,
          input,
        )) as ReadonlyArray<SpecInvalidationResultDto>;
      },
    },

    search: {
      async saveApiKey(input: SaveSearchApiKeyInputDto): Promise<SearchKeyStateDto> {
        return (await rpcRequest(RPC_COMMANDS.SEARCH_SAVE_API_KEY, input)) as SearchKeyStateDto;
      },

      async deleteApiKey(): Promise<SearchKeyStateDto> {
        return (await rpcRequest(RPC_COMMANDS.SEARCH_DELETE_API_KEY)) as SearchKeyStateDto;
      },

      async hasApiKey(): Promise<SearchKeyStateDto> {
        return (await rpcRequest(RPC_COMMANDS.SEARCH_HAS_API_KEY)) as SearchKeyStateDto;
      },
    },

    research: {
      async getResearchState(input: GetResearchStateInputDto): Promise<ResearchStateDto> {
        return (await rpcRequest(
          RPC_COMMANDS.RESEARCH_GET_RESEARCH_STATE,
          input,
        )) as ResearchStateDto;
      },

      async getBundle(input: GetResearchBundleInputDto): Promise<ResearchBundleDto | null> {
        return (await rpcRequest(
          RPC_COMMANDS.RESEARCH_GET_BUNDLE,
          input,
        )) as ResearchBundleDto | null;
      },

      async listBundles(
        input: ListResearchBundlesInputDto,
      ): Promise<ReadonlyArray<ResearchBundleDto>> {
        return (await rpcRequest(
          RPC_COMMANDS.RESEARCH_LIST_BUNDLES,
          input,
        )) as ReadonlyArray<ResearchBundleDto>;
      },

      async setSourceExclusion(input: SetSourceExclusionInputDto): Promise<ReadonlyArray<string>> {
        return (await rpcRequest(
          RPC_COMMANDS.RESEARCH_SET_SOURCE_EXCLUSION,
          input,
        )) as ReadonlyArray<string>;
      },

      async listSourceExclusions(
        input: ListSourceExclusionsInputDto,
      ): Promise<ReadonlyArray<string>> {
        return (await rpcRequest(
          RPC_COMMANDS.RESEARCH_LIST_SOURCE_EXCLUSIONS,
          input,
        )) as ReadonlyArray<string>;
      },
    },

    blueprint: {
      async getState(input: GetBlueprintStateInputDto): Promise<BlueprintStateDto> {
        return (await rpcRequest(RPC_COMMANDS.BLUEPRINT_GET_STATE, input)) as BlueprintStateDto;
      },
      async getBlueprint(input: GetBlueprintInputDto): Promise<StoryBlueprintDto | null> {
        return (await rpcRequest(
          RPC_COMMANDS.BLUEPRINT_GET_BLUEPRINT,
          input,
        )) as StoryBlueprintDto | null;
      },
    },

    chapter: {
      async getOverview(input: GetChapterOverviewInputDto): Promise<ChapterOverviewDto> {
        return (await rpcRequest(RPC_COMMANDS.CHAPTER_GET_OVERVIEW, input)) as ChapterOverviewDto;
      },
      async startRun(input: StartChapterRunInputDto): Promise<ChapterRunStateDto> {
        return (await rpcRequest(RPC_COMMANDS.CHAPTER_START_RUN, input)) as ChapterRunStateDto;
      },
      async getRunState(input: GetChapterRunStateInputDto): Promise<ChapterRunStateDto | null> {
        return (await rpcRequest(
          RPC_COMMANDS.CHAPTER_GET_RUN_STATE,
          input,
        )) as ChapterRunStateDto | null;
      },
      async submitDecision(input: SubmitChapterDecisionInputDto): Promise<ChapterRunStateDto> {
        return (await rpcRequest(
          RPC_COMMANDS.CHAPTER_SUBMIT_DECISION,
          input,
        )) as ChapterRunStateDto;
      },
    },

    manuscript: {
      async getWorkspace(input: GetManuscriptWorkspaceInputDto): Promise<ManuscriptWorkspaceDto> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_GET_WORKSPACE,
          input,
        )) as ManuscriptWorkspaceDto;
      },
      async getChapter(
        input: GetManuscriptChapterInputDto,
      ): Promise<ManuscriptChapterDetailDto | null> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_GET_CHAPTER,
          input,
        )) as ManuscriptChapterDetailDto | null;
      },
      async saveChapter(input: SaveManuscriptChapterInputDto): Promise<ManuscriptChapterDetailDto> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_SAVE_CHAPTER,
          input,
        )) as ManuscriptChapterDetailDto;
      },
      async saveDraft(input: SaveChapterDraftInputDto): Promise<void> {
        await rpcRequest(RPC_COMMANDS.MANUSCRIPT_SAVE_DRAFT, input);
      },
      async getDraft(input: GetChapterDraftInputDto): Promise<ChapterDraftDto | null> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_GET_DRAFT,
          input,
        )) as ChapterDraftDto | null;
      },
      async discardDraft(input: DiscardChapterDraftInputDto): Promise<boolean> {
        return (await rpcRequest(RPC_COMMANDS.MANUSCRIPT_DISCARD_DRAFT, input)) as boolean;
      },
      async exportManuscript(input: ExportManuscriptInputDto): Promise<ExportManuscriptResultDto> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_EXPORT,
          input,
        )) as ExportManuscriptResultDto;
      },
      async listVersions(
        input: ListManuscriptVersionsInputDto,
      ): Promise<ReadonlyArray<ManuscriptVersionSummaryDto>> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_LIST_VERSIONS,
          input,
        )) as ReadonlyArray<ManuscriptVersionSummaryDto>;
      },
      async restoreVersion(
        input: RestoreManuscriptVersionInputDto,
      ): Promise<ManuscriptChapterDetailDto> {
        return (await rpcRequest(
          RPC_COMMANDS.MANUSCRIPT_RESTORE_VERSION,
          input,
        )) as ManuscriptChapterDetailDto;
      },
    },
  };
}
