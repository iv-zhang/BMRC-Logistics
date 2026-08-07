'use client';

import React, { useEffect } from 'react';
import { usePanelMode, type PanelMode } from '@/app/hooks/usePanelMode';

interface PanelShellProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Panel width. Default 480px, capped to the viewport. */
  widthClass?: string;
  ariaLabel?: string;
  /**
   * Pin this panel's position regardless of the user's global preference.
   * Used by surfaces whose content only works in one layout (e.g. the event
   * signup/management drawer, which is always centered).
   */
  forceMode?: PanelMode;
}

/**
 * Shared chrome for every app pop-out. Renders the same inner content in one
 * of two positions:
 *   - `drawer` → full-height sheet pinned to the right edge (legacy behavior)
 *   - `modal`  → centered dialog
 *
 * The `dropdown` preference is intentionally NOT handled here as an overlay —
 * a floating panel anchored to the click greys out the page and never reads as
 * "part of the page." Surfaces that want a true inline dropdown (the inventory
 * list) render their own inline expansion; every other surface treats
 * `dropdown` as `modal` (a clean centered panel). `forceMode` overrides both.
 *
 * The backdrop closes on click and Esc closes the panel. `role="dialog"` keeps
 * the panel interactive under the app-root inert helper (see providers.tsx).
 */
export default function PanelShell({
  isOpen,
  onClose,
  children,
  widthClass = 'w-[480px] max-w-[94vw]',
  ariaLabel,
  forceMode,
}: PanelShellProps) {
  const { mode } = usePanelMode();
  const effectiveMode: 'drawer' | 'modal' =
    forceMode === 'drawer'
      ? 'drawer'
      : forceMode === 'modal' || forceMode === 'dropdown'
        ? 'modal'
        : mode === 'drawer'
          ? 'drawer'
          : 'modal'; // 'dropdown' (non-inventory) and 'modal' both center here

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const positionCls =
    effectiveMode === 'drawer' ? 'justify-end items-stretch' : 'justify-center items-center p-0 md:p-4';

  // Below `md` every pop-out is a full-screen sheet: phones have no room for a
  // centered card that only fills part of the viewport (the body then scrolls in
  // a tiny window while the dimmed page shows through above and below). These
  // `max-md:` utilities are listed after `widthClass` so they win over any
  // unprefixed width/height the caller passed.
  const mobileFullCls =
    'max-md:w-full max-md:max-w-none max-md:h-full max-md:max-h-none max-md:rounded-none';

  const panelCls =
    effectiveMode === 'drawer'
      ? `${widthClass} h-full ${mobileFullCls}`
      : `${widthClass} max-h-[90vh] rounded-large ${mobileFullCls}`;

  return (
    <div
      className={`fixed inset-0 z-50 flex ${positionCls} bg-black/40`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className={`bg-content1 shadow-2xl flex flex-col overflow-hidden overscroll-contain min-h-0 ${panelCls}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
