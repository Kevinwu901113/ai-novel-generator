// @vitest-environment jsdom
/**
 * BlueprintRegion 组件测试（B8）：各相位渲染、失效禁用 accept、gate/escalation
 * 决策入参正确、正文按 blueprintRef 拉取一次（D-B8-5）。
 *
 * 蓝图态与 run 终态由 App 探针以 props 下发（D-B8-2），故本测试直接喂 props，
 * 只 mock window.desktop 的 blueprint.getBlueprint 与 graph.applyHumanDecision。
 * **注意**：仅有本文件的组件级断言是不够的——B6 的教训是"直接挂载组件手喂 state
 * 会绕开 App 分流"，App 级可达性由 app.test.tsx 的四条覆盖。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { BlueprintStateDto, DesktopAPI, StoryBlueprintDto } from '@ai-novel/contracts';
import { BlueprintRegion } from './BlueprintRegion';

const NOW = '2026-08-11T00:00:00.000Z';
const PROJECT_ID = 'proj-1';

function blueprintDto(overrides: Partial<StoryBlueprintDto> = {}): StoryBlueprintDto {
  return {
    id: 'bp-1',
    projectId: PROJECT_ID,
    version: 2,
    premise: '一个关于星际邮差的故事前提',
    characters: [{ name: '林澈', role: '主角', description: '沉默寡言的邮差' }],
    relationships: ['林澈与调度员是旧识'],
    world: '边缘星系的通讯网',
    conflict: '送信人与收信人立场对立',
    ending: '信最终没有送达',
    plotlines: [{ name: '主线', summary: '一封信的旅程' }],
    chapters: [
      { id: 'ch-1', title: '第一封信', goal: '引入邮差与任务' },
      { id: 'ch-2', title: '折返', goal: '揭示收信人身份' },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

function state(overrides: Partial<BlueprintStateDto> = {}): BlueprintStateDto {
  return {
    runId: 'run-1',
    blueprintRef: 'bp-1',
    accepted: false,
    blueprintInvalidated: false,
    gateActive: false,
    escalationActive: false,
    rewriteUsed: 0,
    ...overrides,
  };
}

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const api = {
    blueprint: {
      getState: vi.fn(),
      getBlueprint: vi.fn().mockResolvedValue(blueprintDto()),
    },
    graph: {
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    ...overrides,
  } as unknown as DesktopAPI;
  window.desktop = api;
  return api;
}

async function renderRegion(props: Partial<React.ComponentProps<typeof BlueprintRegion>> = {}) {
  const onRefresh = vi.fn();
  await act(async () => {
    render(
      <BlueprintRegion
        projectId={PROJECT_ID}
        state={state()}
        terminalStatus={null}
        generating={false}
        stateLoading={false}
        onRefresh={onRefresh}
        {...props}
      />,
    );
  });
  return { onRefresh };
}

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
});

describe('BlueprintRegion 相位渲染', () => {
  it('无 run → 提示旅程还没开始，不拉正文', async () => {
    const api = setupDesktop();
    await renderRegion({ state: state({ runId: null, blueprintRef: null }) });
    expect(screen.getByText('创作旅程还没有开始。')).toBeInTheDocument();
    expect(api.blueprint.getBlueprint).not.toHaveBeenCalled();
  });

  it('BLUEPRINT_GENERATE 在途 → 生成中提示', async () => {
    setupDesktop();
    await renderRegion({ state: state({ blueprintRef: null }), generating: true });
    expect(screen.getByText(/正在生成故事蓝图/)).toBeInTheDocument();
  });

  it('gate → 正文 + 两个决策按钮', async () => {
    setupDesktop();
    await renderRegion({ state: state({ gateActive: true }) });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByText('版本 v2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeEnabled();
  });

  it('D-B8-4：失效 → 作废横幅 + 降级展示旧内容 + 禁用接受', async () => {
    setupDesktop();
    await renderRegion({ state: state({ gateActive: true, blueprintInvalidated: true }) });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText(/此蓝图已作废/)).toBeInTheDocument();
    // 旧内容仍在（用户需要看到才能判断）
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeEnabled();
  });

  // 复查发现的可达性缺口：让用户选"就用现在这版蓝图"却不给他看那一版。
  it('escalation → 四选项 + 同屏展示待决策的那一版正文', async () => {
    setupDesktop();
    await renderRegion({ state: state({ escalationActive: true }) });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeEnabled();
    // 但不给 gate 决策按钮——gate 并没有在等人工
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
  });

  it('escalation：失效时 accept_current 一并禁用', async () => {
    setupDesktop();
    await renderRegion({ state: state({ escalationActive: true, blueprintInvalidated: true }) });
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /修改创作要求/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /稍后再说/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /取消这个项目的蓝图/ })).toBeEnabled();
  });

  it('ready → 项目就绪面板 + 正文；不出现 gate 按钮', async () => {
    setupDesktop();
    await renderRegion({ state: state({ accepted: true }), terminalStatus: 'completed' });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText('✓ 蓝图已确认，项目就绪')).toBeInTheDocument();
    expect(screen.getByText(/蓝图规划了 2 章/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
  });

  it('run 终态且从未生成蓝图 → 只有终态文案', async () => {
    setupDesktop();
    await renderRegion({ state: state({ blueprintRef: null }), terminalStatus: 'blocked' });
    expect(screen.getByText('项目已搁置')).toBeInTheDocument();
    expect(screen.getByText('这次流程结束时蓝图还没有生成。')).toBeInTheDocument();
    // 如实的继续指引（独立复查 D4）：blocked/cancelled 没有原地恢复界面
    expect(screen.getByText(/回到"想法"阶段重新开始/)).toBeInTheDocument();
  });

  it('run 终态但已生成过蓝图 → 终态文案 + 只读展示那一版，不给决策按钮', async () => {
    setupDesktop();
    await renderRegion({ terminalStatus: 'cancelled' });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText('项目流程已取消')).toBeInTheDocument();
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
  });

  it('gate 未激活时不给决策按钮（提交必被后端拒）', async () => {
    setupDesktop();
    await renderRegion({ state: state({ blueprintInvalidated: true, gateActive: false }) });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
  });
});

describe('BlueprintRegion 决策入参', () => {
  it('accept → applyHumanDecision(kind=gate, nodeId=BLUEPRINT_USER_GATE, outcome=accept)', async () => {
    const api = setupDesktop();
    const { onRefresh } = await renderRegion({ state: state({ gateActive: true }) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByRole('button', { name: /接受这份蓝图/ }).click();
    });
    expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'gate',
        projectId: PROJECT_ID,
        runId: 'run-1',
        nodeId: 'BLUEPRINT_USER_GATE',
        outcome: 'accept',
      }),
    );
    // 决策落地后立即刷新 App 探针，不等下一轮 poll
    expect(onRefresh).toHaveBeenCalled();
  });

  it('escalation → applyHumanDecision(kind=escalation, nodeId=BLUEPRINT_ESCALATION)', async () => {
    const api = setupDesktop();
    await renderRegion({ state: state({ escalationActive: true }) });
    await act(async () => {
      screen.getByRole('button', { name: /修改创作要求/ }).click();
    });
    expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'escalation',
        nodeId: 'BLUEPRINT_ESCALATION',
        outcome: 'modify_requirements',
      }),
    );
  });

  it('决策失败 → 展示安全错误文案，不抛出', async () => {
    const api = setupDesktop();
    (api.graph.applyHumanDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('/Users/foo/secret.txt 写入失败'),
    );
    await renderRegion({ state: state({ gateActive: true }) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByRole('button', { name: /接受这份蓝图/ }).click();
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('/Users/');
  });
});

describe('BlueprintRegion 正文拉取（D-B8-5）', () => {
  it('同一 blueprintRef 重渲染不重复拉取；ref 变化才重新拉', async () => {
    const api = setupDesktop();
    const onRefresh = vi.fn();
    const props = {
      projectId: PROJECT_ID,
      terminalStatus: null,
      generating: false,
      stateLoading: false,
      onRefresh,
    };
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const result = render(<BlueprintRegion {...props} state={state({ gateActive: true })} />);
      rerender = result.rerender;
    });
    await waitFor(() => {
      expect(api.blueprint.getBlueprint).toHaveBeenCalledTimes(1);
    });

    // 同 ref、只是 rewriteUsed 变了 → 不应重新拉正文
    await act(async () => {
      rerender(<BlueprintRegion {...props} state={state({ gateActive: true, rewriteUsed: 1 })} />);
    });
    expect(api.blueprint.getBlueprint).toHaveBeenCalledTimes(1);

    // ref 变化（重新生成后新版本）→ 重新拉
    (api.blueprint.getBlueprint as ReturnType<typeof vi.fn>).mockResolvedValue(
      blueprintDto({ id: 'bp-2', version: 3 }),
    );
    await act(async () => {
      rerender(
        <BlueprintRegion {...props} state={state({ gateActive: true, blueprintRef: 'bp-2' })} />,
      );
    });
    await waitFor(() => {
      expect(api.blueprint.getBlueprint).toHaveBeenCalledTimes(2);
    });
    expect(api.blueprint.getBlueprint).toHaveBeenLastCalledWith({
      projectId: PROJECT_ID,
      blueprintId: 'bp-2',
    });
  });

  it('正文拉不到（null）→ 不可用提示，不空白', async () => {
    const api = setupDesktop();
    (api.blueprint.getBlueprint as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await renderRegion({ state: state({ gateActive: true }) });
    await waitFor(() => {
      expect(screen.getByText('蓝图内容暂时不可用。')).toBeInTheDocument();
    });
  });
});

describe('B8 独立复查回归：busy 护航 / 决策错误不残留 / 正文重试 / 兜底窗口说明', () => {
  it('决策 busy 须护到 onRefresh 的 promise 落地——期间按钮保持禁用，不得以旧态提前重新可点', async () => {
    setupDesktop();
    let releaseRefresh: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const onRefresh = vi.fn(() => gate);
    await act(async () => {
      render(
        <BlueprintRegion
          projectId={PROJECT_ID}
          state={state({ gateActive: true })}
          terminalStatus={null}
          generating={false}
          stateLoading={false}
          onRefresh={onRefresh}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
    });

    // 点击后 applyHumanDecision 已成功，但探针刷新（onRefresh promise）未落地：
    // 旧态仍在渲染，若 busy 提前放开，双击第二下必然撞后端拒绝（复查 A1 blocker）
    await act(async () => {
      screen.getByRole('button', { name: /接受这份蓝图/ }).click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // 决策按钮全部保持禁用（正文里的章节展开等内容交互不受 busy 约束）
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeDisabled();

    await act(async () => {
      releaseRefresh();
      await gate;
    });
    // promise 落地后 busy 才释放（此时真实场景里新态已随探针落地）
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
  });

  it('决策错误只随决策面板存在——相位切走（决策其实已成功）后不得残留在新界面上', async () => {
    const api = setupDesktop();
    (api.graph.applyHumanDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('提交失败'),
    );
    const props = {
      projectId: PROJECT_ID,
      terminalStatus: null,
      generating: false,
      stateLoading: false,
      onRefresh: vi.fn(),
    };
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const result = render(<BlueprintRegion {...props} state={state({ gateActive: true })} />);
      rerender = result.rerender;
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
    });
    await act(async () => {
      screen.getByRole('button', { name: /接受这份蓝图/ }).click();
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // 探针随后带回新态：决策其实已成功，相位进 ready——错误横幅必须随面板消失
    // （复查 A1：修复前"项目就绪"上永远顶着"请刷新后重新确认"）
    await act(async () => {
      rerender(<BlueprintRegion {...props} state={state({ gateActive: false, accepted: true })} />);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('✓ 蓝图已确认，项目就绪')).toBeInTheDocument();
  });

  it('正文拉取失败 → 错误提示带"重试"，点击后重新拉取并恢复（gate 确认不再永久不可达）', async () => {
    const api = setupDesktop();
    (api.blueprint.getBlueprint as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('worker 忙'))
      .mockResolvedValueOnce(blueprintDto());
    await renderRegion({ state: state({ gateActive: true }) });

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    // 拉取失败时 gate 按钮不可达（fail-closed 正确），重试是唯一恢复入口（复查 D6）
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click();
    });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(api.blueprint.getBlueprint).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
  });

  it('escalation × 正文拉取失败 → accept_current 禁用，其余选项可用（不得拍板看不见的内容）', async () => {
    const api = setupDesktop();
    (api.blueprint.getBlueprint as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('worker 忙'),
    );
    await renderRegion({ state: state({ escalationActive: true }) });
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /修改创作要求/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled();
  });

  it('P9 兜底展示窗口（有 ref、gate 未激活、非失效非终态）→ 给"正在推进"说明，不像死机', async () => {
    setupDesktop();
    await renderRegion({ state: state({ gateActive: false }) });
    await waitFor(() => {
      expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
    });
    expect(screen.getByText(/蓝图流程正在推进/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
  });
});
