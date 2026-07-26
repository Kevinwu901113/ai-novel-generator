import type { DesktopAPI } from '@ai-novel/contracts';

declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
