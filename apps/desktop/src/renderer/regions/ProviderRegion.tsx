/**
 * 模型服务区域组件。
 *
 * 独立渲染右栏模型服务信息，包含：
 * - 提供商状态
 * - API Key 管理
 * - 连接测试
 * - 错误显示
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响 TaskCenter。
 */

import { useState, useCallback } from 'react';
import type { DataServiceStatus, ProviderPublicState } from '@ai-novel/contracts';
import { ERROR_CODE_LABELS } from '../safety/error-code-labels';
import { toSafeUserError } from '../safety/safe-error';

/** 格式化时间 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

interface ProviderRegionProps {
  providerState: ProviderPublicState | null;
  dataServiceStatus: DataServiceStatus;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onDeleteApiKey: () => Promise<void>;
  onTestConnection: () => Promise<void>;
}

export function ProviderRegion({
  providerState,
  dataServiceStatus,
  onSaveApiKey,
  onDeleteApiKey,
  onTestConnection,
}: ProviderRegionProps) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  const handleSaveApiKey = useCallback(async () => {
    if (isSavingKey || dataServiceStatus !== 'ready') return;
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;

    setIsSavingKey(true);
    setProviderError(null);

    try {
      await onSaveApiKey(trimmed);
      setApiKeyInput('');
    } catch (err) {
      const safe = toSafeUserError(err, '保存失败');
      setProviderError(safe.message);
    } finally {
      setIsSavingKey(false);
    }
  }, [apiKeyInput, isSavingKey, dataServiceStatus, onSaveApiKey]);

  const handleDeleteApiKey = useCallback(async () => {
    if (dataServiceStatus !== 'ready') return;

    setProviderError(null);

    try {
      await onDeleteApiKey();
      setDeleteConfirmVisible(false);
    } catch (err) {
      const safe = toSafeUserError(err, '删除失败');
      setProviderError(safe.message);
    }
  }, [dataServiceStatus, onDeleteApiKey]);

  const handleTestConnection = useCallback(async () => {
    if (isTestingConnection || dataServiceStatus !== 'ready') return;

    setIsTestingConnection(true);
    setProviderError(null);

    try {
      await onTestConnection();
    } catch (err) {
      const safe = toSafeUserError(err, '测试失败');
      setProviderError(safe.message);
    } finally {
      setIsTestingConnection(false);
    }
  }, [isTestingConnection, dataServiceStatus, onTestConnection]);

  if (!providerState) {
    return null;
  }

  return (
    <>
      <div className="provider-info">
        <p>
          <strong>提供商：</strong>
          {providerState.displayName}
        </p>
        <p>
          <strong>模型：</strong>
          {providerState.model}
        </p>
        <p>
          <strong>接口类型：</strong>
          {providerState.providerType}
        </p>
        <p>
          <strong>API Key：</strong>
          {providerState.hasApiKey ? '已配置' : '未配置'}
        </p>
        {providerState.lastTestStatus !== 'never' && (
          <>
            <p>
              <strong>最近测试：</strong>
              {providerState.lastTestStatus === 'success'
                ? '连接正常'
                : providerState.lastTestErrorCode
                  ? `[${providerState.lastTestErrorCode}] ${ERROR_CODE_LABELS[providerState.lastTestErrorCode] ?? '测试失败'}`
                  : '测试失败'}
            </p>
            <p>
              <strong>测试时间：</strong>
              {formatTime(providerState.lastTestedAt)}
            </p>
            {providerState.lastTestLatencyMs !== null && (
              <p>
                <strong>延迟：</strong>
                {providerState.lastTestLatencyMs}ms
              </p>
            )}
          </>
        )}
      </div>

      {/* API Key 编辑 */}
      <div className="provider-key-section">
        {!providerState.hasApiKey ? (
          <div className="provider-key-input">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="输入 API Key"
              disabled={isSavingKey || dataServiceStatus !== 'ready'}
              maxLength={8192}
            />
            <button
              onClick={handleSaveApiKey}
              disabled={isSavingKey || !apiKeyInput.trim() || dataServiceStatus !== 'ready'}
            >
              {isSavingKey ? '保存中…' : '保存'}
            </button>
          </div>
        ) : (
          <div className="provider-key-actions">
            {!deleteConfirmVisible ? (
              <button
                className="btn-danger"
                onClick={() => setDeleteConfirmVisible(true)}
                disabled={dataServiceStatus !== 'ready'}
              >
                删除密钥
              </button>
            ) : (
              <div className="delete-confirm">
                <span>确认删除？</span>
                <button className="btn-danger" onClick={handleDeleteApiKey}>
                  确认
                </button>
                <button onClick={() => setDeleteConfirmVisible(false)}>取消</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 连接测试 */}
      <div className="provider-test-section">
        <button
          onClick={handleTestConnection}
          disabled={
            isTestingConnection || !providerState.hasApiKey || dataServiceStatus !== 'ready'
          }
          title={!providerState.hasApiKey ? '请先配置 API Key' : undefined}
        >
          {isTestingConnection ? '正在连接…' : '测试连接'}
        </button>
      </div>

      {/* 错误信息 */}
      {providerError && (
        <div className="provider-error">
          <span>{providerError}</span>
          <button onClick={() => setProviderError(null)}>✕</button>
        </div>
      )}
    </>
  );
}
