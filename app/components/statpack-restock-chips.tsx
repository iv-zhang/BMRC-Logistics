'use client';

import React from 'react';
import { Chip, Tooltip } from '@heroui/react';
import type { Statpack } from '@/app/types';
import { getPackShortages, formatShortage } from '@/app/lib/statpack-shortages';

function formatShortDate(value: Date | { toDate?: () => Date } | undefined | null): string {
  if (!value) return '';
  const d = value instanceof Date ? value : typeof value.toDate === 'function' ? value.toDate() : null;
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface StatpackRestockChipsProps {
  pack: Statpack;
  size?: 'sm' | 'md';
  showOverride?: boolean;
}

/**
 * Compact chip row summarizing a pack's count shortages and, when relevant,
 * that its "Ready" status was manually overridden. Renders a React fragment
 * (no wrapper element) so it drops into an existing flex row of chips.
 */
export default function StatpackRestockChips({ pack, size = 'sm', showOverride = true }: StatpackRestockChipsProps) {
  const shortages = getPackShortages(pack);
  const hasOverride = showOverride && Boolean(pack.readyOverride) && pack.status === 'Ready';

  if (shortages.total === 0 && !hasOverride) return null;

  return (
    <>
      {shortages.total > 0 && (
        <Tooltip
          content={
            <div className="text-xs space-y-1 p-1 max-w-xs">
              {shortages.out.length > 0 && (
                <div>
                  <strong>Out:</strong> {shortages.out.map(formatShortage).join(', ')}
                </div>
              )}
              {shortages.low.length > 0 && (
                <div>
                  <strong>Low:</strong> {shortages.low.map(formatShortage).join(', ')}
                </div>
              )}
            </div>
          }
        >
          <Chip size={size} variant="flat" color={shortages.out.length > 0 ? 'danger' : 'warning'}>
            Needs restock · {shortages.total}
          </Chip>
        </Tooltip>
      )}
      {hasOverride && pack.readyOverride && (
        <Tooltip
          content={
            <div className="text-xs p-1">
              Marked ready by {pack.readyOverride.byName} on {formatShortDate(pack.readyOverride.at)}
              {pack.readyOverride.note ? ` — ${pack.readyOverride.note}` : ''}
            </div>
          }
        >
          <Chip size={size} variant="flat" color="secondary">
            Override
          </Chip>
        </Tooltip>
      )}
    </>
  );
}
