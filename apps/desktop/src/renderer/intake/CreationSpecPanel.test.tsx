// @vitest-environment jsdom
/**
 * CreationSpecPanel 测试（B4）：变更操作构造（纯逻辑）+ 编辑保存流程
 * （CAS 更新 → 显式失效级联，D-B4-4）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { ContractVersionPublicData, DesktopAPI } from '@ai-novel/contracts';
import { buildSpecOperations, parseListInput, CreationSpecPanel } from './CreationSpecPanel';

const SPEC = {
  id: 'spec-v1',
  projectId: 'p1',
  version: 3,
  schemaVersion: 1,
  sourceProposalId: null,
  basedOnGrillSessionId: 's1',
  basedOnGrillSessionVersion: 2,
  sections: {
    premise: '赛博都市修仙快递员',
    genre: ['sci-fi'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST',
    tense: 'PRESENT',
    protagonist: { characterKey: 'protag', name: '快递员阿真' },
  },
  lockedFieldPaths: [],
  contractSnapshotHash: 'h',
  provenance: [],
  createdAt: '2026-08-10T00:00:00.000Z',
  createdBy: 'ai-proposal-accepted',
} as unknown as ContractVersionPublicData;

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
});

describe('parseListInput', () => {
  it('逗号/顿号/中文逗号分隔，去空规整', () => {
    expect(parseListInput('sci-fi, 修仙、 都市，  ')).toEqual(['sci-fi', '修仙', '都市']);
    expect(parseListInput('')).toEqual([]);
  });
});

describe('buildSpecOperations', () => {
  it('仅包含实际变化的字段；无变化返回空', () => {
    const noChange = buildSpecOperations(SPEC, {
      premise: '赛博都市修仙快递员',
      targetAudience: 'adults',
      structure: '',
      chapterLengthTarget: '',
      chapterLengthMinimum: '',
      chapterLengthMaximum: '',
      genre: 'sci-fi',
      tone: 'dark',
      themes: '',
    });
    expect(noChange).toEqual([]);

    const ops = buildSpecOperations(SPEC, {
      premise: '新前提',
      targetAudience: 'adults',
      structure: '三幕结构',
      chapterLengthTarget: '',
      chapterLengthMinimum: '',
      chapterLengthMaximum: '',
      genre: 'sci-fi、修仙',
      tone: 'dark',
      themes: '',
    });
    expect(ops).toEqual([
      { kind: 'set-scalar', path: '/premise', value: '新前提' },
      { kind: 'set-scalar', path: '/structure', value: '三幕结构' },
      { kind: 'set-string-list', path: '/genre', value: ['sci-fi', '修仙'] },
    ]);
  });

  it('空值不做删除语义（structure/themes 留空即跳过）', () => {
    const ops = buildSpecOperations(SPEC, {
      premise: '赛博都市修仙快递员',
      targetAudience: 'adults',
      structure: '',
      chapterLengthTarget: '',
      chapterLengthMinimum: '',
      chapterLengthMaximum: '',
      genre: 'sci-fi',
      tone: 'dark',
      themes: '',
    });
    expect(ops.find((o) => o.path === '/structure')).toBeUndefined();
    expect(ops.find((o) => o.path === '/themes')).toBeUndefined();
  });

  it('单章目标字数使用结构化字段并校验 500..40000', () => {
    const ops = buildSpecOperations(SPEC, {
      premise: '赛博都市修仙快递员',
      targetAudience: 'adults',
      structure: '',
      chapterLengthTarget: '15,000',
      chapterLengthMinimum: '',
      chapterLengthMaximum: '',
      genre: 'sci-fi',
      tone: 'dark',
      themes: '',
    });
    expect(ops).toContainEqual({
      kind: 'set-structured',
      path: '/chapterLength',
      value: { targetCharacters: 15_000 },
    });
    expect(() =>
      buildSpecOperations(SPEC, {
        premise: '赛博都市修仙快递员',
        targetAudience: 'adults',
        structure: '',
        chapterLengthTarget: '50000',
        chapterLengthMinimum: '',
        chapterLengthMaximum: '',
        genre: 'sci-fi',
        tone: 'dark',
        themes: '',
      }),
    ).toThrow('500 到 40,000');

    expect(
      buildSpecOperations(SPEC, {
        premise: '赛博都市修仙快递员',
        targetAudience: 'adults',
        structure: '',
        chapterLengthTarget: '15000',
        chapterLengthMinimum: '14000',
        chapterLengthMaximum: '16000',
        genre: 'sci-fi',
        tone: 'dark',
        themes: '',
      }),
    ).toContainEqual({
      kind: 'set-structured',
      path: '/chapterLength',
      value: {
        targetCharacters: 15_000,
        minimumCharacters: 14_000,
        maximumCharacters: 16_000,
      },
    });
  });

  it('清空已有单章目标时显式删除结构化字段', () => {
    const withChapterLength = {
      ...SPEC,
      sections: {
        ...SPEC.sections,
        chapterLength: {
          targetCharacters: 15_000,
          minimumCharacters: 14_000,
          maximumCharacters: 16_000,
        },
      },
    } as unknown as ContractVersionPublicData;
    const ops = buildSpecOperations(withChapterLength, {
      premise: '赛博都市修仙快递员',
      targetAudience: 'adults',
      structure: '',
      chapterLengthTarget: '',
      chapterLengthMinimum: '14000',
      chapterLengthMaximum: '16000',
      genre: 'sci-fi',
      tone: 'dark',
      themes: '',
    });
    expect(ops).toContainEqual({ kind: 'remove-field', path: '/chapterLength' });
  });
});

describe('CreationSpecPanel', () => {
  it('编辑保存：updateByUser（CAS）成功后触发失效级联并回调 onSaved', async () => {
    const updateByUser = vi.fn().mockResolvedValue({ ...SPEC, id: 'spec-v2', version: 4 });
    const propagateSpecInvalidation = vi.fn().mockResolvedValue([]);
    window.desktop = {
      contract: { updateByUser },
      intake: { propagateSpecInvalidation },
    } as unknown as DesktopAPI;
    const onSaved = vi.fn();

    render(<CreationSpecPanel projectId="p1" spec={SPEC} onSaved={onSaved} />);
    expect(screen.getByText('赛博都市修仙快递员')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('故事前提'), { target: { value: '新前提' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存' }).click();
    });

    await waitFor(() => {
      expect(updateByUser).toHaveBeenCalledWith({
        projectId: 'p1',
        expectedContractVersion: 3,
        operations: [{ kind: 'set-scalar', path: '/premise', value: '新前提' }],
      });
      // D-B4-4：级联引用新版本 id
      expect(propagateSpecInvalidation).toHaveBeenCalledWith({
        projectId: 'p1',
        creationSpecVersionId: 'spec-v2',
      });
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('无变化直接退出编辑，不发起更新', async () => {
    const updateByUser = vi.fn();
    window.desktop = {
      contract: { updateByUser },
      intake: { propagateSpecInvalidation: vi.fn() },
    } as unknown as DesktopAPI;

    render(<CreationSpecPanel projectId="p1" spec={SPEC} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await act(async () => {
      screen.getByRole('button', { name: '保存' }).click();
    });

    expect(updateByUser).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
  });
});
