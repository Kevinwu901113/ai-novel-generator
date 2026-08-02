import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HealthCheckResponse,
  ProjectListItem,
  OpenProjectResult,
  DataServiceStatus,
  ProviderPublicState,
} from '@ai-novel/contracts';
import { isValidHealthCheckResponse } from '@ai-novel/contracts';
import { INITIAL_PANEL_STATE, togglePanel, type PanelId, type PanelState } from './panel-state';
import { GrillWorkbench } from './grill/GrillWorkbench';
import { ManuscriptWorkbench } from './manuscript/ManuscriptWorkbench';
import { ManuscriptLeaveDialog } from './manuscript/ManuscriptLeaveDialog';
import { manuscriptHasDirty, manuscriptIsBusy } from './manuscript/manuscript-leave-guard';
import { TaskCenter } from './task-center/TaskCenter';
import { RendererErrorBoundary } from './safety/RendererErrorBoundary';
import { toSafeUserError } from './safety/safe-error';
import {
  ProjectListRegion,
  CreateProjectRegion,
  ProjectStatusRegion,
  ProviderRegion,
} from './regions';

export function App() {
  const [panelState, setPanelState] = useState<PanelState>(INITIAL_PANEL_STATE);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);

  // 数据服务状态
  const [dataServiceStatus, setDataServiceStatus] = useState<DataServiceStatus>('starting');

  // 项目状态
  const [projects, setProjects] = useState<ReadonlyArray<ProjectListItem>>([]);
  const [currentProject, setCurrentProject] = useState<OpenProjectResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 工作区视图：Grill-me / 稿件
  const [workbench, setWorkbench] = useState<'grill' | 'manuscript'>('grill');
  // 项目/工作区切换的未保存修改离开确认
  const [pendingWorkbenchLeave, setPendingWorkbenchLeave] = useState<{ run: () => void } | null>(
    null,
  );

  // 追踪是否已加载过项目列表
  const hasLoadedProjects = useRef(false);

  // 提供商状态
  const [providerState, setProviderState] = useState<ProviderPublicState | null>(null);

  // Grill 工作区焦点管理
  const grillSectionRef = useRef<HTMLElement | null>(null);
  const createSectionRef = useRef<HTMLElement | null>(null);
  const [shouldFocusGrill, setShouldFocusGrill] = useState(false);
  const [shouldFocusCreate, setShouldFocusCreate] = useState(false);

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setPanelState((prev) => togglePanel(prev, panel));
  }, []);

  // 健康检查（立即）
  useEffect(() => {
    let cancelled = false;
    async function checkHealth() {
      try {
        const result = await window.desktop.healthCheck();
        if (!cancelled && isValidHealthCheckResponse(result)) {
          setHealth(result);
        }
      } catch {
        // 不阻塞
      }
    }
    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  // 轮询数据服务状态
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const result = await window.desktop.getDataServiceStatus();
        if (cancelled) return;
        setDataServiceStatus(result.status);

        if (result.status === 'starting') {
          timer = setTimeout(poll, 500);
        }
      } catch {
        if (!cancelled) {
          setDataServiceStatus('failed');
        }
      }
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 数据服务就绪后自动加载项目列表
  const loadProjects = useCallback(async () => {
    try {
      const list = await window.desktop.projects.list();
      setProjects(list);
      hasLoadedProjects.current = true;
    } catch {
      // 列表加载失败不阻塞
    }
  }, []);

  // 加载提供商状态
  const loadProviderState = useCallback(async () => {
    try {
      const state = await window.desktop.provider.getState();
      setProviderState(state);
    } catch {
      // 提供商状态加载失败不阻塞
    }
  }, []);

  useEffect(() => {
    if (dataServiceStatus === 'ready' && !hasLoadedProjects.current) {
      void loadProjects();
    }
  }, [dataServiceStatus, loadProjects]);

  useEffect(() => {
    if (dataServiceStatus === 'ready') {
      void loadProviderState();
    }
  }, [dataServiceStatus, loadProviderState]);

  // 创建项目
  const handleCreate = useCallback(
    async (name: string, idea: string): Promise<boolean> => {
      setError(null);
      try {
        const result = await window.desktop.projects.create({ name, initialIdea: idea });
        await loadProjects();
        const project = await window.desktop.projects.open(result.id);
        setCurrentProject(project);
        // 创建成功后焦点进入 Grill 工作区
        setShouldFocusGrill(true);
        return true;
      } catch (err) {
        const safe = toSafeUserError(err, '创建项目失败');
        setError(safe.message);
        return false;
      }
    },
    [loadProjects],
  );

  // 打开项目（实际执行）
  const performOpenProject = useCallback(
    async (projectId: string) => {
      if (isLoading || dataServiceStatus !== 'ready') return;
      setIsLoading(true);
      setError(null);

      try {
        const project = await window.desktop.projects.open(projectId);
        setCurrentProject(project);
        setWorkbench('grill');
        await loadProjects();
      } catch (err) {
        const safe = toSafeUserError(err, '打开项目失败');
        setError(safe.message);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, dataServiceStatus, loadProjects],
  );

  // 切换项目 / 离开稿件工作区前检查未保存修改与进行中的 mutation
  const guardLeave = useCallback((run: () => void) => {
    if (manuscriptIsBusy()) {
      // mutation 进行中：不执行切换，不弹「放弃修改」绕过，给出安全可见反馈
      setError('稿件操作正在进行，请完成后再离开');
      return;
    }
    if (manuscriptHasDirty()) {
      setPendingWorkbenchLeave({ run });
    } else {
      run();
    }
  }, []);

  // 打开项目（带 dirty 离开守卫）
  const handleOpenProject = useCallback(
    (projectId: string) => {
      guardLeave(() => void performOpenProject(projectId));
    },
    [guardLeave, performOpenProject],
  );

  // 切换工作区视图（离开稿件工作区前检查 dirty / busy）
  const handleSwitchWorkbench = useCallback(
    (target: 'grill' | 'manuscript') => {
      if (target === workbench) return;
      if (manuscriptIsBusy()) {
        // mutation 进行中：不执行切换，给出安全可见反馈
        setError('稿件操作正在进行，请完成后再离开');
        return;
      }
      const run = () => setWorkbench(target);
      if (target === 'grill' && manuscriptHasDirty()) {
        setPendingWorkbenchLeave({ run });
      } else {
        run();
      }
    },
    [workbench],
  );

  // 重试数据服务
  const handleRetry = useCallback(async () => {
    try {
      await window.desktop.retryDataService();
    } catch {
      // 忽略
    }
  }, []);

  // 新建项目按钮（带 dirty 离开守卫）
  const handleNewProject = useCallback(() => {
    guardLeave(() => {
      setCurrentProject(null);
      setError(null);
      // 切换到新建项目时焦点进入名称输入框
      setShouldFocusCreate(true);
    });
  }, [guardLeave]);

  // 创建成功后焦点进入 Grill 工作区
  useEffect(() => {
    if (shouldFocusGrill && currentProject && grillSectionRef.current) {
      const heading = grillSectionRef.current.querySelector('h2');
      if (heading) {
        (heading as HTMLElement).setAttribute('tabindex', '-1');
        (heading as HTMLElement).focus();
      }
      setShouldFocusGrill(false);
    }
  }, [shouldFocusGrill, currentProject]);

  // 切换到新建项目时焦点进入名称输入框
  useEffect(() => {
    if (shouldFocusCreate && !currentProject && createSectionRef.current) {
      const nameInput = createSectionRef.current.querySelector<HTMLInputElement>('#project-name');
      if (nameInput) {
        nameInput.focus();
      }
      setShouldFocusCreate(false);
    }
  }, [shouldFocusCreate, currentProject]);

  // Provider 操作
  const handleSaveApiKey = useCallback(async (apiKey: string) => {
    const state = await window.desktop.provider.saveApiKey({ apiKey });
    setProviderState(state);
  }, []);

  const handleDeleteApiKey = useCallback(async () => {
    const state = await window.desktop.provider.deleteApiKey();
    setProviderState(state);
  }, []);

  const handleTestConnection = useCallback(async () => {
    try {
      await window.desktop.provider.testConnection();
    } finally {
      await loadProviderState();
    }
  }, [loadProviderState]);

  const isDataServiceReady = dataServiceStatus === 'ready';
  const isDataServiceStarting = dataServiceStatus === 'starting';

  return (
    <div className="app">
      {/* 顶部工具栏 */}
      <header className="toolbar" role="banner">
        <nav className="toolbar-left" aria-label="面板控制">
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('left')}
            aria-label={panelState.left ? '收起项目列表' : '展开项目列表'}
            aria-expanded={panelState.left}
            aria-controls="panel-left"
          >
            ☰
          </button>
          <h1 className="app-title">AI 小说创作代理</h1>
        </nav>
        <div className="toolbar-right">
          <span
            className={`data-service-badge ${dataServiceStatus}`}
            role="status"
            aria-live="polite"
          >
            {isDataServiceStarting && '⟳ 数据服务启动中…'}
            {isDataServiceReady && '● 数据服务就绪'}
            {dataServiceStatus === 'failed' && '✕ 数据服务不可用'}
            {dataServiceStatus === 'disconnected' && '✕ 数据服务已断开'}
          </span>
          <span className="dev-badge" aria-hidden="true">
            开发模式
          </span>
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('right')}
            aria-label={panelState.right ? '收起状态面板' : '展开状态面板'}
            aria-expanded={panelState.right}
            aria-controls="panel-right"
          >
            ☰
          </button>
        </div>
      </header>

      {/* 错误提示 */}
      {error && (
        <div className="global-error" role="alert" aria-live="assertive">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      {/* 主内容区 */}
      <main className="workspace">
        {/* 左栏：项目列表 */}
        {panelState.left && (
          <aside id="panel-left" className="panel panel-left" aria-label="项目列表">
            <RendererErrorBoundary label="项目列表">
              <ProjectListRegion
                dataServiceStatus={dataServiceStatus}
                projects={projects}
                currentProjectId={currentProject?.id ?? null}
                onRetry={handleRetry}
                onNewProject={handleNewProject}
                onOpenProject={handleOpenProject}
              />
            </RendererErrorBoundary>
          </aside>
        )}

        {/* 中栏：新建项目 / 项目工作区（Grill 或稿件） */}
        {currentProject ? (
          <section
            ref={grillSectionRef}
            className="panel panel-center"
            style={{ padding: 0 }}
            aria-label="项目工作区"
          >
            <div className="workbench-tabs" role="tablist" aria-label="工作区">
              <button
                type="button"
                role="tab"
                aria-selected={workbench === 'grill'}
                aria-controls="workbench-grill"
                onClick={() => handleSwitchWorkbench('grill')}
              >
                Grill-me
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workbench === 'manuscript'}
                aria-controls="workbench-manuscript"
                onClick={() => handleSwitchWorkbench('manuscript')}
              >
                稿件
              </button>
            </div>
            {workbench === 'grill' ? (
              <div
                id="workbench-grill"
                className="workbench-pane"
                role="tabpanel"
                aria-label="Grill 工作台"
              >
                <RendererErrorBoundary label="Grill 工作台">
                  <GrillWorkbench projectId={currentProject.id} />
                </RendererErrorBoundary>
              </div>
            ) : (
              <div
                id="workbench-manuscript"
                className="workbench-pane"
                role="tabpanel"
                aria-label="稿件工作台"
              >
                <RendererErrorBoundary label="稿件工作台">
                  <ManuscriptWorkbench projectId={currentProject.id} />
                </RendererErrorBoundary>
              </div>
            )}
          </section>
        ) : (
          <section ref={createSectionRef} className="panel panel-center" aria-label="新建项目">
            <RendererErrorBoundary label="新建项目">
              <CreateProjectRegion
                dataServiceStatus={dataServiceStatus}
                onRetry={handleRetry}
                onCreate={handleCreate}
              />
            </RendererErrorBoundary>
          </section>
        )}

        {/* 右栏：状态 */}
        {panelState.right && (
          <aside id="panel-right" className="panel panel-right" aria-label="状态面板">
            <div className="panel-header">
              <h2 id="status-heading">状态</h2>
            </div>
            <div className="panel-content">
              <section className="status-section" aria-labelledby="status-local-heading">
                <h3 id="status-local-heading">本地存储</h3>
                <p>
                  {isDataServiceReady
                    ? 'SQLite 已就绪'
                    : isDataServiceStarting
                      ? '启动中…'
                      : '不可用'}
                </p>
              </section>
              <section className="status-section" aria-labelledby="status-service-heading">
                <h3 id="status-service-heading">数据服务</h3>
                <p>
                  {isDataServiceStarting && '启动中…'}
                  {isDataServiceReady && '正常运行'}
                  {dataServiceStatus === 'failed' && (
                    <>
                      不可用
                      <button
                        className="btn-retry-inline"
                        onClick={handleRetry}
                        aria-label="重试数据服务"
                      >
                        重试
                      </button>
                    </>
                  )}
                  {dataServiceStatus === 'disconnected' && '已断开'}
                </p>
              </section>
              <section className="status-section" aria-labelledby="status-stage-heading">
                <h3 id="status-stage-heading">当前阶段</h3>
                <p>{currentProject ? 'Grill-me 需求澄清' : '—'}</p>
              </section>
              <RendererErrorBoundary label="项目状态">
                <ProjectStatusRegion currentProject={currentProject} />
              </RendererErrorBoundary>

              {/* 任务活动 */}
              <section
                className="status-section task-center-section"
                aria-labelledby="task-center-heading"
              >
                <h3 id="task-center-heading">任务活动</h3>
                <RendererErrorBoundary label="任务中心">
                  <TaskCenter projectId={currentProject?.id ?? null} />
                </RendererErrorBoundary>
              </section>

              {/* 模型服务 */}
              <section
                className="status-section provider-section"
                aria-labelledby="provider-heading"
              >
                <h3 id="provider-heading">模型服务</h3>
                <RendererErrorBoundary label="模型服务">
                  <ProviderRegion
                    providerState={providerState}
                    dataServiceStatus={dataServiceStatus}
                    onSaveApiKey={handleSaveApiKey}
                    onDeleteApiKey={handleDeleteApiKey}
                    onTestConnection={handleTestConnection}
                  />
                </RendererErrorBoundary>
              </section>
            </div>
          </aside>
        )}
      </main>

      {/* 状态栏 */}
      <footer className="status-bar" role="contentinfo">
        <div className="status-left">
          <span className="status-item">桌面服务：{health?.ok ? '正常' : '检查中...'}</span>
          {health && <span className="status-item">版本：{health.version}</span>}
        </div>
        <div className="status-right">
          {health && (
            <span className="status-item">
              最后检查：{new Date(health.timestamp).toLocaleTimeString('zh-CN')}
            </span>
          )}
        </div>
      </footer>

      {/* 项目/工作区切换的未保存修改离开确认 */}
      {pendingWorkbenchLeave && (
        <ManuscriptLeaveDialog
          title="未保存的修改"
          message="当前稿件有未保存的修改，离开后将丢失这些修改。"
          onContinue={() => setPendingWorkbenchLeave(null)}
          onDiscard={() => {
            const action = pendingWorkbenchLeave;
            setPendingWorkbenchLeave(null);
            action.run();
          }}
        />
      )}
    </div>
  );
}
