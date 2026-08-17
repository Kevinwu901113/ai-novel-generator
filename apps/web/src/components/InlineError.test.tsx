// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InlineError } from './InlineError';

describe('InlineError', () => {
  afterEach(() => {
    cleanup();
  });

  it('banner 变体默认渲染 role=alert 的错误文案', () => {
    render(<InlineError>保存失败</InlineError>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('保存失败');
  });

  it('field 变体同样保留 role=alert（字段级小字号提示）', () => {
    render(<InlineError variant="field">项目名称不能为空</InlineError>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('项目名称不能为空');
    expect(alert.tagName).toBe('SPAN');
  });

  it('未提供 onDismiss 时不渲染关闭按钮', () => {
    render(<InlineError>保存失败</InlineError>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('提供 onDismiss 时渲染关闭按钮，点击触发回调', () => {
    const onDismiss = vi.fn();
    render(<InlineError onDismiss={onDismiss}>保存失败</InlineError>);
    const button = screen.getByRole('button', { name: '关闭错误提示' });
    button.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('可自定义关闭按钮的可访问名称', () => {
    const onDismiss = vi.fn();
    render(
      <InlineError onDismiss={onDismiss} dismissLabel="清除测试失败提示">
        测试失败
      </InlineError>,
    );
    expect(screen.getByRole('button', { name: '清除测试失败提示' })).toBeInTheDocument();
  });
});
