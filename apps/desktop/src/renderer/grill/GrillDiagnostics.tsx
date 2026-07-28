/**
 * Grill-me 开发态诊断面板。
 *
 * 仅在 import.meta.env.DEV 时渲染。
 * 显示截断的 project/session ID、version、最后刷新时间。
 * 禁止显示：absolute path、API Key、Keychain service/account、
 * prompt、模型配置、stack、完整内部 ID。
 */

import { useEffect, useState } from 'react';

interface GrillDiagnosticsProps {
  projectId: string;
  sessionId: string | null;
  sessionVersion: number | null;
}

/** 截断 ID，只显示前 8 位 */
function truncateId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

export function GrillDiagnostics({ projectId, sessionId, sessionVersion }: GrillDiagnosticsProps) {
  const [lastRefresh, setLastRefresh] = useState<string>(new Date().toLocaleTimeString('zh-CN'));

  useEffect(() => {
    setLastRefresh(new Date().toLocaleTimeString('zh-CN'));
  }, [projectId, sessionId, sessionVersion]);

  if (!import.meta.env.DEV) return null;

  return (
    <div
      className="grill-diagnostics"
      style={{
        fontSize: '11px',
        color: '#888',
        padding: '4px 8px',
        borderBottom: '1px solid #eee',
        fontFamily: 'monospace',
      }}
    >
      <span title={projectId}>项目: {truncateId(projectId)}</span>
      {' · '}
      <span title={sessionId ?? ''}>会话: {sessionId ? truncateId(sessionId) : '—'}</span>
      {' · '}
      <span>版本: {sessionVersion ?? '—'}</span>
      {' · '}
      <span>刷新: {lastRefresh}</span>
    </div>
  );
}
