import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      react: path.resolve(__dirname, 'node_modules/.pnpm/react@19.2.8/node_modules/react'),
      'react-dom': path.resolve(
        __dirname,
        'node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom',
      ),
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
