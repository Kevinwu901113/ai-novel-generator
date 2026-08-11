/**
 * 蓝图公共 DTO 与输入校验器测试（B8/D-B8-1）。
 *
 * 重点：exact-keys 语义——多一个键就整包判否。这不是苛刻，而是 preload 侧
 * 防线的前提：worker 若 spread 了 domain 内部字段（如 accepted），必须在这里
 * 被挡下并暴露为契约不一致，而不是悄悄透传到渲染进程。
 */

import { describe, it, expect } from 'vitest';
import {
  isValidBlueprintCharacterDto,
  isValidBlueprintChapterDto,
  isValidBlueprintPlotlineDto,
  isValidGetBlueprintInput,
  isValidStoryBlueprintDto,
  type StoryBlueprintDto,
} from './index';

function blueprint(): StoryBlueprintDto {
  return {
    id: 'bp-1',
    projectId: 'proj-1',
    version: 1,
    premise: '前提',
    characters: [{ name: '林澈', role: '主角', description: '邮差' }],
    relationships: ['甲与乙是旧识'],
    world: '世界',
    conflict: '冲突',
    ending: '结局',
    plotlines: [{ name: '主线', summary: '摘要' }],
    chapters: [{ id: 'ch-1', title: '第一章', goal: '目标' }],
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

describe('isValidStoryBlueprintDto', () => {
  it('完整合法对象通过；空数组字段合法（模型可能不产出人物/情节线）', () => {
    expect(isValidStoryBlueprintDto(blueprint())).toBe(true);
    expect(
      isValidStoryBlueprintDto({
        ...blueprint(),
        characters: [],
        relationships: [],
        plotlines: [],
        chapters: [],
      }),
    ).toBe(true);
  });

  it('缺键 / 多键（exact-keys）均判否', () => {
    const missing = { ...blueprint() } as Record<string, unknown>;
    delete missing.ending;
    expect(isValidStoryBlueprintDto(missing)).toBe(false);
    // accepted 属状态、不进本 DTO——若 worker 侧 spread 带出来必须被挡下
    expect(isValidStoryBlueprintDto({ ...blueprint(), accepted: true })).toBe(false);
  });

  it('类型错误逐项判否', () => {
    expect(isValidStoryBlueprintDto({ ...blueprint(), version: '1' })).toBe(false);
    expect(isValidStoryBlueprintDto({ ...blueprint(), relationships: [1] })).toBe(false);
    expect(isValidStoryBlueprintDto({ ...blueprint(), characters: [{ name: '甲' }] })).toBe(false);
    expect(isValidStoryBlueprintDto({ ...blueprint(), chapters: [{ id: 'c', title: 't' }] })).toBe(
      false,
    );
    expect(isValidStoryBlueprintDto({ ...blueprint(), plotlines: [{ name: 'a' }] })).toBe(false);
  });

  it('非对象判否', () => {
    expect(isValidStoryBlueprintDto(null)).toBe(false);
    expect(isValidStoryBlueprintDto('bp')).toBe(false);
    expect(isValidStoryBlueprintDto([])).toBe(false);
  });
});

describe('子 DTO 校验器', () => {
  it('character / plotline / chapter 各自 exact-keys', () => {
    expect(isValidBlueprintCharacterDto({ name: 'a', role: 'b', description: 'c' })).toBe(true);
    expect(isValidBlueprintCharacterDto({ name: 'a', role: 'b', description: 'c', extra: 1 })).toBe(
      false,
    );
    expect(isValidBlueprintPlotlineDto({ name: 'a', summary: 'b' })).toBe(true);
    expect(isValidBlueprintPlotlineDto({ name: 'a' })).toBe(false);
    expect(isValidBlueprintChapterDto({ id: 'a', title: 'b', goal: 'c' })).toBe(true);
    expect(isValidBlueprintChapterDto({ id: 'a', title: 'b', goal: 3 })).toBe(false);
  });
});

describe('isValidGetBlueprintInput', () => {
  it('projectId + blueprintId 均为 bounded trimmed id 才通过', () => {
    expect(isValidGetBlueprintInput({ projectId: 'p1', blueprintId: 'bp-1' })).toBe(true);
    expect(isValidGetBlueprintInput({ projectId: 'p1' })).toBe(false);
    expect(isValidGetBlueprintInput({ projectId: '', blueprintId: 'bp-1' })).toBe(false);
    expect(isValidGetBlueprintInput({ projectId: ' p1', blueprintId: 'bp-1' })).toBe(false);
    expect(isValidGetBlueprintInput({ projectId: 'p1', blueprintId: 'bp-1', extra: true })).toBe(
      false,
    );
    expect(isValidGetBlueprintInput(null)).toBe(false);
  });
});
