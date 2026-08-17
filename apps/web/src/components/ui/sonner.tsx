import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      // B17（1b）：默认右下角位置（D-B15-3）贴视口边缘，可能被 Home indicator
      // 遮挡。sonner 内置 24px（桌面）/16px（<600px 视口）边距常量原样保留，
      // 叠加 env(safe-area-inset-*)——非刘海设备 env() 恒为 0，数值与迁移前
      // 完全一致。
      offset={{
        bottom: 'calc(24px + env(safe-area-inset-bottom))',
        right: 'calc(24px + env(safe-area-inset-right))',
      }}
      mobileOffset={{
        bottom: 'calc(16px + env(safe-area-inset-bottom))',
        right: 'calc(16px + env(safe-area-inset-right))',
      }}
      {...props}
    />
  );
};

export { Toaster };
