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
import {
  advanceMaxFrontierStage,
  deriveViewStage,
  reachedStagesUpTo,
  stageIndex,
} from './journey/journey-logic';
import { useJourney } from './journey/useJourney';
import { BlueprintRegion } from './blueprint/BlueprintRegion';
import { hasActiveBlueprintGenerate } from './blueprint/blueprint-logic';
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

  // 旅程阶段。
  // B6 REWORK 复查 D-B6-10：展示阶段（viewStage，决定中栏挂载哪个 Region）与
  // 推进阶段（frontierStage，Graph 真实位置，JourneyNav 标示进度）分离——
  // 若中栏挂载单纯 follow frontierStage，调研刚有结果的那一刻，frontier 往往
  // 已经在同一状态快照内推进到 blueprint（sync 节点连推），ResearchRegion 会
  // 被立即卸载换回 IntakeRegion，调研结果永不可达（已坐实 blocker）。
  // B8/D-B8-2：frontierStage 不再由挂载中的 Region 经 onStageChange 回报，改由
  // App 自持的旅程探针（useJourney）独立计算——旧结构在"没有 Region 该被挂载"
  // 时（未实现阶段、以及 run 终态 activeNodes 恒空）阶段无人回报，已连续产生
  // 两条同质 blocker（D-B6-10 与 D-B8-3）。
  const journey = useJourney(currentProject?.id ?? null);
  const frontierStage = journey.frontierStage;
  // 历史最远 frontier（单调增长，切项目重置）：推导"已到达阶段"集合，
  // 决定 JourneyNav 上哪些阶段可点击回看。
  const [maxFrontierStage, setMaxFrontierStage] = useState<JourneyStage>('idea');
  // 用户在 JourneyNav 上显式点选的阶段（用户意图优先于 frontier，见
  // journey-logic.deriveViewStage）；未点选或切项目后重置为 null。
  const [userSelectedStage, setUserSelectedStage] = useState<JourneyStage | null>(null);

  // Grill 工作区焦点管理
  const grillSectionRef = useRef<HTMLElement | null>(null);
  const createSectionRef = useRef<HTMLElement | null>(null);
  const [shouldFocusGrill, setShouldFocusGrill] = useState(false);
  const [shouldFocusCreate, setShouldFocusCreate] = useState(false);

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setPanelState((prev) => togglePanel(prev, panel));
  }, []);

  // 探针推进 frontierStage 时单调推进历史最远 frontier（D-B6-10）。
  useEffect(() => {
    setMaxFrontierStage((prev) => advanceMaxFrontierStage(prev, frontierStage));
  }, [frontierStage]);

  // JourneyNav 点击已到达阶段：锁定展示阶段（D-B6-10 规则 1，用户意图优先）。
  const handleSelectJourneyStage = useCallback((stage: JourneyStage) => {
    setUserSelectedStage(stage);
  }, []);

  // 展示阶段（决定中栏挂载哪个 Region）+ 已到达阶段集合（JourneyNav 可点击范围）。
  const reachedStages = reachedStagesUpTo(maxFrontierStage);
  const viewStage = deriveViewStage({ frontierStage, userSelectedStage, reachedStages });
  // frontier 已越过 research 但仍在展示调研内容（B8 起多为用户主动点回调研阶段
  // 回看）——ResearchRegion 顶部给一条明确说明，避免用户以为流程卡住（D-B6-10）。
  const showResearchBeyondNotice =
    viewStage === 'research' && stageIndex(frontierStage) > stageIndex('research');

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
        // 新项目从旅程起点开始（B6：避免沿用上一个项目遗留的旅程状态导致中栏
        // 短暂挂错 Region，即便自纠正也会闪烁；D-B6-10 起需一并重置展示阶段
        // 三元组，否则会沿用上一个项目的 userSelectedStage/reachedStages）
        setMaxFrontierStage('idea');
        setUserSelectedStage(null);
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
        // 打开项目从旅程起点开始（B6：同上，各 Region 会据 Graph 进度自纠正；
        // D-B6-10 起一并重置展示阶段三元组）
        setMaxFrontierStage('idea');
        setUserSelectedStage(null);
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
              <JourneyNav
                frontierStage={frontierStage}
                viewStage={viewStage}
                reachedStages={reachedStages}
                onSelectStage={handleSelectJourneyStage}
              />
              {/* 探针失败必须可见（B8 复查随行）：D-B8-2 之后阶段派生只由这条
                  循环驱动，它一旦静默失败，界面会冻在"想法"阶段而用户毫无察觉——
                  正是"没有 Region 该被挂载时无人回报"那类问题换了个面目。这里给
                  非阻塞提示（探针下一轮成功即自动消失），不打断当前 Region。 */}
              {journey.error && (
                <div className="journey-probe-error" role="status" aria-live="polite">
                  {journey.error}（正在自动重试）
                </div>
              )}
              {/* D-B6-10：中栏按展示阶段（viewStage）互斥挂载，与推进阶段
                  （frontierStage）分离——挂载哪个 Region 不再单纯 follow frontier。
                  B8 起三分流：blueprint → BlueprintRegion（阶段与蓝图态由
                  App 探针以 props 下发，D-B8-2）；research → ResearchRegion；
                  否则 IntakeRegion（manuscript 尚未建区域，deriveViewStage 默认
                  会先回落到 blueprint，只有用户显式点选 manuscript 才会走到
                  IntakeRegion 的 beyond-intake 占位分支）。 */}
              {viewStage === 'blueprint' ? (
                <BlueprintRegion
                  key={currentProject.id}
                  projectId={currentProject.id}
                  state={journey.blueprintState}
                  terminalStatus={journey.run?.terminalStatus ?? null}
                  generating={hasActiveBlueprintGenerate(journey.progress)}
                  stateLoading={journey.loading}
                  onRefresh={journey.refresh}
                />
              ) : viewStage === 'research' ? (
                <ResearchRegion
                  key={currentProject.id}
                  projectId={currentProject.id}
                  showBeyondResearchNotice={showResearchBeyondNotice}
                />
              ) : (
                <IntakeRegion key={currentProject.id} projectId={currentProject.id} />
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
                    ? (JOURNEY_STAGES.find((s) => s.id === frontierStage)?.label ?? '—')
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
