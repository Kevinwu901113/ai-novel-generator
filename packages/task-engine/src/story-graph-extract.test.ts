/**
 * 故事图谱抽取的严格解析测试（D14 / B22，D-B22-4 解析纪律）。
 *
 * 这一层只管**结构**：任何字段不符/类型错/越界都整体判失败（可重试）。
 * 语义无效（指了不存在的线程 id 等）是写入阶段的事，走逐条丢弃，
 * 覆盖在 apps/worker/src/story-graph-e2e.integration.test.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  parseStoryGraphExtractionV1,
  buildStoryGraphExtractPrompt,
} from './story-graph-extract.js';
import { TaskExecutionError } from './index.js';

const ENTITY = {
  name: '林三',
  kind: 'character',
  aliases: ['林师兄'],
  profile: '外门弟子',
  evidence: '他还只是外门弟子。',
};

const STATE = {
  subject: '林三',
  predicate: '身份',
  object_entity: null,
  object_text: '外门弟子',
  evidence: '他还只是外门弟子。',
  confidence: 0.9,
};

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    entities: [ENTITY],
    states: [STATE],
    threads_open: [],
    threads_close: [],
    merge_suspects: [],
    ...overrides,
  });
}

function expectInvalid(text: string): void {
  let thrown: unknown;
  try {
    parseStoryGraphExtractionV1(text);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(TaskExecutionError);
  expect((thrown as TaskExecutionError).code).toBe('MODEL_RESPONSE_INVALID');
}

describe('parseStoryGraphExtractionV1：结构非法整体判失败', () => {
  it('合法输出解析成类型化结构', () => {
    const parsed = parseStoryGraphExtractionV1(
      payload({
        threads_open: [
          {
            kind: 'foreshadow',
            description: '玉佩来历不明',
            promised_payoff: null,
            evidence: '他摸了摸怀里的玉佩。',
          },
        ],
        threads_close: [{ thread_id: 't1', evidence: '玉佩是掌门信物。' }],
        merge_suspects: [{ entity_a: '林三', entity_b: '黑衣人', reason: '同一人暗示' }],
      }),
    );
    expect(parsed.entities[0].name).toBe('林三');
    expect(parsed.entities[0].aliases).toEqual(['林师兄']);
    expect(parsed.states[0].objectText).toBe('外门弟子');
    expect(parsed.states[0].objectEntity).toBeNull();
    expect(parsed.states[0].confidence).toBe(0.9);
    expect(parsed.threadsOpen[0].promisedPayoff).toBeNull();
    expect(parsed.threadsClose[0].threadId).toBe('t1');
    expect(parsed.mergeSuspects[0].entityB).toBe('黑衣人');
  });

  it('容忍代码围栏，但围栏里的内容仍走全部严格校验', () => {
    const parsed = parseStoryGraphExtractionV1('```json\n' + payload() + '\n```');
    expect(parsed.entities).toHaveLength(1);
    expectInvalid('```json\n{"schemaVersion":1}\n```');
  });

  it('不是 JSON / 不是对象 → 失败', () => {
    expectInvalid('这一章讲了林三的故事。');
    expectInvalid('[]');
  });

  it('顶层字段缺失或多出 → 失败', () => {
    const base = JSON.parse(payload()) as Record<string, unknown>;
    delete base.merge_suspects;
    expectInvalid(JSON.stringify(base));
    expectInvalid(payload({ extra: 1 } as Record<string, unknown>));
  });

  it('schemaVersion 不符 → 失败', () => {
    expectInvalid(payload({ schemaVersion: 2 }));
  });

  it('实体 kind 非法 / 字段不符 → 失败', () => {
    expectInvalid(payload({ entities: [{ ...ENTITY, kind: 'faction' }] }));
    expectInvalid(payload({ entities: [{ ...ENTITY, extra: 'x' }] }));
    const { evidence: _evidence, ...noEvidence } = ENTITY;
    expectInvalid(payload({ entities: [noEvidence] }));
    expectInvalid(payload({ entities: [{ ...ENTITY, name: '   ' }] }));
    expectInvalid(payload({ entities: [{ ...ENTITY, aliases: '林师兄' }] }));
  });

  it('状态边客体二选一违规（都填 / 都空）→ 失败', () => {
    expectInvalid(payload({ states: [{ ...STATE, object_entity: '青云宗' }] }));
    expectInvalid(payload({ states: [{ ...STATE, object_text: null }] }));
  });

  it('confidence 越界或非数字 → 失败', () => {
    expectInvalid(payload({ states: [{ ...STATE, confidence: 1.5 }] }));
    expectInvalid(payload({ states: [{ ...STATE, confidence: '0.9' }] }));
  });

  it('字符串越长 → 失败（防越界输出灌进图里）', () => {
    expectInvalid(payload({ entities: [{ ...ENTITY, name: '林'.repeat(100) }] }));
    expectInvalid(payload({ states: [{ ...STATE, object_text: '弟'.repeat(300) }] }));
  });

  it('条数超限 → 失败', () => {
    expectInvalid(payload({ entities: Array.from({ length: 41 }, () => ENTITY) }));
  });

  it('线程条目字段不符 → 失败', () => {
    expectInvalid(payload({ threads_close: [{ thread_id: 't1' }] }));
    expectInvalid(
      payload({
        threads_open: [
          { kind: 'foreshadow', description: '', promised_payoff: null, evidence: 'x' },
        ],
      }),
    );
  });
});

describe('buildStoryGraphExtractPrompt', () => {
  it('前情登记表带上实体别名与 open 线程 id（核销要按 id 引用）', () => {
    const prompt = buildStoryGraphExtractPrompt({
      chapterNumber: 3,
      title: '第三章',
      content: '正文',
      prior: {
        entities: [
          {
            entity: {
              id: 'e1',
              projectId: 'p1',
              kind: 'character',
              canonicalName: '林三',
              profileSummary: '外门弟子',
              firstChapter: 1,
              origin: 'extracted',
              mergedIntoId: null,
              createdAt: 'now',
              updatedAt: 'now',
            },
            aliases: ['林师兄'],
          },
        ],
        openThreads: [
          {
            id: 'thread-1',
            projectId: 'p1',
            kind: 'foreshadow',
            description: '玉佩来历不明',
            status: 'open',
            promisedPayoff: null,
            openedChapter: 1,
            closedChapter: null,
            sourceChapterId: 'c1',
            sourceContentHash: null,
            evidenceSpan: null,
            origin: 'extracted',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ],
      },
    });
    expect(prompt).toContain('第 3 章');
    expect(prompt).toContain('林师兄');
    expect(prompt).toContain('thread-1');
    expect(prompt).toContain('玉佩来历不明');
    // 档案正文不进 prompt：登记表只要名字与别名，省预算
    expect(prompt).not.toContain('外门弟子');
  });

  it('超长正文只截前段，不把整章灌进 prompt', () => {
    const prompt = buildStoryGraphExtractPrompt({
      chapterNumber: 1,
      title: '长章',
      content: '字'.repeat(30000),
      prior: { entities: [], openThreads: [] },
    });
    expect(prompt.length).toBeLessThan(21000);
  });
});
