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

// ── 提供商 IPC 处理器 ──────────────────────────────────────────────

ipcMain.handle(IPC_CHANNELS.PROVIDER_GET_STATE, async (): Promise<ProviderPublicState> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'provider.getState',
    payload: null,
  });

  return result as ProviderPublicState;
});

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

ipcMain.handle(IPC_CHANNELS.PROVIDER_DELETE_API_KEY, async (): Promise<ProviderPublicState> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'provider.deleteApiKey',
    payload: null,
  });

  return result as ProviderPublicState;
});

ipcMain.handle(IPC_CHANNELS.PROVIDER_TEST_CONNECTION, async (): Promise<ConnectionTestResult> => {
  const requestId = crypto.randomUUID();
  const result = await forwardToWorker({
    requestId,
    command: 'provider.testConnection',
    payload: null,
  });

  return result as ConnectionTestResult;
});

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
