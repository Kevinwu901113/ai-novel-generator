/**
 * 目录级原子发布测试。
 *
 * 覆盖：normal / final 已存在 / force / staging 预存在 / backup 预存在 /
 * publish rename 失败 / backup 恢复 / cleanup / partial failure 快照 / 无绝对路径泄漏。
 */

import { describe, it, expect } from 'vitest';
import { createFakeFs } from './test-util.js';
import { preflightPublish, publishDirectory } from './publish.js';
import { CliUsageError } from './safe-error.js';

function makePublishDeps(fs: ReturnType<typeof createFakeFs>) {
  return {
    exists: fs.exists,
    renameDir: fs.renameDir,
    removeDir: fs.removeDir,
    idGenerator: () => 'run1',
  };
}

const OPTS = {
  finalDir: '/out/exp1',
  stagingDir: '/out/exp1.gq2-tmp-run1',
  backupDir: '/out/exp1.gq2-bak-run1',
  force: false,
};

describe('preflightPublish', () => {
  it('final 不存在 + staging/backup 不存在 → 通过', () => {
    const fs = createFakeFs();
    expect(() => preflightPublish(makePublishDeps(fs), OPTS)).not.toThrow();
  });

  it('final 已存在且无 --force → 前置拒绝（安全消息，无绝对路径）', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.finalDir);
    let err: unknown;
    try {
      preflightPublish(makePublishDeps(fs), OPTS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliUsageError);
    expect(String((err as Error).message)).toMatch(/已存在/);
    expect(String((err as Error).message)).not.toContain('/out/');
  });

  it('final 已存在 + --force → 通过（授权覆盖）', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.finalDir);
    expect(() => preflightPublish(makePublishDeps(fs), { ...OPTS, force: true })).not.toThrow();
  });

  it('staging 预存在 → 前置拒绝，任何写入前', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.stagingDir);
    expect(() => preflightPublish(makePublishDeps(fs), OPTS)).toThrow(/暂存目录/);
  });

  it('backup 预存在 → 前置拒绝', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.backupDir);
    expect(() => preflightPublish(makePublishDeps(fs), OPTS)).toThrow(/备份目录/);
  });
});

describe('publishDirectory', () => {
  it('normal：staging → final，无 backup 残留', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.stagingDir);
    fs.writeFile(`${OPTS.stagingDir}/manifest.private.json`, '{}');
    publishDirectory(makePublishDeps(fs), OPTS);
    expect(fs.exists(`${OPTS.finalDir}/manifest.private.json`)).toBe(true);
    expect(fs.exists(OPTS.stagingDir)).toBe(false);
    expect(fs.exists(OPTS.backupDir)).toBe(false);
  });

  it('force：旧 final 移到 backup，成功后删除 backup', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.finalDir);
    fs.writeFile(`${OPTS.finalDir}/old.txt`, 'old');
    fs.mkdir(OPTS.stagingDir);
    fs.writeFile(`${OPTS.stagingDir}/manifest.private.json`, '{}');
    publishDirectory(makePublishDeps(fs), { ...OPTS, force: true });
    expect(fs.exists(`${OPTS.finalDir}/manifest.private.json`)).toBe(true);
    expect(fs.exists(`${OPTS.finalDir}/old.txt`)).toBe(false);
    expect(fs.exists(OPTS.backupDir)).toBe(false);
  });

  it('publish rename 失败（staging 不存在）→ 不产生 final，错误上抛', () => {
    const fs = createFakeFs();
    // staging 未创建：rename 会抛 ENOENT
    expect(() => publishDirectory(makePublishDeps(fs), OPTS)).toThrow();
    expect(fs.exists(OPTS.finalDir)).toBe(false);
  });

  it('force 时 rename staging→final 失败 → 恢复 backup 到 final', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.finalDir);
    fs.writeFile(`${OPTS.finalDir}/old.txt`, 'old');
    // staging 缺失 → rename staging→final 抛错；backup 已移动，应恢复
    expect(() =>
      publishDirectory(
        {
          ...makePublishDeps(fs),
          renameDir: (from, to) => {
            if (from === OPTS.stagingDir) throw new Error('boom');
            fs.renameDir(from, to);
          },
        },
        { ...OPTS, force: true },
      ),
    ).toThrow('boom');
    expect(fs.exists(`${OPTS.finalDir}/old.txt`)).toBe(true);
    expect(fs.exists(OPTS.backupDir)).toBe(false);
  });

  it('失败时清理残留 staging', () => {
    const fs = createFakeFs();
    fs.mkdir(OPTS.finalDir);
    fs.writeFile(`${OPTS.finalDir}/old.txt`, 'old');
    fs.mkdir(OPTS.stagingDir);
    fs.writeFile(`${OPTS.stagingDir}/m.json`, '{}');
    // 让 rename staging→final 失败
    let called = false;
    expect(() =>
      publishDirectory(
        {
          ...makePublishDeps(fs),
          renameDir: (from, to) => {
            if (from === OPTS.stagingDir && !called) {
              called = true;
              throw new Error('boom');
            }
            fs.renameDir(from, to);
          },
        },
        { ...OPTS, force: true },
      ),
    ).toThrow('boom');
    expect(fs.exists(OPTS.stagingDir)).toBe(false);
    expect(fs.exists(`${OPTS.finalDir}/old.txt`)).toBe(true);
  });
});

describe('partial failure 诊断快照', () => {
  it('失败运行仍可把 manifest + case-results 作为完整目录原子发布', () => {
    const fs = createFakeFs();
    const staging = OPTS.stagingDir;
    fs.mkdir(staging);
    fs.writeFile(`${staging}/manifest.private.json`, '{"runStatus":"PARTIAL_FAILURE"}');
    fs.writeFile(`${staging}/case-results.private.json`, '{"cases":[]}');
    // 没有 candidates.private.json（不允许出现“完整 candidate suite”命名）
    expect(fs.exists(`${staging}/candidates.private.json`)).toBe(false);
    publishDirectory(makePublishDeps(fs), OPTS);
    expect(fs.exists(`${OPTS.finalDir}/manifest.private.json`)).toBe(true);
    expect(fs.exists(`${OPTS.finalDir}/case-results.private.json`)).toBe(true);
    expect(fs.exists(`${OPTS.finalDir}/candidates.private.json`)).toBe(false);
  });
});
