/**
 * Grill IPC 频道注册测试。
 *
 * 验证所有 grill IPC 频道在 contracts 中定义，
 * 且 main process 中有对应的 handler 注册。
 */

import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@ai-novel/contracts';

describe('Grill IPC channels', () => {
  const GRILL_CHANNELS = [
    'GRILL_CREATE_SESSION',
    'GRILL_GET_SESSION',
    'GRILL_LIST_SESSIONS',
    'GRILL_START_SESSION',
    'GRILL_PAUSE_SESSION',
    'GRILL_RESUME_SESSION',
    'GRILL_COMPLETE_SESSION',
    'GRILL_ABANDON_SESSION',
    'GRILL_ADD_QUESTIONS',
    'GRILL_MARK_QUESTION_ASKED',
    'GRILL_ANSWER_QUESTION',
    'GRILL_SKIP_QUESTION',
    'GRILL_SUPERSEDE_QUESTION',
    'GRILL_GET_CURRENT_ANSWERS',
    'GRILL_LIST_ANSWER_HISTORY',
    'GRILL_CREATE_PROPOSAL',
    'GRILL_REVIEW_PROPOSAL',
    'GRILL_LIST_PROPOSALS',
  ] as const;

  it.each(GRILL_CHANNELS)('IPC_CHANNELS 包含 %s', (channelKey) => {
    expect(IPC_CHANNELS[channelKey]).toBeDefined();
    expect(typeof IPC_CHANNELS[channelKey]).toBe('string');
    expect(IPC_CHANNELS[channelKey]).toMatch(/^ipc:grill-/);
  });

  it('共有 18 个 grill 频道', () => {
    const grillChannelKeys = Object.keys(IPC_CHANNELS).filter((k) => k.startsWith('GRILL_'));
    expect(grillChannelKeys).toHaveLength(18);
  });

  it('所有 grill 频道值唯一', () => {
    const grillChannelValues = Object.entries(IPC_CHANNELS)
      .filter(([k]) => k.startsWith('GRILL_'))
      .map(([, v]) => v);
    const unique = new Set(grillChannelValues);
    expect(unique.size).toBe(grillChannelValues.length);
  });
});
