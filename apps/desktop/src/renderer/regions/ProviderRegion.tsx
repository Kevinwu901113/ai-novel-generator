/**
 * 模型服务区域组件（B1：多模型服务）。
 *
 * 独立渲染设置抽屉中的模型服务信息，包含：
 * - 模型服务列表（多条）
 * - 新增模型服务
 * - 设为默认 / 删除
 * - API Key 管理（按服务分别配置）
 * - 连接测试（按服务分别测试）
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响 TaskCenter。
 *
 * 无障碍特性：
 * - API Key 输入有 sr-only label
 * - 保存/测试中 aria-busy
 * - 删除确认 Escape 取消
 * - 取消/删除 Key 后焦点恢复到删除按钮
 * - 删除 Key 成功后焦点移到 API Key 输入
 * - 错误 role="alert"
 * - 状态 role="status"
 * - 确认区域 role="group"
 * - 焦点管理使用受控 state + useEffect，无 document 级 listener
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectionTestResult,
  CreateProviderProfileInput,
  DataServiceStatus,
  ProviderProtocol,
  ProviderPublicState,
} from '@ai-novel/contracts';
import { PROVIDER_PROTOCOLS } from '@ai-novel/contracts';
import { ERROR_CODE_LABELS } from '../safety/error-code-labels';
import { toSafeUserError } from '../safety/safe-error';

/** 格式化时间 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** 协议的中文说明（附带协议标识值作为次要说明） */
const PROTOCOL_LABELS: Readonly<Record<ProviderProtocol, string>> = {
  'anthropic-messages': 'Anthropic 消息协议（anthropic-messages）',
  'openai-chat': 'OpenAI 兼容协议（openai-chat）',
};

/** 简单校验：仅接受 http/https 开头的地址 */
function isValidBaseUrl(value: string): boolean {
  return /^https?:\/\/\S+/i.test(value.trim());
}

interface ProviderRegionProps {
  providers: ReadonlyArray<ProviderPublicState>;
  dataServiceStatus: DataServiceStatus;
  onCreate: (input: CreateProviderProfileInput) => Promise<void>;
  onSetDefault: (profileId: string) => Promise<void>;
  onRemove: (profileId: string) => Promise<void>;
  onSaveApiKey: (profileId: string, apiKey: string) => Promise<void>;
  onDeleteApiKey: (profileId: string) => Promise<void>;
  onTestConnection: (profileId: string) => Promise<ConnectionTestResult | void>;
}

export function ProviderRegion({
  providers,
  dataServiceStatus,
  onCreate,
  onSetDefault,
  onRemove,
  onSaveApiKey,
  onDeleteApiKey,
  onTestConnection,
}: ProviderRegionProps) {
  const isReady = dataServiceStatus === 'ready';

  return (
    <div className="provider-region">
      <ProviderCreateForm isReady={isReady} onCreate={onCreate} />

      <ul className="provider-list" aria-label="模型服务列表">
        {providers.length === 0 && (
          <li className="provider-empty" role="status">
            尚未添加任何模型服务
          </li>
        )}
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            isReady={isReady}
            onSetDefault={onSetDefault}
            onRemove={onRemove}
            onSaveApiKey={onSaveApiKey}
            onDeleteApiKey={onDeleteApiKey}
            onTestConnection={onTestConnection}
          />
        ))}
      </ul>
    </div>
  );
}

// ── 新增模型服务表单 ──────────────────────────────────────────────

interface ProviderCreateFormProps {
  isReady: boolean;
  onCreate: (input: CreateProviderProfileInput) => Promise<void>;
}

function ProviderCreateForm({ isReady, onCreate }: ProviderCreateFormProps) {
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState<ProviderProtocol>(PROVIDER_PROTOCOLS[0]);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const labelTrimmed = label.trim();
  const baseUrlTrimmed = baseUrl.trim();
  const modelTrimmed = model.trim();

  const labelInvalid = attempted && labelTrimmed.length === 0;
  const baseUrlInvalid = attempted && !isValidBaseUrl(baseUrlTrimmed);
  const modelInvalid = attempted && modelTrimmed.length === 0;

  const canSubmit =
    isReady &&
    !isSubmitting &&
    labelTrimmed.length > 0 &&
    isValidBaseUrl(baseUrlTrimmed) &&
    modelTrimmed.length > 0;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setAttempted(true);
      if (!isReady || isSubmitting) return;
      if (
        labelTrimmed.length === 0 ||
        !isValidBaseUrl(baseUrlTrimmed) ||
        modelTrimmed.length === 0
      ) {
        return;
      }

      setIsSubmitting(true);
      setFormError(null);
      try {
        await onCreate({
          label: labelTrimmed,
          protocol,
          baseUrl: baseUrlTrimmed,
          model: modelTrimmed,
        });
        setLabel('');
        setBaseUrl('');
        setModel('');
        setAttempted(false);
      } catch (err) {
        const safe = toSafeUserError(err, '添加模型服务失败');
        setFormError(safe.message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [isReady, isSubmitting, labelTrimmed, baseUrlTrimmed, modelTrimmed, protocol, onCreate],
  );

  return (
    <form className="provider-create-form" onSubmit={handleSubmit} aria-label="新增模型服务">
      <div className="form-field">
        <label htmlFor="provider-label">名称</label>
        <input
          id="provider-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="给这个模型服务起个名字"
          disabled={isSubmitting}
          aria-invalid={labelInvalid ? 'true' : undefined}
          aria-describedby={labelInvalid ? 'provider-label-error' : undefined}
        />
        {labelInvalid && (
          <span className="form-error" id="provider-label-error" role="alert">
            名称不能为空
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="provider-protocol">协议</label>
        <select
          id="provider-protocol"
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
          disabled={isSubmitting}
        >
          {PROVIDER_PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {PROTOCOL_LABELS[p]}
            </option>
          ))}
        </select>
        <p className="form-hint">
          {protocol === 'anthropic-messages'
            ? '地址请勿包含 /v1，系统会自动补全为 /v1/messages。'
            : '地址需包含版本段（如 https://api.deepseek.com/v1），系统会自动补全 /chat/completions。'}
        </p>
      </div>

      <div className="form-field">
        <label htmlFor="provider-base-url">服务地址</label>
        <input
          id="provider-base-url"
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://..."
          disabled={isSubmitting}
          aria-invalid={baseUrlInvalid ? 'true' : undefined}
          aria-describedby={baseUrlInvalid ? 'provider-base-url-error' : undefined}
        />
        {baseUrlInvalid && (
          <span className="form-error" id="provider-base-url-error" role="alert">
            请填写以 http:// 或 https:// 开头的地址
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="provider-model">模型标识</label>
        <input
          id="provider-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="模型标识"
          disabled={isSubmitting}
          aria-invalid={modelInvalid ? 'true' : undefined}
          aria-describedby={modelInvalid ? 'provider-model-error' : undefined}
        />
        {modelInvalid && (
          <span className="form-error" id="provider-model-error" role="alert">
            模型标识不能为空
          </span>
        )}
      </div>

      {formError && (
        <div className="provider-error" role="alert" aria-live="assertive">
          <span>{formError}</span>
          <button type="button" onClick={() => setFormError(null)} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}

      <button
        type="submit"
        className="btn-create"
        disabled={!canSubmit}
        aria-busy={isSubmitting ? 'true' : undefined}
        aria-label={isSubmitting ? '正在添加模型服务' : '添加模型服务'}
      >
        {isSubmitting ? '添加中…' : '添加模型服务'}
      </button>
    </form>
  );
}

// ── 单条模型服务 ─────────────────────────────────────────────────

interface ProviderRowProps {
  provider: ProviderPublicState;
  isReady: boolean;
  onSetDefault: (profileId: string) => Promise<void>;
  onRemove: (profileId: string) => Promise<void>;
  onSaveApiKey: (profileId: string, apiKey: string) => Promise<void>;
  onDeleteApiKey: (profileId: string) => Promise<void>;
  onTestConnection: (profileId: string) => Promise<ConnectionTestResult | void>;
}

function ProviderRow({
  provider,
  isReady,
  onSetDefault,
  onRemove,
  onSaveApiKey,
  onDeleteApiKey,
  onTestConnection,
}: ProviderRowProps) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isDeletingKey, setIsDeletingKey] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isSettingDefault, setIsSettingDefault] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [deleteKeyConfirmVisible, setDeleteKeyConfirmVisible] = useState(false);
  const [removeConfirmVisible, setRemoveConfirmVisible] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  // 焦点管理 refs（API Key 删除确认）
  const deleteKeyBtnRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteKeyBtnRef = useRef<HTMLButtonElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const shouldRestoreKeyFocusRef = useRef(false);
  const shouldFocusApiKeyRef = useRef(false);

  // 焦点管理 refs（删除模型服务确认）
  const removeBtnRef = useRef<HTMLButtonElement>(null);
  const confirmRemoveBtnRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreRemoveFocusRef = useRef(false);

  const { hasApiKey } = provider;

  // 删除 Key 确认显示时，焦点移到确认按钮
  useEffect(() => {
    if (deleteKeyConfirmVisible && confirmDeleteKeyBtnRef.current) {
      confirmDeleteKeyBtnRef.current.focus();
    }
  }, [deleteKeyConfirmVisible]);

  // 删除 Key 确认隐藏后，恢复焦点到删除按钮
  useEffect(() => {
    if (!deleteKeyConfirmVisible && shouldRestoreKeyFocusRef.current) {
      shouldRestoreKeyFocusRef.current = false;
      const timer = setTimeout(() => {
        deleteKeyBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [deleteKeyConfirmVisible]);

  // hasApiKey 变为 false 且需要聚焦 API Key 输入时
  useEffect(() => {
    if (!hasApiKey && shouldFocusApiKeyRef.current) {
      shouldFocusApiKeyRef.current = false;
      const timer = setTimeout(() => {
        apiKeyInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [hasApiKey]);

  // 删除模型服务确认显示时，焦点移到确认按钮
  useEffect(() => {
    if (removeConfirmVisible && confirmRemoveBtnRef.current) {
      confirmRemoveBtnRef.current.focus();
    }
  }, [removeConfirmVisible]);

  // 删除模型服务确认隐藏后，恢复焦点到删除按钮
  useEffect(() => {
    if (!removeConfirmVisible && shouldRestoreRemoveFocusRef.current) {
      shouldRestoreRemoveFocusRef.current = false;
      const timer = setTimeout(() => {
        removeBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [removeConfirmVisible]);

  const handleSaveApiKey = useCallback(async () => {
    if (isSavingKey || !isReady) return;
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;

    setIsSavingKey(true);
    setRowError(null);
    try {
      await onSaveApiKey(provider.id, trimmed);
      setApiKeyInput('');
    } catch (err) {
      const safe = toSafeUserError(err, '保存失败');
      setRowError(safe.message);
    } finally {
      setIsSavingKey(false);
    }
  }, [apiKeyInput, isSavingKey, isReady, onSaveApiKey, provider.id]);

  const handleDeleteKeyClick = useCallback(() => {
    setDeleteKeyConfirmVisible(true);
  }, []);

  const handleDeleteKeyConfirm = useCallback(async () => {
    if (!isReady) return;
    setIsDeletingKey(true);
    setRowError(null);
    try {
      shouldFocusApiKeyRef.current = true;
      await onDeleteApiKey(provider.id);
      setDeleteKeyConfirmVisible(false);
    } catch (err) {
      shouldFocusApiKeyRef.current = false;
      const safe = toSafeUserError(err, '删除失败');
      setRowError(safe.message);
    } finally {
      setIsDeletingKey(false);
    }
  }, [isReady, onDeleteApiKey, provider.id]);

  const handleDeleteKeyCancel = useCallback(() => {
    shouldRestoreKeyFocusRef.current = true;
    setDeleteKeyConfirmVisible(false);
  }, []);

  const handleDeleteKeyKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDeleteKeyCancel();
      }
    },
    [handleDeleteKeyCancel],
  );

  const handleTestConnection = useCallback(async () => {
    if (isTestingConnection || !isReady) return;
    setIsTestingConnection(true);
    setRowError(null);
    try {
      await onTestConnection(provider.id);
    } catch (err) {
      const safe = toSafeUserError(err, '测试失败');
      setRowError(safe.message);
    } finally {
      setIsTestingConnection(false);
    }
  }, [isTestingConnection, isReady, onTestConnection, provider.id]);

  const handleSetDefault = useCallback(async () => {
    if (isSettingDefault || !isReady || provider.isDefault) return;
    setIsSettingDefault(true);
    setRowError(null);
    try {
      await onSetDefault(provider.id);
    } catch (err) {
      const safe = toSafeUserError(err, '设置默认失败');
      setRowError(safe.message);
    } finally {
      setIsSettingDefault(false);
    }
  }, [isSettingDefault, isReady, provider.isDefault, onSetDefault, provider.id]);

  const handleRemoveClick = useCallback(() => {
    setRemoveConfirmVisible(true);
  }, []);

  const handleRemoveConfirm = useCallback(async () => {
    if (!isReady) return;
    setIsRemoving(true);
    setRowError(null);
    try {
      await onRemove(provider.id);
      setRemoveConfirmVisible(false);
    } catch (err) {
      const safe = toSafeUserError(err, '删除失败');
      setRowError(safe.message);
    } finally {
      setIsRemoving(false);
    }
  }, [isReady, onRemove, provider.id]);

  const handleRemoveCancel = useCallback(() => {
    shouldRestoreRemoveFocusRef.current = true;
    setRemoveConfirmVisible(false);
  }, []);

  const handleRemoveKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleRemoveCancel();
      }
    },
    [handleRemoveCancel],
  );

  return (
    <li className={`provider-item${provider.isDefault ? ' provider-item-default' : ''}`}>
      <div className="provider-info">
        <p>
          <strong>模型服务：</strong>
          {provider.label}
          {provider.isDefault && (
            <span className="provider-default-badge" role="status">
              默认
            </span>
          )}
        </p>
        <p>
          <strong>协议：</strong>
          {PROTOCOL_LABELS[provider.protocol]}
        </p>
        <p>
          <strong>模型：</strong>
          {provider.model}
        </p>
        <p>
          <strong>地址：</strong>
          {provider.baseUrl}
        </p>
        <p>
          <strong>API Key：</strong>
          <span role="status" aria-live="polite">
            {provider.hasApiKey ? '已配置' : '未配置'}
          </span>
        </p>
        {provider.lastTestStatus !== 'never' && (
          <>
            <p>
              <strong>最近测试：</strong>
              {provider.lastTestStatus === 'success'
                ? '连接正常'
                : provider.lastTestErrorCode
                  ? `[${provider.lastTestErrorCode}] ${ERROR_CODE_LABELS[provider.lastTestErrorCode] ?? '测试失败'}`
                  : '测试失败'}
            </p>
            <p>
              <strong>测试时间：</strong>
              {formatTime(provider.lastTestedAt)}
            </p>
            {provider.lastTestLatencyMs !== null && (
              <p>
                <strong>延迟：</strong>
                {provider.lastTestLatencyMs}ms
              </p>
            )}
          </>
        )}
      </div>

      {/* API Key 编辑 */}
      <div className="provider-key-section">
        {!provider.hasApiKey ? (
          <div className="provider-key-input">
            <label htmlFor={`provider-api-key-${provider.id}`} className="sr-only">
              API Key
            </label>
            <input
              ref={apiKeyInputRef}
              id={`provider-api-key-${provider.id}`}
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
            {!deleteKeyConfirmVisible ? (
              <button
                ref={deleteKeyBtnRef}
                className="btn-danger"
                onClick={handleDeleteKeyClick}
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
                onKeyDown={handleDeleteKeyKeyDown}
              >
                <span>确认删除？</span>
                <button
                  ref={confirmDeleteKeyBtnRef}
                  className="btn-danger"
                  onClick={handleDeleteKeyConfirm}
                  disabled={isDeletingKey}
                  aria-label="确认删除 API Key"
                >
                  {isDeletingKey ? '删除中…' : '确认'}
                </button>
                <button
                  onClick={handleDeleteKeyCancel}
                  disabled={isDeletingKey}
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
          disabled={isTestingConnection || !provider.hasApiKey || !isReady}
          aria-busy={isTestingConnection}
          aria-label={isTestingConnection ? '测试中' : '测试连接'}
          title={!provider.hasApiKey ? '请先配置 API Key' : undefined}
        >
          {isTestingConnection ? '正在连接…' : '测试连接'}
        </button>
      </div>

      {/* 设为默认 / 删除模型服务 */}
      <div className="provider-actions-section">
        <button
          onClick={handleSetDefault}
          disabled={isSettingDefault || provider.isDefault || !isReady}
          aria-label={provider.isDefault ? '已是默认模型服务' : '设为默认模型服务'}
        >
          {provider.isDefault ? '默认服务' : '设为默认'}
        </button>

        {!removeConfirmVisible ? (
          <button
            ref={removeBtnRef}
            className="btn-danger"
            onClick={handleRemoveClick}
            disabled={!isReady || isRemoving}
            aria-label="删除模型服务"
          >
            删除
          </button>
        ) : (
          <div
            className="delete-confirm"
            role="group"
            aria-label="确认删除模型服务"
            onKeyDown={handleRemoveKeyDown}
          >
            <span>确认删除该模型服务？</span>
            <button
              ref={confirmRemoveBtnRef}
              className="btn-danger"
              onClick={handleRemoveConfirm}
              disabled={isRemoving}
              aria-label="确认删除模型服务"
            >
              {isRemoving ? '删除中…' : '确认'}
            </button>
            <button onClick={handleRemoveCancel} disabled={isRemoving} aria-label="取消删除">
              取消
            </button>
          </div>
        )}
      </div>

      {/* 错误信息 */}
      {rowError && (
        <div className="provider-error" role="alert" aria-live="assertive">
          <span>{rowError}</span>
          <button onClick={() => setRowError(null)} aria-label="关闭错误提示">
            ✕
          </button>
        </div>
      )}
    </li>
  );
}
