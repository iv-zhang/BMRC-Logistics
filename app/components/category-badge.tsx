'use client';

import type { ItemCategory } from '@/app/types';

/**
 * Two-letter category code badges — shared by inventory, audit, and any page
 * that displays inventory categories. Per-type hues are permitted here only
 * because their purpose is identification, not status.
 */
export const CAT_CFG: Record<ItemCategory, { code: string; bg: string; text: string }> = {
  Airway:      { code: 'AW', bg: 'bg-sky-100 dark:bg-sky-900/30',         text: 'text-sky-700 dark:text-sky-300' },
  Trauma:      { code: 'TR', bg: 'bg-red-100 dark:bg-red-900/30',         text: 'text-red-700 dark:text-red-300' },
  Vitals:      { code: 'VT', bg: 'bg-violet-100 dark:bg-violet-900/30',   text: 'text-violet-700 dark:text-violet-300' },
  Meds:        { code: 'MD', bg: 'bg-pink-100 dark:bg-pink-900/30',       text: 'text-pink-700 dark:text-pink-300' },
  PPE:         { code: 'PP', bg: 'bg-amber-100 dark:bg-amber-900/30',     text: 'text-amber-700 dark:text-amber-300' },
  Splinting:   { code: 'SP', bg: 'bg-orange-100 dark:bg-orange-900/30',   text: 'text-orange-700 dark:text-orange-300' },
  Hygiene:     { code: 'HY', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  'First Aid': { code: 'FA', bg: 'bg-green-100 dark:bg-green-900/30',     text: 'text-green-700 dark:text-green-300' },
  Other:       { code: 'OT', bg: 'bg-content3',                            text: 'text-foreground-500' },
};

export function getCatCfg(category: string) {
  return CAT_CFG[category as ItemCategory] ?? CAT_CFG.Other;
}

/** Large 50px (card), small 36px (table row), tiny 18px (sidebar list). */
export function CategoryBadge({
  category,
  size = 'large',
}: {
  category: string;
  size?: 'large' | 'small' | 'tiny';
}) {
  const cfg = getCatCfg(category);
  if (size === 'tiny') {
    return (
      <span className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] font-semibold flex-none ${cfg.bg} ${cfg.text}`}>
        {cfg.code}
      </span>
    );
  }
  if (size === 'small') {
    return (
      <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center font-mono font-semibold text-[11px] flex-none ${cfg.bg} ${cfg.text}`}>
        {cfg.code}
      </div>
    );
  }
  return (
    <div className={`w-[50px] h-[50px] rounded-[13px] flex items-center justify-center font-mono font-semibold text-[15px] flex-none ${cfg.bg} ${cfg.text}`}>
      {cfg.code}
    </div>
  );
}
