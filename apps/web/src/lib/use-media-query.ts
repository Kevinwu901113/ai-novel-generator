import { useEffect, useState } from 'react';

/**
 * 媒体查询挂载判定（B18，D-B18-3）。
 *
 * CSS 断点类（AppRail 的 `hidden md:flex`、AppBottomNav 的 `md:hidden`）负责
 * 视觉显隐；这里再做条件渲染是为了让同名导航控件（首页/新建/打开设置）在
 * 可访问性树里永远只有一份——jsdom 与真实辅助技术都不看 CSS 断点，双导航
 * 同时在 DOM 里会产生重复控件（App 级测试以 findByRole 重试到超时坐实）。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
