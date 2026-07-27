/**
 * macOS Keychain SecretStore 实现。
 *
 * 使用 /usr/bin/security 命令与 macOS Keychain 交互。
 *
 * 安全要求：
 * - execFile（不用 shell 拼接，不阻塞 Worker 事件循环）
 * - service/account 由上层固定配置提供
 * - 超时 10 秒
 * - 区分“条目不存在”和系统故障
 * - delete 对不存在项幂等
 * - 不记录 argv、stderr、原始子进程错误或 secret
 *
 * 已知限制：
 * - macOS `security add-generic-password -w <value>` 会将 value 作为
 *   子进程参数短暂暴露给同一用户可见的进程检查工具。
 * - V1.0 发布前需要评估原生 Security.framework helper。
 */

import { execFile } from 'node:child_process';
import type { SecretStore } from '@ai-novel/application';

const SECURITY_PATH = '/usr/bin/security';
const TIMEOUT_MS = 10_000;
const SMALL_MAX_BUFFER = 4 * 1024;
const SECRET_MAX_BUFFER = 1024 * 1024;
const ERR_SEC_ITEM_NOT_FOUND = 44;

interface SecurityCommandError extends Error {
  readonly exitCode?: number;
}

function toSecurityCommandError(error: unknown): SecurityCommandError {
  const source = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  const result = new Error('Keychain command failed') as SecurityCommandError;

  if (typeof source.code === 'number') {
    Object.defineProperty(result, 'exitCode', { value: source.code, enumerable: false });
  }

  return result;
}

function isItemNotFound(error: unknown): boolean {
  return (error as SecurityCommandError).exitCode === ERR_SEC_ITEM_NOT_FOUND;
}

function execSecurity(
  args: string[],
  maxBuffer = SMALL_MAX_BUFFER,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      SECURITY_PATH,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          reject(toSecurityCommandError(error));
          return;
        }
        resolve({ stdout: stdout ?? '' });
      },
    );
  });
}

/** 仅移除 security -w 在输出末尾追加的单个换行。 */
function stripTrailingLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export function createMacOSKeychainSecretStore(): SecretStore {
  return {
    async hasSecret(service: string, account: string): Promise<boolean> {
      try {
        await execSecurity(['find-generic-password', '-s', service, '-a', account]);
        return true;
      } catch (error) {
        if (isItemNotFound(error)) return false;
        throw new Error('无法访问 Keychain');
      }
    },

    async setSecret(service: string, account: string, secret: string): Promise<void> {
      try {
        // -U 原子更新现有条目；条目不存在时创建，避免 delete → add 丢失窗口。
        await execSecurity([
          'add-generic-password',
          '-U',
          '-s',
          service,
          '-a',
          account,
          '-w',
          secret,
        ]);
      } catch {
        throw new Error('无法写入 Keychain');
      }
    },

    async getSecret(service: string, account: string): Promise<string | null> {
      try {
        const { stdout } = await execSecurity(
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          SECRET_MAX_BUFFER,
        );
        const secret = stripTrailingLineEnding(stdout);
        return secret.length > 0 ? secret : null;
      } catch (error) {
        if (isItemNotFound(error)) return null;
        throw new Error('无法读取 Keychain');
      }
    },

    async deleteSecret(service: string, account: string): Promise<void> {
      try {
        await execSecurity(['delete-generic-password', '-s', service, '-a', account]);
      } catch (error) {
        if (isItemNotFound(error)) return;
        throw new Error('无法删除 Keychain 项');
      }
    },
  };
}
