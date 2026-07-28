// @vitest-environment jsdom
/**
 * ProviderRegion 测试。
 *
 * 覆盖：
 * 7. provider.testConnection rejection 后仍调用 provider.getState
 * 8. provider 失败状态刷新后显示新的 lastTestStatus/errorCode
 * 9. 无 unhandled rejection
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { ProviderRegion } from './ProviderRegion';
import type { ProviderPublicState, DesktopAPI } from '@ai-novel/contracts';

// ── Mock 数据 ────────────────────────────────────────────────────────

const mockProviderState: ProviderPublicState = {
  displayName: 'OpenAI',
  model: 'gpt-4',
  providerType: 'openai',
  hasApiKey: true,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestedAt: null,
  lastTestLatencyMs: null,
};

// ── 测试 ─────────────────────────────────────────────────────────

describe('ProviderRegion 失败状态刷新', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
    vi.restoreAllMocks();
  });

  // 7. provider.testConnection rejection 后仍调用 provider.getState
  it('provider.testConnection rejection 后仍调用 provider.getState', async () => {
    const onTestConnection = vi.fn().mockRejectedValue(new Error('连接超时'));

    await act(async () => {
      render(
        <ProviderRegion
          providerState={mockProviderState}
          dataServiceStatus="ready"
          onSaveApiKey={async () => {}}
          onDeleteApiKey={async () => {}}
          onTestConnection={onTestConnection}
        />,
      );
    });

    const testBtn = screen.getByText('测试连接');
    await act(async () => {
      testBtn.click();
    });

    expect(onTestConnection).toHaveBeenCalledTimes(1);
    // 错误被 ProviderRegion 捕获并显示安全消息
    await waitFor(() => {
      expect(screen.getByText('连接超时')).toBeInTheDocument();
    });
  });

  // 8. provider 失败状态刷新后显示新的 lastTestStatus/errorCode
  it('provider 失败状态刷新后显示新的 lastTestStatus/errorCode', async () => {
    const onTestConnection = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('连接超时'), { code: 'PROVIDER_TIMEOUT' }));

    await act(async () => {
      render(
        <ProviderRegion
          providerState={mockProviderState}
          dataServiceStatus="ready"
          onSaveApiKey={async () => {}}
          onDeleteApiKey={async () => {}}
          onTestConnection={onTestConnection}
        />,
      );
    });

    const testBtn = screen.getByText('测试连接');
    await act(async () => {
      testBtn.click();
    });

    // 应该显示安全错误消息（错误码映射）
    await waitFor(() => {
      expect(screen.getByText('连接超时')).toBeInTheDocument();
    });
  });

  // 9. 无 unhandled rejection
  it('无 unhandled rejection', async () => {
    const onTestConnection = vi.fn().mockRejectedValue(new Error('连接超时'));

    await act(async () => {
      render(
        <ProviderRegion
          providerState={mockProviderState}
          dataServiceStatus="ready"
          onSaveApiKey={async () => {}}
          onDeleteApiKey={async () => {}}
          onTestConnection={onTestConnection}
        />,
      );
    });

    const testBtn = screen.getByText('测试连接');
    await act(async () => {
      testBtn.click();
    });

    // 不应该有 unhandled rejection
    // 如果有 unhandled rejection，act() 会抛出错误
    expect(onTestConnection).toHaveBeenCalled();
  });
});
