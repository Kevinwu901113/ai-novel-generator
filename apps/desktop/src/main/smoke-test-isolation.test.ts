import { describe, it, expect } from 'vitest';

/**
 * 验证 smoke-test 参数检测逻辑。
 *
 * 这些测试确认：
 * - 明确传入 --smoke-test 时进入 smoke 模式；
 * - 无参数（正常启动）不属于 smoke 模式；
 * - 相似但不同的参数不被误判。
 */
describe('smoke-test 参数隔离', () => {
  /**
   * 模拟 index.ts 中的检测逻辑：
   *   const isSmokeTest = process.argv.includes('--smoke-test');
   */
  function detectSmokeTest(argv: string[]): boolean {
    return argv.includes('--smoke-test');
  }

  it('显式传入 --smoke-test 时应为 true', () => {
    expect(detectSmokeTest(['/app', '--smoke-test'])).toBe(true);
  });

  it('无参数（正常启动）应为 false', () => {
    expect(
      detectSmokeTest(['/Applications/AI小说创作代理.app/Contents/MacOS/ai-novel-generator']),
    ).toBe(false);
  });

  it('空 argv 应为 false', () => {
    expect(detectSmokeTest([])).toBe(false);
  });

  it('仅含 Electron 内部参数应为 false', () => {
    expect(detectSmokeTest(['/app', '--no-sandbox', '--disable-gpu'])).toBe(false);
  });

  it('相似但不同的参数应为 false', () => {
    expect(detectSmokeTest(['/app', '--smoke', '--test'])).toBe(false);
    expect(detectSmokeTest(['/app', '--smoke-test-extra'])).toBe(false);
  });

  it('仅含路径和 Electron 参数的正常启动应为 false', () => {
    // macOS .app 实际启动 argv
    expect(
      detectSmokeTest(['/Applications/AI小说创作代理.app/Contents/MacOS/ai-novel-generator']),
    ).toBe(false);
    // 带 Electron 内部参数
    expect(
      detectSmokeTest([
        '/Applications/AI小说创作代理.app/Contents/MacOS/ai-novel-generator',
        '--no-sandbox',
      ]),
    ).toBe(false);
  });
});
