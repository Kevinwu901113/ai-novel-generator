import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HealthCheckResponse,
  ProjectListItem,
  OpenProjectResult,
  DataServiceStatus,
} from '@ai-novel/contracts';
import { isValidHealthCheckResponse } from '@ai-novel/contracts';
import { INITIAL_PANEL_STATE, togglePanel, type PanelId, type PanelState } from './panel-state';

const MAX_NAME_LENGTH = 100;
const MAX_IDEA_LENGTH = 20_000;

function unicodeLength(str: string): number {
  return [...str].length;
}

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

  // 表单状态
  const [formName, setFormName] = useState('');
  const [formIdea, setFormIdea] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isCreating, setIsCreating] = useState(false);

  // 追踪是否已加载过项目列表
  const hasLoadedProjects = useRef(false);

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

        // 如果还在 starting，继续轮询
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
    } catch (err) {
      // 列表加载失败不阻塞
      console.error('Failed to load projects:', err);
    }
  }, []);

  useEffect(() => {
    if (dataServiceStatus === 'ready' && !hasLoadedProjects.current) {
      void loadProjects();
    }
  }, [dataServiceStatus, loadProjects]);

  // 验证表单
  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};

    const nameTrimmed = formName.trim();
    if (nameTrimmed.length === 0) {
      errors.name = '项目名称不能为空';
    } else if (unicodeLength(nameTrimmed) > MAX_NAME_LENGTH) {
      errors.name = `项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }

    const ideaTrimmed = formIdea.trim();
    if (ideaTrimmed.length === 0) {
      errors.initialIdea = '初始想法不能为空';
    } else if (unicodeLength(ideaTrimmed) > MAX_IDEA_LENGTH) {
      errors.initialIdea = `初始想法不能超过 ${MAX_IDEA_LENGTH} 个字符`;
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formName, formIdea]);

  // 创建项目
  const handleCreate = useCallback(async () => {
    if (isCreating || dataServiceStatus !== 'ready') return;
    if (!validateForm()) return;

    setIsCreating(true);
    setError(null);

    try {
      const result = await window.desktop.projects.create({
        name: formName.trim(),
        initialIdea: formIdea.trim(),
      });

      setFormName('');
      setFormIdea('');
      setFormErrors({});
      await loadProjects();

      const project = await window.desktop.projects.open(result.id);
      setCurrentProject(project);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      const message = err instanceof Error ? err.message : '创建项目失败';
      setError(code ? `[${code}] ${message}` : message);
    } finally {
      setIsCreating(false);
    }
  }, [formName, formIdea, isCreating, dataServiceStatus, validateForm, loadProjects]);

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
        const code = (err as Error & { code?: string }).code;
        const message = err instanceof Error ? err.message : '打开项目失败';
        setError(code ? `[${code}] ${message}` : message);
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

  // 格式化短 ID
  const shortId = (id: string) => id.slice(0, 8);

  // 格式化时间
  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  };

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
          {/* 数据服务状态指示器 */}
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
            <div className="panel-header">
              <h2>项目列表</h2>
              <button
                className="btn-new-project"
                onClick={() => {
                  setCurrentProject(null);
                  setError(null);
                }}
                title="新建项目"
                disabled={!isDataServiceReady}
              >
                ＋
              </button>
            </div>
            <div className="panel-content">
              {isDataServiceStarting ? (
                <div className="empty-state">
                  <p className="loading-indicator">⟳</p>
                  <p>数据服务启动中…</p>
                </div>
              ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
                <div className="empty-state">
                  <p>数据服务不可用</p>
                  <button className="btn-retry" onClick={handleRetry}>
                    重试数据服务
                  </button>
                </div>
              ) : projects.length === 0 ? (
                <div className="empty-state">
                  <p>尚未创建项目</p>
                  <p className="empty-hint">在中间栏创建第一个项目</p>
                </div>
              ) : (
                <ul className="project-list">
                  {projects.map((p) => (
                    <li
                      key={p.id}
                      className={`project-item ${currentProject?.id === p.id ? 'active' : ''} ${p.isMissing ? 'missing' : ''}`}
                      onClick={() => !p.isMissing && handleOpenProject(p.id)}
                    >
                      <span className="project-item-name">{p.name}</span>
                      {p.isMissing && <span className="project-item-badge">缺失</span>}
                      <span className="project-item-time">
                        {formatTime(p.lastOpenedAt ?? p.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        )}

        {/* 中栏：新建项目 / 项目详情 */}
        <section className="panel panel-center">
          <div className="panel-header">
            <h2>{currentProject ? currentProject.name : '新建项目'}</h2>
          </div>
          <div className="panel-content">
            {currentProject ? (
              <div className="project-detail">
                <div className="detail-section">
                  <h3>项目名称</h3>
                  <p className="detail-value">{currentProject.name}</p>
                </div>
                <div className="detail-section">
                  <h3>初始想法</h3>
                  <p className="detail-idea">{currentProject.initialIdea}</p>
                </div>
                <div className="detail-section">
                  <h3>状态</h3>
                  <p className="detail-value">{currentProject.status}</p>
                </div>
                <div className="detail-next-step">
                  <p>下一阶段：需求理解与 Grill-me</p>
                  <p className="empty-hint">（Grill-me 尚未实现）</p>
                </div>
              </div>
            ) : isDataServiceStarting ? (
              <div className="empty-state">
                <p className="loading-indicator">⟳</p>
                <p>数据服务启动中，请稍候…</p>
              </div>
            ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
              <div className="empty-state">
                <p>数据服务不可用</p>
                <p className="empty-hint">无法创建项目，请检查数据服务状态</p>
                <button className="btn-retry" onClick={handleRetry}>
                  重试数据服务
                </button>
              </div>
            ) : (
              <div className="create-form">
                <div className="form-field">
                  <label htmlFor="project-name">项目名称</label>
                  <input
                    id="project-name"
                    type="text"
                    value={formName}
                    onChange={(e) => {
                      setFormName(e.target.value);
                      setFormErrors((prev) => ({ ...prev, name: '' }));
                    }}
                    placeholder="给你的小说起个名字"
                    maxLength={200}
                    disabled={isCreating}
                  />
                  <div className="form-field-footer">
                    {formErrors.name && <span className="form-error">{formErrors.name}</span>}
                    <span className="char-count">
                      {unicodeLength(formName.trim())} / {MAX_NAME_LENGTH}
                    </span>
                  </div>
                </div>

                <div className="form-field">
                  <label htmlFor="project-idea">描述你想写的小说……</label>
                  <textarea
                    id="project-idea"
                    value={formIdea}
                    onChange={(e) => {
                      setFormIdea(e.target.value);
                      setFormErrors((prev) => ({ ...prev, initialIdea: '' }));
                    }}
                    placeholder="可以是模糊的想法、灵感片段、想写的题材……"
                    rows={10}
                    disabled={isCreating}
                  />
                  <div className="form-field-footer">
                    {formErrors.initialIdea && (
                      <span className="form-error">{formErrors.initialIdea}</span>
                    )}
                    <span className="char-count">
                      {unicodeLength(formIdea.trim())} / {MAX_IDEA_LENGTH.toLocaleString()}
                    </span>
                  </div>
                </div>

                <button className="btn-create" onClick={handleCreate} disabled={isCreating}>
                  {isCreating ? '创建中…' : '创建项目'}
                </button>
              </div>
            )}
          </div>
        </section>

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
                <p>{currentProject ? '项目创建' : '—'}</p>
              </div>
              {currentProject && (
                <>
                  <div className="status-section">
                    <h3>项目 ID</h3>
                    <p className="mono">{shortId(currentProject.id)}</p>
                  </div>
                  <div className="status-section">
                    <h3>创建时间</h3>
                    <p>{formatTime(currentProject.createdAt)}</p>
                  </div>
                  <div className="status-section">
                    <h3>最近打开</h3>
                    <p>{formatTime(currentProject.lastOpenedAt)}</p>
                  </div>
                  <div className="status-section">
                    <h3>项目状态</h3>
                    <p>{currentProject.status}</p>
                  </div>
                </>
              )}
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
