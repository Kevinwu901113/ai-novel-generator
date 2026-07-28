import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './App.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 元素');

createRoot(root, {
  onCaughtError(_error, _errorInfo) {
    // 不 console.error 原始 Error、stack 或 componentStack
    // 错误已由 RendererErrorBoundary 处理
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
