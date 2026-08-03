/**
 * 底部状态栏（App shell）。
 *
 * 纯展示组合组件：桌面服务健康检查结果 / 版本 / 最后检查时间。
 * 保持与重构前 App.tsx 完全一致的 DOM（footer.status-bar）。
 */

import type { HealthCheckResponse } from '@ai-novel/contracts';

interface AppStatusBarProps {
  health: HealthCheckResponse | null;
}

export function AppStatusBar({ health }: AppStatusBarProps) {
  return (
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
  );
}
