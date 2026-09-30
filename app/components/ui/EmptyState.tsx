'use client';

import React from 'react';
import { PackageOpen } from 'lucide-react';

export interface EmptyStateProps {
  /** Defaults to a muted `PackageOpen` glyph — pass any lucide icon element to override. */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Dashed border, e.g. "no items match these filters". `plain` for a
   * bare centered block with no card chrome (e.g. inside a modal body). */
  variant?: 'dashed' | 'plain';
  className?: string;
}

/**
 * Standard "nothing here" block — matches the inventory "No items match
 * these filters" card. Use for empty lists, empty search results, and
 * zero-state sections alike; do not hand-roll a second empty-state shape.
 */
export default function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'dashed',
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`text-center py-16 px-4 ${variant === 'dashed' ? 'bg-content1 border border-dashed border-divider rounded-large' : ''} ${className}`}
    >
      {icon ?? <PackageOpen size={32} className="mx-auto text-foreground-300 mb-2" />}
      <p className="text-sm font-semibold text-foreground-500">{title}</p>
      {description && <p className="text-xs text-foreground-400 mt-1">{description}</p>}
      {action && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
