/**
 * B11 server 集成测试：起真 http.Server（端口 0）+ 真 worker initialize（临时数据根），
 * 用真实 fetch 打端到端。覆盖：
 * - 认证（无/错 token 401；Host 白名单 403）
 * - readiness（starting → ready；失败态 WORKER_UNAVAILABLE；dataServiceRetry 恢复）
 * - 业务链路（project.create → project.list）
 * - 服务端校验（未知命令 / 非法 payload / research 域坏 payload——该域 handler 内部
 *   零校验，服务端这层是真实安全边界，必须实打实挡住）
 * - 静态托管（路径穿越 404、CSP/缓存 header）
 *
 * 不触 Keychain（覆盖的命令不经 secret-store），ubuntu CI 可跑。
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './app.js';

const HOST = '127.0.0.1';

interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

function rpcUrl(running: RunningServer): string {
  return `http://${HOST}:${running.port}/api/rpc`;
}

async function callRpc(
  running: RunningServer,
  command: string,
  payload?: unknown,
  options?: { readonly token?: string | null },
): Promise<{ status: number; envelope: Envelope }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options?.token === undefined ? running.token : options.token;
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(rpcUrl(running), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload === undefined ? { command } : { command, payload }),
  });
  return { status: response.status, envelope: (await response.json()) as Envelope };
}

describe('server 集成（正常路径）', () => {
  let tempRoot: string;
  let running: RunningServer;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ai-novel-server-test-'));
    const webRoot = join(tempRoot, 'web-dist');
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(webRoot, 'assets', 'entry.js'), 'export {};');

    running = await startServer({
      dataRoot: join(tempRoot, 'data'),
      host: HOST,
      port: 0,
      webRoot,
      version: 'test',
    });
  });

  afterAll(async () => {
    await running.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('无 token 的 RPC 请求得 401，且不进入业务分发', async () => {
    const { status, envelope } = await callRpc(running, 'app.healthCheck', undefined, {
      token: null,
    });
    expect(status).toBe(401);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('UNAUTHORIZED');
  });

  it('错误 token 得 401', async () => {
    const { status } = await callRpc(running, 'app.healthCheck', undefined, {
      token: 'wrong-token',
    });
    expect(status).toBe(401);
  });

  it('Host 头不在白名单得 403（DNS rebinding 防护）', async () => {
    // fetch/undici 不允许伪造 Host 头，用原始 http.request 模拟 rebinding 场景
    const statusCode = await new Promise<number>((resolvePromise, rejectPromise) => {
      const req = request(
        {
          host: HOST,
          port: running.port,
          path: '/api/rpc',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${running.token}`,
            host: 'evil.example.com',
          },
        },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode ?? 0);
        },
      );
      req.on('error', rejectPromise);
      req.end(JSON.stringify({ command: 'app.healthCheck' }));
    });
    expect(statusCode).toBe(403);
  });

  it('healthCheck 携带正确 token 返回 ok', async () => {
    const { status, envelope } = await callRpc(running, 'app.healthCheck');
    expect(status).toBe(200);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toMatchObject({ ok: true, version: 'test' });
  });

  it('dataServiceStatus 在启动恢复完成后为 ready', async () => {
    await running.initialization;
    const { envelope } = await callRpc(running, 'app.dataServiceStatus');
    expect(envelope.data).toEqual({ status: 'ready' });
  });

  it('project.create → project.list 打通真实业务链', async () => {
    await running.initialization;
    const created = await callRpc(running, 'project.create', {
      name: '集成测试项目',
      initialIdea: '一个用于集成测试的模糊想法',
    });
    expect(created.envelope.success).toBe(true);
    const createdProject = created.envelope.data as { id: string; name: string };
    expect(createdProject.name).toBe('集成测试项目');

    const listed = await callRpc(running, 'project.list');
    expect(listed.envelope.success).toBe(true);
    const projects = listed.envelope.data as ReadonlyArray<{ id: string }>;
    expect(projects.some((p) => p.id === createdProject.id)).toBe(true);
  });

  it('未知命令得 VALIDATION_ERROR（HTTP 200 + 信封）', async () => {
    const { status, envelope } = await callRpc(running, 'graph.advanceNode', { foo: 1 });
    expect(status).toBe(200);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('VALIDATION_ERROR');
  });

  it('project.create 非法 payload 被服务端校验挡住', async () => {
    const { envelope } = await callRpc(running, 'project.create', { name: 42, initialIdea: 'x' });
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('VALIDATION_ERROR');
  });

  it('research 域坏 payload 必须被服务端校验挡住（该域 handler 内部零校验）', async () => {
    await running.initialization;
    const cases: ReadonlyArray<unknown> = [null, 42, { projectId: 42 }, { bogus: true }];
    for (const payload of cases) {
      const { envelope } = await callRpc(running, 'research.getResearchState', payload);
      expect(envelope.success).toBe(false);
      expect(envelope.error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('无 payload 命令带上 payload 会被拒绝', async () => {
    await running.initialization;
    const { envelope } = await callRpc(running, 'project.list', { sneaky: true });
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('VALIDATION_ERROR');
  });

  it('静态托管：/ 返回 index.html（no-cache + CSP + nosniff）', async () => {
    const response = await fetch(`http://${HOST}:${running.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('静态托管：hashed assets 走 immutable 缓存', async () => {
    const response = await fetch(`http://${HOST}:${running.port}/assets/entry.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('路径穿越请求得 404', async () => {
    // fetch 会归一化 URL 中的 ..，用原始 socket 语义的编码形式打
    const response = await fetch(`http://${HOST}:${running.port}/assets/%2e%2e/%2e%2e/etc/passwd`);
    expect(response.status).toBe(404);
  });

  it('未知 API 路径得 404', async () => {
    const response = await fetch(`http://${HOST}:${running.port}/api/nope`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('server 集成（初始化失败与重试）', () => {
  let tempRoot: string;
  let running: RunningServer;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ai-novel-server-fail-'));
    const dataRoot = join(tempRoot, 'data');
    // 让 app.sqlite 是个目录：token 写入正常，但 AppDatabase 打开必然失败
    mkdirSync(join(dataRoot, 'app.sqlite'), { recursive: true });
    running = await startServer({
      dataRoot,
      host: HOST,
      port: 0,
      webRoot: null,
      version: 'test',
    });
  });

  afterAll(async () => {
    await running.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('初始化失败进入 failed；业务命令得 WORKER_UNAVAILABLE；修复后 retry 恢复 ready', async () => {
    const first = await running.initialization;
    expect(first).toBe('failed');

    const status = await callRpc(running, 'app.dataServiceStatus');
    expect(status.envelope.data).toEqual({ status: 'failed' });

    const blocked = await callRpc(running, 'project.list');
    expect(blocked.envelope.success).toBe(false);
    expect(blocked.envelope.error?.code).toBe('WORKER_UNAVAILABLE');

    // 修复根因后经 app.dataServiceRetry 恢复（语义与原 Electron retryWorker 一致）
    rmdirSync(join(tempRoot, 'data', 'app.sqlite'));
    await callRpc(running, 'app.dataServiceRetry');
    await expect
      .poll(async () => (await callRpc(running, 'app.dataServiceStatus')).envelope.data, {
        timeout: 10_000,
      })
      .toEqual({ status: 'ready' });

    const after = await callRpc(running, 'project.list');
    expect(after.envelope.success).toBe(true);
  });
});
