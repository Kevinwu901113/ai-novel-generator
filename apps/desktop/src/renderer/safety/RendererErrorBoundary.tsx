/**
 * 区域错误边界组件。
 *
 * 捕获子组件树中的渲染异常，防止整个 renderer 白屏。
 * 特性：
 * - 不保存、不显示任何原始异常消息
 * - 固定显示稳定中文 fallback
 * - 提供"重新加载此区域"按钮
 * - reset 后重新挂载子树
 * - boundary 自身异常不递归崩溃
 * - 不持久化错误到 localStorage、数据库或日志
 * - 不调用 toSafeUserError
 */

import { Component, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 区域名称，用于 fallback 显示 */
  label: string;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
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
      resetCount: 0,
    };
  }

  static getDerivedStateFromError(): Partial<RendererErrorBoundaryState> {
    // 不保存任何原始异常信息
    return { hasError: true };
  }

  private handleReset = (): void => {
    this.setState((prev) => ({
      hasError: false,
      resetCount: prev.resetCount + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <div className="error-boundary-content">
            <p className="error-boundary-title">{this.props.label}加载异常</p>
            <p className="error-boundary-message">该区域暂时无法显示，请重新加载。</p>
            <button className="error-boundary-reset-btn" onClick={this.handleReset} type="button">
              重新加载此区域
            </button>
          </div>
        </div>
      );
    }

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
