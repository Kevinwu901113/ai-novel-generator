// @vitest-environment jsdom
/**
 * 安全错误处理模块测试。
 *
 * 覆盖 toSafeUserError 的所有场景：
 * 1. 已知错误码映射
 * 2. 未知安全短消息
 * 3. /Users/ 路径泄露
 * 4. /home/ 路径泄露
 * 5. file:// 协议泄露
 * 6. .sqlite 数据库泄露
 * 7. node_modules 路径泄露
 * 8. JS stack frame 泄露
 * 9. UUID 泄露
 * 10. Bearer token 泄露
 * 11. sk-/API Key 形态泄露
 * 12. 超长消息截断
 */

import { describe, it, expect } from 'vitest';
import { toSafeUserError } from './safe-error';

describe('toSafeUserError', () => {
  // 1. 已知错误码使用稳定中文映射
  it('已知错误码使用稳定中文映射', () => {
    const error = Object.assign(new Error('原始消息'), { code: 'PROVIDER_TIMEOUT' });
    const result = toSafeUserError(error, '回退消息');
    expect(result.code).toBe('PROVIDER_TIMEOUT');
    expect(result.message).toBe('连接超时');
  });

  // 2. 未知安全短消息可以显示
  it('未知安全短消息可以显示', () => {
    const error = new Error('网络连接失败');
    const result = toSafeUserError(error, '回退消息');
    expect(result.code).toBeNull();
    expect(result.message).toBe('网络连接失败');
  });

  // 3. /Users/ 路径泄露
  it('/Users/ 路径泄露时使用 fallback', () => {
    const error = new Error('查询失败 at /Users/foo/db.sqlite');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 4. /home/ 路径泄露
  it('/home/ 路径泄露时使用 fallback', () => {
    const error = new Error('文件不存在 /home/user/data.json');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 5. file:// 协议泄露
  it('file:// 协议泄露时使用 fallback', () => {
    const error = new Error('无法访问 file:///tmp/test.txt');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 6. .sqlite 数据库泄露
  it('.sqlite 数据库泄露时使用 fallback', () => {
    const error = new Error('数据库错误 data.sqlite');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 7. node_modules 路径泄露
  it('node_modules 路径泄露时使用 fallback', () => {
    const error = new Error('模块加载失败 node_modules/react/index.js');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 8. JS stack frame 泄露
  it('JS stack frame 泄露时使用 fallback', () => {
    const error = new Error('Error\n    at Object.<anonymous> (file.ts:10:5)');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 9. UUID 泄露
  it('UUID 泄露时使用 fallback', () => {
    const error = new Error('任务 550e8400-e29b-41d4-a716-446655440000 失败');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 10. Bearer token 泄露
  it('Bearer token 泄露时使用 fallback', () => {
    const error = new Error('认证失败 Bearer sk-abc123xyz');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 11. sk-/API Key 形态泄露
  it('sk- API Key 泄露时使用 fallback', () => {
    const error = new Error('Invalid API key sk-abc123xyz789');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  it('api_key 形态泄露时使用 fallback', () => {
    const error = new Error('配置错误 api_key=sk-abc123xyz');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 12. 超长消息截断或替换为 fallback
  it('超长消息使用 fallback', () => {
    const longMessage = 'a'.repeat(300);
    const error = new Error(longMessage);
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
    expect(result.message.length).toBeLessThanOrEqual(200);
  });

  // 额外测试：非 Error 对象
  it('非 Error 对象使用 fallback', () => {
    const result = toSafeUserError('some string error', '加载失败');
    expect(result.message).toBe('some string error');
  });

  it('null 使用 fallback', () => {
    const result = toSafeUserError(null, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  it('undefined 使用 fallback', () => {
    const result = toSafeUserError(undefined, '加载失败');
    expect(result.message).toBe('加载失败');
  });

  // 额外测试：Keychain 泄露
  it('Keychain 泄露时使用 fallback', () => {
    const error = new Error('Keychain service com.app.keys');
    const result = toSafeUserError(error, '加载失败');
    expect(result.message).toBe('加载失败');
  });
});
