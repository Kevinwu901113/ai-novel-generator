import { AppIcon } from './AppIcon';

interface AppRailProps {
  readonly isHome: boolean;
  readonly onHome: () => void;
  readonly onNewProject: () => void;
  readonly onOpenSettings: () => void;
}

export function AppRail({ isHome, onHome, onNewProject, onOpenSettings }: AppRailProps) {
  return (
    <nav className="app-rail" aria-label="全局导航">
      <div className="app-mark" aria-hidden="true">
        文
      </div>

      <div className="rail-actions">
        <button
          className={`rail-button ${isHome ? 'active' : ''}`}
          type="button"
          onClick={onHome}
          aria-label="首页"
          aria-current={isHome ? 'page' : undefined}
        >
          <AppIcon name="home" />
          <span>首页</span>
        </button>
        <button className="rail-button" type="button" onClick={onNewProject} aria-label="新建项目">
          <AppIcon name="add" />
          <span>新建</span>
        </button>
      </div>

      <button
        className="rail-button rail-settings"
        type="button"
        onClick={onOpenSettings}
        aria-label="打开设置"
      >
        <AppIcon name="settings" />
        <span>设置</span>
      </button>
    </nav>
  );
}
