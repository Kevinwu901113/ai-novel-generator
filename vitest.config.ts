import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      react: path.resolve(__dirname, 'apps/web/node_modules/react'),
      'react-dom': path.resolve(__dirname, 'apps/web/node_modules/react-dom'),
      // B15：apps/web 的 shadcn/ui 生成件与自建组件用 `@/` 别名（对齐
      // apps/web/tsconfig.json 与 vite.config.ts），根级 vitest 需要同一份映射
      // 才能在测试里解析这些 import。
      '@': path.resolve(__dirname, 'apps/web/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
