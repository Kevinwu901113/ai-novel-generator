/**
 * Research API 命令输入 / DTO 校验器测试（GE-4/B6，D-B6-3）。
 */

import { describe, it, expect } from 'vitest';
import {
  isValidResearchDepthDto,
  isValidResearchValidDto,
  isValidResearchSourceRecordDto,
  isValidResearchQuestionDto,
  isValidFactNoteDto,
  isValidResearchBundleDto,
  isValidResearchStateDto,
  isValidGetResearchStateInput,
  isValidGetResearchBundleInput,
  isValidListResearchBundlesInput,
  isValidSetSourceExclusionInput,
  isValidListSourceExclusionsInput,
} from './index.js';

describe('ResearchDepthDto / ResearchValidDto', () => {
  it('depth：none/light/deep 合法，其余非法', () => {
    expect(isValidResearchDepthDto('none')).toBe(true);
    expect(isValidResearchDepthDto('light')).toBe(true);
    expect(isValidResearchDepthDto('deep')).toBe(true);
    expect(isValidResearchDepthDto('ultra')).toBe(false);
    expect(isValidResearchDepthDto(null)).toBe(false);
  });

  it('valid：valid/invalid 合法，其余非法', () => {
    expect(isValidResearchValidDto('valid')).toBe(true);
    expect(isValidResearchValidDto('invalid')).toBe(true);
    expect(isValidResearchValidDto('unknown')).toBe(false);
  });
});

describe('ResearchSourceRecordDto / ResearchQuestionDto / FactNoteDto', () => {
  const source = {
    url: 'https://example.com/a',
    title: '标题',
    fetchedAt: '2026-08-11T00:00:00.000Z',
    excerpt: '摘要',
  };

  it('source：合法/缺键/多余键', () => {
    expect(isValidResearchSourceRecordDto(source)).toBe(true);
    expect(isValidResearchSourceRecordDto({ ...source, title: undefined })).toBe(false);
    expect(isValidResearchSourceRecordDto({ ...source, extra: 'x' })).toBe(false);
  });

  it('question：sources 数组元素必须逐一合法', () => {
    expect(isValidResearchQuestionDto({ id: 'q1', text: '问题', sources: [source] })).toBe(true);
    expect(isValidResearchQuestionDto({ id: 'q1', text: '问题', sources: [] })).toBe(true);
    expect(isValidResearchQuestionDto({ id: 'q1', text: '问题', sources: [{ url: 'x' }] })).toBe(
      false,
    );
    expect(isValidResearchQuestionDto({ id: 'q1', sources: [] })).toBe(false);
  });

  it('factNote：sourceUrls 必须是字符串数组', () => {
    expect(
      isValidFactNoteDto({ id: 'f1', text: '事实', sourceUrls: ['https://example.com/a'] }),
    ).toBe(true);
    expect(isValidFactNoteDto({ id: 'f1', text: '事实', sourceUrls: [1] })).toBe(false);
  });
});

describe('ResearchBundleDto', () => {
  const bundle = {
    id: 'rb1',
    projectId: 'p1',
    version: 1,
    depth: 'deep' as const,
    questions: [],
    factNotes: [],
    conclusion: '结论',
    createdAt: '2026-08-11T00:00:00.000Z',
    basedOnBundleId: null,
  };

  it('合法 bundle（basedOnBundleId 可空）', () => {
    expect(isValidResearchBundleDto(bundle)).toBe(true);
    expect(isValidResearchBundleDto({ ...bundle, basedOnBundleId: 'rb0' })).toBe(true);
  });

  it('非法 depth / 非法 questions 元素 / 缺键', () => {
    expect(isValidResearchBundleDto({ ...bundle, depth: 'ultra' })).toBe(false);
    expect(isValidResearchBundleDto({ ...bundle, questions: [{ id: 'q1' }] })).toBe(false);
    const { conclusion: _conclusion, ...missing } = bundle;
    expect(isValidResearchBundleDto(missing)).toBe(false);
  });
});

describe('ResearchStateDto', () => {
  const emptyState = {
    runId: null,
    researchDecision: null,
    researchValid: null,
    bundleRef: null,
    bundleInvalidated: false,
    escalationActive: false,
    researchRetryUsed: 0,
  };

  it('无 run 时全 null/false/0 合法', () => {
    expect(isValidResearchStateDto(emptyState)).toBe(true);
  });

  it('deep + bundle + escalation 合法组合', () => {
    expect(
      isValidResearchStateDto({
        runId: 'r1',
        researchDecision: 'deep',
        researchValid: 'invalid',
        bundleRef: 'rb1',
        bundleInvalidated: false,
        escalationActive: true,
        researchRetryUsed: 3,
      }),
    ).toBe(true);
  });

  it('非法枚举 / 缺键 / 多余键', () => {
    expect(isValidResearchStateDto({ ...emptyState, researchDecision: 'ultra' })).toBe(false);
    expect(isValidResearchStateDto({ ...emptyState, researchValid: 'maybe' })).toBe(false);
    const { runId: _runId, ...missing } = emptyState;
    expect(isValidResearchStateDto(missing)).toBe(false);
    expect(isValidResearchStateDto({ ...emptyState, extra: 1 })).toBe(false);
  });
});

describe('Research 输入命令校验器', () => {
  it('getResearchState / listBundles / listSourceExclusions：projectId 必须 bounded trimmed', () => {
    expect(isValidGetResearchStateInput({ projectId: 'p1' })).toBe(true);
    expect(isValidGetResearchStateInput({ projectId: '' })).toBe(false);
    expect(isValidGetResearchStateInput({ projectId: ' p1' })).toBe(false);
    expect(isValidGetResearchStateInput({})).toBe(false);
    expect(isValidGetResearchStateInput(null)).toBe(false);

    expect(isValidListResearchBundlesInput({ projectId: 'p1' })).toBe(true);
    expect(isValidListResearchBundlesInput({ projectId: 'p1', extra: 1 })).toBe(false);

    expect(isValidListSourceExclusionsInput({ projectId: 'p1' })).toBe(true);
    expect(isValidListSourceExclusionsInput({})).toBe(false);
  });

  it('getBundle：projectId + bundleId', () => {
    expect(isValidGetResearchBundleInput({ projectId: 'p1', bundleId: 'rb1' })).toBe(true);
    expect(isValidGetResearchBundleInput({ projectId: 'p1' })).toBe(false);
    expect(isValidGetResearchBundleInput({ projectId: 'p1', bundleId: '' })).toBe(false);
  });

  it('setSourceExclusion：projectId + url + excluded boolean', () => {
    expect(
      isValidSetSourceExclusionInput({
        projectId: 'p1',
        url: 'https://example.com/a',
        excluded: true,
      }),
    ).toBe(true);
    expect(
      isValidSetSourceExclusionInput({
        projectId: 'p1',
        url: 'https://example.com/a',
        excluded: 'true',
      } as never),
    ).toBe(false);
    expect(isValidSetSourceExclusionInput({ projectId: 'p1', url: '', excluded: true })).toBe(
      false,
    );
    expect(isValidSetSourceExclusionInput({ projectId: 'p1', excluded: true } as never)).toBe(
      false,
    );
  });

  it('setSourceExclusion：超长 URL 拒绝', () => {
    const longUrl = `https://example.com/${'a'.repeat(2048)}`;
    expect(isValidSetSourceExclusionInput({ projectId: 'p1', url: longUrl, excluded: true })).toBe(
      false,
    );
  });
});
