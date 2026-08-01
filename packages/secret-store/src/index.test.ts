/**
 * @ai-novel/secret-store 行为 / 安全 / 边界测试。
 *
 * 全部 fake execFile，不触网、不触碰真实 Keychain 条目。
 * 覆盖：get/set/delete/has、item not found、timeout、safe error、
 * no shell、no secret logging、package boundary。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMacOSKeychainSecretStore } from './index.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const mockExecFile = vi.mocked(execFile);
const SECURITY_PATH = '/usr/bin/security';

interface ExecFileCallback {
  (error: NodeJS.ErrnoException | null, stdout: string, stderr: string): void;
}

function mockOk(stdout = ''): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, stdout, '');
    },
  );
}

function mockError(code?: number, extra: Partial<NodeJS.ErrnoException> = {}): void {
  const err = new Error('boom') as NodeJS.ErrnoException;
  if (code !== undefined) err.code = code as never;
  Object.assign(err, extra);
  mockExecFile.mockImplementation(
    (_file: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(err, '', '');
    },
  );
}

function lastArgs(): string[] {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1];
  return call ? (call[1] as string[]) : [];
}

const SERVICE = 'com.ai-novel-generator.test.service';
const ACCOUNT = 'test-account';

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('createMacOSKeychainSecretStore 行为', () => {
  const store = createMacOSKeychainSecretStore();

  it('getSecret 成功时返回去掉末尾换行的 secret', async () => {
    mockOk('sk-live-secret-123\n');
    const secret = await store.getSecret(SERVICE, ACCOUNT);
    expect(secret).toBe('sk-live-secret-123');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('getSecret 空输出返回 null', async () => {
    mockOk('');
    expect(await store.getSecret(SERVICE, ACCOUNT)).toBeNull();
  });

  it('hasSecret 命中返回 true', async () => {
    mockOk();
    expect(await store.hasSecret(SERVICE, ACCOUNT)).toBe(true);
  });

  it('setSecret 使用 add-generic-password -U 原子更新', async () => {
    mockOk();
    await store.setSecret(SERVICE, ACCOUNT, 'secret-value');
    const args = lastArgs();
    expect(args).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      SERVICE,
      '-a',
      ACCOUNT,
      '-w',
      'secret-value',
    ]);
  });

  it('deleteSecret 成功时 resolve', async () => {
    mockOk();
    await expect(store.deleteSecret(SERVICE, ACCOUNT)).resolves.toBeUndefined();
  });
});

describe('item not found（security 退出码 44）', () => {
  const store = createMacOSKeychainSecretStore();

  it('getSecret 返回 null（不是抛错）', async () => {
    mockError(44);
    expect(await store.getSecret(SERVICE, ACCOUNT)).toBeNull();
  });

  it('hasSecret 返回 false', async () => {
    mockError(44);
    expect(await store.hasSecret(SERVICE, ACCOUNT)).toBe(false);
  });

  it('deleteSecret 幂等（不抛错）', async () => {
    mockError(44);
    await expect(store.deleteSecret(SERVICE, ACCOUNT)).resolves.toBeUndefined();
  });
});

describe('系统故障 / 超时', () => {
  const store = createMacOSKeychainSecretStore();

  it('非 44 的系统故障抛安全错误', async () => {
    mockError(1);
    await expect(store.getSecret(SERVICE, ACCOUNT)).rejects.toThrow('无法读取 Keychain');
    await expect(store.hasSecret(SERVICE, ACCOUNT)).rejects.toThrow('无法访问 Keychain');
    await expect(store.setSecret(SERVICE, ACCOUNT, 'x')).rejects.toThrow('无法写入 Keychain');
    await expect(store.deleteSecret(SERVICE, ACCOUNT)).rejects.toThrow('无法删除 Keychain 项');
  });

  it('超时（killed）被归类为系统故障，抛安全错误而非原始错误', async () => {
    mockError(undefined, { killed: true, signal: 'SIGTERM' });
    await expect(store.getSecret(SERVICE, ACCOUNT)).rejects.toThrow('无法读取 Keychain');
  });
});

describe('安全：no shell / no secret logging / 固定路径', () => {
  const store = createMacOSKeychainSecretStore();

  it('execFile 以 shell:false 调用 /usr/bin/security', async () => {
    mockOk('secret\n');
    await store.getSecret(SERVICE, ACCOUNT);
    const call = mockExecFile.mock.calls[0];
    expect(call[0]).toBe(SECURITY_PATH);
    const opts = call[2] as Record<string, unknown>;
    expect(opts.shell).toBe(false);
    expect(opts.encoding).toBe('utf8');
  });

  it('安全错误消息不包含 secret / argv / stderr', async () => {
    mockError(1);
    await expect(store.getSecret(SERVICE, ACCOUNT)).rejects.toThrow('无法读取 Keychain');
    await expect(store.setSecret(SERVICE, ACCOUNT, 'TOP-SECRET-VALUE')).rejects.toThrow(
      '无法写入 Keychain',
    );
  });

  it('getSecret 失败时不会把 secret 写入任何错误对象', async () => {
    mockError(1);
    try {
      await store.getSecret(SERVICE, ACCOUNT);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(String(err)).not.toContain('TOP-SECRET');
      expect(String(err)).not.toContain('/usr/bin/security');
    }
  });
});

describe('package boundary', () => {
  it('dependencies 仅 @ai-novel/application（type-only SecretStore）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ '@ai-novel/application': 'workspace:*' });
  });

  it('实现只用 execFile（shell:false），无 shell 拼接 / spawn / execSync / 网络', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'index.ts'), 'utf8');
    expect(source).toContain("from 'node:child_process'");
    expect(source).toMatch(/execFile\(/);
    expect(source).not.toMatch(/\bshell\s*:\s*true\b/);
    expect(source).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bspawn\(/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/node:https|node:http|node:sqlite|node:net/);
  });
});
