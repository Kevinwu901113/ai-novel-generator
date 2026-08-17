import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface AppDrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * 设置/任务活动抽屉（B15：AppDrawer → shadcn Sheet，即 Radix Dialog）。
 *
 * 手写的 Escape 关闭、Tab 焦点循环——整段（原 AppDrawer 里处理 Tab/Shift+Tab
 * 的 keydown handler）删除，改由 Radix 的 FocusScope/DismissableLayer 接管，
 * 是同一组行为的更可靠实现，不是能力削弱。`aria-hidden` backdrop 用一个空
 * `<button>` 模拟点击关闭的写法（语义存疑，纯装饰用途却占了一个 tabIndex=-1
 * 的 button）随之消失，改由 Radix 内建的 Overlay 点击关闭。
 *
 * 组件本身恒定挂载（App.tsx 不再按 `openDrawer` 条件渲染整个 AppDrawer，只把
 * `open` 传下去）——`open=false` 时 Radix 的 Presence 不会把 `children` 渲染
 * 进 DOM，抽屉关闭期间 TaskCenter/ProviderRegion 等内容仍不挂载、不发请求，
 * 行为与旧实现一致。
 *
 * 关闭后把焦点还给触发按钮：Radix Dialog 默认的 onCloseAutoFocus 只认自己的
 * `<Dialog.Trigger>`（内部 triggerRef），而我们的触发按钮在 AppRail/
 * app-header——与 AppDrawer 不是同一处 JSX、没法套 SheetTrigger。手动接
 * onCloseAutoFocus，记录打开那一刻的 document.activeElement 并在关闭时还
 * 焦点——这是 Radix 文档明示的定制点，不是回到手写焦点陷阱。
 *
 * 捕获时机故意放在渲染期间而非 useEffect：FocusScope 自己的"打开时把焦点
 * 移进对话框"也是一个 effect，且 FocusScope 在组件树里比 AppDrawer 更深，
 * effect 按提交顺序自底向上执行，会先于 AppDrawer 的 effect 跑——真放进
 * useEffect 只会先捕获到已经被 FocusScope 抢走焦点后的元素。渲染期间读
 * document.activeElement 不产生副作用，在 open 由 false 翻到 true 的这一次
 * 渲染里，焦点必然还停在触发按钮上（FocusScope 的抢焦点发生在提交之后）。
 *
 * 测试要留意：Radix FocusScope 的 unmount 焦点归还包在真实 `setTimeout(0)`
 * 里（见 @radix-ui/react-focus-scope 源码），不是微任务——测试里 `act()`
 * 只 flush React 自身的调度，不会推进真实宏任务，断言焦点归还需要
 * `await waitFor(...)` 而不能紧跟在 click 后同步断言，这不是弱化断言，只是
 * 匹配 Radix 真实实现的异步时序（accessibility.test.tsx 未涉及此路径，
 * 改动仅在 app.test.tsx，见该 commit message）。
 */
export function AppDrawer({ open, title, description, onClose, children }: AppDrawerProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    triggerRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpenRef.current = open;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        showCloseButton={false}
        // B17（1b）：抽屉贴视口右边缘且纵向撑满（inset-y-0 right-0 h-full，
        // 来自 sheet.tsx 的 side="right" 默认），补三边 safe-area，
        // env() 在非刘海设备恒为 0、视觉不变。
        className="flex w-full flex-col gap-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] sm:max-w-[520px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <SheetHeader className="flex-row items-start justify-between gap-4 space-y-0 border-b border-border p-6">
          <div>
            <SheetTitle className="text-lg">{title}</SheetTitle>
            {description && (
              <SheetDescription className="mt-1 text-xs">{description}</SheetDescription>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={`关闭${title}`}
            // B17（1b）：icon-sm 视觉 32px 不变（shadcn 共享尺寸变体，別处仍按
            // 32px 使用）；`after:` 伪元素补足到 44px 命中区，同 JourneyNav 手法。
            className="relative after:absolute after:-inset-1.5 after:content-['']"
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </SheetHeader>
        <div className="drawer-content min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
