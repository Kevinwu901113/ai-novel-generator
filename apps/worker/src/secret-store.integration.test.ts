/**
 * macOS Keychain 真实集成测试。
 *
 * 默认跳过。仅在显式设置环境变量时运行：
 *   INTEGRATION_KEYCHAIN_TEST=1 pnpm exec vitest run apps/worker/src/secret-store.integration.test.ts
 *
 * 安全要求：
 * - 使用随机 service/account，不使用真实 MiMo service
 * - 使用明显无效的随机 secret（不使用真实 Key）
 * - finally 中必须清理所有测试 Keychain 条目
 * - 不打印 secret 到日志或输出
 */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMacOSKeychainSecretStore } from './secret-store.js';

const ENABLED = process.env.INTEGRATION_KEYCHAIN_TEST === '1';

// 使用随机 service 避免与真实条目冲突
const TEST_SERVICE = `com.ai-novel-generator.test.${randomUUID().slice(0, 8)}`;
const TEST_ACCOUNT = `test-account-${randomUUID().slice(0, 8)}`;

// 明显无效的随机 secret
const TEST_SECRET_1 = `test-secret-not-real-${randomUUID()}`;
const TEST_SECRET_2 = `test-secret-overwrite-${randomUUID()}`;

// 需要清理的条目
const entriesToCleanup: Array<{ service: string; account: string }> = [];

afterAll(async () => {
  if (!ENABLED) return;
  const store = createMacOSKeychainSecretStore();
  for (const entry of entriesToCleanup) {
    try {
      await store.deleteSecret(entry.service, entry.account);
    } catch {
      // 忽略清理错误
    }
  }
});

describe.skipIf(!ENABLED)('macOS Keychain 集成测试', () => {
  const store = createMacOSKeychainSecretStore();

  it('set → has → get 完整流程', async () => {
    entriesToCleanup.push({ service: TEST_SERVICE, account: TEST_ACCOUNT });

    // set
    await store.setSecret(TEST_SERVICE, TEST_ACCOUNT, TEST_SECRET_1);

    // has
    expect(await store.hasSecret(TEST_SERVICE, TEST_ACCOUNT)).toBe(true);

    // get
    const retrieved = await store.getSecret(TEST_SERVICE, TEST_ACCOUNT);
    expect(retrieved).toBe(TEST_SECRET_1);
  });

  it('overwrite → get 覆盖旧值', async () => {
    // overwrite
    await store.setSecret(TEST_SERVICE, TEST_ACCOUNT, TEST_SECRET_2);

    // get (应该返回新值)
    const retrieved = await store.getSecret(TEST_SERVICE, TEST_ACCOUNT);
    expect(retrieved).toBe(TEST_SECRET_2);
  });

  it('delete → has 删除后不存在', async () => {
    // delete
    await store.deleteSecret(TEST_SERVICE, TEST_ACCOUNT);

    // has
    expect(await store.hasSecret(TEST_SERVICE, TEST_ACCOUNT)).toBe(false);

    // get
    expect(await store.getSecret(TEST_SERVICE, TEST_ACCOUNT)).toBeNull();
  });

  it('delete 幂等：删除不存在的条目不报错', async () => {
    const ghostService = `com.ai-novel-generator.test.ghost-${randomUUID().slice(0, 8)}`;
    const ghostAccount = `ghost-${randomUUID().slice(0, 8)}`;

    // 不存在时删除不抛出
    await expect(store.deleteSecret(ghostService, ghostAccount)).resolves.not.toThrow();
  });

  it('hasSecret 不存在时返回 false', async () => {
    const noService = `com.ai-novel-generator.test.no-${randomUUID().slice(0, 8)}`;
    const noAccount = `no-${randomUUID().slice(0, 8)}`;

    expect(await store.hasSecret(noService, noAccount)).toBe(false);
  });

  it('getSecret 不存在时返回 null', async () => {
    const noService = `com.ai-novel-generator.test.no2-${randomUUID().slice(0, 8)}`;
    const noAccount = `no2-${randomUUID().slice(0, 8)}`;

    expect(await store.getSecret(noService, noAccount)).toBeNull();
  });
});
