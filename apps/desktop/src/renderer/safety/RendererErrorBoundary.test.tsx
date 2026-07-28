// @vitest-environment jsdom
/**
 * RendererErrorBoundary 测试。
 *
 * 使用 React 19 onCaughtError 机制测试。
 * 不 mock 全局 console，不过滤 stderr。
 *
 * 覆盖：
 * 1. 捕获异常并显示固定 fallback
 * 2. fallback 不显示原始异常
 * 3. 点击重新加载后子树重新挂载
 * 4. Grill 崩溃不影响 TaskCenter
 * 5. TaskCenter 崩溃不影响 Provider
 * 6. ProjectListRegion 崩溃不影响 CreateProjectRegion
 * 7. CreateProjectRegion 崩溃不影响右栏
 * 8. ProjectStatusRegion 崩溃不影响 TaskCenter
 * 9. ProviderRegion 崩溃不影响 TaskCenter
 * 10. 安全短异常消息也不得出现在 fallback DOM
 * 11. reset 只重新挂载对应区域
 */

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { RendererErrorBoundary } from './RendererErrorBoundary';

// ── 测试用崩溃组件 ────────────────────────────────────────────────

function ThrowingComponent({ message = '测试异常' }: { message?: string }) {
  throw new Error(message);
}

function WorkingComponent({ text = '正常工作' }: { text?: string }) {
  return <div data-testid={`working-${text}`}>{text}</div>;
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('RendererErrorBoundary 基础', () => {
  afterEach(() => {
    cleanup();
  });

  // 1. 捕获异常并显示固定 fallback
  it('捕获异常并显示固定 fallback', () => {
    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('测试加载异常')).toBeInTheDocument();
    expect(screen.getByText('该区域暂时无法显示，请重新加载。')).toBeInTheDocument();
    expect(screen.getByText('重新加载此区域')).toBeInTheDocument();
  });

  // 2. fallback 不显示原始异常
  it('fallback 不显示原始异常', () => {
    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent message="/Users/foo/secret.txt 操作失败" />
      </RendererErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('/Users/');
    expect(alert.textContent).not.toContain('secret.txt');
    expect(alert.textContent).not.toContain('操作失败');
    expect(alert.textContent).not.toContain('测试异常');
  });

  // 3. 点击重新加载后子树重新挂载
  it('点击重新加载后子树重新挂载', () => {
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

    shouldThrow = false;
    act(() => {
      screen.getByText('重新加载此区域').click();
    });

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 4. 正常渲染时显示子组件
  it('正常渲染时显示子组件', () => {
    render(
      <RendererErrorBoundary label="测试">
        <WorkingComponent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByTestId('working-正常工作')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 5. 安全短异常消息也不得出现在 fallback DOM
  it('安全短异常消息也不得出现在 fallback DOM', () => {
    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent message="网络连接失败" />
      </RendererErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('网络连接失败');
    expect(alert.textContent).toContain('该区域暂时无法显示，请重新加载。');
  });

  // 6. 固定显示 label + 固定消息
  it('固定显示 label 和固定消息', () => {
    render(
      <RendererErrorBoundary label="Grill 工作台">
        <ThrowingComponent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByText('Grill 工作台加载异常')).toBeInTheDocument();
    expect(screen.getByText('该区域暂时无法显示，请重新加载。')).toBeInTheDocument();
  });
});

describe('Error Boundary 区域隔离', () => {
  afterEach(() => {
    cleanup();
  });

  // 7. Grill 崩溃不影响 TaskCenter
  it('Grill 崩溃不影响 TaskCenter', () => {
    render(
      <div>
        <RendererErrorBoundary label="Grill 工作台">
          <ThrowingComponent message="Grill 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="任务中心">
          <WorkingComponent text="TaskCenter" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('Grill 工作台加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-TaskCenter')).toBeInTheDocument();
  });

  // 8. TaskCenter 崩溃不影响 Provider
  it('TaskCenter 崩溃不影响 Provider', () => {
    render(
      <div>
        <RendererErrorBoundary label="任务中心">
          <ThrowingComponent message="TaskCenter 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="模型服务">
          <WorkingComponent text="Provider" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('任务中心加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-Provider')).toBeInTheDocument();
  });

  // 9. ProjectListRegion 崩溃不影响 CreateProjectRegion
  it('ProjectListRegion 崩溃不影响 CreateProjectRegion', () => {
    render(
      <div>
        <RendererErrorBoundary label="项目列表">
          <ThrowingComponent message="列表崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="新建项目">
          <WorkingComponent text="CreateProject" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('项目列表加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-CreateProject')).toBeInTheDocument();
  });

  // 10. CreateProjectRegion 崩溃不影响右栏
  it('CreateProjectRegion 崩溃不影响右栏', () => {
    render(
      <div>
        <RendererErrorBoundary label="新建项目">
          <ThrowingComponent message="创建崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="任务中心">
          <WorkingComponent text="RightPanel" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('新建项目加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-RightPanel')).toBeInTheDocument();
  });

  // 11. ProjectStatusRegion 崩溃不影响 TaskCenter
  it('ProjectStatusRegion 崩溃不影响 TaskCenter', () => {
    render(
      <div>
        <RendererErrorBoundary label="项目状态">
          <ThrowingComponent message="状态崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="任务中心">
          <WorkingComponent text="TaskCenter2" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('项目状态加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-TaskCenter2')).toBeInTheDocument();
  });

  // 12. ProviderRegion 崩溃不影响 TaskCenter
  it('ProviderRegion 崩溃不影响 TaskCenter', () => {
    render(
      <div>
        <RendererErrorBoundary label="模型服务">
          <ThrowingComponent message="Provider 崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="任务中心">
          <WorkingComponent text="TaskCenter3" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByText('模型服务加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-TaskCenter3')).toBeInTheDocument();
  });

  // 13. 多个区域独立工作
  it('多个区域独立工作', () => {
    render(
      <div>
        <RendererErrorBoundary label="区域A">
          <WorkingComponent text="A" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域B">
          <ThrowingComponent message="B崩溃" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域C">
          <WorkingComponent text="C" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByTestId('working-A')).toBeInTheDocument();
    expect(screen.getByText('区域B加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-C')).toBeInTheDocument();
  });

  // 14. reset 只重新挂载对应区域
  it('reset 只重新挂载对应区域', () => {
    let throwB = true;

    function ConditionalThrowB() {
      if (throwB) throw new Error('B 崩溃');
      return <div data-testid="B-recovered">B 已恢复</div>;
    }

    render(
      <div>
        <RendererErrorBoundary label="区域A">
          <WorkingComponent text="A-stable" />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域B">
          <ConditionalThrowB />
        </RendererErrorBoundary>
        <RendererErrorBoundary label="区域C">
          <WorkingComponent text="C-stable" />
        </RendererErrorBoundary>
      </div>,
    );

    expect(screen.getByTestId('working-A-stable')).toBeInTheDocument();
    expect(screen.getByText('区域B加载异常')).toBeInTheDocument();
    expect(screen.getByTestId('working-C-stable')).toBeInTheDocument();

    throwB = false;
    act(() => {
      screen.getByText('重新加载此区域').click();
    });

    expect(screen.getByTestId('working-A-stable')).toBeInTheDocument();
    expect(screen.getByTestId('B-recovered')).toBeInTheDocument();
    expect(screen.getByTestId('working-C-stable')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
