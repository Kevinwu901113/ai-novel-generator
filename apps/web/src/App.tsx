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
import { ChapterRegion } from './chapter/ChapterRegion';
import { hasActiveBlueprintGenerate } from './blueprint/blueprint-logic';
import { TaskCenter } from './task-center/TaskCenter';
import { ResearchRegion } from './research/ResearchRegion';
import { SearchKeyPanel } from './research/SearchKeyPanel';
import { RendererErrorBoundary } from './safety/RendererErrorBoundary';
import { toSafeUserError } from './safety/safe-error';
import { ProjectStatusRegion, ProviderRegion } from './regions';
import { HomePage } from './home/HomePage';
import { AppDrawer } from './shell/AppDrawer';
import { AppIcon } from './shell/AppIcon';
import { AppRail } from './shell/AppRail';
import type { DrawerId } from './shell-state';

export function App() {
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [openDrawer, setOpenDrawer] = useState<DrawerId | null>(null);

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
  const [searchConfigured, setSearchConfigured] = useState<boolean | null>(null);

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

  // 探针推进 frontierStage 时单调推进历史最远 frontier（D-B6-10）。
  useEffect(() => {
    setMaxFrontierStage((prev) => advanceMaxFrontierStage(prev, frontierStage));
  }, [frontierStage]);

  // JourneyNav 点击已到达阶段：锁定展示阶段（D-B6-10 规则 1，用户意图优先）。
  const handleSelectJourneyStage = useCallback((stage: JourneyStage) => {
    setUserSelectedStage(stage);
  }, []);

  // 蓝图人工决策落地后的收尾（B8 独立复查坐实的 blocker 修复）：
  // 1. 解除用户视图锁定——决策可能把 frontier 带去别处（modify_requirements 回
  //    访谈重出澄清问题），若 userSelectedStage 仍锁在 'blueprint'，中栏会继续
  //    挂着一份无按钮无说明的旧蓝图，用户点完"修改创作要求"像什么都没发生，
  //    而新的澄清问题在没被挂载的 Region 里干等；
  // 2. 立即刷新探针，且把"新状态落地后才 resolve"的 promise 交回 useBlueprint，
  //    供决策 busy 护航（防止按钮以旧态提前重新可点）。
  // TD-030-4 起 research 侧同用（escalation 的 modify_requirements 会把 frontier
  // 带回访谈；若视图仍锁在 'research'，用户点完像什么都没发生——同病同修）。
  const journeyRefresh = journey.refresh;
  const handleHumanDecisionSettled = useCallback(async () => {
    setUserSelectedStage(null);
    await journeyRefresh();
  }, [journeyRefresh]);

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

  const loadSearchStatus = useCallback(async () => {
    try {
      const state = await window.desktop.search.hasApiKey();
      setSearchConfigured(state.hasApiKey);
    } catch {
      setSearchConfigured(false);
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
      void loadSearchStatus();
    }
  }, [dataServiceStatus, loadProviders, loadSearchStatus]);

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

  const handleHome = useCallback(() => {
    setCurrentProject(null);
    setError(null);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setOpenDrawer('settings');
  }, []);

  const handleOpenTasks = useCallback(() => {
    setOpenDrawer('tasks');
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setOpenDrawer(null);
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
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? null;
  const currentStageLabel = currentProject
    ? (JOURNEY_STAGES.find((stage) => stage.id === frontierStage)?.label ?? '想法')
    : null;

  return (
    <div className="app-shell">
      <AppRail
        isHome={!currentProject}
        onHome={handleHome}
        onNewProject={handleNewProject}
        onOpenSettings={handleOpenSettings}
      />

      <div className="app-surface">
        <header className="app-header" role="banner">
          <div className="header-identity">
            {currentProject ? (
              <>
                <button className="header-home-link" type="button" onClick={handleHome}>
                  项目
                </button>
                <AppIcon name="chevron" size={15} />
                <h1>{currentProject.name}</h1>
                <span className="stage-pill">{currentStageLabel}</span>
              </>
            ) : (
              <>
                <span className="header-product-name">AI 小说创作代理</span>
                <span className="header-product-note">本地优先创作台</span>
              </>
            )}
          </div>

          <div className="header-actions">
            {!isDataServiceReady && (
              <span className={`service-status-pill ${dataServiceStatus}`} role="status">
                {isDataServiceStarting ? '数据服务启动中' : '数据服务不可用'}
              </span>
            )}
            {currentProject && (
              <button className="header-button" type="button" onClick={handleOpenTasks}>
                <AppIcon name="activity" size={18} />
                <span>任务活动</span>
              </button>
            )}
            <button className="header-button" type="button" onClick={handleOpenSettings}>
              <AppIcon name="settings" size={18} />
              <span>{defaultProvider?.hasApiKey ? defaultProvider.label : '配置模型'}</span>
            </button>
          </div>
        </header>

        {error && (
          <div className="global-error" role="alert" aria-live="assertive">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="关闭错误提示">
              ✕
            </button>
          </div>
        )}

        <main className="main-surface">
          {currentProject ? (
            <section ref={grillSectionRef} className="project-workspace" aria-label="创作旅程">
              <div className="project-journey-bar">
                <JourneyNav
                  frontierStage={frontierStage}
                  viewStage={viewStage}
                  reachedStages={reachedStages}
                  onSelectStage={handleSelectJourneyStage}
                />
              </div>
              {journey.error && (
                <div className="journey-probe-error" role="status" aria-live="polite">
                  {journey.error}（正在自动重试）
                </div>
              )}
              <div className="project-canvas">
                <div className="project-canvas-inner">
                  <RendererErrorBoundary label="创作旅程">
                    {viewStage === 'manuscript' ? (
                      <ChapterRegion key={currentProject.id} projectId={currentProject.id} />
                    ) : viewStage === 'blueprint' ? (
                      <BlueprintRegion
                        key={currentProject.id}
                        projectId={currentProject.id}
                        state={journey.blueprintState}
                        terminalStatus={journey.run?.terminalStatus ?? null}
                        generating={hasActiveBlueprintGenerate(journey.progress)}
                        stateLoading={journey.loading}
                        onRefresh={handleHumanDecisionSettled}
                      />
                    ) : viewStage === 'research' ? (
                      <ResearchRegion
                        key={currentProject.id}
                        projectId={currentProject.id}
                        showBeyondResearchNotice={showResearchBeyondNotice}
                        onDecisionSettled={handleHumanDecisionSettled}
                      />
                    ) : (
                      <IntakeRegion key={currentProject.id} projectId={currentProject.id} />
                    )}
                  </RendererErrorBoundary>
                </div>
              </div>
            </section>
          ) : (
            <RendererErrorBoundary label="首页">
              <HomePage
                dataServiceStatus={dataServiceStatus}
                projects={projects}
                defaultProvider={defaultProvider}
                searchConfigured={searchConfigured}
                createSectionRef={createSectionRef}
                onRetry={handleRetry}
                onCreate={handleCreate}
                onOpenProject={handleOpenProject}
                onOpenSettings={handleOpenSettings}
              />
            </RendererErrorBoundary>
          )}
        </main>
      </div>

      {openDrawer === 'tasks' && (
        <AppDrawer
          title="任务活动"
          description={currentProject ? `${currentProject.name} 的模型调用与运行记录` : undefined}
          onClose={handleCloseDrawer}
        >
          <RendererErrorBoundary label="任务中心">
            <TaskCenter projectId={currentProject?.id ?? null} />
          </RendererErrorBoundary>
          {currentProject && (
            <details className="drawer-details">
              <summary>项目信息</summary>
              <RendererErrorBoundary label="项目状态">
                <ProjectStatusRegion currentProject={currentProject} />
              </RendererErrorBoundary>
            </details>
          )}
        </AppDrawer>
      )}

      {openDrawer === 'settings' && (
        <AppDrawer
          title="创作服务设置"
          description="配置生成模型、联网搜索与本地运行状态"
          onClose={handleCloseDrawer}
        >
          <section className="drawer-section" aria-labelledby="provider-heading">
            <div className="drawer-section-heading">
              <AppIcon name="sparkles" size={18} />
              <div>
                <h3 id="provider-heading">模型提供商</h3>
                <p>正文、蓝图和创作要求都使用这里的默认模型。</p>
              </div>
            </div>
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

          <section className="drawer-section" aria-labelledby="search-key-heading">
            <div className="drawer-section-heading">
              <AppIcon name="search" size={18} />
              <div>
                <h3 id="search-key-heading">联网搜索</h3>
                <p>可选。需要历史或现实资料时，使用 Tavily 完成调研。</p>
              </div>
            </div>
            <RendererErrorBoundary label="搜索服务">
              <SearchKeyPanel
                dataServiceStatus={dataServiceStatus}
                onStatusChange={setSearchConfigured}
              />
            </RendererErrorBoundary>
          </section>

          <section className="drawer-section system-overview" aria-labelledby="system-heading">
            <div className="drawer-section-heading">
              <AppIcon name="database" size={18} />
              <div>
                <h3 id="system-heading">本地运行</h3>
                <p>项目和稿件只保存在这台电脑。</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>数据服务</dt>
                <dd>{isDataServiceReady ? 'SQLite 已就绪' : '暂不可用'}</dd>
              </div>
              <div>
                <dt>桌面服务</dt>
                <dd>{health?.ok ? '正常' : '检查中'}</dd>
              </div>
              {health && (
                <div>
                  <dt>版本</dt>
                  <dd>{health.version}</dd>
                </div>
              )}
            </dl>
          </section>
        </AppDrawer>
      )}
    </div>
  );
}
