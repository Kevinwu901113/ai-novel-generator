// @vitest-environment jsdom
/**
 * ProviderRegion 测试（B1：多模型服务）。
 *
 * 覆盖：
 * 1. 列表渲染多个模型服务，默认项有可识别标记
 * 2. 新增流程：填表 → 调用 create 且入参正确 → 触发刷新
 * 3. 测试连接：成功与失败两种结果的展示
 * 4. 保存 / 删除 Key 按 profileId 调用
 * 5. 设为默认、删除（含二次确认）
 * 6. 失败路径不泄露上游内容
 * 7. 表单校验：label 空、baseUrl 非 http(s) 时不发起调用
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderRegion } from './ProviderRegion';
import type { ProviderPublicState, DesktopAPI } from '@ai-novel/contracts';

// ── Mock 数据 ────────────────────────────────────────────────────────

const providerA: ProviderPublicState = {
  id: 'provider-a',
  label: 'MiMo V2.5 Pro',
  protocol: 'anthropic-messages',
  baseUrl: 'https://api.mimo.example',
  model: 'mimo-v2.5-pro',
  enabled: true,
  isDefault: true,
  hasApiKey: true,
  lastTestedAt: null,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

const providerB: ProviderPublicState = {
  id: 'provider-b',
  label: 'DeepSeek',
  protocol: 'openai-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  enabled: true,
  isDefault: false,
  hasApiKey: false,
  lastTestedAt: null,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestLatencyMs: null,
};

function noop(): void {
  // no-op default
}

function makeProps(overrides: Partial<React.ComponentProps<typeof ProviderRegion>> = {}) {
  return {
    providers: [providerA, providerB],
    dataServiceStatus: 'ready' as const,
    onCreate: vi.fn().mockResolvedValue(undefined),
    onSetDefault: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onSaveApiKey: vi.fn().mockResolvedValue(undefined),
    onDeleteApiKey: vi.fn().mockResolvedValue(undefined),
    onTestConnection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
  vi.restoreAllMocks();
  noop();
});

describe('ProviderRegion 列表渲染', () => {
  it('渲染多个模型服务，默认项有可识别标记', () => {
    render(<ProviderRegion {...makeProps()} />);

    expect(screen.getByText('MiMo V2.5 Pro')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);

    const defaultItem = items.find((li) => li.textContent?.includes('MiMo V2.5 Pro'));
    expect(defaultItem).toBeDefined();
    expect(within(defaultItem as HTMLElement).getByText('默认')).toBeInTheDocument();

    const otherItem = items.find((li) => li.textContent?.includes('DeepSeek'));
    expect(otherItem).toBeDefined();
    expect(within(otherItem as HTMLElement).queryByText('默认')).not.toBeInTheDocument();
  });

  it('无模型服务时显示空态', () => {
    render(<ProviderRegion {...makeProps({ providers: [] })} />);
    expect(screen.getByText('尚未添加任何模型服务')).toBeInTheDocument();
  });
});

describe('ProviderRegion 新增流程', () => {
  it('填表并提交后以正确入参调用 onCreate', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onCreate })} />);

    await user.type(screen.getByLabelText('名称'), '新服务');
    await user.selectOptions(screen.getByLabelText('协议'), 'openai-chat');
    await user.type(screen.getByLabelText('服务地址'), 'https://api.example.com/v1');
    await user.type(screen.getByLabelText('模型标识'), 'example-model');

    await user.click(screen.getByRole('button', { name: '添加模型服务' }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        label: '新服务',
        protocol: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
      });
    });
  });

  it('label 为空时不发起调用', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onCreate })} />);

    await user.type(screen.getByLabelText('服务地址'), 'https://api.example.com/v1');
    await user.type(screen.getByLabelText('模型标识'), 'example-model');
    await user.click(screen.getByRole('button', { name: '添加模型服务' }));

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('baseUrl 非 http(s) 时不发起调用', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onCreate })} />);

    await user.type(screen.getByLabelText('名称'), '新服务');
    await user.type(screen.getByLabelText('服务地址'), 'ftp://not-http.example.com');
    await user.type(screen.getByLabelText('模型标识'), 'example-model');
    await user.click(screen.getByRole('button', { name: '添加模型服务' }));

    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('ProviderRegion 测试连接', () => {
  it('测试连接成功后调用 onTestConnection', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockResolvedValue({
      success: true,
      latencyMs: 120,
      errorCode: null,
      errorMessage: null,
    });
    render(<ProviderRegion {...makeProps({ onTestConnection })} />);

    const items = screen.getAllByRole('listitem');
    const defaultItem = items.find((li) =>
      li.textContent?.includes('MiMo V2.5 Pro'),
    ) as HTMLElement;
    const testBtn = within(defaultItem).getByRole('button', { name: '测试连接' });

    await user.click(testBtn);

    await waitFor(() => {
      expect(onTestConnection).toHaveBeenCalledWith('provider-a');
    });
  });

  it('测试连接失败时只展示归一化中文消息，不泄露上游内容', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockRejectedValue(
      Object.assign(new Error('upstream 500: /Users/secret/leak sk-abc123456789'), {
        code: 'PROVIDER_TIMEOUT',
      }),
    );
    render(<ProviderRegion {...makeProps({ onTestConnection })} />);

    const items = screen.getAllByRole('listitem');
    const defaultItem = items.find((li) =>
      li.textContent?.includes('MiMo V2.5 Pro'),
    ) as HTMLElement;
    const testBtn = within(defaultItem).getByRole('button', { name: '测试连接' });

    await user.click(testBtn);

    await waitFor(() => {
      expect(within(defaultItem).getByText('连接超时')).toBeInTheDocument();
    });

    expect(screen.queryByText(/upstream 500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sk-abc123456789/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/Users\/secret/)).not.toBeInTheDocument();
  });

  it('无 unhandled rejection', async () => {
    const onTestConnection = vi.fn().mockRejectedValue(new Error('连接超时'));
    render(<ProviderRegion {...makeProps({ onTestConnection })} />);

    const items = screen.getAllByRole('listitem');
    const defaultItem = items.find((li) =>
      li.textContent?.includes('MiMo V2.5 Pro'),
    ) as HTMLElement;
    const testBtn = within(defaultItem).getByRole('button', { name: '测试连接' });

    await act(async () => {
      testBtn.click();
    });

    expect(onTestConnection).toHaveBeenCalled();
  });
});

describe('ProviderRegion API Key 操作', () => {
  it('保存 Key 时按 profileId 调用 onSaveApiKey', async () => {
    const user = userEvent.setup();
    const onSaveApiKey = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onSaveApiKey })} />);

    const items = screen.getAllByRole('listitem');
    // DeepSeek（provider-b）未配置 Key
    const deepseekItem = items.find((li) => li.textContent?.includes('DeepSeek')) as HTMLElement;
    const input = within(deepseekItem).getByPlaceholderText('输入 API Key');
    await user.type(input, 'my-secret-key');
    await user.click(within(deepseekItem).getByRole('button', { name: '保存 API Key' }));

    await waitFor(() => {
      expect(onSaveApiKey).toHaveBeenCalledWith('provider-b', 'my-secret-key');
    });
  });

  it('删除 Key 需二次确认后按 profileId 调用 onDeleteApiKey', async () => {
    const user = userEvent.setup();
    const onDeleteApiKey = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onDeleteApiKey })} />);

    const items = screen.getAllByRole('listitem');
    // MiMo（provider-a）已配置 Key
    const mimoItem = items.find((li) => li.textContent?.includes('MiMo V2.5 Pro')) as HTMLElement;
    await user.click(within(mimoItem).getByRole('button', { name: '删除 API Key' }));

    // 二次确认出现前不应调用
    expect(onDeleteApiKey).not.toHaveBeenCalled();
    expect(within(mimoItem).getByText('确认删除？')).toBeInTheDocument();

    await user.click(within(mimoItem).getByRole('button', { name: '确认删除 API Key' }));

    await waitFor(() => {
      expect(onDeleteApiKey).toHaveBeenCalledWith('provider-a');
    });
  });
});

describe('ProviderRegion 设为默认与删除', () => {
  it('设为默认按钮按 profileId 调用 onSetDefault', async () => {
    const user = userEvent.setup();
    const onSetDefault = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onSetDefault })} />);

    const items = screen.getAllByRole('listitem');
    const deepseekItem = items.find((li) => li.textContent?.includes('DeepSeek')) as HTMLElement;
    await user.click(within(deepseekItem).getByRole('button', { name: '设为默认模型服务' }));

    await waitFor(() => {
      expect(onSetDefault).toHaveBeenCalledWith('provider-b');
    });
  });

  it('删除模型服务需二次确认后按 profileId 调用 onRemove', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<ProviderRegion {...makeProps({ onRemove })} />);

    const items = screen.getAllByRole('listitem');
    const deepseekItem = items.find((li) => li.textContent?.includes('DeepSeek')) as HTMLElement;
    await user.click(within(deepseekItem).getByRole('button', { name: '删除模型服务' }));

    expect(onRemove).not.toHaveBeenCalled();
    expect(within(deepseekItem).getByText('确认删除该模型服务？')).toBeInTheDocument();

    await user.click(within(deepseekItem).getByRole('button', { name: '确认删除模型服务' }));

    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledWith('provider-b');
    });
  });
});
