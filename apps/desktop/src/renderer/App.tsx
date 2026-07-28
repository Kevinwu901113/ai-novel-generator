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

  // 追踪是否已加载过项目列表
  const hasLoadedProjects = useRef(false);

  // 提供商状态
  const [providerState, setProviderState] = useState<ProviderPublicState | null>(null);

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
        return true;
      } catch (err) {
        const safe = toSafeUserError(err, '创建项目失败');
        setError(safe.message);
        return false;
      }
    },
    [loadProjects],
  );

  // 打开项目
  const handleOpenProject = useCallback(
    async (projectId: string) => {
      if (isLoading || dataServiceStatus !== 'ready') return;
      setIsLoading(true);
      setError(null);

      try {
        const project = await window.desktop.projects.open(projectId);
        setCurrentProject(project);
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

  // 重试数据服务
  const handleRetry = useCallback(async () => {
    try {
      await window.desktop.retryDataService();
    } catch {
      // 忽略
    }
  }, []);

  // 新建项目按钮
  const handleNewProject = useCallback(() => {
    setCurrentProject(null);
    setError(null);
  }, []);

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
      <header className="toolbar">
        <div className="toolbar-left">
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('left')}
            title={panelState.left ? '收起项目列表' : '展开项目列表'}
          >
            ☰
          </button>
          <h1 className="app-title">AI 小说创作代理</h1>
        </div>
        <div className="toolbar-right">
          <span className={`data-service-badge ${dataServiceStatus}`}>
            {isDataServiceStarting && '⟳ 数据服务启动中…'}
            {isDataServiceReady && '● 数据服务就绪'}
            {dataServiceStatus === 'failed' && '✕ 数据服务不可用'}
            {dataServiceStatus === 'disconnected' && '✕ 数据服务已断开'}
          </span>
          <span className="dev-badge">开发模式</span>
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('right')}
            title={panelState.right ? '收起状态面板' : '展开状态面板'}
          >
            ☰
          </button>
        </div>
      </header>

      {/* 错误提示 */}
      {error && (
        <div className="global-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* 主内容区 */}
      <main className="workspace">
        {/* 左栏：项目列表 */}
        {panelState.left && (
          <aside className="panel panel-left">
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

        {/* 中栏：新建项目 / Grill 工作台 */}
        {currentProject ? (
          <section className="panel panel-center" style={{ padding: 0 }}>
            <RendererErrorBoundary label="Grill 工作台">
              <GrillWorkbench projectId={currentProject.id} />
            </RendererErrorBoundary>
          </section>
        ) : (
          <section className="panel panel-center">
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
          <aside className="panel panel-right">
            <div className="panel-header">
              <h2>状态</h2>
            </div>
            <div className="panel-content">
              <div className="status-section">
                <h3>本地存储</h3>
                <p>
                  {isDataServiceReady
                    ? 'SQLite 已就绪'
                    : isDataServiceStarting
                      ? '启动中…'
                      : '不可用'}
                </p>
              </div>
              <div className="status-section">
                <h3>数据服务</h3>
                <p>
                  {isDataServiceStarting && '启动中…'}
                  {isDataServiceReady && '正常运行'}
                  {dataServiceStatus === 'failed' && (
                    <>
                      不可用
                      <button className="btn-retry-inline" onClick={handleRetry}>
                        重试
                      </button>
                    </>
                  )}
                  {dataServiceStatus === 'disconnected' && '已断开'}
                </p>
              </div>
              <div className="status-section">
                <h3>当前阶段</h3>
                <p>{currentProject ? 'Grill-me 需求澄清' : '—'}</p>
              </div>
              <RendererErrorBoundary label="项目状态">
                <ProjectStatusRegion currentProject={currentProject} />
              </RendererErrorBoundary>

              {/* 任务活动 */}
              <div className="status-section task-center-section">
                <h3>任务活动</h3>
                <RendererErrorBoundary label="任务中心">
                  <TaskCenter projectId={currentProject?.id ?? null} />
                </RendererErrorBoundary>
              </div>

              {/* 模型服务 */}
              <div className="status-section provider-section">
                <h3>模型服务</h3>
                <RendererErrorBoundary label="模型服务">
                  <ProviderRegion
                    providerState={providerState}
                    dataServiceStatus={dataServiceStatus}
                    onSaveApiKey={handleSaveApiKey}
                    onDeleteApiKey={handleDeleteApiKey}
                    onTestConnection={handleTestConnection}
                  />
                </RendererErrorBoundary>
              </div>
            </div>
          </aside>
        )}
      </main>

      {/* 状态栏 */}
      <footer className="status-bar">
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
    </div>
  );
}
