import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TokenGate } from './auth/TokenGate';
import { createDesktopClient } from './desktop-client';
import './styles/tailwind.css';

// B12：Web 形态下 window.desktop 不再由 Electron preload 的 contextBridge 注入，
// 改为浏览器端 HTTP 客户端（apps/web/src/desktop-client.ts）。必须在渲染 <App/>
// 之前完成赋值——App 内的 effect 首帧就会调用 window.desktop.healthCheck() 等方法。
window.desktop = createDesktopClient();

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 元素');

createRoot(root, {
  onCaughtError(_error, _errorInfo) {
    // 不 console.error 原始 Error、stack 或 componentStack
    // 错误已由 RendererErrorBoundary 处理
  },
}).render(
  <StrictMode>
    <TokenGate>
      <App />
    </TokenGate>
  </StrictMode>,
);
