/**
 * 新建项目区域组件。
 *
 * 独立渲染中栏新建项目表单，包含：
 * - 数据服务状态判断
 * - 表单输入和验证
 * - 创建按钮
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响其他区域。
 *
 * 无障碍特性：
 * - label 与输入框正确关联（htmlFor/id）
 * - 校验失败字段设置 aria-invalid="true"
 * - 错误文本通过稳定 id + aria-describedby 关联
 * - 字符计数通过 aria-describedby 可读
 * - 创建中按钮 disabled + aria-busy
 * - 创建失败保留输入内容
 * - 创建失败后焦点保持在第一个无效字段
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { DataServiceStatus } from '@ai-novel/contracts';

const MAX_NAME_LENGTH = 100;
const MAX_IDEA_LENGTH = 20_000;

function unicodeLength(str: string): number {
  return [...str].length;
}

interface CreateProjectRegionProps {
  dataServiceStatus: DataServiceStatus;
  onRetry: () => void;
  onCreate: (name: string, idea: string) => Promise<boolean>;
}

export function CreateProjectRegion({
  dataServiceStatus,
  onRetry,
  onCreate,
}: CreateProjectRegionProps) {
  const [formName, setFormName] = useState('');
  const [formIdea, setFormIdea] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const ideaInputRef = useRef<HTMLTextAreaElement>(null);

  const isDataServiceStarting = dataServiceStatus === 'starting';

  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};

    const nameTrimmed = formName.trim();
    if (nameTrimmed.length === 0) {
      errors.name = '项目名称不能为空';
    } else if (unicodeLength(nameTrimmed) > MAX_NAME_LENGTH) {
      errors.name = `项目名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }

    const ideaTrimmed = formIdea.trim();
    if (ideaTrimmed.length === 0) {
      errors.initialIdea = '初始想法不能为空';
    } else if (unicodeLength(ideaTrimmed) > MAX_IDEA_LENGTH) {
      errors.initialIdea = `初始想法不能超过 ${MAX_IDEA_LENGTH} 个字符`;
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formName, formIdea]);

  /**
   * 创建失败后焦点保持在第一个无效字段。
   * 仅在 attempted 为 true 且有错误时触发。
   */
  useEffect(() => {
    if (!attempted) return;
    if (formErrors.name && nameInputRef.current) {
      nameInputRef.current.focus();
    } else if (formErrors.initialIdea && ideaInputRef.current) {
      ideaInputRef.current.focus();
    }
  }, [formErrors, attempted]);

  const handleCreate = useCallback(async () => {
    if (isCreating || dataServiceStatus !== 'ready') return;
    setAttempted(true);

    if (!validateForm()) return;

    setIsCreating(true);
    try {
      const succeeded = await onCreate(formName.trim(), formIdea.trim());
      if (succeeded) {
        setFormName('');
        setFormIdea('');
        setFormErrors({});
        setAttempted(false);
      }
      // 失败时保留输入内容，不强制移走焦点
    } finally {
      setIsCreating(false);
    }
  }, [formName, formIdea, isCreating, dataServiceStatus, validateForm, onCreate]);

  // 构建 aria-describedby 值
  const nameDescribedBy = [formErrors.name ? 'project-name-error' : null, 'project-name-count']
    .filter(Boolean)
    .join(' ');

  const ideaDescribedBy = [
    formErrors.initialIdea ? 'project-idea-error' : null,
    'project-idea-count',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className="panel-header">
        <h2 id="create-project-heading">新建项目</h2>
      </div>
      <div className="panel-content" aria-labelledby="create-project-heading">
        {isDataServiceStarting ? (
          <div className="empty-state" role="status">
            <p className="loading-indicator" aria-hidden="true">
              ⟳
            </p>
            <p>数据服务启动中，请稍候…</p>
          </div>
        ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
          <div className="empty-state">
            <p>数据服务不可用</p>
            <p className="empty-hint">无法创建项目，请检查数据服务状态</p>
            <button className="btn-retry" onClick={onRetry}>
              重试数据服务
            </button>
          </div>
        ) : (
          <div className="create-form" role="form" aria-label="创建新项目">
            <div className="form-field">
              <label htmlFor="project-name">项目名称</label>
              <input
                ref={nameInputRef}
                id="project-name"
                type="text"
                value={formName}
                onChange={(e) => {
                  setFormName(e.target.value);
                  setFormErrors((prev) => ({ ...prev, name: '' }));
                }}
                placeholder="给你的小说起个名字"
                maxLength={200}
                disabled={isCreating}
                aria-invalid={formErrors.name ? 'true' : undefined}
                aria-describedby={nameDescribedBy || undefined}
                aria-required="true"
              />
              <div className="form-field-footer">
                {formErrors.name && (
                  <span className="form-error" id="project-name-error" role="alert">
                    {formErrors.name}
                  </span>
                )}
                <span className="char-count" id="project-name-count">
                  {unicodeLength(formName.trim())} / {MAX_NAME_LENGTH}
                </span>
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="project-idea">描述你想写的小说……</label>
              <textarea
                ref={ideaInputRef}
                id="project-idea"
                value={formIdea}
                onChange={(e) => {
                  setFormIdea(e.target.value);
                  setFormErrors((prev) => ({ ...prev, initialIdea: '' }));
                }}
                placeholder="可以是模糊的想法、灵感片段、想写的题材……"
                rows={10}
                disabled={isCreating}
                aria-invalid={formErrors.initialIdea ? 'true' : undefined}
                aria-describedby={ideaDescribedBy || undefined}
                aria-required="true"
              />
              <div className="form-field-footer">
                {formErrors.initialIdea && (
                  <span className="form-error" id="project-idea-error" role="alert">
                    {formErrors.initialIdea}
                  </span>
                )}
                <span className="char-count" id="project-idea-count">
                  {unicodeLength(formIdea.trim())} / {MAX_IDEA_LENGTH.toLocaleString()}
                </span>
              </div>
            </div>

            <button
              className="btn-create"
              onClick={handleCreate}
              disabled={isCreating || dataServiceStatus !== 'ready'}
              aria-busy={isCreating ? 'true' : undefined}
              aria-label={isCreating ? '正在创建项目' : '创建项目'}
            >
              {isCreating ? '创建中…' : '创建项目'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
