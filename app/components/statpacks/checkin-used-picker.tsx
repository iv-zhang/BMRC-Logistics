'use client';

import React, { useMemo, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { Search, Minus, Plus, Check, ArrowRight } from 'lucide-react';
import type { StatpackItem, StatpackPocket } from '@/app/types';

// Mirrors POCKETS in app/statpacks/check-off/page.tsx — section headers /
// order only, kept local so this component has no dependency on the page.
const POCKET_LABELS: { id: StatpackPocket; name: string }[] = [
  { id: 'main',       name: 'Main Compartment' },
  { id: 'front_aux',  name: 'Front Aux Pouch' },
  { id: 'side_left',  name: 'Left Side Pocket' },
  { id: 'side_right', name: 'Right Side Pocket' },
];

/** One touched item, ready to become a `logStatpackCheckOff` check entry (minus `usedQty`, which is display-only). */
export interface CheckinUsedPick {
  itemId: string;
  itemName: string;
  batchId?: string;
  compartmentId?: string;
  pocket?: StatpackPocket;
  requiredQuantity: number;
  countedQuantity: number;
  ok: boolean;
  /** Units the crew reported using — carried for the review-sheet summary, not part of the log entry itself. */
  usedQty: number;
}

export interface CheckinUsedPickerProps {
  /** Full pack contents. Assets are filtered out internally — see `isAssetContent`. */
  items: StatpackItem[];
  /** Fires with entries for touched items only, once the crew taps Continue. */
  onContinue: (picks: CheckinUsedPick[]) => void;
}

// Mirrors `isAssetContent` in app/lib/statpack-shortages.ts (and the asset
// test `logStatpackCheckOff` uses in app/lib/inventory.ts): assets are
// status-tracked, never counted, so they never appear in this picker.
function isAssetContent(it: StatpackItem): boolean {
  return Boolean(it.serialNumber) || Boolean(it.assetInstanceId) || Boolean(it.itemDetails?.isAsset);
}

function itemName(it: StatpackItem): string {
  return it.itemDetails?.name || `Item ${it.itemId.slice(-6)}`;
}

// The ceiling on how much of an item can be reported "used" — same fallback
// the check-off page uses everywhere else: currentQuantity, else par.
function ceilingFor(it: StatpackItem): number {
  const q = typeof it.currentQuantity === 'number' ? it.currentQuantity : it.requiredQuantity;
  return Math.max(0, q);
}

export default function CheckinUsedPicker({ items, onContinue }: CheckinUsedPickerProps) {
  const [search, setSearch] = useState('');
  const [usedQty, setUsedQty] = useState<Record<string, number>>({});

  const consumables = useMemo(() => items.filter(it => !isAssetContent(it)), [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return consumables;
    return consumables.filter(it => itemName(it).toLowerCase().includes(q));
  }, [consumables, search]);

  const groups = useMemo(() =>
    POCKET_LABELS
      .map(pk => ({ ...pk, items: filtered.filter(it => it.pocket === pk.id) }))
      .filter(pk => pk.items.length > 0),
    [filtered]
  );

  const touchedCount = useMemo(() => Object.values(usedQty).filter(q => q > 0).length, [usedQty]);

  // Setting to 0 removes the entry entirely — untouched items must produce
  // NO ENTRY AT ALL so their stored currentQuantity is preserved.
  const setQty = (it: StatpackItem, next: number) => {
    const ceiling = ceilingFor(it);
    const clamped = Math.max(0, Math.min(ceiling, next));
    setUsedQty(prev => {
      const copy = { ...prev };
      if (clamped <= 0) delete copy[it.itemId];
      else copy[it.itemId] = clamped;
      return copy;
    });
  };

  const tap = (it: StatpackItem) => {
    if ((usedQty[it.itemId] ?? 0) > 0) {
      setUsedQty(prev => {
        const copy = { ...prev };
        delete copy[it.itemId];
        return copy;
      });
      return;
    }
    const ceiling = ceilingFor(it);
    if (ceiling <= 0) return; // nothing on hand to report as used
    setUsedQty(prev => ({ ...prev, [it.itemId]: Math.min(1, ceiling) }));
  };

  const handleContinue = () => {
    const picks: CheckinUsedPick[] = consumables
      .filter(it => (usedQty[it.itemId] ?? 0) > 0)
      .map(it => {
        const used = usedQty[it.itemId];
        const counted = Math.max(0, ceilingFor(it) - used);
        return {
          itemId: it.itemId,
          itemName: itemName(it),
          batchId: it.batchId,
          compartmentId: it.compartmentId,
          pocket: it.pocket,
          requiredQuantity: it.requiredQuantity,
          countedQuantity: counted,
          ok: counted >= it.requiredQuantity,
          usedQty: used,
        };
      });
    onContinue(picks);
  };

  return (
    <div className="flex-1 flex flex-col">
      {/* Search — sticky just below the screen header; whole flow shares one
          (window-level) scroll, matching the rest of this mobile-first page —
          no nested overflow-y-auto region here. */}
      <div className="sticky top-14 z-30 bg-background/95 backdrop-blur-md border-b border-divider px-3 py-2">
        <Input
          placeholder="Search items…"
          startContent={<Search size={16} className="text-foreground-400" />}
          value={search}
          onValueChange={setSearch}
          isClearable
          aria-label="Search pack items"
          classNames={{
            inputWrapper: 'bg-content1 border border-divider data-[hover=true]:bg-content1',
          }}
        />
      </div>

      {/* Grouped item list */}
      <div className="flex-1 px-3 py-3 pb-28 flex flex-col gap-4">
        {groups.length === 0 && (
          <div className="flex-1 flex items-center justify-center py-12">
            <p className="text-sm text-foreground-400 font-medium">
              {search ? `No items match "${search}"` : 'No consumables in this pack'}
            </p>
          </div>
        )}
        {groups.map(pk => (
          <div key={pk.id} className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 px-1">
              {pk.name}
            </div>
            <div className="flex flex-col gap-2">
              {pk.items.map(it => {
                const name = itemName(it);
                const used = usedQty[it.itemId] ?? 0;
                const touched = used > 0;
                const ceiling = ceilingFor(it);
                const disabled = ceiling <= 0;
                return (
                  <div
                    key={it.itemId}
                    onClick={disabled ? undefined : () => tap(it)}
                    className={`border rounded-xl px-3 py-3 transition-all duration-150 ${
                      disabled
                        ? 'bg-content2/50 border-divider opacity-60 cursor-default'
                        : touched
                        ? 'bg-primary border-primary cursor-pointer'
                        : 'bg-content2 border-divider cursor-pointer hover:border-primary/30'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-6 h-6 rounded-lg flex-none flex items-center justify-center border-2 transition-all ${
                        touched ? 'bg-white border-white' : 'bg-transparent border-foreground-400'
                      }`}>
                        <Check size={13} strokeWidth={3.5} className={touched ? 'text-primary' : 'text-transparent'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold ${touched ? 'text-white' : 'text-foreground'}`}>
                          {name}
                        </div>
                        <div className={`text-xs font-medium ${touched ? 'text-white/70' : 'text-foreground-500'}`}>
                          {disabled ? 'None on hand' : `${ceiling} on hand`}
                        </div>
                      </div>
                      {touched && (
                        <div className="flex items-center gap-1.5 flex-none" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => setQty(it, used - 1)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150 bg-white/15 hover:bg-white/25 text-white"
                            aria-label={`Decrease ${name} used`}
                          >
                            <Minus size={13} strokeWidth={2.7} />
                          </button>
                          <div className="min-w-[38px] text-center">
                            <div className="font-mono text-lg font-semibold leading-none tabular-nums text-white">
                              {used}
                            </div>
                            <div className="text-[9px] font-semibold mt-0.5 uppercase tracking-wide text-white/60">
                              used
                            </div>
                          </div>
                          <button
                            onClick={() => setQty(it, used + 1)}
                            disabled={used >= ceiling}
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150 bg-white/20 hover:bg-white/30 text-white disabled:opacity-40"
                            aria-label={`Increase ${name} used`}
                          >
                            <Plus size={13} strokeWidth={2.7} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Sticky footer — Continue */}
      <div className="sticky bottom-0 z-30 bg-background/80 backdrop-blur-md border-t border-divider px-3 py-3 flex items-center gap-3 flex-none">
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {touchedCount} item{touchedCount === 1 ? '' : 's'} used
          </span>
          <span className="text-xs text-foreground-400 font-medium">Tap an item to record usage</span>
        </div>
        <Button
          color="primary"
          className="ml-auto font-semibold"
          isDisabled={touchedCount === 0}
          onPress={handleContinue}
          endContent={<ArrowRight size={16} />}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
