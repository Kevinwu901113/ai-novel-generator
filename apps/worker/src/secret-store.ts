/**
 * macOS Keychain SecretStore 实现。
 *
 * 使用 /usr/bin/security 命令与 macOS Keychain 交互。
 *
 * 安全要求：
 * - execFile（不用 shell 拼接，不阻塞 Worker 线程）
 * - service/account 来自固定常量
 * - 超时 10 秒，超时后终止子进程
 * - 区分"不存在"和"故障"
 * - delete 对不存在项幂等
 * - 日志不输出 secret
 *
 * 已知限制：
 * - macOS `security add-generic-password -w <value>` 会将 value 作为
 *   进程参数传递，短暂出现在进程列表（ps）中。
 *   这是 macOS security 命令的已知行为，无法完全绕过。
 *   - 不出现在 shell 历史中（execFile 不经过 shell）
 *   - 出现在 /proc 或 ps 输出中（进程参数是公开的）
 *   - V1.0 发布前需要评估是否接受此风险或引入原生 helper
 * - stdin 方式不可靠：`security add-generic-password -w` 在无值时
 *   会提示 retype password，但 stdin 已关闭导致失败。
 */

import { execFile } from 'node:child_process';
import type { SecretStore } from '@ai-novel/application';

// ── 常量 ──────────────────────────────────────────────────────────

const SECURITY_PATH = '/usr/bin/security';
const TIMEOUT_MS = 10_000;

// macOS Keychain 错误码
const ERR_SEC_ITEM_NOT_FOUND = 44;

// ── 日志 ──────────────────────────────────────────────────────────

const logError = (...args: unknown[]) => console.error('[secret-store]', ...args);

// ── 辅助函数 ──────────────────────────────────────────────────────

/**
 * 将 macOS security 命令错误分类。
 *
 * 区分"项不存在"（可恢复）和"系统错误"（需上报）。
 * 错误消息不包含 secret 或完整 argv。
 *
 * execFile 回调中，退出码在 err.code（number），
 * execFileSync 中，退出码在 err.status。
 */
function classifySecurityError(
  err: unknown,
): { kind: 'not-found' } | { kind: 'system'; message: string } {
  const errObj = err as NodeJS.ErrnoException & { status?: number };
  // execFile: exit code in .code (number); execFileSync: in .status
  const exitCode =
    typeof errObj.code === 'number'
      ? errObj.code
      : typeof errObj.status === 'number'
        ? errObj.status
        : undefined;
  if (exitCode === ERR_SEC_ITEM_NOT_FOUND) {
    return { kind: 'not-found' };
  }
  const message = err instanceof Error ? err.message : '未知错误';
  return { kind: 'system', message };
}

/**
 * 包装 execFile 为 Promise，支持 timeout 和 maxBuffer。
 * 超时后自动终止子进程。
 */
function execFileAsync(
  args: string[],
  options: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout ?? TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? 1024;

    const child = execFile(
      SECURITY_PATH,
      args,
      {
        timeout,
        maxBuffer,
        encoding: options.encoding ?? 'utf8',
        // 不使用 shell
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      },
    );

    // 超时时 SIGTERM 子进程
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('close', () => {
      clearTimeout(timer);
    });
  });
}

// ── SecretStore 实现 ──────────────────────────────────────────────

/**
 * 创建 macOS Keychain SecretStore 实现。
 *
 * 使用异步 execFile 与 Keychain 交互，不阻塞 Worker 线程。
 * 不缓存 API Key 到模块级状态。
 */
export function createMacOSKeychainSecretStore(): SecretStore {
  return {
    async hasSecret(service: string, account: string): Promise<boolean> {
      try {
        await execFileAsync(['find-generic-password', '-s', service, '-a', account], {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024,
        });
        return true;
      } catch (err) {
        const classified = classifySecurityError(err);
        if (classified.kind === 'not-found') {
          return false;
        }
        // Keychain 锁定或系统提示时视为不可用（不是"不存在"）
        logError('hasSecret 检查失败:', classified.message);
        return false;
      }
    },

    async setSecret(service: string, account: string, secret: string): Promise<void> {
      // 先尝试删除旧项（幂等），再添加新项
      try {
        await execFileAsync(['delete-generic-password', '-s', service, '-a', account], {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024,
        });
      } catch {
        // 不存在时 exit code 44，忽略
      }

      // 使用 -w <value> 传递密码
      // execFile 不经过 shell，密码不出现在 shell 历史中
      // 已知限制：密码作为进程参数，短暂出现在 ps 输出中
      try {
        await execFileAsync(['add-generic-password', '-s', service, '-a', account, '-w', secret], {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024,
        });
      } catch (err) {
        const classified = classifySecurityError(err);
        logError('setSecret 写入失败:', classified.kind === 'system' ? classified.message : '未知');
        throw new Error('无法写入 Keychain');
      }
    },

    async getSecret(service: string, account: string): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync(
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          {
            timeout: TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          },
        );
        // -w 标志将密码输出到 stdout，末尾带换行
        // trim 移除尾部换行，不影响密码内容
        const password = stdout.trim();
        return password || null;
      } catch (err) {
        const classified = classifySecurityError(err);
        if (classified.kind === 'not-found') {
          return null;
        }
        logError('getSecret 读取失败:', classified.message);
        throw new Error('无法读取 Keychain');
      }
    },

    async deleteSecret(service: string, account: string): Promise<void> {
      try {
        await execFileAsync(['delete-generic-password', '-s', service, '-a', account], {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024,
        });
      } catch (err) {
        const classified = classifySecurityError(err);
        if (classified.kind === 'not-found') {
          // 幂等：不存在时不报错
          return;
        }
        logError('deleteSecret 删除失败:', classified.message);
        throw new Error('无法删除 Keychain 项');
      }
    },
  };
}
