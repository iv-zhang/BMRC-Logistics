'use client';

import React from 'react';
import { X } from 'lucide-react';
import type { StatsFilterState, CrossFilter } from '@/app/lib/stats/shared';

type RangePreset = 'all' | 'ytd' | 'year' | '90d' | '30d' | '7d' | 'custom';

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'ytd', label: 'YTD' },
  { key: 'year', label: 'Past year' },
  { key: '90d', label: '90 days' },
  { key: '30d', label: '30 days' },
  { key: '7d', label: '7 days' },
  { key: 'custom', label: 'Custom' },
];

interface FilterShelfProps {
  filters: StatsFilterState;
  onRangeChange: (preset: RangePreset, customStart?: string, customEnd?: string) => void;
  onClearCrossFilter: (f: CrossFilter) => void;
  onClearAll: () => void;
  rangePreset: RangePreset;
  customStart: string;
  customEnd: string;
}

export default function FilterShelf({
  filters,
  onRangeChange,
  onClearCrossFilter,
  onClearAll,
  rangePreset,
  customStart,
  customEnd,
}: FilterShelfProps) {
  const hasCrossFilters = filters.crossFilters.length > 0;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Time range presets */}
      <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1 flex-wrap">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => {
              if (p.key === 'custom') {
                onRangeChange(p.key, customStart, customEnd);
              } else {
                onRangeChange(p.key);
              }
            }}
            className={`px-2.5 py-1.5 rounded-medium text-xs font-semibold transition-colors duration-150 ${
              rangePreset === p.key
                ? 'bg-primary text-white'
                : 'text-foreground-500 hover:bg-content2'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom date inputs */}
      {rangePreset === 'custom' && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={customStart}
            onChange={(e) => onRangeChange('custom', e.target.value, customEnd)}
            className="text-xs font-semibold px-2 py-1.5 rounded-lg border border-divider outline-none bg-content1 text-foreground"
          />
          <span className="text-xs text-foreground-400">to</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => onRangeChange('custom', customStart, e.target.value)}
            className="text-xs font-semibold px-2 py-1.5 rounded-lg border border-divider outline-none bg-content1 text-foreground"
          />
        </div>
      )}

      {/* Cross-filter chips (only render if there are filters) */}
      {hasCrossFilters && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {filters.crossFilters.map((f) => (
              <div
                key={`${f.field}-${f.value}`}
                className="flex items-center gap-1.5 bg-primary-50 dark:bg-primary-900/20 border border-primary/30 rounded-full px-3 py-1.5 text-xs font-semibold text-primary"
              >
                <span className="truncate">
                  {f.field}: <span className="font-normal">{f.label}</span>
                </span>
                <button
                  onClick={() => onClearCrossFilter(f)}
                  className="flex-none hover:opacity-70 transition-opacity duration-150"
                  aria-label={`Clear ${f.field} filter`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Clear all button */}
          {filters.crossFilters.length > 1 && (
            <button
              onClick={onClearAll}
              className="text-xs font-semibold text-primary hover:text-primary-600 transition-colors duration-150"
            >
              Clear all
            </button>
          )}
        </>
      )}
    </div>
  );
}
