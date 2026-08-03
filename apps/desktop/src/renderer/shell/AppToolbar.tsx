/**
 * 顶部工具栏（App shell header）。
 *
 * 纯展示组合组件：由 App 传入跨切面状态与回调，渲染：
 * - 左面板开关（aria-controls="panel-left"）
 * - 应用标题
 * - 数据服务状态 badge
 * - 开发模式 badge
 * - 右面板开关（aria-controls="panel-right"）
 *
 * 保持与重构前 App.tsx 完全一致的 DOM（id / aria-label / aria-expanded / 文案）。
 *
 * 未来产品工作区接入后，这里是 CurrentProjectHeader（当前项目名 / 阶段）的插槽，
 * 但本任务不新增任何可见 DOM。
 */

import type { DataServiceStatus } from '@ai-novel/contracts';
import type { PanelId, PanelState } from '../panel-state';

interface AppToolbarProps {
  panelState: PanelState;
  dataServiceStatus: DataServiceStatus;
  onTogglePanel: (panel: PanelId) => void;
}

export function AppToolbar({ panelState, dataServiceStatus, onTogglePanel }: AppToolbarProps) {
  const isDataServiceReady = dataServiceStatus === 'ready';
  const isDataServiceStarting = dataServiceStatus === 'starting';

  return (
    <header className="toolbar" role="banner">
      <nav className="toolbar-left" aria-label="面板控制">
        <button
          className="toolbar-btn"
          onClick={() => onTogglePanel('left')}
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
          onClick={() => onTogglePanel('right')}
          aria-label={panelState.right ? '收起状态面板' : '展开状态面板'}
          aria-expanded={panelState.right}
          aria-controls="panel-right"
        >
          ☰
        </button>
      </div>
    </header>
  );
}
