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
 * - API Key 输入有 sr-only label
 * - 保存/测试中 aria-busy
 * - 删除确认 Escape 取消
 * - 取消/删除后焦点恢复到删除按钮
 * - 删除成功后焦点移到 API Key 输入
 * - 错误 role="alert"
 * - 状态 role="status"
 * - 确认区域 role="group"
 * - 焦点管理使用受控 state + useEffect，无 document 级 listener
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  // 焦点管理 refs
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  // 标记是否需要在删除确认隐藏后恢复焦点到删除按钮
  const shouldRestoreFocusRef = useRef(false);
  // 标记是否需要在删除成功后聚焦 API Key 输入
  const shouldFocusApiKeyRef = useRef(false);

  const isReady = dataServiceStatus === 'ready';
  const hasApiKey = providerState?.hasApiKey ?? false;

  // 删除确认显示时，焦点移到确认删除按钮
  useEffect(() => {
    if (deleteConfirmVisible && confirmBtnRef.current) {
      confirmBtnRef.current.focus();
    }
  }, [deleteConfirmVisible]);

  // 删除确认隐藏后，恢复焦点到删除按钮
  useEffect(() => {
    if (!deleteConfirmVisible && shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      // 使用 setTimeout 确保 DOM 更新后再聚焦
      const timer = setTimeout(() => {
        deleteBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [deleteConfirmVisible]);

  // hasApiKey 变为 false 且需要聚焦 API Key 输入时
  useEffect(() => {
    if (!hasApiKey && shouldFocusApiKeyRef.current) {
      shouldFocusApiKeyRef.current = false;
      const timer = setTimeout(() => {
        apiKeyInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [hasApiKey]);

  const handleSaveApiKey = useCallback(async () => {
    if (isSavingKey || !isReady) return;
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
  }, [apiKeyInput, isSavingKey, isReady, onSaveApiKey]);

  const handleDeleteClick = useCallback(() => {
    setDeleteConfirmVisible(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!isReady) return;

    setIsDeleting(true);
    setProviderError(null);

    try {
      shouldFocusApiKeyRef.current = true;
      await onDeleteApiKey();
      setDeleteConfirmVisible(false);
    } catch (err) {
      // 删除失败时清理 shouldFocusApiKeyRef
      shouldFocusApiKeyRef.current = false;
      const safe = toSafeUserError(err, '删除失败');
      setProviderError(safe.message);
    } finally {
      setIsDeleting(false);
    }
  }, [isReady, onDeleteApiKey]);

  const handleDeleteCancel = useCallback(() => {
    shouldRestoreFocusRef.current = true;
    setDeleteConfirmVisible(false);
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (isTestingConnection || !isReady) return;

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
  }, [isTestingConnection, isReady, onTestConnection]);

  /** 确认区域的键盘事件处理 */
  const handleConfirmKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDeleteCancel();
      }
    },
    [handleDeleteCancel],
  );

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
          <span role="status" aria-live="polite">
            {providerState.hasApiKey ? '已配置' : '未配置'}
          </span>
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
            <label htmlFor="provider-api-key" className="sr-only">
              API Key
            </label>
            <input
              ref={apiKeyInputRef}
              id="provider-api-key"
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="输入 API Key"
              disabled={isSavingKey || !isReady}
              maxLength={8192}
            />
            <button
              onClick={handleSaveApiKey}
              disabled={isSavingKey || !apiKeyInput.trim() || !isReady}
              aria-busy={isSavingKey}
              aria-label={isSavingKey ? '保存中' : '保存 API Key'}
            >
              {isSavingKey ? '保存中…' : '保存'}
            </button>
          </div>
        ) : (
          <div className="provider-key-actions">
            {!deleteConfirmVisible ? (
              <button
                ref={deleteBtnRef}
                className="btn-danger"
                onClick={handleDeleteClick}
                disabled={!isReady}
                aria-label="删除 API Key"
              >
                删除密钥
              </button>
            ) : (
              <div
                className="delete-confirm"
                role="group"
                aria-label="确认删除 API Key"
                onKeyDown={handleConfirmKeyDown}
              >
                <span>确认删除？</span>
                <button
                  ref={confirmBtnRef}
                  className="btn-danger"
                  onClick={handleDeleteConfirm}
                  disabled={isDeleting}
                  aria-label="确认删除 API Key"
                >
                  {isDeleting ? '删除中…' : '确认'}
                </button>
                <button onClick={handleDeleteCancel} disabled={isDeleting} aria-label="取消删除">
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
          disabled={isTestingConnection || !providerState.hasApiKey || !isReady}
          aria-busy={isTestingConnection}
          aria-label={isTestingConnection ? '测试中' : '测试连接'}
          title={!providerState.hasApiKey ? '请先配置 API Key' : undefined}
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
    </>
  );
}
