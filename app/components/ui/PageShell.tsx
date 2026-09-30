'use client';

import React from 'react';
import { Spinner } from '@heroui/react';

/** Shared page gradient — the outermost wrapper background for every standard
 * (non-dashboard) page, and every loading state. Never vary the stops/direction. */
export const PAGE_GRADIENT =
  'bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800';

export interface PageShellProps {
  children: React.ReactNode;
  /**
   * Desktop fixed-height app shell (`md:h-screen md:overflow-hidden`) — for
   * pages that own a single internal scroll region (e.g. `/inventory`,
   * `/stats`). Omit for ordinary document pages that scroll with the window.
   */
  fixedHeight?: boolean;
  /**
   * Shows the gradient + centered spinner instead of children. Use in place of
   * a page's own loading branch so every page's loading state matches exactly
   * (never `bg-background` or an unstyled div — that flashes black in dark mode).
   */
  loading?: boolean;
  /** Overrides the default `max-w-7xl` container width. Rarely needed. */
  maxWidthClassName?: string;
  className?: string;
}

/**
 * Standard page wrapper: the blue gradient background + centered `max-w-7xl`
 * container with the canonical horizontal/vertical padding
 * (`px-4 sm:px-6 py-6 sm:py-8`). This is the shell every page in the app other
 * than `/dashboard` (full-width `px-6`, compact sticky header, no
 * `max-w-7xl`) should render into.
 *
 * `fixedHeight` reproduces the `/inventory` and `/stats` rule: the page
 * becomes a fixed-height flex column on desktop and the caller is responsible
 * for making exactly one descendant the scroll region (`md:overflow-y-auto`).
 * Never add `sticky`/`overflow-y-auto` to a filter sidebar to work around
 * this — see the Inventory Scroll Rule in CLAUDE.md.
 */
export default function PageShell({
  children,
  fixedHeight = false,
  loading = false,
  maxWidthClassName = 'max-w-7xl',
  className = '',
}: PageShellProps) {
  if (loading) {
    return (
      <div className={`min-h-screen ${PAGE_GRADIENT} flex items-center justify-center`}>
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen ${fixedHeight ? 'md:h-screen md:overflow-hidden' : ''} ${PAGE_GRADIENT} flex flex-col ${className}`}
    >
      <div
        className={`${maxWidthClassName} mx-auto px-4 sm:px-6 py-6 sm:py-8 ${fixedHeight ? 'md:pb-3 md:h-full md:min-h-0' : ''} w-full flex flex-col`}
      >
        {children}
      </div>
    </div>
  );
}
