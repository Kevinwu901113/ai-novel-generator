import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// B12：Web 形态。base 用绝对路径 '/'（由 apps/server 托管）；dev 模式下
// /api 代理到本机 apps/server（默认端口 4870，可用 AI_NOVEL_PORT 对齐）。
export default defineConfig({
  plugins: [react()],
  root: './src',
  base: '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.AI_NOVEL_PORT ?? '4870'}`,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
