import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS, type HealthCheckResponse } from '@ai-novel/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const isSmokeTest = process.argv.includes('--smoke-test');

// ── 日志工具 ──────────────────────────────────────────────
const log = (...args: unknown[]) => {
  console.log('[main]', ...args);
};

const logError = (...args: unknown[]) => {
  console.error('[main]', ...args);
};

// ── 窗口单例 ──────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

const WINDOW_DEFAULTS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
} as const;

/**
 * 创建主窗口。
 *
 * - 始终以 show: false 创建，由 ready-to-show 或回退计时器控制显示；
 * - smoke test 模式下不显示窗口，由 runSmokeTest 控制生命周期；
 * - 如已有未销毁的窗口，将其提到前台并返回。
 */
function createMainWindow(): BrowserWindow {
  // 复用已有窗口
  if (mainWindow && !mainWindow.isDestroyed()) {
    log('Reusing existing window');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  log('Creating new window');
  const win = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    center: true,
    title: 'AI 小说创作代理',
    // 始终隐藏，由 ready-to-show 或回退计时器显式控制显示；
    // 使用 show: true 时，isVisible() 立即返回 true，导致回退计时器失效
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  mainWindow = win;

  // 创建后立即检查窗口状态
  const bounds = win.getBounds();
  log('Window created', {
    bounds,
    isVisible: win.isVisible(),
    isDestroyed: win.isDestroyed(),
    isMinimized: win.isMinimized(),
  });

  // ── 窗口生命周期事件 ─────────────────────────────────
  win.on('ready-to-show', () => {
    log('ready-to-show');
    if (!isSmokeTest) {
      win.show();
      win.focus();
    }
  });

  win.on('show', () => {
    const bounds = win.getBounds();
    const isVisible = win.isVisible();
    const isDestroyed = win.isDestroyed();
    log('window show', { bounds, isVisible, isDestroyed });
  });

  win.on('closed', () => {
    log('window closed');
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // ── WebContents 事件 ─────────────────────────────────
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load');
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logError('did-fail-load:', { errorCode, errorDescription, validatedURL });
    // 加载失败时确保窗口可见，显示错误而非静默隐藏
    if (!isSmokeTest && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logError('preload-error:', { preloadPath, error: String(error) });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logError('render-process-gone:', details.reason, details.exitCode);
    // 渲染进程崩溃时确保窗口可见，而非静默隐藏
    if (!isSmokeTest && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  // ── 导航保护 ─────────────────────────────────────────
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) {
      return; // 开发模式允许 Vite HMR 导航
    }
    event.preventDefault();
  });

  // ── 加载内容 ─────────────────────────────────────────
  if (isDev) {
    void win.loadURL('http://localhost:5173');
    if (!isSmokeTest) win.webContents.openDevTools();
  } else {
    const rendererPath = path.join(__dirname, '../renderer/index.html');
    log('Loading renderer from:', rendererPath);
    void win.loadFile(rendererPath);
  }

  // ── 加载完成回退：防止 ready-to-show 未触发时永远隐藏 ──
  if (!isSmokeTest) {
    const SHOW_FALLBACK_MS = 5_000;
    const fallbackTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        logError(`Fallback: window not visible after ${SHOW_FALLBACK_MS}ms, forcing show`);
        win.show();
        win.focus();
      }
    }, SHOW_FALLBACK_MS);

    // ready-to-show 已触发则取消回退
    win.once('ready-to-show', () => {
      clearTimeout(fallbackTimer);
    });
  }

  return win;
}

// ── IPC 健康检查 ──────────────────────────────────────────
ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (): Promise<HealthCheckResponse> => {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
    version: app.getVersion(),
  };
});

// ── Smoke test ────────────────────────────────────────────
/** Smoke test：启动 → 加载 Renderer → 验证 healthCheck → 退出 */
function runSmokeTest(): void {
  log('Running smoke test');
  const win = createMainWindow();
  let healthCheckReceived = false;

  const timeout = setTimeout(() => {
    if (healthCheckReceived) return;
    console.error('[smoke-test] FAIL: timed out waiting for healthCheck');
    app.exit(1);
  }, 15_000);

  // 拦截 healthCheck 以检测 preload 是否正常工作
  ipcMain.removeHandler(IPC_CHANNELS.HEALTH_CHECK);
  ipcMain.handle(IPC_CHANNELS.HEALTH_CHECK, async (): Promise<HealthCheckResponse> => {
    healthCheckReceived = true;
    console.log('[smoke-test] healthCheck invoked via preload — PASS');
    clearTimeout(timeout);

    // 给 Renderer 一点时间完成渲染，然后退出
    setTimeout(() => {
      console.log('[smoke-test] All checks passed, exiting');
      app.exit(0);
    }, 500);

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      version: app.getVersion(),
    };
  });

  // 监听 Renderer 加载和控制台消息
  win.webContents.on('did-finish-load', () => {
    console.log('[smoke-test] Renderer loaded');
  });

  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[smoke-test] Renderer process gone:', details.reason);
    app.exit(1);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[smoke-test] Failed to load:', errorCode, errorDescription);
    app.exit(1);
  });
}

// ── 应用生命周期 ──────────────────────────────────────────
app.whenReady().then(() => {
  log('app ready, isSmokeTest:', isSmokeTest, 'isDev:', isDev);

  if (isSmokeTest) {
    runSmokeTest();
    return;
  }

  createMainWindow();

  // macOS activate：点击 Dock 图标或从后台切回
  app.on('activate', () => {
    log('activate event, window count:', BrowserWindow.getAllWindows().length);

    // 没有窗口 → 创建
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }

    // 有窗口但可能隐藏/最小化 → 恢复
    if (mainWindow && !mainWindow.isDestroyed()) {
      app.show();
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
