import '@testing-library/jest-dom/vitest';

// B15：jsdom 不内置 window.matchMedia（sonner 的 Toaster 挂载时用它探测系统
// 深色模式，@ai-novel/web 的 App 级测试渲染真实 <App/> 会经过这条路径）。
// 补一个最小 stub——不真的响应系统配色变化，测试环境也不需要。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
