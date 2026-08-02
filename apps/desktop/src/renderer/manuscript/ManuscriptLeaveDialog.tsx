/**
 * ManuscriptLeaveDialog —— 未保存修改离开确认对话框（MV1-B）。
 *
 * 至少提供两个操作：
 * - 「继续编辑」：取消离开，保留本地 buffer；
 * - 「放弃修改并离开」：确认离开。
 *
 * 可访问性：焦点 trap（Tab 在对话框内循环）、打开时聚焦首按钮、
 * Esc = 继续编辑、关闭后恢复焦点到触发元素。
 */

import { useEffect, useRef } from 'react';
import { useRestoreFocus } from '../accessibility/useRestoreFocus';

interface ManuscriptLeaveDialogProps {
  readonly title: string;
  readonly message: string;
  readonly onContinue: () => void;
  readonly onDiscard: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ManuscriptLeaveDialog({
  title,
  message,
  onContinue,
  onDiscard,
}: ManuscriptLeaveDialogProps) {
  useRestoreFocus(true);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const continueButtonRef = useRef<HTMLButtonElement | null>(null);

  // 打开时聚焦「继续编辑」按钮
  useEffect(() => {
    continueButtonRef.current?.focus();
  }, []);

  // 焦点 trap：Tab / Shift+Tab 在对话框内循环
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onContinue();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !dialog.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onContinue]);

  return (
    <div className="leave-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="leave-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        aria-describedby="leave-dialog-message"
      >
        <h3 id="leave-dialog-title" className="leave-dialog-title">
          {title}
        </h3>
        <p id="leave-dialog-message" className="leave-dialog-message">
          {message}
        </p>
        <div className="leave-dialog-actions">
          <button
            ref={continueButtonRef}
            type="button"
            className="btn btn-primary"
            onClick={onContinue}
          >
            继续编辑
          </button>
          <button type="button" className="btn btn-danger" onClick={onDiscard}>
            放弃修改并离开
          </button>
        </div>
      </div>
    </div>
  );
}
