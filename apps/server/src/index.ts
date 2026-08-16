/**
 * CLI 入口（B11 / D11）：`node apps/server/dist/index.js`。
 *
 * 环境变量：
 * - `AI_NOVEL_DATA_ROOT` 数据根（缺省走 data-root.ts 的探测顺序，含老桌面版数据）
 * - `AI_NOVEL_HOST`      绑定地址，默认 127.0.0.1；显式设 0.0.0.0 放开局域网
 * - `AI_NOVEL_PORT`      端口，默认 4870
 * - `AI_NOVEL_WEB_ROOT`  前端构建产物目录，默认 ../../web/dist（相对本文件）
 *
 * 安全提示：局域网访问是明文 HTTP（无 TLS）。请只在可信网络放开 0.0.0.0；
 * 录入 provider API key 建议在本机 localhost 完成。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localAddresses } from './auth.js';
import { resolveDataRoot } from './data-root.js';
import { startServer } from './app.js';

function readOwnVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveWebRoot(): string | null {
  const override = process.env.AI_NOVEL_WEB_ROOT;
  const candidate = override ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(candidate)) {
    return candidate;
  }
  console.log(`[server] 未找到前端构建产物（${candidate}），静态页面暂不可用`);
  return null;
}

async function main(): Promise<void> {
  const resolution = resolveDataRoot();
  console.log(`[server] 数据根：${resolution.dataRoot}`);
  for (const note of resolution.notes) {
    console.log(`[server]   ${note}`);
  }

  const host = process.env.AI_NOVEL_HOST ?? '127.0.0.1';
  const port = Number(process.env.AI_NOVEL_PORT ?? '4870');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效端口：${process.env.AI_NOVEL_PORT}`);
  }

  const running = await startServer({
    dataRoot: resolution.dataRoot,
    host,
    port,
    webRoot: resolveWebRoot(),
    version: readOwnVersion(),
  });

  console.log(`[server] 已监听 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${running.port}/`);
  if (host === '0.0.0.0') {
    for (const address of localAddresses()) {
      if (address.includes(':')) continue; // 局域网访问指引只列 IPv4
      console.log(`[server]   局域网：http://${address}:${running.port}/`);
    }
    console.log('[server] ⚠️ 局域网访问是明文 HTTP，请只在可信网络使用');
  }
  console.log(`[server] 访问令牌（页面首次打开时录入）：${running.token}`);
  console.log(`[server]   令牌文件：${resolution.dataRoot}/auth-token`);

  void running.initialization.then((state) => {
    if (state === 'ready') {
      console.log('[server] 数据服务就绪（启动恢复完成）');
    } else {
      console.error('[server] 数据服务初始化失败——修复后可在页面重试，或重启服务');
    }
  });

  const shutdown = () => {
    console.log('[server] 正在退出…');
    void running.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] 启动失败：${message}`);
  process.exit(1);
});
