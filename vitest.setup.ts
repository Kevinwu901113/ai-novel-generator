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

// B16：jsdom 不实现 Pointer Events 相关 DOM API（hasPointerCapture /
// setPointerCapture / releasePointerCapture）与 scrollIntoView——Radix
// Select（ProviderRegion 的协议下拉）在打开/选中时会调用这些方法，jsdom 下
// 直接抛 TypeError 中断测试。补最小 no-op stub，只影响测试环境。
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
