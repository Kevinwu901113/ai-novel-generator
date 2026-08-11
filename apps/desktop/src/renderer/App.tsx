import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HealthCheckResponse,
  ProjectListItem,
  OpenProjectResult,
  DataServiceStatus,
  ProviderPublicState,
  CreateProviderProfileInput,
} from '@ai-novel/contracts';
import { isValidHealthCheckResponse } from '@ai-novel/contracts';
import { INITIAL_PANEL_STATE, togglePanel, type PanelId, type PanelState } from './panel-state';
// B4：旧 Grill 工作台从默认入口移除（代码保留，见 grill/GrillWorkbench.tsx）
import { IntakeRegion } from './intake/IntakeRegion';
import { JourneyNav } from './journey/JourneyNav';
import { JOURNEY_STAGES, type JourneyStage } from './intake/intake-logic';
import { TaskCenter } from './task-center/TaskCenter';
import { ResearchRegion } from './research/ResearchRegion';
import { SearchKeyPanel } from './research/SearchKeyPanel';
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

  // 模型服务列表
  const [providers, setProviders] = useState<ReadonlyArray<ProviderPublicState>>([]);

  // 旅程阶段（D-B4-1：由 IntakeRegion 从 Graph 进度投影回报，仅展示用）
  const [journeyStage, setJourneyStage] = useState<JourneyStage>('idea');

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

  // 加载模型服务列表
  const loadProviders = useCallback(async () => {
    try {
      const list = await window.desktop.provider.list();
      setProviders(list);
    } catch {
      // 模型服务列表加载失败不阻塞
    }
  }, []);

  useEffect(() => {
    if (dataServiceStatus === 'ready' && !hasLoadedProjects.current) {
      void loadProjects();
    }
  }, [dataServiceStatus, loadProjects]);

  useEffect(() => {
    if (dataServiceStatus === 'ready') {
      void loadProviders();
    }
  }, [dataServiceStatus, loadProviders]);

  // 创建项目
  const handleCreate = useCallback(
    async (name: string, idea: string): Promise<boolean> => {
      setError(null);
      try {
        const result = await window.desktop.projects.create({ name, initialIdea: idea });
        await loadProjects();
        const project = await window.desktop.projects.open(result.id);
        setCurrentProject(project);
        // 新项目从旅程起点开始（B6：避免沿用上一个项目遗留的 journeyStage
        // 导致中栏短暂挂错 Region，即便自纠正也会闪烁）
        setJourneyStage('idea');
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

  // 打开项目
  const handleOpenProject = useCallback(
    async (projectId: string) => {
      if (isLoading || dataServiceStatus !== 'ready') return;
      setIsLoading(true);
      setError(null);

      try {
        const project = await window.desktop.projects.open(projectId);
        setCurrentProject(project);
        // 打开项目从旅程起点开始（B6：同上，各 Region 会据 Graph 进度自纠正）
        setJourneyStage('idea');
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
    // 切换到新建项目时焦点进入名称输入框
    setShouldFocusCreate(true);
  }, []);

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

  // 模型服务操作
  const handleCreateProvider = useCallback(
    async (input: CreateProviderProfileInput) => {
      await window.desktop.provider.create(input);
      await loadProviders();
    },
    [loadProviders],
  );

  const handleSetDefaultProvider = useCallback(async (profileId: string) => {
    const list = await window.desktop.provider.setDefault({ profileId });
    setProviders(list);
  }, []);

  const handleRemoveProvider = useCallback(async (profileId: string) => {
    const list = await window.desktop.provider.remove({ profileId });
    setProviders(list);
  }, []);

  const handleSaveApiKey = useCallback(async (profileId: string, apiKey: string) => {
    const state = await window.desktop.provider.saveApiKey({ profileId, apiKey });
    setProviders((prev) => prev.map((p) => (p.id === state.id ? state : p)));
  }, []);

  const handleDeleteApiKey = useCallback(async (profileId: string) => {
    const state = await window.desktop.provider.deleteApiKey({ profileId });
    setProviders((prev) => prev.map((p) => (p.id === state.id ? state : p)));
  }, []);

  const handleTestConnection = useCallback(
    async (profileId: string) => {
      try {
        await window.desktop.provider.testConnection({ profileId });
      } finally {
        await loadProviders();
      }
    },
    [loadProviders],
  );

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

        {/* 中栏：新建项目 / 创作旅程（B4：对话式访谈替换 Grill 工作台默认入口） */}
        {currentProject ? (
          <section
            ref={grillSectionRef}
            className="panel panel-center"
            style={{ padding: 0 }}
            aria-label="创作旅程"
          >
            <RendererErrorBoundary label="创作旅程">
              <JourneyNav current={journeyStage} />
              {/* D-B6-7：中栏按 journeyStage 互斥挂载——任一时刻只有一条轮询循环。
                  idea/clarify → IntakeRegion；research → ResearchRegion。
                  blueprint/manuscript 尚未建区域，沿用 IntakeRegion 的通用
                  "beyond-intake" 占位（其自身相位机器会给出正确文案）。 */}
              {journeyStage === 'research' ? (
                <ResearchRegion
                  key={currentProject.id}
                  projectId={currentProject.id}
                  onStageChange={setJourneyStage}
                />
              ) : (
                <IntakeRegion
                  key={currentProject.id}
                  projectId={currentProject.id}
                  onStageChange={setJourneyStage}
                />
              )}
            </RendererErrorBoundary>
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
                <p>
                  {currentProject
                    ? (JOURNEY_STAGES.find((s) => s.id === journeyStage)?.label ?? '—')
                    : '—'}
                </p>
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
                    providers={providers}
                    dataServiceStatus={dataServiceStatus}
                    onCreate={handleCreateProvider}
                    onSetDefault={handleSetDefaultProvider}
                    onRemove={handleRemoveProvider}
                    onSaveApiKey={handleSaveApiKey}
                    onDeleteApiKey={handleDeleteApiKey}
                    onTestConnection={handleTestConnection}
                  />
                </RendererErrorBoundary>
              </section>

              {/* 搜索服务（Tavily，B6：D-B6-5 全局单槽位，与模型服务并列） */}
              <section
                className="status-section search-key-section"
                aria-labelledby="search-key-heading"
              >
                <h3 id="search-key-heading">搜索服务</h3>
                <RendererErrorBoundary label="搜索服务">
                  <SearchKeyPanel dataServiceStatus={dataServiceStatus} />
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
    </div>
  );
}
