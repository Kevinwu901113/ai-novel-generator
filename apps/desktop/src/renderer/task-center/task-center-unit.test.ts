/**
 * 任务中心纯逻辑单元测试。
 */

import { describe, it, expect } from 'vitest';
import {
  taskStatusLabel,
  taskTypeLabel,
  isTaskTerminal,
  isTaskActive,
  buildTaskTypeOptions,
} from './task-labels';
import {
  safeNumber,
  formatNumber,
  formatLatency,
  formatTaskShortId,
  formatTime,
} from './task-formatters';
import { presentTaskResult } from './task-result-presenter';
import { taskErrorMessage, sanitizeErrorMessage, sanitizeLoadError } from './task-error-message';

// ── task-labels ──────────────────────────────────────────────────────

describe('taskStatusLabel', () => {
  it('返回已知状态的中文标签', () => {
    expect(taskStatusLabel('PENDING')).toBe('待处理');
    expect(taskStatusLabel('RUNNING')).toBe('运行中');
    expect(taskStatusLabel('SUCCEEDED')).toBe('成功');
    expect(taskStatusLabel('FAILED')).toBe('失败');
  });

  it('未知状态原样返回', () => {
    expect(taskStatusLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('taskTypeLabel', () => {
  it('返回已知类型的中文标签', () => {
    expect(taskTypeLabel('MODEL_INVOCATION_TEST')).toBe('模型调用测试');
    expect(taskTypeLabel('GRILL_QUESTION_PLAN')).toBe('Grill 问题规划');
    expect(taskTypeLabel('CREATION_CONTRACT_DRAFT')).toBe('创作契约草案');
  });

  it('未知类型使用安全 fallback', () => {
    const label = taskTypeLabel('SOME_NEW_TYPE');
    expect(label).toContain('未知任务');
    expect(label).toContain('SOME');
    expect(label).not.toContain('SOME_NEW_TYPE');
  });

  it('超长未知类型截断', () => {
    const label = taskTypeLabel('VERY_LONG_TYPE_NAME_EXCEEDING_LIMITS');
    expect(label).toContain('未知任务');
    expect(label.length).toBeLessThan(30);
  });
});

describe('isTaskTerminal', () => {
  it('终态返回 true', () => {
    expect(isTaskTerminal('SUCCEEDED')).toBe(true);
    expect(isTaskTerminal('FAILED')).toBe(true);
    expect(isTaskTerminal('CANCELLED')).toBe(true);
  });

  it('非终态返回 false', () => {
    expect(isTaskTerminal('PENDING')).toBe(false);
    expect(isTaskTerminal('RUNNING')).toBe(false);
  });
});

describe('isTaskActive', () => {
  it('活跃态返回 true', () => {
    expect(isTaskActive('PENDING')).toBe(true);
    expect(isTaskActive('RUNNING')).toBe(true);
  });

  it('非活跃态返回 false', () => {
    expect(isTaskActive('SUCCEEDED')).toBe(false);
    expect(isTaskActive('FAILED')).toBe(false);
  });
});

describe('buildTaskTypeOptions', () => {
  it('包含 ALL 和去重的类型', () => {
    const tasks = [
      { taskType: 'MODEL_INVOCATION_TEST' },
      { taskType: 'MODEL_INVOCATION_TEST' },
      { taskType: 'GRILL_QUESTION_PLAN' },
    ];
    const opts = buildTaskTypeOptions(tasks);
    expect(opts[0]).toEqual({ value: 'ALL', label: '全部' });
    expect(opts).toHaveLength(3);
  });

  it('空列表只有 ALL', () => {
    expect(buildTaskTypeOptions([])).toEqual([{ value: 'ALL', label: '全部' }]);
  });
});

// ── task-formatters ──────────────────────────────────────────────────

describe('safeNumber', () => {
  it('null 返回 null', () => expect(safeNumber(null)).toBeNull());
  it('undefined 返回 null', () => expect(safeNumber(undefined)).toBeNull());
  it('NaN 返回 null', () => expect(safeNumber(NaN)).toBeNull());
  it('Infinity 返回 null', () => expect(safeNumber(Infinity)).toBeNull());
  it('-Infinity 返回 null', () => expect(safeNumber(-Infinity)).toBeNull());
  it('正常数值返回自身', () => expect(safeNumber(42)).toBe(42));
  it('字符串数值转换', () => expect(safeNumber('100')).toBe(100));
  it('非数值字符串返回 null', () => expect(safeNumber('abc')).toBeNull());
});

describe('formatNumber', () => {
  it('null 返回 —', () => expect(formatNumber(null)).toBe('—'));
  it('NaN 返回 —', () => expect(formatNumber(NaN)).toBe('—'));
  it('Infinity 返回 —', () => expect(formatNumber(Infinity)).toBe('—'));
  it('正常数字格式化', () => {
    const result = formatNumber(1234567);
    expect(result).toContain('1');
    expect(result).toContain('234');
    expect(result).toContain('567');
  });
});

describe('formatLatency', () => {
  it('null 返回 —', () => expect(formatLatency(null)).toBe('—'));
  it('NaN 返回 —', () => expect(formatLatency(NaN)).toBe('—'));
  it('小于 1000ms 显示 ms', () => expect(formatLatency(500)).toBe('500ms'));
  it('等于 1000ms 显示秒', () => expect(formatLatency(1000)).toBe('1.0s'));
  it('大于 1000ms 显示秒', () => expect(formatLatency(2500)).toBe('2.5s'));
});

describe('formatTaskShortId', () => {
  it('截取前 8 字符', () => {
    expect(formatTaskShortId('abcdefghijklmnop')).toBe('abcdefgh');
  });
});

describe('formatTime', () => {
  it('null 返回 —', () => expect(formatTime(null)).toBe('—'));
  it('undefined 返回 —', () => expect(formatTime(undefined)).toBe('—'));
  it('有效 ISO 字符串格式化', () => {
    const result = formatTime('2024-01-01T00:00:00Z');
    expect(result).not.toBe('—');
    expect(typeof result).toBe('string');
  });
});

// ── task-result-presenter ────────────────────────────────────────────

describe('presentTaskResult', () => {
  it('MODEL_INVOCATION_TEST 有效结果显示', () => {
    const result = presentTaskResult('MODEL_INVOCATION_TEST', {
      accepted: true,
      textLength: 100,
    });
    expect(result).toContain('是');
    expect(result).toContain('100');
  });

  it('MODEL_INVOCATION_TEST rejected', () => {
    const result = presentTaskResult('MODEL_INVOCATION_TEST', {
      accepted: false,
      textLength: 50,
    });
    expect(result).toContain('否');
    expect(result).toContain('50');
  });

  it('MODEL_INVOCATION_TEST 无效 result 返回 null', () => {
    expect(presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true })).toBeNull();
    expect(presentTaskResult('MODEL_INVOCATION_TEST', { textLength: 10 })).toBeNull();
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: 'yes', textLength: 10 }),
    ).toBeNull();
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true, textLength: -1 }),
    ).toBeNull();
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true, textLength: 10, extra: 1 }),
    ).toBeNull();
    expect(presentTaskResult('MODEL_INVOCATION_TEST', null)).toBeNull();
  });

  it('textLength = 1.5 被拒绝（非整数）', () => {
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true, textLength: 1.5 }),
    ).toBeNull();
  });

  it('textLength = NaN 被拒绝', () => {
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true, textLength: NaN }),
    ).toBeNull();
  });

  it('textLength = Infinity 被拒绝', () => {
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', { accepted: true, textLength: Infinity }),
    ).toBeNull();
  });

  it('textLength = "42" 被拒绝（字符串）', () => {
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', {
        accepted: true,
        textLength: '42' as unknown as number,
      }),
    ).toBeNull();
  });

  it('result 带 prompt/path/response 等额外字段被拒绝', () => {
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', {
        accepted: true,
        textLength: 100,
        prompt: 'secret',
      }),
    ).toBeNull();
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', {
        accepted: true,
        textLength: 100,
        path: '/Users/foo',
      }),
    ).toBeNull();
    expect(
      presentTaskResult('MODEL_INVOCATION_TEST', {
        accepted: true,
        textLength: 100,
        response: 'full text',
      }),
    ).toBeNull();
  });

  it('GRILL_QUESTION_PLAN 固定文本', () => {
    expect(presentTaskResult('GRILL_QUESTION_PLAN', { anything: true })).toBe('规划任务结果已保存');
    expect(presentTaskResult('GRILL_QUESTION_PLAN', null)).toBe('规划任务结果已保存');
  });

  it('CREATION_CONTRACT_DRAFT 有效白名单结果显示', () => {
    const result = presentTaskResult('CREATION_CONTRACT_DRAFT', {
      proposalId: 'prop-00000001',
      schemaVersion: 1,
      baseGrillSessionVersion: 2,
      baseContractVersion: null,
      sectionCount: 17,
    });
    expect(result).toContain('创作契约草案已生成');
    expect(result).toContain('17');
  });

  it('CREATION_CONTRACT_DRAFT 只展示白名单字段，不泄露 proposalId 完整值', () => {
    const result = presentTaskResult('CREATION_CONTRACT_DRAFT', {
      proposalId: 'prop-00000001',
      schemaVersion: 1,
      baseGrillSessionVersion: 2,
      baseContractVersion: 3,
      sectionCount: 5,
    });
    expect(result).not.toContain('prop-00000001');
    expect(result).not.toContain('schemaVersion');
    expect(result).not.toContain('2');
  });

  it('CREATION_CONTRACT_DRAFT 额外字段被拒绝（白名单校验）', () => {
    expect(
      presentTaskResult('CREATION_CONTRACT_DRAFT', {
        proposalId: 'prop-00000001',
        schemaVersion: 1,
        baseGrillSessionVersion: 2,
        baseContractVersion: null,
        sectionCount: 5,
        sections: { premise: 'secret' },
      }),
    ).toBeNull();
  });

  it('CREATION_CONTRACT_DRAFT 无效字段类型被拒绝', () => {
    expect(
      presentTaskResult('CREATION_CONTRACT_DRAFT', {
        proposalId: 'prop-00000001',
        schemaVersion: '1' as unknown as number,
        baseGrillSessionVersion: 2,
        baseContractVersion: null,
        sectionCount: 5,
      }),
    ).toBeNull();
    expect(
      presentTaskResult('CREATION_CONTRACT_DRAFT', {
        proposalId: 'prop-00000001',
        schemaVersion: 1,
        baseGrillSessionVersion: 2,
        baseContractVersion: null,
        sectionCount: -1,
      }),
    ).toBeNull();
    expect(
      presentTaskResult('CREATION_CONTRACT_DRAFT', {
        proposalId: 'prop-00000001',
        schemaVersion: 1,
        baseGrillSessionVersion: 0,
        baseContractVersion: null,
        sectionCount: 5,
      }),
    ).toBeNull();
    expect(presentTaskResult('CREATION_CONTRACT_DRAFT', null)).toBeNull();
    expect(presentTaskResult('CREATION_CONTRACT_DRAFT', undefined)).toBeNull();
  });

  it('未知类型有 result 时显示通用文本', () => {
    expect(presentTaskResult('UNKNOWN_TYPE', { data: 1 })).toBe('任务结果已保存');
  });

  it('未知类型无 result 时返回 null', () => {
    expect(presentTaskResult('UNKNOWN_TYPE', null)).toBeNull();
    expect(presentTaskResult('UNKNOWN_TYPE', undefined)).toBeNull();
  });
});

// ── task-error-message ───────────────────────────────────────────────

describe('taskErrorMessage', () => {
  it('已知 errorCode 映射中文', () => {
    expect(taskErrorMessage('TASK_INTERRUPTED', null)).toBe('任务在上次运行中被中断');
    expect(taskErrorMessage('PROVIDER_TIMEOUT', null)).toBe('模型服务连接超时');
  });

  it('未知 errorCode 显示错误码', () => {
    expect(taskErrorMessage('UNKNOWN_CODE', null)).toContain('UNKNOWN_CODE');
  });

  it('无 errorCode 时使用 errorMessage', () => {
    expect(taskErrorMessage(null, '简单错误')).toBe('简单错误');
  });

  it('无任何错误信息时返回未知错误', () => {
    expect(taskErrorMessage(null, null)).toBe('未知错误');
  });
});

describe('sanitizeErrorMessage', () => {
  it('包含 /Users/ 时替换', () => {
    expect(sanitizeErrorMessage('error at /Users/foo/bar')).toBe('任务执行出现错误');
  });

  it('包含 /home/ 时替换', () => {
    expect(sanitizeErrorMessage('error at /home/user')).toBe('任务执行出现错误');
  });

  it('包含 file:// 时替换', () => {
    expect(sanitizeErrorMessage('error at file:///path')).toBe('任务执行出现错误');
  });

  it('包含 .sqlite 时替换', () => {
    expect(sanitizeErrorMessage('error in data.sqlite')).toBe('任务执行出现错误');
  });

  it('包含 node_modules 时替换', () => {
    expect(sanitizeErrorMessage('error in node_modules/pkg')).toBe('任务执行出现错误');
  });

  it('包含 stack frame 时替换', () => {
    expect(sanitizeErrorMessage('Error\n    at Object.<anonymous>')).toBe('任务执行出现错误');
  });

  it('包含 UUID 时替换', () => {
    expect(sanitizeErrorMessage('task a1b2c3d4-e5f6-7890-abcd-ef1234567890 failed')).toBe(
      '任务执行出现错误',
    );
  });

  it('安全消息原样返回', () => {
    expect(sanitizeErrorMessage('连接超时')).toBe('连接超时');
  });
});

describe('sanitizeLoadError', () => {
  it('Error 含路径时使用默认提示', () => {
    expect(sanitizeLoadError(new Error('fail at /Users/foo'), '默认提示')).toBe('默认提示');
  });

  it('Error 含 stack 时使用默认提示', () => {
    expect(sanitizeLoadError(new Error('Error\n    at foo (bar.js:1:1)'), '默认提示')).toBe(
      '默认提示',
    );
  });

  it('Error 含 .sqlite 时使用默认提示', () => {
    expect(sanitizeLoadError(new Error('open data.sqlite failed'), '默认提示')).toBe('默认提示');
  });

  it('安全 Error 消息原样返回', () => {
    expect(sanitizeLoadError(new Error('网络错误'), '默认提示')).toBe('网络错误');
  });

  it('非 Error 使用默认提示', () => {
    expect(sanitizeLoadError('string error', '默认提示')).toBe('默认提示');
    expect(sanitizeLoadError(null, '默认提示')).toBe('默认提示');
    expect(sanitizeLoadError(undefined, '默认提示')).toBe('默认提示');
  });
});
