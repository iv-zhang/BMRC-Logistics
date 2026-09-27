'use client';

import React, { useState } from 'react';
import { AlertTriangle, ClipboardList, ArrowRight, ChevronRight, ChevronDown } from 'lucide-react';
import type { StatpackPocket } from '@/app/types';

export type FixKind = 'checks' | 'issue' | 'sharps' | 'bag-seal';

export interface FixItem {
  /** Stable React key. */
  key: string;
  kind: FixKind;
  itemId?: string;
  bagId?: string;
  pocket?: StatpackPocket;
  /** Human pocket name, or 'Not in a pocket'. */
  pocketName: string;
  itemName: string;
  /** The problem, plain language, with the real numbers. */
  headline: string;
  /** One line per problem flag — a single 'issue' can carry up to 3. */
  details: string[];
  /** How to fix it, naming the literal on-screen buttons. */
  fixHint: string;
  /** False when no row exists anywhere to scroll to. */
  reachable: boolean;
}

export interface ThingsToFixCardProps {
  mode: 'checkout' | 'checkin' | 'audit';
  items: FixItem[];
  onSelect: (f: FixItem) => void;
}

const MODE_LEAD: Record<ThingsToFixCardProps['mode'], string> = {
  checkout: 'before you take this pack',
  checkin: 'before you finish check-in',
  audit: 'before you submit this audit',
};

function FixRow({ f, onSelect }: { f: FixItem; onSelect: (f: FixItem) => void }) {
  const isProblem = f.kind !== 'checks';
  const lines = f.details.length > 0 ? f.details : [f.headline];

  return (
    <button
      type="button"
      onClick={() => onSelect(f)}
      className={`w-full text-left border rounded-xl px-3 py-3 transition-all duration-150 flex items-start gap-2 ${
        isProblem
          ? 'bg-danger-50 dark:bg-danger-950/20 border-divider hover:border-danger/40'
          : 'bg-warning-50 dark:bg-warning-950/20 border-divider hover:border-warning/40'
      }`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="font-semibold text-sm text-foreground truncate">{f.itemName}</div>
        <div className={`text-xs font-medium truncate ${f.reachable ? 'text-foreground-500' : 'text-warning'}`}>
          {f.pocketName}
        </div>
        {!f.reachable && (
          <div className="text-xs text-warning font-medium break-words">
            This item isn&apos;t in any pocket, so it isn&apos;t in the list below — tell an admin.
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {lines.map((line, i) => (
            <div key={i} className="text-xs text-foreground-600 break-words">
              {line}
            </div>
          ))}
        </div>
        <div className="flex items-start gap-1 text-xs font-medium text-foreground-400 break-words">
          <ArrowRight size={12} className="flex-none mt-0.5" />
          <span className="break-words">{f.fixHint}</span>
        </div>
      </div>
      <ChevronRight size={18} className="flex-none text-foreground-300 mt-0.5" />
    </button>
  );
}

export default function ThingsToFixCard({ mode, items, onSelect }: ThingsToFixCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  const problems = items.filter(f => f.kind !== 'checks');
  const checks = items.filter(f => f.kind === 'checks');
  const hasProblems = problems.length > 0;
  const lead = MODE_LEAD[mode];

  return (
    <div data-fix-card className="scroll-mt-20 bg-content1 border border-divider rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-xl flex-none flex items-center justify-center ${
            hasProblems
              ? 'bg-danger-50 dark:bg-danger-950/20 text-danger'
              : 'bg-warning-50 dark:bg-warning-950/20 text-warning'
          }`}
        >
          {hasProblems ? <AlertTriangle size={18} /> : <ClipboardList size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-base font-semibold leading-tight ${hasProblems ? 'text-danger' : 'text-warning'}`}>
            {hasProblems ? `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix` : "Nothing's wrong yet"}
          </div>
          <div className="text-xs text-foreground-500 font-medium mt-0.5 break-words">
            {hasProblems ? lead : `Just a few boxes still to fill in ${lead}`}
          </div>
        </div>
      </div>

      {hasProblems && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 px-1">
            Problems
          </div>
          <div className="flex flex-col gap-2">
            {problems.map(f => (
              <FixRow key={f.key} f={f} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      {checks.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center gap-2 text-left bg-warning-50 dark:bg-warning-950/20 rounded-xl px-3 py-2.5 transition-all duration-150"
          >
            <span className="flex-1 min-w-0 text-sm font-semibold text-warning truncate">
              {checks.length} item{checks.length === 1 ? '' : 's'} still need their boxes filled in
            </span>
            <ChevronDown
              size={16}
              className={`flex-none text-warning transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          {/* Unfilled boxes aren't wrong yet — every oxygen/AED/expiration check
              starts empty at page load, so this group stays amber and collapsed
              rather than reading as an error list on a pack nobody has touched. */}
          {expanded && (
            <div className="flex flex-col gap-2">
              {checks.map(f => (
                <FixRow key={f.key} f={f} onSelect={onSelect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
