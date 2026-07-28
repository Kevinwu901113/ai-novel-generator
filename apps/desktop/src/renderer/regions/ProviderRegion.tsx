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
 *
 * 无障碍特性：
 * - API Key 输入有可访问 label（不只依赖 placeholder）
 * - 保存、删除、测试按钮有明确名称
 * - 保存和测试期间使用 aria-busy
 * - 错误提示使用 role="alert"
 * - 成功/状态刷新使用 role="status"
 * - 不朗读 API Key 内容
 * - 删除确认：焦点移动到确认按钮，Escape 取消，取消后焦点恢复
 */

import { useState, useCallback, useRef, useEffect } from 'react';
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
  const [providerStatus, setProviderStatus] = useState<string | null>(null);

  // 焦点管理
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);

  // 删除确认出现时将焦点移动到确认按钮
  useEffect(() => {
    if (deleteConfirmVisible) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      // 使用 setTimeout 确保 DOM 已更新
      const timer = setTimeout(() => {
        confirmDeleteRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    } else if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      // 恢复焦点到触发按钮
      const timer = setTimeout(() => {
        deleteTriggerRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [deleteConfirmVisible]);

  // 删除确认的 Escape 处理
  useEffect(() => {
    if (!deleteConfirmVisible) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        shouldRestoreFocusRef.current = true;
        setDeleteConfirmVisible(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [deleteConfirmVisible]);

  const handleSaveApiKey = useCallback(async () => {
    if (isSavingKey || dataServiceStatus !== 'ready') return;
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;

    setIsSavingKey(true);
    setProviderError(null);
    setProviderStatus(null);

    try {
      await onSaveApiKey(trimmed);
      setApiKeyInput('');
      setProviderStatus('API Key 已保存');
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
    setProviderStatus(null);

    try {
      await onDeleteApiKey();
      shouldRestoreFocusRef.current = true;
      setDeleteConfirmVisible(false);
      setProviderStatus('API Key 已删除');
    } catch (err) {
      const safe = toSafeUserError(err, '删除失败');
      setProviderError(safe.message);
    }
  }, [dataServiceStatus, onDeleteApiKey]);

  const handleTestConnection = useCallback(async () => {
    if (isTestingConnection || dataServiceStatus !== 'ready') return;

    setIsTestingConnection(true);
    setProviderError(null);
    setProviderStatus(null);

    try {
      await onTestConnection();
      setProviderStatus('连接测试完成');
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
          <span role="status">{providerState.hasApiKey ? '已配置' : '未配置'}</span>
        </p>
        {providerState.lastTestStatus !== 'never' && (
          <>
            <p>
              <strong>最近测试：</strong>
              <span role="status">
                {providerState.lastTestStatus === 'success'
                  ? '连接正常'
                  : providerState.lastTestErrorCode
                    ? `[${providerState.lastTestErrorCode}] ${ERROR_CODE_LABELS[providerState.lastTestErrorCode] ?? '测试失败'}`
                    : '测试失败'}
              </span>
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
            <label htmlFor="provider-api-key" className="sr-only">
              API Key
            </label>
            <input
              id="provider-api-key"
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="输入 API Key"
              disabled={isSavingKey || dataServiceStatus !== 'ready'}
              maxLength={8192}
              aria-required="true"
              autoComplete="off"
            />
            <button
              onClick={handleSaveApiKey}
              disabled={isSavingKey || !apiKeyInput.trim() || dataServiceStatus !== 'ready'}
              aria-busy={isSavingKey ? 'true' : undefined}
              aria-label={isSavingKey ? '正在保存 API Key' : '保存 API Key'}
            >
              {isSavingKey ? '保存中…' : '保存'}
            </button>
          </div>
        ) : (
          <div className="provider-key-actions">
            {!deleteConfirmVisible ? (
              <button
                ref={deleteTriggerRef}
                className="btn-danger"
                onClick={() => setDeleteConfirmVisible(true)}
                disabled={dataServiceStatus !== 'ready'}
                aria-label="删除 API Key"
              >
                删除密钥
              </button>
            ) : (
              <div className="delete-confirm" role="group" aria-label="确认删除 API Key">
                <span>确认删除？</span>
                <button
                  ref={confirmDeleteRef}
                  className="btn-danger"
                  onClick={handleDeleteApiKey}
                  aria-label="确认删除 API Key"
                >
                  确认
                </button>
                <button
                  onClick={() => {
                    shouldRestoreFocusRef.current = true;
                    setDeleteConfirmVisible(false);
                  }}
                  aria-label="取消删除"
                >
                  取消
                </button>
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
          aria-busy={isTestingConnection ? 'true' : undefined}
          aria-label={
            !providerState.hasApiKey
              ? '请先配置 API Key'
              : isTestingConnection
                ? '正在测试连接'
                : '测试连接'
          }
        >
          {isTestingConnection ? '正在连接…' : '测试连接'}
        </button>
      </div>

      {/* 错误信息 */}
      {providerError && (
        <div className="provider-error" role="alert" aria-live="assertive">
          <span>{providerError}</span>
          <button onClick={() => setProviderError(null)} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      {/* 状态信息 */}
      {providerStatus && (
        <div className="provider-status" role="status" aria-live="polite">
          <span>{providerStatus}</span>
          <button onClick={() => setProviderStatus(null)} aria-label="关闭状态提示">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
