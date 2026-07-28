/**
 * 区域错误边界组件。
 *
 * 捕获子组件树中的渲染异常，防止整个 renderer 白屏。
 * 特性：
 * - 显示稳定的中文 fallback 消息
 * - 不暴露原始 message、stack、componentStack
 * - 提供"重新加载此区域"按钮
 * - reset 后重新挂载子树
 * - boundary 自身异常不递归崩溃
 * - 不持久化错误到 localStorage、数据库或日志
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { toSafeUserError } from './safe-error';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 区域名称，用于 fallback 显示 */
  label: string;
  /** 错误回退消息 */
  fallbackMessage?: string;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
  /** 安全的错误信息，不包含原始异常 */
  safeMessage: string | null;
  /** 重置计数器，用于强制重新挂载子树 */
  resetCount: number;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  constructor(props: RendererErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      safeMessage: null,
      resetCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<RendererErrorBoundaryState> {
    // 将原始 Error 转换为安全消息，不保存原始 Error 对象
    const safe = toSafeUserError(error, '区域加载失败');
    return {
      hasError: true,
      safeMessage: safe.message,
    };
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    // 不记录原始错误到任何地方
    // 不调用 console.error、console.log 或任何日志服务
    // 不持久化到 localStorage、数据库或文件
  }

  private handleReset = (): void => {
    this.setState((prev) => ({
      hasError: false,
      safeMessage: null,
      resetCount: prev.resetCount + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const { label, fallbackMessage } = this.props;
      const displayMessage = this.state.safeMessage ?? fallbackMessage ?? '区域加载失败';

      return (
        <div className="error-boundary-fallback" role="alert">
          <div className="error-boundary-content">
            <p className="error-boundary-title">{label}加载异常</p>
            <p className="error-boundary-message">{displayMessage}</p>
            <button className="error-boundary-reset-btn" onClick={this.handleReset} type="button">
              重新加载此区域
            </button>
          </div>
        </div>
      );
    }

    // 使用 resetCount 作为 key 来强制重新挂载子树
    return (
      <RendererErrorBoundaryInner key={this.state.resetCount}>
        {this.props.children}
      </RendererErrorBoundaryInner>
    );
  }
}

/**
 * 内部组件，使用 key 来强制重新挂载。
 * 当 resetCount 变化时，React 会卸载旧的并挂载新的。
 */
function RendererErrorBoundaryInner({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
