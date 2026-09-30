'use client';

import React from 'react';

export interface PageHeaderProps {
  title: string;
  /** Rendered as the header's second line — typically a `<StatRow>`, but any
   * node (e.g. a one-line description) is accepted. */
  subtitle?: React.ReactNode;
  /** Right-aligned cluster — view toggle, Export, primary CTA, etc. Wrap
   * multiple controls in a `flex items-center gap-3 flex-wrap` div yourself,
   * or pass a single pre-built cluster. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The standard page header block: title on one line, an optional stats/description
 * line beneath it, and a right-aligned action cluster. Always `mb-6`. This is
 * the ONLY page-header shape — do not hand-roll a second one; the dashboard's
 * compact sticky `h-[54px]` header (`app/dashboard/page.tsx`) is a separate
 * layout family and is not covered here.
 */
export default function PageHeader({ title, subtitle, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex items-end justify-between gap-4 mb-6 flex-wrap ${className}`}>
      <div>
        <h1 className="text-2xl font-semibold text-foreground mb-1.5">{title}</h1>
        {subtitle}
      </div>
      {actions && <div className="flex items-center gap-3 flex-wrap">{actions}</div>}
    </div>
  );
}
