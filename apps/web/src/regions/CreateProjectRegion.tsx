/**
 * 新建项目区域组件。
 *
 * 独立渲染首页灵感入口或面板式新建项目表单，包含：
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
import { AlertCircle } from 'lucide-react';
import type { DataServiceStatus } from '@ai-novel/contracts';
import { EmptyState } from '@/components/EmptyState';
import { InlineError } from '@/components/InlineError';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_NAME_LENGTH = 100;
const MAX_IDEA_LENGTH = 20_000;

function unicodeLength(str: string): number {
  return [...str].length;
}

interface CreateProjectRegionProps {
  variant?: 'panel' | 'home';
  dataServiceStatus: DataServiceStatus;
  onRetry: () => void;
  onCreate: (name: string, idea: string) => Promise<boolean>;
}

export function CreateProjectRegion({
  variant = 'panel',
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
  const isHome = variant === 'home';

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

  const content = (
    <div
      className={isHome ? 'w-full' : 'flex-1 overflow-y-auto p-4'}
      aria-labelledby={variant === 'panel' ? 'create-project-heading' : undefined}
    >
      {isDataServiceStarting ? (
        <div
          role="status"
          className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-center text-muted-foreground"
        >
          <Spinner label={null} size={24} />
          <p className="text-[15px]">数据服务启动中，请稍候…</p>
        </div>
      ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
        <EmptyState
          icon={AlertCircle}
          message="数据服务不可用"
          hint="无法创建项目，请检查数据服务状态"
          actionLabel="重试数据服务"
          onAction={onRetry}
        />
      ) : (
        <div
          className={cn('flex max-w-[600px] flex-col gap-5', isHome && 'max-w-none gap-4')}
          role="form"
          aria-label="创建新项目"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name" className={isHome ? 'text-xs text-muted-foreground' : ''}>
              项目名称
            </Label>
            <Input
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
              className={isHome ? 'rounded-[10px] bg-background/88' : ''}
            />
            <div className="flex min-h-5 items-center justify-between">
              {formErrors.name && (
                <InlineError variant="field" id="project-name-error">
                  {formErrors.name}
                </InlineError>
              )}
              <span className="ml-auto text-xs text-muted-foreground" id="project-name-count">
                {unicodeLength(formName.trim())} / {MAX_NAME_LENGTH}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-idea" className={isHome ? 'text-xs text-muted-foreground' : ''}>
              描述你想写的小说……
            </Label>
            <Textarea
              ref={ideaInputRef}
              id="project-idea"
              value={formIdea}
              onChange={(e) => {
                setFormIdea(e.target.value);
                setFormErrors((prev) => ({ ...prev, initialIdea: '' }));
              }}
              placeholder="可以是模糊的想法、灵感片段、想写的题材……"
              rows={isHome ? 6 : 10}
              disabled={isCreating}
              aria-invalid={formErrors.initialIdea ? 'true' : undefined}
              aria-describedby={ideaDescribedBy || undefined}
              aria-required="true"
              className={cn(
                'resize-y',
                isHome ? 'min-h-32 rounded-[10px] bg-background/88 leading-[1.7]' : 'min-h-[150px]',
              )}
            />
            <div className="flex min-h-5 items-center justify-between">
              {formErrors.initialIdea && (
                <InlineError variant="field" id="project-idea-error">
                  {formErrors.initialIdea}
                </InlineError>
              )}
              <span className="ml-auto text-xs text-muted-foreground" id="project-idea-count">
                {unicodeLength(formIdea.trim())} / {MAX_IDEA_LENGTH.toLocaleString()}
              </span>
            </div>
          </div>

          <Button
            onClick={handleCreate}
            disabled={isCreating || dataServiceStatus !== 'ready'}
            aria-busy={isCreating ? 'true' : undefined}
            aria-label={isCreating ? '正在创建项目' : isHome ? '开始整理想法' : '创建项目'}
            className={cn('self-start', isHome && 'min-h-11 self-stretch rounded-[10px] text-sm')}
          >
            {isCreating ? '正在开始…' : isHome ? '开始整理想法' : '创建项目'}
          </Button>
        </div>
      )}
    </div>
  );

  if (isHome) {
    return content;
  }

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 id="create-project-heading" className="text-sm font-semibold">
          新建项目
        </h2>
      </div>
      {content}
    </>
  );
}
