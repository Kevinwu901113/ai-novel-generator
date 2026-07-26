import { describe, it, expect } from 'vitest';
import {
  isValidHealthCheckResponse,
  isValidCreateProjectInput,
  isValidOpenProjectInput,
  isAppError,
  type HealthCheckResponse,
} from './index';

describe('isValidHealthCheckResponse', () => {
  it('应该接受有效的健康检查响应', () => {
    const valid: HealthCheckResponse = {
      ok: true,
      timestamp: '2024-01-01T00:00:00.000Z',
      version: '1.0.0',
    };
    expect(isValidHealthCheckResponse(valid)).toBe(true);
  });

  it('应该接受 ok=false 的响应', () => {
    const valid: HealthCheckResponse = {
      ok: false,
      timestamp: '2024-01-01T00:00:00.000Z',
      version: '1.0.0',
    };
    expect(isValidHealthCheckResponse(valid)).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidHealthCheckResponse(null)).toBe(false);
  });

  it('应该拒绝 undefined', () => {
    expect(isValidHealthCheckResponse(undefined)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidHealthCheckResponse('string')).toBe(false);
    expect(isValidHealthCheckResponse(42)).toBe(false);
    expect(isValidHealthCheckResponse(true)).toBe(false);
  });

  it('应该拒绝缺少 ok 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝缺少 timestamp 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝缺少 version 字段的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('应该拒绝 ok 字段类型错误的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: 'true',
        timestamp: '2024-01-01T00:00:00.000Z',
        version: '1.0.0',
      }),
    ).toBe(false);
  });

  it('应该拒绝 timestamp 字段类型错误的对象', () => {
    expect(
      isValidHealthCheckResponse({
        ok: true,
        timestamp: 1234567890,
        version: '1.0.0',
      }),
    ).toBe(false);
  });
});

describe('isValidCreateProjectInput', () => {
  it('应该接受有效输入', () => {
    expect(isValidCreateProjectInput({ name: '测试', initialIdea: '想法' })).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidCreateProjectInput(null)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidCreateProjectInput('string')).toBe(false);
  });

  it('应该拒绝缺少 name 的对象', () => {
    expect(isValidCreateProjectInput({ initialIdea: '想法' })).toBe(false);
  });

  it('应该拒绝缺少 initialIdea 的对象', () => {
    expect(isValidCreateProjectInput({ name: '测试' })).toBe(false);
  });

  it('应该拒绝 name 类型错误', () => {
    expect(isValidCreateProjectInput({ name: 123, initialIdea: '想法' })).toBe(false);
  });

  it('应该拒绝 initialIdea 类型错误', () => {
    expect(isValidCreateProjectInput({ name: '测试', initialIdea: 123 })).toBe(false);
  });
});

describe('isValidOpenProjectInput', () => {
  it('应该接受有效输入', () => {
    expect(isValidOpenProjectInput({ projectId: 'abc-123' })).toBe(true);
  });

  it('应该拒绝 null', () => {
    expect(isValidOpenProjectInput(null)).toBe(false);
  });

  it('应该拒绝非对象值', () => {
    expect(isValidOpenProjectInput(42)).toBe(false);
  });

  it('应该拒绝缺少 projectId 的对象', () => {
    expect(isValidOpenProjectInput({})).toBe(false);
  });

  it('应该拒绝 projectId 类型错误', () => {
    expect(isValidOpenProjectInput({ projectId: 123 })).toBe(false);
  });
});

describe('isAppError', () => {
  it('应该接受有效的 AppError', () => {
    expect(isAppError({ code: 'VALIDATION_ERROR', message: '验证失败' })).toBe(true);
  });

  it('应该接受所有有效错误码', () => {
    const codes = [
      'VALIDATION_ERROR',
      'PROJECT_NOT_FOUND',
      'PROJECT_DIRECTORY_MISSING',
      'PROJECT_DATABASE_INVALID',
      'DATABASE_VERSION_UNSUPPORTED',
      'PROJECT_CREATE_FAILED',
      'WORKER_UNAVAILABLE',
    ];
    for (const code of codes) {
      expect(isAppError({ code, message: '错误' })).toBe(true);
    }
  });

  it('应该拒绝无效错误码', () => {
    expect(isAppError({ code: 'UNKNOWN_CODE', message: '错误' })).toBe(false);
  });

  it('应该拒绝缺少 message 的对象', () => {
    expect(isAppError({ code: 'VALIDATION_ERROR' })).toBe(false);
  });

  it('应该拒绝 null', () => {
    expect(isAppError(null)).toBe(false);
  });
});
