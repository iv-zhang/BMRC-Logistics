'use client';

import React from 'react';

export interface SectionCardProps {
  /** Card title. Omit for a bare content wrapper (e.g. a sidebar filter group
   * that uses its own dense label instead). */
  title?: string;
  /** Rendered next to the title on the same row (e.g. a "Clear" link or count). */
  action?: React.ReactNode;
  /**
   * `card` (default) — plain `bg-content1 border-divider` card, header text
   * only, for standard page sections.
   * `stripe` — dashboard-style card (`rounded-[18px]`, `bg-content2` header
   * stripe with a divider, soft shadow), matching `app/dashboard/page.tsx`.
   */
  variant?: 'card' | 'stripe';
  /** Caps the body at this height and makes it independently scrollable
   * (`overflow-y-auto`). Use on any section whose list can grow unbounded —
   * never leave a scrollable body uncapped. */
  maxBodyHeight?: number;
  /** Dense section label style (`text-[11px] uppercase tracking-widest`)
   * instead of the normal title — matches sidebar filter group headers. */
  dense?: boolean;
  /**
   * Body padding. `none` renders edge-to-edge content (e.g. a `<DataList>`
   * whose rows/dividers should touch the card's border) — the header, if
   * any, still gets its own inset so the title never touches the border.
   */
  padding?: 'none' | 'sm' | 'md';
  children: React.ReactNode;
  className?: string;
}

const BODY_PADDING: Record<NonNullable<SectionCardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
};

/**
 * The single reusable card shape: `bg-content1 border border-divider
 * rounded-large`. Never nest a second bordered card inside this — separate
 * sub-content with `bg-content2` insets or spacing instead.
 */
export default function SectionCard({
  title,
  action,
  variant = 'card',
  maxBodyHeight,
  dense = false,
  padding = 'md',
  children,
  className = '',
}: SectionCardProps) {
  const bodyStyle = maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined;
  const scrollCls = maxBodyHeight ? 'overflow-y-auto' : '';
  const hasHeader = Boolean(title || action);

  if (variant === 'stripe') {
    return (
      <div
        className={`bg-content1 border border-divider rounded-[18px] overflow-hidden ${className}`}
        style={{ boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}
      >
        {hasHeader && (
          <div className="flex items-center gap-[11px] px-4 py-[13px] border-b border-divider bg-content2">
            {title && <h2 className="text-[14.5px] font-bold tracking-tight text-foreground flex-1 min-w-0">{title}</h2>}
            {action}
          </div>
        )}
        <div className={scrollCls} style={bodyStyle}>
          {children}
        </div>
      </div>
    );
  }

  // The header always gets an inset (title/border never touch), independent
  // of the body's own padding — matters when `padding="none"` is used to let
  // an edge-to-edge child (e.g. `<DataList variant="divided">`) touch the card border.
  const headerInsetCls = padding === 'sm' ? 'px-3 pt-3' : 'px-4 pt-4';

  return (
    <div className={`bg-content1 border border-divider rounded-large overflow-hidden ${className}`}>
      {hasHeader && (
        <div className={`flex items-center justify-between gap-2 ${headerInsetCls}`}>
          {title && (
            dense ? (
              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">{title}</p>
            ) : (
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
            )
          )}
          {action}
        </div>
      )}
      <div
        className={`${scrollCls} ${BODY_PADDING[padding]} ${hasHeader ? 'mt-3' : ''}`}
        style={bodyStyle}
      >
        {children}
      </div>
    </div>
  );
}
