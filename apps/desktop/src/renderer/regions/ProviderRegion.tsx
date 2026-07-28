/**
 * 模型服务商配置区域（只读安全）。
 *
 * 只允许：保存 API Key、删除 API Key、测试连接。
 * 不允许：修改 providerType / model、写 projects/*、读取项目数据。
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
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

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

  const handleSave = useCallback(async () => {
    if (!apiKeyInput.trim()) {
      setError('请输入 API Key');
      return;
    }
    setIsSaving(true);
    setError(null);
    setTestResult(null);
    try {
      await onSaveApiKey(apiKeyInput.trim());
      setApiKeyInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  }, [apiKeyInput, onSaveApiKey]);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setError(null);
    setTestResult(null);
    try {
      await onTestConnection();
      setTestResult('连接成功');
    } catch (err) {
      setError(err instanceof Error ? err.message : '测试失败');
    } finally {
      setIsTesting(false);
    }
  }, [onTestConnection]);

  const handleDeleteClick = useCallback(() => {
    setDeleteConfirmVisible(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    setIsDeleting(true);
    setError(null);
    try {
      shouldFocusApiKeyRef.current = true;
      await onDeleteApiKey();
      setDeleteConfirmVisible(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setIsDeleting(false);
    }
  }, [onDeleteApiKey]);

  const handleDeleteCancel = useCallback(() => {
    shouldRestoreFocusRef.current = true;
    setDeleteConfirmVisible(false);
  }, []);

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

  return (
    <div className="provider-region">
      {/* 状态显示 */}
      <div className="provider-info">
        <div className="provider-info-row">
          <span className="provider-label">状态</span>
          <span className="provider-value" role="status" aria-live="polite">
            {hasApiKey ? '已配置' : '未配置'}
          </span>
        </div>
        {providerState?.displayName && (
          <div className="provider-info-row">
            <span className="provider-label">服务商</span>
            <span className="provider-value">{providerState.displayName}</span>
          </div>
        )}
        {providerState?.model && (
          <div className="provider-info-row">
            <span className="provider-label">模型</span>
            <span className="provider-value">{providerState.model}</span>
          </div>
        )}
      </div>

      {/* API Key 输入 */}
      {!hasApiKey && (
        <div className="provider-input-row">
          <label htmlFor="provider-api-key" className="sr-only">
            API Key
          </label>
          <input
            ref={apiKeyInputRef}
            id="provider-api-key"
            type="password"
            className="provider-input"
            placeholder="输入 API Key"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            disabled={!isReady || isSaving}
          />
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!isReady || isSaving}
            aria-busy={isSaving}
            aria-label={isSaving ? '保存中' : '保存 API Key'}
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      )}

      {/* 操作按钮 */}
      {hasApiKey && (
        <div className="provider-actions">
          <button
            className="btn-test"
            onClick={handleTest}
            disabled={!isReady || isTesting}
            aria-busy={isTesting}
            aria-label={isTesting ? '测试中' : '测试连接'}
          >
            {isTesting ? '测试中...' : '测试连接'}
          </button>
          <button
            ref={deleteBtnRef}
            className="btn-delete"
            onClick={handleDeleteClick}
            disabled={!isReady}
            aria-label="删除 API Key"
          >
            删除密钥
          </button>
        </div>
      )}

      {/* 删除确认 */}
      {deleteConfirmVisible && (
        <div
          className="provider-delete-confirm"
          role="group"
          aria-label="确认删除 API Key"
          onKeyDown={handleConfirmKeyDown}
        >
          <p className="delete-confirm-text">确认删除 API Key？此操作不可撤销。</p>
          <div className="delete-confirm-actions">
            <button
              ref={confirmBtnRef}
              className="btn-confirm-delete"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              aria-label="确认删除 API Key"
            >
              {isDeleting ? '删除中...' : '确认删除'}
            </button>
            <button
              className="btn-cancel-delete"
              onClick={handleDeleteCancel}
              disabled={isDeleting}
              aria-label="取消删除"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="provider-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {/* 测试结果 */}
      {testResult && (
        <div className="provider-test-result" role="status" aria-live="polite">
          {testResult}
        </div>
      )}
    </div>
  );
}
