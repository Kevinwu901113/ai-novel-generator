/**
 * Electron Main Process 入口。
 *
 * 启动顺序（不阻塞窗口）：
 * 1. app.whenReady()
 * 2. 同步创建 BrowserWindow，立即加载 Renderer
 * 3. 注册 IPC 处理器（不等待 Worker）
 * 4. 并行启动 Utility Process
 * 5. ready-to-show / did-finish-load 时显示窗口
 * 6. Worker ready 后 Renderer 可请求数据
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import {
  IPC_CHANNELS,
  isValidCreateProjectInput,
  isValidOpenProjectInput,
  isValidSaveApiKeyInput,
  isValidProviderProfileIdInput,
  isValidCreateProviderProfileInput,
  isValidUpdateProviderProfileInput,
  isValidCreateModelInvocationTestInput,
  isValidGrillCreateSessionInput,
  isValidGrillSessionIdInput,
  isValidGrillSessionVersionInput,
  isValidGrillAddQuestionsInput,
  isValidGrillAnswerQuestionInput,
  isValidGrillQuestionActionInput,
  isValidGrillCreateProposalInput,
  isValidGrillReviewProposalInput,
  isValidGrillListProposalsInput,
  isValidGrillListAnswerHistoryInput,
  isValidGrillListQuestionsInput,
  isValidGrillRequestQuestionPlanInput,
  isValidGrillAcceptQuestionPlanProposalInput,
  isValidGrillListQuestionPlanProposalsInput,
  isValidGrillQuestionPlanProposalIdInput,
  isValidGetCurrentCreationContractInput,
  isValidListCreationContractVersionsInput,
  isValidGetCreationContractProposalInput,
  isValidListCreationContractProposalsInput,
  isValidRequestContractDraftInput,
  isValidAcceptContractProposalInput,
  isValidRejectContractProposalInput,
  isValidUpdateContractByUserInput,
  isValidLockContractFieldInput,
  isValidUnlockContractFieldInput,
  isValidCreateProjectRunInput,
  isValidCreateChapterRunInput,
  isValidGetRunProgressInput,
  isValidApplyHumanDecisionInput,
  isValidListRunsInput,
  type HealthCheckResponse,
  type CreateProjectResult,
  type ListProjectsResult,
  type OpenProjectResult,
  type ProviderPublicState,
  type ConnectionTestResult,
  type TaskPublicData,
  type TaskStatsPublicData,
  type GrillSessionPublicData,
  type GrillQuestionPublicData,
  type GrillAnswerPublicData,
  type GrillProposalPublicData,
  type GrillRequestQuestionPlanResult,
  type GrillQuestionPlanProposalPublicData,
  type ContractVersionPublicData,
  type ContractVersionSummary,
  type ProposalPublicData,
  type RequestContractDraftResult,
  type GraphProgressProjectionDto,
  type GraphRunSummaryDto,
} from '@ai-novel/contracts';
import { mark } from './startup-timeline.js';
import { createMainWindow, getMainWindow } from './window-manager.js';
import {
  startWorker,
  shutdownWorker,
  sendToWorker,
  getWorkerStatus,
  retryWorker,
} from './worker-client.js';

mark('process-start');

const isSmokeTest = process.argv.includes('--smoke-test');

const log = (...args: unknown[]) => console.log('[main]', ...args);

// ── IPC 处理器（不等待 Worker，立即注册）──────────────────────────

/** 包装 sendToWorker 调用，确保错误码传递给 Renderer */
async function forwardToWorker(request: {
  requestId: string;
  command: string;
  payload: unknown;
}): Promise<unknown> {
  try {
    return await sendToWorker(request);
  } catch (err) {
    const code = (err as Error & { code?: string }).code || 'PROJECT_CREATE_FAILED';
    const message = err instanceof Error ? err.message : '操作失败';
    const forwarded = new Error(message) as Error & { code?: string };
    forwarded.code = code;
    throw forwarded;
  }
}

ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (): Promise<HealthCheckResponse> => {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    version: app.getVersion(),
  };
});

/** 数据服务状态查询 */
ipcMain.handle('ipc:data-service-status', async () => {
  return { status: getWorkerStatus() };
});

/** 重试数据服务 */
ipcMain.handle('ipc:data-service-retry', async () => {
  retryWorker();
  return { status: getWorkerStatus() };
});

ipcMain.handle(
  IPC_CHANNELS.PROJECT_CREATE,
  async (_event, input: unknown): Promise<CreateProjectResult> => {
    if (!isValidCreateProjectInput(input)) {
      throw Object.assign(new Error('无效的创建项目输入'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'project.create',
      payload: input,
    });

    return result as CreateProjectResult;
  },
);

ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async (): Promise<ListProjectsResult> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'project.list',
    payload: null,
  });

  return result as ListProjectsResult;
});

ipcMain.handle(
  IPC_CHANNELS.PROJECT_OPEN,
  async (_event, projectId: string): Promise<OpenProjectResult> => {
    if (!isValidOpenProjectInput({ projectId })) {
      throw Object.assign(new Error('无效的项目 ID'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'project.open',
      payload: { projectId },
    });

    return result as OpenProjectResult;
  },
);

// ── 提供商 IPC 处理器（多 provider；按 profileId 定位）───────────────

ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST, async (): Promise<ReadonlyArray<ProviderPublicState>> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'provider.list',
    payload: null,
  });

  return result as ReadonlyArray<ProviderPublicState>;
});

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_CREATE,
  async (_event, input: unknown): Promise<ProviderPublicState> => {
    if (!isValidCreateProviderProfileInput(input)) {
      throw Object.assign(new Error('无效的创建提供商配置输入'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.create',
      payload: input,
    });

    return result as ProviderPublicState;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_UPDATE,
  async (_event, input: unknown): Promise<ProviderPublicState> => {
    if (!isValidUpdateProviderProfileInput(input)) {
      throw Object.assign(new Error('无效的更新提供商配置输入'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.update',
      payload: input,
    });

    return result as ProviderPublicState;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_DELETE,
  async (_event, input: unknown): Promise<ReadonlyArray<ProviderPublicState>> => {
    if (!isValidProviderProfileIdInput(input)) {
      throw Object.assign(new Error('无效的提供商配置 ID'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.delete',
      payload: input,
    });

    return result as ReadonlyArray<ProviderPublicState>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_SET_DEFAULT,
  async (_event, input: unknown): Promise<ReadonlyArray<ProviderPublicState>> => {
    if (!isValidProviderProfileIdInput(input)) {
      throw Object.assign(new Error('无效的提供商配置 ID'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.setDefault',
      payload: input,
    });

    return result as ReadonlyArray<ProviderPublicState>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_SAVE_API_KEY,
  async (_event, input: unknown): Promise<ProviderPublicState> => {
    if (!isValidSaveApiKeyInput(input)) {
      throw Object.assign(new Error('无效的 API Key 输入'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.saveApiKey',
      payload: input,
    });

    return result as ProviderPublicState;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_DELETE_API_KEY,
  async (_event, input: unknown): Promise<ProviderPublicState> => {
    if (!isValidProviderProfileIdInput(input)) {
      throw Object.assign(new Error('无效的提供商配置 ID'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.deleteApiKey',
      payload: input,
    });

    return result as ProviderPublicState;
  },
);

ipcMain.handle(
  IPC_CHANNELS.PROVIDER_TEST_CONNECTION,
  async (_event, input: unknown): Promise<ConnectionTestResult> => {
    if (!isValidProviderProfileIdInput(input)) {
      throw Object.assign(new Error('无效的提供商配置 ID'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'provider.testConnection',
      payload: input,
    });

    return result as ConnectionTestResult;
  },
);

// ── 任务 IPC 处理器 ────────────────────────────────────────────────

ipcMain.handle(
  IPC_CHANNELS.TASK_CREATE_MODEL_INVOCATION_TEST,
  async (_event, input: unknown): Promise<TaskPublicData> => {
    if (!isValidCreateModelInvocationTestInput(input)) {
      throw Object.assign(new Error('无效的创建任务输入'), { code: 'VALIDATION_ERROR' });
    }

    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'task.createModelInvocationTest',
      payload: input,
    });

    return result as TaskPublicData;
  },
);

ipcMain.handle(IPC_CHANNELS.TASK_GET, async (_event, payload: unknown): Promise<TaskPublicData> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'task.get',
    payload,
  });

  return result as TaskPublicData;
});

ipcMain.handle(
  IPC_CHANNELS.TASK_LIST,
  async (_event, payload: unknown): Promise<ReadonlyArray<TaskPublicData>> => {
    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'task.list',
      payload,
    });

    return result as ReadonlyArray<TaskPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.TASK_GET_STATS,
  async (_event, payload: unknown): Promise<TaskStatsPublicData> => {
    const requestId = crypto.randomUUID();
    const result = await forwardToWorker({
      requestId,
      command: 'task.getStats',
      payload,
    });

    return result as TaskStatsPublicData;
  },
);

// ── Grill-me IPC 处理器 ──────────────────────────────────────────────

ipcMain.handle(
  IPC_CHANNELS.GRILL_CREATE_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillCreateSessionInput(input)) {
      throw Object.assign(new Error('无效的创建会话输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.createSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_GET_SESSION,
  async (_event, payload: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionIdInput(payload)) {
      throw Object.assign(new Error('无效的会话查询输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.getSession',
      payload,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_LIST_SESSIONS,
  async (_event, payload: unknown): Promise<ReadonlyArray<GrillSessionPublicData>> => {
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.listSessions',
      payload,
    })) as ReadonlyArray<GrillSessionPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_LIST_QUESTIONS,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillQuestionPublicData>> => {
    if (!isValidGrillListQuestionsInput(input)) {
      throw Object.assign(new Error('无效的问题列表输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.listQuestions',
      payload: input,
    })) as ReadonlyArray<GrillQuestionPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_START_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionVersionInput(input)) {
      throw Object.assign(new Error('无效的会话操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.startSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_PAUSE_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionVersionInput(input)) {
      throw Object.assign(new Error('无效的会话操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.pauseSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_RESUME_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionVersionInput(input)) {
      throw Object.assign(new Error('无效的会话操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.resumeSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_COMPLETE_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionVersionInput(input)) {
      throw Object.assign(new Error('无效的会话操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.completeSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_ABANDON_SESSION,
  async (_event, input: unknown): Promise<GrillSessionPublicData> => {
    if (!isValidGrillSessionVersionInput(input)) {
      throw Object.assign(new Error('无效的会话操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.abandonSession',
      payload: input,
    })) as GrillSessionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_ADD_QUESTIONS,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillQuestionPublicData>> => {
    if (!isValidGrillAddQuestionsInput(input)) {
      throw Object.assign(new Error('无效的添加问题输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.addQuestions',
      payload: input,
    })) as ReadonlyArray<GrillQuestionPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_MARK_QUESTION_ASKED,
  async (_event, input: unknown): Promise<GrillQuestionPublicData> => {
    if (!isValidGrillQuestionActionInput(input)) {
      throw Object.assign(new Error('无效的问题操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.markQuestionAsked',
      payload: input,
    })) as GrillQuestionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_ANSWER_QUESTION,
  async (_event, input: unknown): Promise<GrillAnswerPublicData> => {
    if (!isValidGrillAnswerQuestionInput(input)) {
      throw Object.assign(new Error('无效的回答问题输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.answerQuestion',
      payload: input,
    })) as GrillAnswerPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_SKIP_QUESTION,
  async (_event, input: unknown): Promise<GrillQuestionPublicData> => {
    if (!isValidGrillQuestionActionInput(input)) {
      throw Object.assign(new Error('无效的问题操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.skipQuestion',
      payload: input,
    })) as GrillQuestionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_SUPERSEDE_QUESTION,
  async (_event, input: unknown): Promise<GrillQuestionPublicData> => {
    if (!isValidGrillQuestionActionInput(input)) {
      throw Object.assign(new Error('无效的问题操作输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.supersedeQuestion',
      payload: input,
    })) as GrillQuestionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_GET_CURRENT_ANSWERS,
  async (_event, payload: unknown): Promise<ReadonlyArray<GrillAnswerPublicData>> => {
    if (!isValidGrillSessionIdInput(payload)) {
      throw Object.assign(new Error('无效的答案查询输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.getCurrentAnswers',
      payload,
    })) as ReadonlyArray<GrillAnswerPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_LIST_ANSWER_HISTORY,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillAnswerPublicData>> => {
    if (!isValidGrillListAnswerHistoryInput(input)) {
      throw Object.assign(new Error('无效的答案历史输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.listAnswerHistory',
      payload: input,
    })) as ReadonlyArray<GrillAnswerPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_CREATE_PROPOSAL,
  async (_event, input: unknown): Promise<GrillProposalPublicData> => {
    if (!isValidGrillCreateProposalInput(input)) {
      throw Object.assign(new Error('无效的创建提案输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.createProposal',
      payload: input,
    })) as GrillProposalPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_REVIEW_PROPOSAL,
  async (_event, input: unknown): Promise<GrillProposalPublicData> => {
    if (!isValidGrillReviewProposalInput(input)) {
      throw Object.assign(new Error('无效的审核提案输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.reviewProposal',
      payload: input,
    })) as GrillProposalPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_LIST_PROPOSALS,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillProposalPublicData>> => {
    if (!isValidGrillListProposalsInput(input)) {
      throw Object.assign(new Error('无效的提案列表输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.listProposals',
      payload: input,
    })) as ReadonlyArray<GrillProposalPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_REQUEST_QUESTION_PLAN,
  async (_event, input: unknown): Promise<GrillRequestQuestionPlanResult> => {
    if (!isValidGrillRequestQuestionPlanInput(input)) {
      throw Object.assign(new Error('无效的请求问题规划输入'), { code: 'GRILL_VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.requestQuestionPlan',
      payload: input,
    })) as GrillRequestQuestionPlanResult;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_ACCEPT_QUESTION_PLAN_PROPOSAL,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillQuestionPublicData>> => {
    if (!isValidGrillAcceptQuestionPlanProposalInput(input)) {
      throw Object.assign(new Error('无效的接受问题规划提案输入'), {
        code: 'GRILL_VALIDATION_ERROR',
      });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.acceptQuestionPlanProposal',
      payload: input,
    })) as ReadonlyArray<GrillQuestionPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_LIST_QUESTION_PLAN_PROPOSALS,
  async (_event, input: unknown): Promise<ReadonlyArray<GrillQuestionPlanProposalPublicData>> => {
    if (!isValidGrillListQuestionPlanProposalsInput(input)) {
      throw Object.assign(new Error('无效的问题规划提案列表输入'), {
        code: 'GRILL_VALIDATION_ERROR',
      });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.listQuestionPlanProposals',
      payload: input,
    })) as ReadonlyArray<GrillQuestionPlanProposalPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRILL_GET_QUESTION_PLAN_PROPOSAL,
  async (_event, input: unknown): Promise<GrillQuestionPlanProposalPublicData> => {
    if (!isValidGrillQuestionPlanProposalIdInput(input)) {
      throw Object.assign(new Error('无效的问题规划提案查询输入'), {
        code: 'GRILL_VALIDATION_ERROR',
      });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'grill.getQuestionPlanProposal',
      payload: input,
    })) as GrillQuestionPlanProposalPublicData;
  },
);

// ── 创作契约 IPC 处理器 ────────────────────────────────────────────
// Main 只做 validator + forwardToWorker，不直接打开 SQLite。

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_GET_CURRENT,
  async (_event, input: unknown): Promise<ContractVersionPublicData | null> => {
    if (!isValidGetCurrentCreationContractInput(input)) {
      throw Object.assign(new Error('无效的当前契约查询输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.getCurrent',
      payload: input,
    })) as ContractVersionPublicData | null;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_LIST_VERSIONS,
  async (_event, input: unknown): Promise<ReadonlyArray<ContractVersionSummary>> => {
    if (!isValidListCreationContractVersionsInput(input)) {
      throw Object.assign(new Error('无效的契约版本列表输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.listVersions',
      payload: input,
    })) as ReadonlyArray<ContractVersionSummary>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_GET_PROPOSAL,
  async (_event, input: unknown): Promise<ProposalPublicData> => {
    if (!isValidGetCreationContractProposalInput(input)) {
      throw Object.assign(new Error('无效的契约提案查询输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.getProposal',
      payload: input,
    })) as ProposalPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_LIST_PROPOSALS,
  async (_event, input: unknown): Promise<ReadonlyArray<ProposalPublicData>> => {
    if (!isValidListCreationContractProposalsInput(input)) {
      throw Object.assign(new Error('无效的契约提案列表输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.listProposals',
      payload: input,
    })) as ReadonlyArray<ProposalPublicData>;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_REQUEST_DRAFT,
  async (_event, input: unknown): Promise<RequestContractDraftResult> => {
    if (!isValidRequestContractDraftInput(input)) {
      throw Object.assign(new Error('无效的请求创作契约输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.requestDraft',
      payload: input,
    })) as RequestContractDraftResult;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_ACCEPT_PROPOSAL,
  async (_event, input: unknown): Promise<ContractVersionPublicData> => {
    if (!isValidAcceptContractProposalInput(input)) {
      throw Object.assign(new Error('无效的接受契约提案输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.acceptProposal',
      payload: input,
    })) as ContractVersionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_REJECT_PROPOSAL,
  async (_event, input: unknown): Promise<ProposalPublicData> => {
    if (!isValidRejectContractProposalInput(input)) {
      throw Object.assign(new Error('无效的拒绝契约提案输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.rejectProposal',
      payload: input,
    })) as ProposalPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_UPDATE_BY_USER,
  async (_event, input: unknown): Promise<ContractVersionPublicData> => {
    if (!isValidUpdateContractByUserInput(input)) {
      throw Object.assign(new Error('无效的用户更新契约输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.updateByUser',
      payload: input,
    })) as ContractVersionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_LOCK_FIELD,
  async (_event, input: unknown): Promise<ContractVersionPublicData> => {
    if (!isValidLockContractFieldInput(input)) {
      throw Object.assign(new Error('无效的锁定契约字段输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.lockField',
      payload: input,
    })) as ContractVersionPublicData;
  },
);

ipcMain.handle(
  IPC_CHANNELS.CONTRACT_UNLOCK_FIELD,
  async (_event, input: unknown): Promise<ContractVersionPublicData> => {
    if (!isValidUnlockContractFieldInput(input)) {
      throw Object.assign(new Error('无效的解锁契约字段输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'contract.unlockField',
      payload: input,
    })) as ContractVersionPublicData;
  },
);

// ── Graph Run（GE-1）──────────────────────────────────────────────

ipcMain.handle(
  IPC_CHANNELS.GRAPH_CREATE_PROJECT_RUN,
  async (_event, input: unknown): Promise<GraphProgressProjectionDto> => {
    if (!isValidCreateProjectRunInput(input)) {
      throw Object.assign(new Error('无效的创建 Project run 输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'graph.createProjectRun',
      payload: input,
    })) as GraphProgressProjectionDto;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRAPH_CREATE_CHAPTER_RUN,
  async (_event, input: unknown): Promise<GraphProgressProjectionDto> => {
    if (!isValidCreateChapterRunInput(input)) {
      throw Object.assign(new Error('无效的创建 Chapter run 输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'graph.createChapterRun',
      payload: input,
    })) as GraphProgressProjectionDto;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRAPH_GET_RUN_PROGRESS,
  async (_event, input: unknown): Promise<GraphProgressProjectionDto> => {
    if (!isValidGetRunProgressInput(input)) {
      throw Object.assign(new Error('无效的获取 run 进度输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'graph.getRunProgress',
      payload: input,
    })) as GraphProgressProjectionDto;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRAPH_APPLY_HUMAN_DECISION,
  async (_event, input: unknown): Promise<GraphProgressProjectionDto> => {
    if (!isValidApplyHumanDecisionInput(input)) {
      throw Object.assign(new Error('无效的人工决策输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'graph.applyHumanDecision',
      payload: input,
    })) as GraphProgressProjectionDto;
  },
);

ipcMain.handle(
  IPC_CHANNELS.GRAPH_LIST_RUNS,
  async (_event, input: unknown): Promise<ReadonlyArray<GraphRunSummaryDto>> => {
    if (!isValidListRunsInput(input)) {
      throw Object.assign(new Error('无效的列出 run 输入'), { code: 'VALIDATION_ERROR' });
    }
    const requestId = crypto.randomUUID();
    return (await forwardToWorker({
      requestId,
      command: 'graph.listRuns',
      payload: input,
    })) as ReadonlyArray<GraphRunSummaryDto>;
  },
);

// ── Smoke test ────────────────────────────────────────────────────

function runSmokeTest(): void {
  log('Running smoke test');
  const win = createMainWindow();
  let healthCheckReceived = false;

  const timeout = setTimeout(() => {
    if (healthCheckReceived) return;
    console.error('[smoke-test] FAIL: timed out waiting for healthCheck');
    app.exit(1);
  }, 15_000);

  ipcMain.removeHandler(IPC_CHANNELS.HEALTH_CHECK);
  ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (): Promise<HealthCheckResponse> => {
    healthCheckReceived = true;
    console.log('[smoke-test] healthCheck invoked via preload — PASS');
    clearTimeout(timeout);

    setTimeout(() => {
      console.log('[smoke-test] All checks passed, exiting');
      app.exit(0);
    }, 500);

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      version: app.getVersion(),
    };
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[smoke-test] Renderer loaded');
  });

  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[smoke-test] Renderer process gone:', details.reason);
    app.exit(1);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[smoke-test] Failed to load:', errorCode, errorDescription);
    app.exit(1);
  });
}

// ── 应用生命周期 ──────────────────────────────────────────────────

app.whenReady().then(() => {
  mark('app-ready');
  log('app ready, isSmokeTest:', isSmokeTest);

  if (isSmokeTest) {
    runSmokeTest();
    return;
  }

  // 1. 立即创建窗口（不等待 Worker）
  createMainWindow();

  // 2. 并行启动 Worker（不阻塞窗口）
  startWorker();

  // macOS activate
  app.on('activate', () => {
    log('activate event');
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      app.show();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') {
    shutdownWorker();
    app.quit();
  }
});

app.on('before-quit', () => {
  log('before-quit');
  shutdownWorker();
});
