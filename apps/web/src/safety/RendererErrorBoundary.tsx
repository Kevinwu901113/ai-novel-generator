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
 *
 * 无障碍特性：
 * - fallback 出现后将焦点移动到 fallback 容器
 * - fallback 容器使用 tabIndex={-1}
 * - 保留固定静态错误消息
 * - 不显示原始异常
 * - "重新加载此区域"按钮保持可键盘操作
 * - reset 后焦点进入重新挂载区域
 * - 不在普通 rerender 时重复抢焦点
 * - 焦点样式通过 CSS .restored-focus-container 提供可见替代
 */

import { Component, createRef, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 区域名称，用于 fallback 显示 */
  label: string;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
  /** 重置计数器，用于强制重新挂载子树 */
  resetCount: number;
  /** 标记是否需要在下次渲染后设置焦点 */
  shouldFocusFallback: boolean;
  /** 标记是否需要在 reset 后设置焦点到恢复内容 */
  shouldFocusRestored: boolean;
}

/** 真正可聚焦的元素选择器 */
const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  private fallbackRef = createRef<HTMLDivElement>();
  private restoredRef = createRef<HTMLDivElement>();
  private focusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: RendererErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      resetCount: 0,
      shouldFocusFallback: false,
      shouldFocusRestored: false,
    };
  }

  static getDerivedStateFromError(): Partial<RendererErrorBoundaryState> {
    // 不保存任何原始异常信息
    return { hasError: true, shouldFocusFallback: true };
  }

  override componentDidMount(): void {
    // React 19 StrictMode 下 error boundary 可能仅触发 componentDidMount 而非 componentDidUpdate
    this.scheduleFocusIfNeeded();
  }

  override componentDidUpdate(
    _prevProps: RendererErrorBoundaryProps,
    _prevState: RendererErrorBoundaryState,
  ): void {
    this.scheduleFocusIfNeeded();
  }

  /** 调度焦点移动（共享 componentDidMount / componentDidUpdate 逻辑） */
  private scheduleFocusIfNeeded(): void {
    // fallback 出现后将焦点移动到 fallback 容器
    if (this.state.shouldFocusFallback && this.fallbackRef.current) {
      const ref = this.fallbackRef.current;
      // 使用 setTimeout 确保在 React DOM 更新后设置焦点
      this.focusTimer = setTimeout(() => {
        ref.focus();
        this.focusTimer = null;
      }, 0);
      this.setState({ shouldFocusFallback: false });
    }

    // reset 后焦点进入重新挂载区域
    if (this.state.shouldFocusRestored && this.restoredRef.current) {
      const container = this.restoredRef.current;
      this.focusTimer = setTimeout(() => {
        // 尝试找到首个真正可聚焦元素
        const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          // 没有真实可聚焦元素时聚焦恢复容器
          container.focus();
        }
        this.focusTimer = null;
      }, 0);
      this.setState({ shouldFocusRestored: false });
    }
  }

  override componentWillUnmount(): void {
    this.clearFocusTimer();
  }

  private clearFocusTimer(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  private handleReset = (): void => {
    this.setState((prev) => ({
      hasError: false,
      resetCount: prev.resetCount + 1,
      shouldFocusRestored: true,
    }));
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          ref={this.fallbackRef}
          className="error-boundary-fallback"
          role="alert"
          tabIndex={-1}
          aria-label={`${this.props.label}加载异常`}
        >
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
      <div ref={this.restoredRef} tabIndex={-1} className="restored-focus-container">
        <RendererErrorBoundaryInner key={this.state.resetCount}>
          {this.props.children}
        </RendererErrorBoundaryInner>
      </div>
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
