// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  afterEach(() => {
    cleanup();
  });

  it('默认自带 role=status 与可访问名称', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('加载中');
  });

  it('可自定义无障碍标签', () => {
    render(<Spinner label="验证中" />);
    expect(screen.getByRole('status')).toHaveTextContent('验证中');
  });

  it('label=null 时降级为纯装饰图标，不产生独立 status', () => {
    render(<Spinner label={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('图标默认 aria-hidden，不会被朗读两次', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    const icon = status.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('尊重 prefers-reduced-motion：图标带 motion-reduce 降级类', () => {
    render(<Spinner />);
    const icon = screen.getByRole('status').querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('motion-reduce:animate-none');
  });
});
