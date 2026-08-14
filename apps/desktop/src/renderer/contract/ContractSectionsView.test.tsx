// @vitest-environment jsdom
/**
 * ContractSectionsView 结构化展示测试。
 *
 * 覆盖：
 * - 中文 labels 分组渲染
 * - array 使用列表
 * - nested object 使用子卡片
 * - optional section 缺失时不渲染空壳
 * - 目标长度格式化
 * - 锁定字段标记（仅当前版本传入）
 * - 不渲染原始 JSON
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ContractSectionsView } from './ContractSectionsView';
import type { CreationContractSectionsPublicData } from '@ai-novel/contracts';

const fullSections: CreationContractSectionsPublicData = {
  premise: '一个被遗忘的神明在人间重新崛起的故事',
  genre: ['都市', '奇幻'],
  tone: ['治愈', '悬疑'],
  themes: ['身份', '救赎'],
  targetAudience: '喜欢慢热叙事的成年读者',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  targetLength: { unit: 'words', value: 80000 },
  chapterLength: { targetCharacters: 3000 },
  structure: '三幕式：觉醒、对抗、和解',
  protagonist: {
    characterKey: 'hero',
    name: '陆沉',
    role: '主角',
    motivation: '寻找失落的记忆',
    arc: '从逃避到直面',
    traits: ['谨慎', '温柔'],
  },
  supportingCharacters: [
    {
      characterKey: 'friend',
      name: '苏晚',
      role: '挚友',
      relationship: '青梅竹马',
      traits: ['勇敢'],
    },
  ],
  relationships: [
    {
      relationshipKey: 'hero-friend',
      fromCharacterKey: 'hero',
      toCharacterKey: 'friend',
      type: '信任',
      dynamic: '逐渐加深',
    },
  ],
  worldRules: ['神明信仰会侵蚀记忆'],
  mustInclude: ['每一章至少一个记忆碎片'],
  mustAvoid: ['机械降神式结尾'],
  contentBoundaries: {
    rating: 'PG-13',
    allowedContent: ['轻度暴力'],
    prohibitedContent: ['血腥描写'],
    notes: '保持克制的氛围描写',
  },
  unresolvedQuestions: ['陆沉的记忆为何被封印？'],
};

/** 只含必填字段的最小 sections（所有 optional 缺失） */
const minimalSections: CreationContractSectionsPublicData = {
  premise: '前提文本',
  genre: ['都市'],
  tone: ['治愈'],
  targetAudience: '目标读者',
  narrativePov: 'FIRST',
  tense: 'PRESENT',
  protagonist: { characterKey: 'hero', name: '陆沉' },
};

describe('ContractSectionsView', () => {
  afterEach(() => {
    cleanup();
  });

  // ── 核心分组 ──────────────────────────────────────────────────

  it('渲染核心设定分组与中文 labels', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('核心设定')).toBeDefined();
    expect(screen.getByText('前提')).toBeDefined();
    expect(screen.getByText(fullSections.premise)).toBeDefined();
    expect(screen.getByText('目标读者')).toBeDefined();
    expect(screen.getByText(fullSections.targetAudience)).toBeDefined();
  });

  it('叙事视角 / 时态使用中文枚举标签', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('叙事视角')).toBeDefined();
    expect(screen.getByText('第三人称有限视角')).toBeDefined();
    expect(screen.getByText('时态')).toBeDefined();
    expect(screen.getByText('过去时')).toBeDefined();
  });

  it('结构作为长文本块完整显示', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText(fullSections.structure!)).toBeDefined();
  });

  // ── 类型与基调 ────────────────────────────────────────────────

  it('类型 / 基调 / 主题以顿号连接', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('都市、奇幻')).toBeDefined();
    expect(screen.getByText('治愈、悬疑')).toBeDefined();
    expect(screen.getByText('身份、救赎')).toBeDefined();
  });

  // ── 目标长度 ──────────────────────────────────────────────────

  it('目标长度格式化为"约 N 字"', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('约 80,000 字')).toBeDefined();
    expect(screen.getByText('约 3,000 字')).toBeDefined();
  });

  // ── 主角子卡片 ────────────────────────────────────────────────

  it('主角字段渲染为子卡片', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getAllByText('主角').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('陆沉')).toBeDefined();
    expect(screen.getByText('寻找失落的记忆')).toBeDefined();
    expect(screen.getByText('从逃避到直面')).toBeDefined();
    // traits 为列表
    expect(screen.getByText('谨慎')).toBeDefined();
    expect(screen.getByText('温柔')).toBeDefined();
  });

  // ── 配角子卡片 ────────────────────────────────────────────────

  it('配角渲染为子卡片列表', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('配角')).toBeDefined();
    expect(screen.getByText('苏晚')).toBeDefined();
    expect(screen.getByText('青梅竹马')).toBeDefined();
    expect(screen.getByText('勇敢')).toBeDefined();
  });

  // ── 人物关系 ──────────────────────────────────────────────────

  it('人物关系格式为 from → to：type（dynamic）', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('hero → friend：信任（逐渐加深）')).toBeDefined();
  });

  // ── 字符串列表分组 ────────────────────────────────────────────

  it('世界规则 / 必须包含 / 必须避免 / 未决问题渲染为列表', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('世界规则')).toBeDefined();
    expect(screen.getByText('神明信仰会侵蚀记忆')).toBeDefined();
    expect(screen.getByText('必须包含')).toBeDefined();
    expect(screen.getByText('每一章至少一个记忆碎片')).toBeDefined();
    expect(screen.getByText('必须避免')).toBeDefined();
    expect(screen.getByText('机械降神式结尾')).toBeDefined();
    expect(screen.getByText('未决问题')).toBeDefined();
    expect(screen.getByText('陆沉的记忆为何被封印？')).toBeDefined();
  });

  // ── 内容边界 ──────────────────────────────────────────────────

  it('内容边界渲染 rating / 允许内容 / 禁止内容 / 备注', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(screen.getByText('内容边界')).toBeDefined();
    expect(screen.getByText('PG-13')).toBeDefined();
    expect(screen.getByText('轻度暴力')).toBeDefined();
    expect(screen.getByText('血腥描写')).toBeDefined();
    expect(screen.getByText('保持克制的氛围描写')).toBeDefined();
  });

  // ── optional 缺失时不渲染空壳 ────────────────────────────────

  it('optional section 缺失时不渲染空壳', () => {
    render(<ContractSectionsView sections={minimalSections} />);
    expect(screen.queryByText('主题')).toBeNull();
    expect(screen.queryByText('目标长度')).toBeNull();
    expect(screen.queryByText('配角')).toBeNull();
    expect(screen.queryByText('人物关系')).toBeNull();
    expect(screen.queryByText('世界规则')).toBeNull();
    expect(screen.queryByText('必须包含')).toBeNull();
    expect(screen.queryByText('内容边界')).toBeNull();
    expect(screen.queryByText('未决问题')).toBeNull();
    // 必填的核心仍渲染
    expect(screen.getByText('核心设定')).toBeDefined();
    expect(screen.getByText('前提文本')).toBeDefined();
  });

  it('主角可选字段缺失时只渲染存在字段', () => {
    render(<ContractSectionsView sections={minimalSections} />);
    expect(screen.getByText('陆沉')).toBeDefined();
    expect(screen.queryByText('成长弧线')).toBeNull();
    expect(screen.queryByText('动机')).toBeNull();
  });

  // ── 锁定字段标记 ──────────────────────────────────────────────

  it('命中锁定路径的字段显示 🔒 标记', () => {
    render(
      <ContractSectionsView
        sections={fullSections}
        lockedFieldPaths={['/premise', '/protagonist/name']}
      />,
    );
    const markers = document.querySelectorAll('.contract-lock-marker');
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });

  it('无锁定时不显示 🔒 标记', () => {
    render(<ContractSectionsView sections={fullSections} />);
    expect(document.querySelectorAll('.contract-lock-marker').length).toBe(0);
  });

  // ── 不渲染原始 JSON ───────────────────────────────────────────

  it('不渲染原始 JSON 结构', () => {
    render(<ContractSectionsView sections={fullSections} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('{');
    expect(text).not.toContain('"premise"');
    expect(text).not.toContain('"genre"');
  });

  it('长文本完整显示（不截断）', () => {
    const longPremise = '长'.repeat(500);
    render(<ContractSectionsView sections={{ ...minimalSections, premise: longPremise }} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(longPremise);
  });
});
