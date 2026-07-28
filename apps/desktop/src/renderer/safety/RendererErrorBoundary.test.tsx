// @vitest-environment jsdom
/**
 * RendererErrorBoundary 测试。
 *
 * 覆盖：
 * 1. 捕获异常
 * 2. fallback 不显示原始异常
 * 3. 点击重新加载后子树重新挂载
 * 4. Grill 崩溃不影响 TaskCenter
 * 5. TaskCenter 崩溃不影响 Provider
 * 6. 区域隔离
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { RendererErrorBoundary } from './RendererErrorBoundary';

// ── 测试用崩溃组件 ────────────────────────────────────────────────

function ThrowingComponent({ message = '测试异常' }: { message?: string }) {
  throw new Error(message);
}

function WorkingComponent({ text = '正常工作' }: { text?: string }) {
  return <div data-testid="working">{text}</div>;
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('RendererErrorBoundary', () => {
  afterEach(() => {
    cleanup();
  });

  // 1. 捕获异常并显示 fallback
  it('捕获异常并显示 fallback', () => {
    // 抑制 React 的错误边界控制台输出
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('测试加载异常')).toBeInTheDocument();
    expect(screen.getByText('重新加载此区域')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  // 2. fallback 不显示原始异常
  it('fallback 不显示原始异常', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent message="/Users/foo/secret.txt 操作失败" />
      </RendererErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('/Users/');
    expect(alert.textContent).not.toContain('secret.txt');
    expect(alert.textContent).not.toContain('操作失败');

    consoleSpy.mockRestore();
  });

  // 3. 点击重新加载后子树重新挂载
  it('点击重新加载后子树重新挂载', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;

    function ConditionalThrow() {
      if (shouldThrow) {
        throw new Error('测试异常');
      }
      return <div data-testid="recovered">已恢复</div>;
    }

    render(
      <RendererErrorBoundary label="测试">
        <ConditionalThrow />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // 修改条件，点击重新加载后不再抛异常
    shouldThrow = false;
    act(() => {
      screen.getByText('重新加载此区域').click();
    });

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  // 4. 正常渲染时显示子组件
  it('正常渲染时显示子组件', () => {
    render(
      <RendererErrorBoundary label="测试">
        <WorkingComponent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByTestId('working')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 5. 安全消息从错误中提取
  it('安全消息从错误中提取', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent message="网络连接失败" />
      </RendererErrorBoundary>,
    );

    // 安全的错误消息会直接显示
    expect(screen.getByText('网络连接失败')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});

describe('Error Boundary 区域隔离', () => {
  afterEach(() => {
    cleanup();
  });

  // 4. Grill 崩溃不影响 TaskCenter
  it('Grill 崩溃不影响 TaskCenter', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <RendererErrorBoundary label="Grill 工作台">
          <ThrowingComponent message="Grill 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="任务中心">
          <WorkingComponent text="TaskCenter 正常" />
        </RendererErrorBoundary>
      </div>,
    );

    // Grill 应该显示错误
    expect(screen.getByText('Grill 工作台加载异常')).toBeInTheDocument();

    // TaskCenter 应该正常工作
    expect(screen.getByText('TaskCenter 正常')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  // 5. TaskCenter 崩溃不影响 Provider
  it('TaskCenter 崩溃不影响 Provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <RendererErrorBoundary label="任务中心">
          <ThrowingComponent message="TaskCenter 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="模型服务">
          <WorkingComponent text="Provider 正常" />
        </RendererErrorBoundary>
      </div>,
    );

    // TaskCenter 应该显示错误
    expect(screen.getByText('任务中心加载异常')).toBeInTheDocument();

    // Provider 应该正常工作
    expect(screen.getByText('Provider 正常')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  // 6. 多个区域独立工作
  it('多个区域独立工作', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <RendererErrorBoundary label="区域A">
          <WorkingComponent text="区域A 正常" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域B">
          <ThrowingComponent message="区域B 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域C">
          <WorkingComponent text="区域C 正常" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('区域A 正常')).toBeInTheDocument();
    expect(screen.getByText('区域B加载异常')).toBeInTheDocument();
    expect(screen.getByText('区域C 正常')).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});
