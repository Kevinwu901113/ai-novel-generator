// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  afterEach(() => {
    cleanup();
  });

  it('展示主文案与可选提示', () => {
    render(<EmptyState icon={Inbox} message="还没有项目" hint="先把上面的第一个想法写下来。" />);
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
    expect(screen.getByText('先把上面的第一个想法写下来。')).toBeInTheDocument();
  });

  it('图标是装饰性的（aria-hidden），不会侵入可访问名称', () => {
    render(<EmptyState icon={Inbox} message="还没有项目" />);
    const container = screen.getByText('还没有项目').closest('div')!.parentElement!;
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('引导按钮是真实 button，点击触发回调', () => {
    const onAction = vi.fn();
    render(
      <EmptyState icon={Inbox} message="还没有项目" actionLabel="新建项目" onAction={onAction} />,
    );
    const button = screen.getByRole('button', { name: '新建项目' });
    button.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('未提供 actionLabel/onAction 时不渲染按钮', () => {
    render(<EmptyState icon={Inbox} message="还没有项目" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
