/**
 * 搜索服务（Tavily）API Key 面板（B6，D-B6-5）。
 *
 * 全局单槽位（无 profileId，独立于任何项目），挂在创作服务设置抽屉、与
 * "模型提供商"（ProviderRegion）并列。镜像 ProviderRow 的 key 区块结构与无障碍处理：
 * - 未配置：password input（sr-only label）+ 保存按钮（aria-busy）；
 * - 已配置：删除按钮 + 二次确认（role="group"、Escape 取消、焦点管理）；
 * - 不做测试连接（无对应后端，D-B6-5 明确不新增）。
 *
 * 保存成功后仅做一次性反馈提示："已保存，等待中的调研任务将自动继续"——
 * worker 侧 TD-026-2 尾随重扫会自动重驱动等待中的 RESEARCH_RUN 任务，
 * UI 不需要、也不应该额外触发任何刷新动作。
 *
 * dataServiceStatus 镜像 ProviderRegion 的 isReady 门控：数据服务未就绪前
 * （app 冷启动的短暂窗口）不发起 IPC 调用、操作按钮禁用，就绪后立即读取一次
 * （不轮询——key 有无很少变化，App 级 dataServiceStatus 变化已足够触发重读）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataServiceStatus } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';

export interface SearchKeyPanelProps {
  readonly dataServiceStatus: DataServiceStatus;
  readonly onStatusChange?: (hasApiKey: boolean) => void;
}

export function SearchKeyPanel({ dataServiceStatus, onStatusChange }: SearchKeyPanelProps) {
  const isReady = dataServiceStatus === 'ready';
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isDeletingKey, setIsDeletingKey] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // 焦点管理 refs（镜像 ProviderRow）
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteBtnRef = useRef<HTMLButtonElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const shouldRestoreFocusRef = useRef(false);
  const shouldFocusApiKeyRef = useRef(false);

  useEffect(() => {
    if (!isReady) return undefined;
    let cancelled = false;
    void window.desktop.search
      .hasApiKey()
      .then((state) => {
        if (!cancelled) {
          setHasApiKey(state.hasApiKey);
          onStatusChange?.(state.hasApiKey);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(toSafeUserError(err, '读取搜索服务 API Key 状态失败').message);
          setHasApiKey(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isReady, onStatusChange]);

  // 删除确认显示时，焦点移到确认按钮
  useEffect(() => {
    if (deleteConfirmVisible && confirmDeleteBtnRef.current) {
      confirmDeleteBtnRef.current.focus();
    }
  }, [deleteConfirmVisible]);

  // 删除确认隐藏后，恢复焦点到删除按钮
  useEffect(() => {
    if (!deleteConfirmVisible && shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false;
      const timer = setTimeout(() => {
        deleteBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [deleteConfirmVisible]);

  // hasApiKey 变为 false 且需要聚焦 API Key 输入时
  useEffect(() => {
    if (hasApiKey === false && shouldFocusApiKeyRef.current) {
      shouldFocusApiKeyRef.current = false;
      const timer = setTimeout(() => {
        apiKeyInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [hasApiKey]);

  const handleSave = useCallback(async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed || isSavingKey || !isReady) return;
    setIsSavingKey(true);
    setError(null);
    setSavedNotice(false);
    try {
      const state = await window.desktop.search.saveApiKey({ apiKey: trimmed });
      setHasApiKey(state.hasApiKey);
      onStatusChange?.(state.hasApiKey);
      setApiKeyInput('');
      setSavedNotice(true);
    } catch (err) {
      setError(toSafeUserError(err, '保存搜索服务 API Key 失败').message);
    } finally {
      setIsSavingKey(false);
    }
  }, [apiKeyInput, isSavingKey, isReady, onStatusChange]);

  const handleDeleteClick = useCallback(() => {
    setDeleteConfirmVisible(true);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    shouldRestoreFocusRef.current = true;
    setDeleteConfirmVisible(false);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!isReady) return;
    setIsDeletingKey(true);
    setError(null);
    try {
      shouldFocusApiKeyRef.current = true;
      const state = await window.desktop.search.deleteApiKey();
      setHasApiKey(state.hasApiKey);
      onStatusChange?.(state.hasApiKey);
      setDeleteConfirmVisible(false);
    } catch (err) {
      shouldFocusApiKeyRef.current = false;
      setError(toSafeUserError(err, '删除搜索服务 API Key 失败').message);
    } finally {
      setIsDeletingKey(false);
    }
  }, [isReady, onStatusChange]);

  const handleDeleteKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDeleteCancel();
      }
    },
    [handleDeleteCancel],
  );

  return (
    <div className="search-key-panel">
      {error && (
        <div className="search-key-error" role="alert" aria-live="assertive">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      {!isReady || hasApiKey === null ? (
        <p className="search-key-loading" role="status">
          正在读取搜索服务配置…
        </p>
      ) : !hasApiKey ? (
        <div className="search-key-input">
          <label htmlFor="search-api-key" className="sr-only">
            搜索服务 API Key
          </label>
          <input
            ref={apiKeyInputRef}
            id="search-api-key"
            type="password"
            value={apiKeyInput}
            onChange={(e) => {
              setApiKeyInput(e.target.value);
              setSavedNotice(false);
            }}
            placeholder="输入 Tavily API Key"
            disabled={isSavingKey || !isReady}
            maxLength={8192}
          />
          <button
            onClick={() => void handleSave()}
            disabled={isSavingKey || !apiKeyInput.trim() || !isReady}
            aria-busy={isSavingKey}
            aria-label={isSavingKey ? '保存中' : '保存搜索服务 API Key'}
          >
            {isSavingKey ? '保存中…' : '保存'}
          </button>
        </div>
      ) : (
        <div className="search-key-actions">
          <span role="status" aria-live="polite">
            已配置
          </span>
          {!deleteConfirmVisible ? (
            <button
              ref={deleteBtnRef}
              className="btn-danger"
              onClick={handleDeleteClick}
              disabled={!isReady}
              aria-label="删除搜索服务 API Key"
            >
              删除密钥
            </button>
          ) : (
            <div
              className="delete-confirm"
              role="group"
              aria-label="确认删除搜索服务 API Key"
              onKeyDown={handleDeleteKeyDown}
            >
              <span>确认删除？</span>
              <button
                ref={confirmDeleteBtnRef}
                className="btn-danger"
                onClick={() => void handleDeleteConfirm()}
                disabled={isDeletingKey}
                aria-label="确认删除搜索服务 API Key"
              >
                {isDeletingKey ? '删除中…' : '确认'}
              </button>
              <button onClick={handleDeleteCancel} disabled={isDeletingKey} aria-label="取消删除">
                取消
              </button>
            </div>
          )}
        </div>
      )}

      {savedNotice && (
        <p className="search-key-saved-notice" role="status">
          已保存，等待中的调研任务将自动继续
        </p>
      )}
    </div>
  );
}
