// @vitest-environment jsdom
/**
 * 产品工作区页面骨架测试。
 *
 * 证明：
 * - 五个产品页面骨架可独立渲染（标题 / 描述 / 空状态）；
 * - ProductWorkflowContainer 按主链顺序渲染五个阶段并标记当前阶段；
 * - 页面骨架不访问 window.desktop（不依赖任何 DesktopAPI）；
 * - onNavigate 为纯 UI 未来接入点，可被装配方注入。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { IdeaIntakePage } from '../idea-intake/IdeaIntakePage';
import { ResearchPage } from '../research/ResearchPage';
import { BlueprintPage } from '../blueprint/BlueprintPage';
import { GenerationPage } from '../generation/GenerationPage';
import { ProductPageFrame } from './ProductPageFrame';
import { ProductWorkflowContainer } from './ProductWorkflowContainer';

afterEach(() => {
  cleanup();
  // 页面骨架不应访问 window.desktop；明确置空以暴露任何意外访问。
  window.desktop = undefined as never;
});

// ── 页面骨架独立渲染 ────────────────────────────────────────────────

describe('产品页面骨架独立渲染', () => {
  it('IdeaIntakePage 渲染想法入口与空状态', () => {
    render(<IdeaIntakePage isActive />);

    expect(screen.getByRole('heading', { name: '想法' })).toBeInTheDocument();
    expect(screen.getByText('告诉我你想写什么')).toBeInTheDocument();
    expect(screen.getByText('当前阶段')).toBeInTheDocument();
  });

  it('ResearchPage 渲染调研空状态', () => {
    render(<ResearchPage />);

    expect(screen.getByRole('heading', { name: '调研' })).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
  });

  it('BlueprintPage 渲染规划空状态', () => {
    render(<BlueprintPage />);

    expect(screen.getByRole('heading', { name: '规划' })).toBeInTheDocument();
  });

  it('GenerationPage 渲染生成空状态', () => {
    render(<GenerationPage />);

    expect(screen.getByRole('heading', { name: '生成' })).toBeInTheDocument();
  });

  it('ProductPageFrame 渲染稿件占位', () => {
    render(
      <ProductPageFrame title="稿件" description="稿件描述" isActive={false} onNavigate={undefined}>
        <p>稿件空状态</p>
      </ProductPageFrame>,
    );

    expect(screen.getByRole('heading', { name: '稿件' })).toBeInTheDocument();
    expect(screen.getByText('稿件空状态')).toBeInTheDocument();
  });
});

// ── 容器装配 ────────────────────────────────────────────────────────

describe('ProductWorkflowContainer', () => {
  it('按主链顺序渲染五个阶段', () => {
    render(<ProductWorkflowContainer />);

    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(5);

    const titles = items.map((item) => item.querySelector('h3')?.textContent);
    expect(titles).toEqual(['想法', '调研', '规划', '生成', '稿件']);
  });

  it('activeIndex 标记当前阶段', () => {
    render(<ProductWorkflowContainer activeIndex={1} />);

    // 调研为当前阶段
    const researchPage = screen.getByRole('heading', { name: '调研' }).closest('section');
    expect(researchPage).toHaveAttribute('aria-current', 'step');
    expect(within(researchPage as HTMLElement).getByText('当前阶段')).toBeInTheDocument();

    // 想法为非当前阶段
    const ideaPage = screen.getByRole('heading', { name: '想法' }).closest('section');
    expect(ideaPage).not.toHaveAttribute('aria-current');
  });

  it('onNavigate 为可注入的未来接入点（纯 UI）', () => {
    const onNavigate = vi.fn();
    render(<IdeaIntakePage onNavigate={onNavigate} />);

    const action = screen.getByRole('button', { name: '进入想法' });
    fireEvent.click(action);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

// ── 不访问 DesktopAPI ───────────────────────────────────────────────

describe('产品页不访问不存在的 DesktopAPI', () => {
  it('渲染页面骨架不抛出（window.desktop 未定义）', () => {
    // window.desktop 已由 afterEach 置为 undefined，任何访问都会抛错。
    expect(() => {
      render(
        <>
          <IdeaIntakePage />
          <ResearchPage />
          <BlueprintPage />
          <GenerationPage />
          <ProductWorkflowContainer />
        </>,
      );
    }).not.toThrow();

    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThanOrEqual(4);
  });
});
