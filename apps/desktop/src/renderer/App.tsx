import { useCallback, useEffect, useState } from 'react';
import type { HealthCheckResponse } from '@ai-novel/contracts';
import { isValidHealthCheckResponse } from '@ai-novel/contracts';
import { INITIAL_PANEL_STATE, togglePanel, type PanelId, type PanelState } from './panel-state';

export function App() {
  const [panelState, setPanelState] = useState<PanelState>(INITIAL_PANEL_STATE);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setPanelState((prev) => togglePanel(prev, panel));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const result = await window.desktop.healthCheck();
        if (!cancelled && isValidHealthCheckResponse(result)) {
          setHealth(result);
        }
      } catch {
        // 健康检查失败时不阻塞 UI
      }
    }

    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      {/* 顶部工具栏 */}
      <header className="toolbar">
        <div className="toolbar-left">
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('left')}
            title={panelState.left ? '收起项目结构' : '展开项目结构'}
          >
            ☰
          </button>
          <h1 className="app-title">AI 小说创作代理</h1>
        </div>
        <div className="toolbar-right">
          <span className="dev-badge">开发模式</span>
          <button
            className="toolbar-btn"
            onClick={() => handleTogglePanel('right')}
            title={panelState.right ? '收起任务面板' : '展开任务面板'}
          >
            ☰
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <main className="workspace">
        {/* 左栏：项目结构 */}
        {panelState.left && (
          <aside className="panel panel-left">
            <div className="panel-header">
              <h2>项目结构</h2>
            </div>
            <div className="panel-content">
              <div className="empty-state">
                <p>尚未创建项目</p>
              </div>
            </div>
          </aside>
        )}

        {/* 中栏：正文与 Grill-me 工作区 */}
        <section className="panel panel-center">
          <div className="panel-header">
            <h2>正文与 Grill-me 工作区</h2>
          </div>
          <div className="panel-content">
            <div className="empty-state">
              <p>尚未创建项目</p>
              <p className="empty-hint">请先创建项目以开始创作</p>
            </div>
          </div>
        </section>

        {/* 右栏：AI 任务与状态 */}
        {panelState.right && (
          <aside className="panel panel-right">
            <div className="panel-header">
              <h2>AI 任务与状态</h2>
            </div>
            <div className="panel-content">
              <div className="empty-state">
                <p>尚无任务</p>
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
