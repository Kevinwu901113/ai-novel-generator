/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约校验测试
 */

import { describe, it, expect } from 'vitest';
import { isValidWorkflowStage } from './index';

describe('闭合枚举校验', () => {
  it('WorkflowStage', () => {
    expect(isValidWorkflowStage('idea')).toBe(true);
    expect(isValidWorkflowStage('generate')).toBe(true);
    expect(isValidWorkflowStage('done')).toBe(true);
    expect(isValidWorkflowStage('export')).toBe(false);
    expect(isValidWorkflowStage(1)).toBe(false);
  });
});
