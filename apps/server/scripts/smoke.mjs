/**
 * B12 Web 冒烟（替代原 Electron 打包冒烟，ubuntu 可跑）：
 * 对**构建产物**真启动 apps/server（临时数据根、随机端口），验证：
 * 1. GET / 返回 index.html 且其中引用的每个 asset 都能取到（钉"构建产物实际可服务"，
 *    防 vite 产物结构变化后 server 静态托管路径假绿）；
 * 2. 无 token 的 RPC 得 401；带 token 的 app.healthCheck 得 ok:true；
 * 3. 数据服务能在超时内到 ready。
 *
 * 前置：`pnpm build` 已完成（CI 的 Build 步骤）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../dist/index.js');
const webDist = resolve(here, '../../web/dist');

const tempRoot = mkdtempSync(join(tmpdir(), 'ai-novel-smoke-'));
const dataRoot = join(tempRoot, 'data');

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exitCode = 1;
}

const child = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    AI_NOVEL_DATA_ROOT: dataRoot,
    AI_NOVEL_PORT: '0',
    AI_NOVEL_WEB_ROOT: webDist,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

function waitFor(predicate, what, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setInterval(() => {
      const result = predicate();
      if (result) {
        clearInterval(timer);
        resolvePromise(result);
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        rejectPromise(new Error(`server 提前退出（code=${child.exitCode}）\n${stdout}\n${stderr}`));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error(`等待超时：${what}\n${stdout}\n${stderr}`));
      }
    }, 100);
  });
}

try {
  const port = await waitFor(() => {
    const match = stdout.match(/已监听 http:\/\/127\.0\.0\.1:(\d+)\//u);
    return match ? Number(match[1]) : null;
  }, '监听端口');
  const base = `http://127.0.0.1:${port}`;
  const token = readFileSync(join(dataRoot, 'auth-token'), 'utf8').trim();

  // 1. index.html 与其引用的全部 assets 可服务
  const indexResponse = await fetch(`${base}/`);
  if (indexResponse.status !== 200) fail(`GET / 状态码 ${indexResponse.status}`);
  const indexHtml = await indexResponse.text();
  if (!indexHtml.includes('<div id="root">')) fail('index.html 缺少挂载点');
  const assetPaths = [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map(
    (match) => match[1],
  );
  if (assetPaths.length === 0) fail('index.html 未引用任何 /assets/ 产物（结构变化？）');
  for (const assetPath of assetPaths) {
    const assetResponse = await fetch(`${base}${assetPath}`);
    if (assetResponse.status !== 200) fail(`GET ${assetPath} 状态码 ${assetResponse.status}`);
  }

  // 2. RPC 认证
  const noToken = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'app.healthCheck' }),
  });
  if (noToken.status !== 401) fail(`无 token RPC 状态码 ${noToken.status}（应 401）`);

  const health = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: 'app.healthCheck' }),
  });
  const healthBody = await health.json();
  if (health.status !== 200 || healthBody?.data?.ok !== true) {
    fail(`healthCheck 异常：${health.status} ${JSON.stringify(healthBody)}`);
  }

  // 3. 数据服务 ready
  await waitFor(() => stdout.includes('数据服务就绪'), '数据服务 ready');

  if (process.exitCode !== 1) {
    console.log('[smoke] PASS：静态产物可服务、认证生效、数据服务就绪');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  child.kill('SIGTERM');
  rmSync(tempRoot, { recursive: true, force: true });
}
