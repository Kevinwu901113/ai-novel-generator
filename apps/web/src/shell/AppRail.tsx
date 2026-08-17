import { Home, Plus, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AppRailProps {
  readonly isHome: boolean;
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
 */
export function AppRail({ isHome, onHome, onNewProject, onOpenSettings }: AppRailProps) {
  return (
    <nav
      className="flex flex-col items-center gap-[22px] border-r border-white/[0.06] bg-rail px-2.5 pt-[18px] pb-3.5 text-rail-foreground"
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
        onClick={onOpenSettings}
        className="mt-auto"
      />
    </nav>
  );
}
