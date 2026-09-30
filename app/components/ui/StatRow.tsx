'use client';

import React from 'react';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'primary';

const TEXT_TONE: Record<StatTone, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  primary: 'text-primary',
};

const BOX_TONE: Record<StatTone, string> = {
  default: 'bg-content1 border-divider',
  success: 'bg-success-50 dark:bg-success-900/20 border-success/30',
  warning: 'bg-warning-50 dark:bg-warning-900/20 border-warning/30',
  danger: 'bg-danger-50 dark:bg-danger-900/20 border-danger/30',
  primary: 'bg-primary-50 dark:bg-primary-900/20 border-primary/30',
};

// Dynamic `bg-${tone}` / `text-${tone}/80` strings are invisible to
// Tailwind's static scanner — every class it emits must appear as a full
// literal somewhere in source, so every tone variant is spelled out below
// rather than built with template-literal interpolation.
const DOT_TONE: Record<StatTone, string> = {
  default: 'bg-foreground-300',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  primary: 'bg-primary',
};

const LABEL_TONE: Record<StatTone, string> = {
  default: 'text-foreground-400',
  success: 'text-success/80',
  warning: 'text-warning/80',
  danger: 'text-danger/80',
  primary: 'text-primary/80',
};

export interface StatRowItem {
  key: string;
  /** Numeric or pre-formatted value. Always rendered with `tabular-nums`. */
  value: React.ReactNode;
  label: string;
  tone?: StatTone;
}

export interface StatRowProps {
  items: StatRowItem[];
  /**
   * `plain` — inline text stats separated by dot dividers, for the page
   * header's second line (e.g. "42 items · 3 low stock · 1 expired").
   * `boxes` — tinted stat boxes with a colored square indicator, for pages
   * that track status categories at a glance (inventory, assets).
   */
  variant?: 'plain' | 'boxes';
  className?: string;
}

/**
 * The page-header stats line. Two variants matching the two documented
 * header patterns — never hand-roll a third. Prefer `boxes` when the page
 * has a fixed set of status categories the user scans repeatedly; `plain`
 * for a lighter one-line summary.
 */
export default function StatRow({ items, variant = 'plain', className = '' }: StatRowProps) {
  if (items.length === 0) return null;

  if (variant === 'boxes') {
    return (
      <div className={`flex items-center gap-2 flex-wrap ${className}`}>
        {items.map((item) => (
          <div
            key={item.key}
            className={`flex items-center gap-2 border rounded-large px-3 py-1.5 ${BOX_TONE[item.tone ?? 'default']}`}
          >
            {item.tone && item.tone !== 'default' && (
              <span className={`w-2 h-2 rounded-sm flex-none ${DOT_TONE[item.tone]}`} />
            )}
            <span className={`font-mono font-semibold tabular-nums ${TEXT_TONE[item.tone ?? 'default']}`}>
              {item.value}
            </span>
            <span className={`text-xs font-medium ${LABEL_TONE[item.tone ?? 'default']}`}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 text-sm text-foreground-500 flex-wrap ${className}`}>
      {items.map((item, i) => (
        <React.Fragment key={item.key}>
          {i > 0 && <span className="w-1 h-1 rounded-full bg-divider" />}
          <span>
            <span className={`font-semibold tabular-nums ${TEXT_TONE[item.tone ?? 'default']}`}>
              {item.value}
            </span>{' '}
            {item.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
