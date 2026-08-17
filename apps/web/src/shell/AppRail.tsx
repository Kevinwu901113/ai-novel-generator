import { Home, Plus, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AppRailProps {
  readonly isHome: boolean;
  /** B19：设置页打开时「设置」入口呈 active（设置从抽屉改页面后有了驻留态）。 */
  readonly isSettings?: boolean;
  readonly onHome: () => void;
  readonly onNewProject: () => void;
  readonly onOpenSettings: () => void;
}

interface RailButtonProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly ariaLabel: string;
  readonly ariaCurrent?: 'page';
  readonly active?: boolean;
  readonly className?: string;
  readonly onClick: () => void;
}

function RailButton({
  icon: Icon,
  label,
  ariaLabel,
  ariaCurrent,
  active = false,
  className,
  onClick,
}: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      className={cn(
        'flex min-h-[52px] w-full flex-col items-center justify-center gap-[3px] rounded-xl text-[10px] transition-colors',
        active
          ? 'bg-white/[0.09] text-white shadow-[inset_3px_0_0_var(--color-rail-active)]'
          : 'text-rail-muted hover:bg-white/[0.09] hover:text-white',
        className,
      )}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/**
 * 全局导航侧栏（B15：图标从手写 AppIcon 换 lucide-react，aria-label/
 * aria-current 语义逐个保留）。
 *
 * B17（1b 移动端最小集）：rail 贴着视口物理左边缘（横屏时可能被刘海/圆角
 * 遮挡），左/上/下三边補 `env(safe-area-inset-*)`——用 `max(原值, env(...))`
 * 保证非刘海设备上 env() 恒为 0、结果等于原值，桌面/常规设备视觉不变。
 */
export function AppRail({
  isHome,
  isSettings = false,
  onHome,
  onNewProject,
  onOpenSettings,
}: AppRailProps) {
  return (
    <nav
      className="hidden flex-col items-center gap-[22px] border-r border-white/[0.06] bg-rail pt-[max(18px,env(safe-area-inset-top))] pr-2.5 pb-[max(14px,env(safe-area-inset-bottom))] pl-[max(10px,env(safe-area-inset-left))] text-rail-foreground md:flex"
      aria-label="全局导航"
    >
      <div
        className="grid size-[38px] place-items-center rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 font-serif text-[19px] font-bold text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--color-primary-600)_35%,transparent)]"
        aria-hidden="true"
      >
        文
      </div>

      <div className="flex w-full flex-col gap-2">
        <RailButton
          icon={Home}
          label="首页"
          ariaLabel="首页"
          ariaCurrent={isHome ? 'page' : undefined}
          active={isHome}
          onClick={onHome}
        />
        <RailButton icon={Plus} label="新建" ariaLabel="新建项目" onClick={onNewProject} />
      </div>

      <RailButton
        icon={Settings}
        label="设置"
        ariaLabel="打开设置"
        ariaCurrent={isSettings ? 'page' : undefined}
        active={isSettings}
        onClick={onOpenSettings}
        className="mt-auto"
      />
    </nav>
  );
}

/**
 * 移动端底部导航（B18，D-B18-3）：<768px 时 AppRail 隐藏（76px 常驻左栏在
 * 375pt 屏上占 20% 宽却无对应收益），同三项入口改由底部横条承接。作为主列
 * flex 尾部的 shrink-0 行渲染（不用 fixed 覆盖，不与内部滚动容器抢 z 轴）；
 * 每项 min-h 48px 触控目标，底边补 safe-area。桌面（≥768px）整体隐藏，与
 * AppRail 互斥，同一可访问名称不会同时出现两份。
 */
export function AppBottomNav({
  isHome,
  isSettings = false,
  onHome,
  onNewProject,
  onOpenSettings,
}: AppRailProps) {
  return (
    <nav
      className="flex shrink-0 items-stretch justify-around border-t border-white/[0.06] bg-rail px-2 pt-1 pb-[max(6px,env(safe-area-inset-bottom))] text-rail-foreground md:hidden"
      aria-label="全局导航"
    >
      <RailButton
        icon={Home}
        label="首页"
        ariaLabel="首页"
        ariaCurrent={isHome ? 'page' : undefined}
        active={isHome}
        onClick={onHome}
        className="min-h-[48px] max-w-[120px]"
      />
      <RailButton
        icon={Plus}
        label="新建"
        ariaLabel="新建项目"
        onClick={onNewProject}
        className="min-h-[48px] max-w-[120px]"
      />
      <RailButton
        icon={Settings}
        label="设置"
        ariaLabel="打开设置"
        ariaCurrent={isSettings ? 'page' : undefined}
        active={isSettings}
        onClick={onOpenSettings}
        className="min-h-[48px] max-w-[120px]"
      />
    </nav>
  );
}
