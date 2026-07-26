import { describe, it, expect } from 'vitest';
import { isValidHealthCheckResponse, type HealthCheckResponse } from './index';

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
