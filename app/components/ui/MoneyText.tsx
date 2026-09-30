'use client';

import React from 'react';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * Formats integer cents as `$1,234.56`. Returns `"—"` for `null`/`undefined`/
 * non-finite input: an unknown amount is NOT zero, and a fabricated `$0.00`
 * is indistinguishable from a real one (platform-overhaul plan, rule 0).
 *
 * Money in this codebase is integer cents end to end — this helper is the one
 * place cents become dollars for display. Non-integer input is rounded to the
 * nearest cent rather than trusted, so a float leak can't print `$12.3400001`.
 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  // `|| 0` normalizes -0, which Intl would print as "-$0.00".
  return USD.format((Math.round(cents) || 0) / 100);
}

export interface MoneyTextProps {
  /** Integer cents. `null`/`undefined` renders "—" (never "$0.00"). */
  cents: number | null | undefined;
  /** Color a negative amount `text-danger` and a positive one `text-success`
   * (for deltas/variances). Off by default — color means status, not decoration. */
  signed?: boolean;
  className?: string;
}

/**
 * Money display: `font-mono tabular-nums` so columns of amounts align.
 * Unknown (`null`) renders an em dash in muted text.
 */
export default function MoneyText({ cents, signed = false, className = '' }: MoneyTextProps) {
  const unknown = cents === null || cents === undefined || !Number.isFinite(cents);
  const tone = unknown
    ? 'text-foreground-400'
    : signed && (cents as number) < 0
      ? 'text-danger'
      : signed && (cents as number) > 0
        ? 'text-success'
        : '';

  return (
    <span className={`font-mono tabular-nums ${tone} ${className}`}>{formatCents(cents)}</span>
  );
}
