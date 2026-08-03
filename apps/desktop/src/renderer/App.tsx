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
import { toSafeUserError } from './safety/safe-error';
import {
  AppToolbar,
  ProjectSidebar,
  ProjectSelectionShell,
  ProjectWorkspaceShell,
  SystemStatusPanel,
  AppStatusBar,
} from './shell';

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

  return (
    <div className="app">
      <AppToolbar
        panelState={panelState}
        dataServiceStatus={dataServiceStatus}
        onTogglePanel={handleTogglePanel}
      />

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
          <ProjectSidebar
            dataServiceStatus={dataServiceStatus}
            projects={projects}
            currentProjectId={currentProject?.id ?? null}
            onRetry={handleRetry}
            onNewProject={handleNewProject}
            onOpenProject={handleOpenProject}
          />
        )}

        {/* 中栏：新建项目 / Grill 工作台 */}
        {currentProject ? (
          <ProjectWorkspaceShell projectId={currentProject.id} sectionRef={grillSectionRef} />
        ) : (
          <ProjectSelectionShell
            dataServiceStatus={dataServiceStatus}
            sectionRef={createSectionRef}
            onRetry={handleRetry}
            onCreate={handleCreate}
          />
        )}

        {/* 右栏：状态 */}
        {panelState.right && (
          <SystemStatusPanel
            dataServiceStatus={dataServiceStatus}
            currentProject={currentProject}
            providerState={providerState}
            onRetry={handleRetry}
            onSaveApiKey={handleSaveApiKey}
            onDeleteApiKey={handleDeleteApiKey}
            onTestConnection={handleTestConnection}
          />
        )}
      </main>

      {/* 状态栏 */}
      <AppStatusBar health={health} />
    </div>
  );
}
