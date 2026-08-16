// @vitest-environment jsdom
/**
 * TokenGate 测试（B12）。
 *
 * 覆盖：
 * - 无 token 显示令牌录入页
 * - 录入成功（mock window.desktop.healthCheck 成功）渲染 children
 * - healthCheck 失败显示错误提示
 * - 'ai-novel:auth-required' 事件把已授权态拉回录入态
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { TokenGate } from './TokenGate';
import { AUTH_TOKEN_STORAGE_KEY, AUTH_REQUIRED_EVENT } from '../desktop-client';

function setInputValue(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function renderAsync(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result!;
}

describe('TokenGate', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  it('无 token 时显示令牌录入页，不渲染 children', async () => {
    await renderAsync(
      <TokenGate>
        <div>受保护内容</div>
      </TokenGate>,
    );

    expect(screen.getByText('AI 小说创作代理')).toBeInTheDocument();
    expect(screen.getByLabelText('访问令牌')).toBeInTheDocument();
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
  });

  it('录入令牌并验证成功后渲染 children', async () => {
    window.desktop = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true, timestamp: 't', version: '1.0.0' }),
    } as unknown as DesktopAPI;

    await renderAsync(
      <TokenGate>
        <div>受保护内容</div>
      </TokenGate>,
    );

    const input = screen.getByLabelText('访问令牌');
    setInputValue(input, 'valid-token');

    await act(async () => {
      screen.getByRole('button', { name: /进入|确认/ }).click();
    });

    await waitFor(() => {
      expect(screen.getByText('受保护内容')).toBeInTheDocument();
    });
    expect(window.desktop.healthCheck).toHaveBeenCalled();
  });

  it('healthCheck 失败时显示「令牌无效，请重新输入」', async () => {
    window.desktop = {
      healthCheck: vi.fn().mockRejectedValue(new Error('访问令牌缺失或无效')),
    } as unknown as DesktopAPI;

    await renderAsync(
      <TokenGate>
        <div>受保护内容</div>
      </TokenGate>,
    );

    const input = screen.getByLabelText('访问令牌');
    setInputValue(input, 'bad-token');

    await act(async () => {
      screen.getByRole('button', { name: /进入|确认/ }).click();
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('令牌无效，请重新输入');
    });
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
  });

  it('ai-novel:auth-required 事件把已授权态拉回录入态', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'existing-token');
    window.desktop = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true, timestamp: 't', version: '1.0.0' }),
    } as unknown as DesktopAPI;

    await renderAsync(
      <TokenGate>
        <div>受保护内容</div>
      </TokenGate>,
    );

    expect(screen.getByText('受保护内容')).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    });

    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(screen.getByLabelText('访问令牌')).toBeInTheDocument();
  });
});
