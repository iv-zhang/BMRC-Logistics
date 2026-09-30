'use client';

import React from 'react';
import EmptyState from './EmptyState';

export interface DataListProps<T> {
  items: T[];
  /** Stable key per row (usually the Firestore doc id). */
  getKey: (item: T) => string;
  /** Row content. In `divided` mode the row sits inside one shared bordered
   * wrapper — don't add your own border. In `cards` mode each row is its own
   * bordered card; render the inner content only (DataList supplies the chrome). */
  renderItem: (item: T) => React.ReactNode;
  /** Makes each row clickable (hover state + pointer). */
  onItemClick?: (item: T) => void;
  /**
   * `divided` (default) — one `bg-content1 border rounded-large` wrapper with
   * `divide-y` rows; the dense default for list pages.
   * `cards` — a separate bordered, hoverable card per row (`space-y-3`), for
   * rows that are individually clickable objects (inventory list view).
   */
  variant?: 'divided' | 'cards';
  /** Shown instead of the list when `items` is empty. */
  empty?: { title: string; description?: string; icon?: React.ReactNode; action?: React.ReactNode };
  className?: string;
}

/**
 * The standard list container. Replaces the hand-rolled
 * `bg-content1 border border-divider rounded-large divide-y` wrappers and
 * `space-y-3` card stacks scattered across pages, and owns the empty state
 * so every list says "nothing here" the same way.
 */
export default function DataList<T>({
  items,
  getKey,
  renderItem,
  onItemClick,
  variant = 'divided',
  empty,
  className = '',
}: DataListProps<T>) {
  if (items.length === 0) {
    return empty ? <EmptyState {...empty} className={className} /> : null;
  }

  const clickable = Boolean(onItemClick);

  if (variant === 'cards') {
    return (
      <div className={`flex flex-col gap-3 ${className}`}>
        {items.map((item) => (
          <div
            key={getKey(item)}
            onClick={onItemClick ? () => onItemClick(item) : undefined}
            className={`bg-content1 border border-divider rounded-large px-4 py-4 transition-all duration-150 ${
              clickable ? 'cursor-pointer hover:border-primary/30 hover:shadow-sm' : ''
            }`}
          >
            {renderItem(item)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`bg-content1 border border-divider rounded-large divide-y divide-divider overflow-hidden ${className}`}>
      {items.map((item) => (
        <div
          key={getKey(item)}
          onClick={onItemClick ? () => onItemClick(item) : undefined}
          className={`px-4 py-3 transition-colors duration-150 ${
            clickable ? 'cursor-pointer hover:bg-content2' : ''
          }`}
        >
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}
