/**
 * 窗口管理器。
 *
 * 创建和管理 BrowserWindow。
 * 窗口创建不依赖 Worker 状态。
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mark } from './startup-timeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const isSmokeTest = process.argv.includes('--smoke-test');

const log = (...args: unknown[]) => console.log('[window]', ...args);
const logError = (...args: unknown[]) => console.error('[window]', ...args);

let mainWindow: BrowserWindow | null = null;

const WINDOW_DEFAULTS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
} as const;

export function createMainWindow(): BrowserWindow {
  mark('create-window-start');

  if (mainWindow && !mainWindow.isDestroyed()) {
    log('reusing existing window');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  log('creating new window');
  const win = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    center: true,
    title: 'AI 小说创作代理',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  mark('browser-window-created');
  mainWindow = win;

  // ── 窗口事件 ────────────────────────────────────────
  win.on('ready-to-show', () => {
    mark('ready-to-show');
    log('ready-to-show');
    if (!isSmokeTest) {
      win.show();
      win.focus();
    }
  });

  win.on('show', () => {
    mark('window-show');
    log('window show');
  });

  win.on('closed', () => {
    log('window closed');
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  // ── WebContents 事件 ────────────────────────────────
  win.webContents.on('did-finish-load', () => {
    mark('did-finish-load');
    log('did-finish-load');
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logError('did-fail-load:', { errorCode, errorDescription, validatedURL });
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
    if (!isSmokeTest && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith('http://localhost:5173')) return;
    event.preventDefault();
  });

  // ── 加载内容 ────────────────────────────────────────
  mark('renderer-load-start');
  if (isDev) {
    void win.loadURL('http://localhost:5173');
    if (!isSmokeTest) win.webContents.openDevTools();
  } else {
    const rendererPath = path.join(__dirname, '../renderer/index.html');
    void win.loadFile(rendererPath);
  }

  // ── 回退计时器：防止 ready-to-show 未触发 ──────────
  if (!isSmokeTest) {
    const SHOW_FALLBACK_MS = 3_000;
    const fallbackTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        logError(`fallback: forcing show after ${SHOW_FALLBACK_MS}ms`);
        win.show();
        win.focus();
      }
    }, SHOW_FALLBACK_MS);

    win.once('ready-to-show', () => clearTimeout(fallbackTimer));
  }

  return win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
