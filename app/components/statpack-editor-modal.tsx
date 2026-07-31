'use client';

/**
 * StatpackEditorModal — the rich, single-surface statpack editor.
 *
 * Implements the "Statpack Editor" design: a modal shell with an editable
 * header (pack name / status / location popovers), a compact bag-layout column
 * with meta readouts, and a searchable/filterable contents list where each row
 * expands into a full rules & verification editor (pocket, par, on-hand,
 * serial/expiration/O₂/advisory toggles, custom checkout warnings, swap/remove).
 *
 * Wired to the real Statpack data model; surfaces use theme tokens so the
 * editor reads correctly in both light and dark mode.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, AutocompleteItem } from '@heroui/react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  Plus, Minus, Link2, Search, MapPin, ChevronDown, Pencil, X, Check,
  Trash2, Shield, AlertTriangle, Save, Package, PackagePlus,
} from 'lucide-react';
import type {
  Statpack, StatpackItem, StatpackPocket, StatpackWarning, InventoryItem,
  ExchangeBag, ExchangeBagAssignment, InventoryBatch,
} from '@/app/types';
import { getCatCfg } from '@/app/components/category-badge';
import { subscribeExchangeBags, resolveBagAssignments } from '@/app/lib/exchange-bags';
import { batchHasStock } from '@/app/lib/item-status';

type Pocket = StatpackPocket;
type Filter = 'all' | 'assets' | 'contents';

const POCKETS: { id: Pocket; short: string; long: string }[] = [
  { id: 'main', short: 'Main', long: 'Main Compartment' },
  { id: 'front_aux', short: 'Front', long: 'Front Aux Pouch' },
  { id: 'side_left', short: 'Left', long: 'Left Side Pocket' },
  { id: 'side_right', short: 'Right', long: 'Right Side Pocket' },
];
const POCKET_LABEL: Record<Pocket, string> = {
  main: 'Main Compartment', front_aux: 'Front Aux Pouch',
  side_left: 'Left Side Pocket', side_right: 'Right Side Pocket',
};

const STATUS_OPTIONS: Statpack['status'][] = [
  'Ready', 'Restock Needed', 'Expired Items', 'In Use', 'Pending Initial Check',
];
// map each status to a semantic token set (dot / text / soft bg)
function statusMeta(s: string): { dot: string; text: string; soft: string } {
  switch (s) {
    case 'Ready': return { dot: 'bg-success', text: 'text-success', soft: 'bg-success-50 dark:bg-success-900/20' };
    case 'Restock Needed': return { dot: 'bg-warning', text: 'text-warning', soft: 'bg-warning-50 dark:bg-warning-900/20' };
    case 'Expired Items':
    case 'CRITICAL - EXPIRED ITEMS': return { dot: 'bg-danger', text: 'text-danger', soft: 'bg-danger-50 dark:bg-danger-900/20' };
    case 'In Use': return { dot: 'bg-primary', text: 'text-primary', soft: 'bg-primary-50 dark:bg-primary-900/20' };
    default: return { dot: 'bg-foreground-400', text: 'text-foreground-500', soft: 'bg-content2' };
  }
}

const LOCATION_PRESETS = ['Vehicle 1', 'Vehicle 2', 'HQ · Back Room', 'HQ · Front', 'CPR Closet', 'Event Trailer'];

// ── item-level derived helpers ─────────────────────────────────────
const isAsset = (it: StatpackItem) => !!(it.serialNumber || it.assetInstanceId);
const isOxygen = (it: StatpackItem) => !!it.itemDetails?.isOxygen;
// A "placeholder" line has no real inventory-backed itemId/batchId — a genuinely
// off-book item added via the escape hatch in the add-item popover, distinct from
// (and visibly flagged apart from) the default inventory-linked add path.
const isPlaceholder = (it: StatpackItem) => it.batchId === 'placeholder' || it.itemId.startsWith('placeholder-');
const itemName = (it: StatpackItem) => it.itemDetails?.name || it.variantName || it.itemId || 'Item';
const itemCategory = (it: StatpackItem) => (it.itemDetails?.category as string) || 'Other';
const itemValue = (it: StatpackItem) => it.itemValue ?? it.itemDetails?.assetValue ?? 0;

function expToMonth(d: unknown): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d as string);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}
function expState(d: unknown): 'expired' | 'soon' | 'ok' | null {
  const m = expToMonth(d);
  if (!m) return null;
  const [y, mo] = m.split('-').map(Number);
  const end = new Date(y, mo, 0, 23, 59, 59);
  const now = new Date();
  if (end.getTime() < now.getTime()) return 'expired';
  return (end.getTime() - now.getTime()) / 86400000 <= 62 ? 'soon' : 'ok';
}
function expLabel(d: unknown): string {
  const m = expToMonth(d);
  if (!m) return '';
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// ── inventory hydration (Timestamp → Date), same pattern as app/restock/page.tsx ──
function toDateVal(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const anyV = v as { toDate?: () => Date };
  if (typeof anyV.toDate === 'function') return anyV.toDate();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? undefined : d;
}
function hydrateInventoryLite(raw: Record<string, unknown>): InventoryItem {
  const rawBatches = raw.batches;
  const batches = Array.isArray(rawBatches)
    ? rawBatches.map((b: unknown) => {
        const bb = b as Record<string, unknown>;
        return { ...bb, expirationDate: toDateVal(bb?.expirationDate), openDate: toDateVal(bb?.openDate) };
      })
    : rawBatches;
  return { ...raw, batches } as unknown as InventoryItem;
}

/**
 * Pick a real batch to link a new content line to: the earliest-expiring
 * non-expired batch that still has stock (per `batchHasStock`). Returns null
 * when the item has nothing linkable — the caller must refuse to add the
 * line rather than fabricate a batchId (see the addItem fix in Workstream D).
 */
function resolveBatchForItem(item: InventoryItem): InventoryBatch | null {
  const now = new Date();
  const candidates = (item.batches || []).filter(
    (b) => batchHasStock(b) && (!b.expirationDate || b.expirationDate >= now),
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const at = a.expirationDate ? a.expirationDate.getTime() : Infinity;
    const bt = b.expirationDate ? b.expirationDate.getTime() : Infinity;
    return at - bt;
  })[0];
}

type Popover = null | 'name' | 'status' | 'location' | 'additem';
type RightTab = 'contents' | 'bags';

export default function StatpackEditorModal({
  pack,
  isOpen,
  onClose,
  onSave,
  onDelete,
  canDelete = true,
}: {
  pack: Statpack | null;
  isOpen: boolean;
  onClose: () => void;
  /** Persist the edited pack. Should write to Firestore and resolve. */
  onSave: (draft: Statpack) => Promise<void> | void;
  /** Delete the pack (and route away). */
  onDelete?: () => Promise<void> | void;
  canDelete?: boolean;
}) {
  const [draft, setDraft] = useState<Statpack | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [pocket, setPocket] = useState<Pocket | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [locDraft, setLocDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>('contents');
  const [addItemError, setAddItemError] = useState('');
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [exchangeBags, setExchangeBags] = useState<ExchangeBag[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Seed the local draft ONCE per open. `pack` may be a live onSnapshot object
  // (it changes reference on every Firestore update); re-seeding on those changes
  // would clobber the user's unsaved edits, so we only seed on the closed→open
  // transition (and once `pack` first becomes available if it opened early).
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isOpen) { seededRef.current = false; return; }
    if (!seededRef.current && pack) {
      const seeded = JSON.parse(JSON.stringify(pack)) as Statpack;
      // Normalize the legacy flat `exchangeBagIds` into pocket-aware assignments
      // once, at seed time, via the shared resolver — never read either raw
      // field directly elsewhere in this component.
      seeded.exchangeBagAssignments = resolveBagAssignments(seeded);
      setDraft(seeded);
      setFilter('all'); setPocket('all'); setSearch('');
      setExpanded(null); setPopover(null); setRightTab('contents'); setAddItemError('');
      seededRef.current = true;
    }
  }, [isOpen, pack]);

  // Inventory + exchange bag subscriptions — only while the editor is open.
  useEffect(() => {
    if (!isOpen) return;
    const unsub = onSnapshot(collection(db, 'inventory'), (snap) => {
      setInventoryItems(snap.docs.map((d) => hydrateInventoryLite({ id: d.id, ...d.data() } as Record<string, unknown>)));
    });
    return () => unsub();
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const unsub = subscribeExchangeBags(setExchangeBags);
    return () => unsub();
  }, [isOpen]);

  // dismiss popovers on outside click
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest && t.closest('[data-keepopen]')) return;
      setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  const patchPack = (fn: (p: Statpack) => void) =>
    setDraft(prev => { if (!prev) return prev; const next = structuredClone(prev); fn(next); return next; });
  const patchItem = (idx: number, fn: (it: StatpackItem) => void) =>
    setDraft(prev => { if (!prev) return prev; const next = structuredClone(prev); const it = next.contents[idx]; if (it) fn(it); return next; });
  const patchBagAssignment = (idx: number, fn: (a: ExchangeBagAssignment) => void) =>
    patchPack(p => {
      const list = [...(p.exchangeBagAssignments ?? [])];
      const item = { ...list[idx] };
      fn(item);
      list[idx] = item;
      p.exchangeBagAssignments = list;
    });

  const items = useMemo<StatpackItem[]>(() => draft?.contents ?? [], [draft]);

  // pack-level derived numbers
  const derived = useMemo(() => {
    const assets = items.filter(isAsset);
    const consumables = items.filter(i => !isAsset(i));
    const attn = items.filter(i => i.currentQuantity < i.requiredQuantity || expState(i.expirationDate) === 'expired').length;
    const totalValue = items.reduce((s, i) => s + itemValue(i) * (i.requiredQuantity || 0), 0);
    return { assets: assets.length, consumables: consumables.length, attn, totalValue };
  }, [items]);

  // filtered / searched view — keep the true index for mutations
  const view = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => {
        if (pocket !== 'all' && (it.pocket || 'main') !== pocket) return false;
        if (filter === 'assets' && !isAsset(it)) return false;
        if (filter === 'contents' && isAsset(it)) return false;
        if (q) {
          const hay = `${itemName(it)} ${itemCategory(it)} ${it.serialNumber || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [items, pocket, filter, search]);

  if (!isOpen || !draft) return null;

  const st = statusMeta(draft.status);

  const pocketCounts = (pid: Pocket) => {
    const its = items.filter(i => (i.pocket || 'main') === pid);
    return { count: its.length, assets: its.filter(isAsset).length };
  };

  // Add a REAL inventory-backed content line: sets a real itemId, and for
  // consumables resolves a real batchId from the item's own batches (never a
  // fabricated `manual-<ts>`/`manual` pair — that made it impossible to add a
  // content line that actually points at real stock). Assets (isAsset) aren't
  // batch-tracked, so they get `batchId: ''` — the same convention used by real
  // seed/asset-linked statpack entries elsewhere in the app.
  const addRealItem = (itemId: string) => {
    const item = inventoryItems.find(i => i.id === itemId);
    if (!item) return;
    setAddItemError('');
    const target: Pocket = pocket !== 'all' ? pocket : 'main';
    const asset = !!item.isAsset;
    let batch: InventoryBatch | null = null;
    if (!asset) {
      batch = resolveBatchForItem(item);
      if (!batch) {
        setAddItemError(`"${item.name}" has no in-stock, unexpired batch to link. Add stock first, or use the placeholder line below.`);
        return;
      }
    }
    const base: StatpackItem = {
      itemId: item.id,
      batchId: asset ? '' : batch!.id,
      requiredQuantity: 1,
      // New expected items start at 0 on-hand: the pack physically lacks the item
      // until someone stocks it, so the next check-off surfaces it as short.
      currentQuantity: 0,
      pocket: target,
      itemValue: item.assetValue ?? 0,
      itemDetails: item,
      verificationRules: asset ? { requireSerial: true } : {},
      customWarnings: [],
      ...(asset && item.assetSerial ? { serialNumber: item.assetSerial } : {}),
      ...(batch?.expirationDate ? { expirationDate: batch.expirationDate } : {}),
      ...(batch?.lotNumber ? { lotNumber: batch.lotNumber } : {}),
    };
    patchPack(p => { p.contents.unshift(base); });
    setExpanded(0);
    setPopover(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  // Escape hatch for genuinely off-book items with no inventory record.
  // Visibly distinct (amber, "placeholder" labeled) — not the default path.
  const addPlaceholderItem = () => {
    const target: Pocket = pocket !== 'all' ? pocket : 'main';
    const base: StatpackItem = {
      itemId: `placeholder-${Date.now()}`,
      batchId: 'placeholder',
      requiredQuantity: 1,
      currentQuantity: 0,
      pocket: target,
      itemValue: 0,
      itemDetails: { name: 'Off-book placeholder', category: 'Other' } as unknown as InventoryItem,
      verificationRules: {},
      customWarnings: [],
    };
    patchPack(p => { p.contents.unshift(base); });
    setExpanded(0);
    setPopover(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const bagAssignments = draft.exchangeBagAssignments ?? [];
  const addBagAssignment = () =>
    patchPack(p => { p.exchangeBagAssignments = [...(p.exchangeBagAssignments ?? []), { bagId: '', pocket: 'main', qtyPerPack: 1 }]; });
  const removeBagAssignment = (idx: number) =>
    patchPack(p => { p.exchangeBagAssignments = (p.exchangeBagAssignments ?? []).filter((_, i) => i !== idx); });

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      // recompute a fresh asset value from contents so the summary stays in sync
      const value = items.reduce((s, i) => s + itemValue(i) * (i.requiredQuantity || 0), 0);
      await onSave({ ...draft, assetValue: value });
    } finally {
      setSaving(false);
    }
  };

  // Phone: chips grow to equal fractions of a full-width row and stand 44px tall.
  // `sm:` restores the desktop hug-content, 28px-tall segmented control exactly.
  const filterChip = (active: boolean) =>
    `flex flex-1 sm:flex-none items-center justify-center gap-1.5 text-xs font-semibold rounded-medium px-3 py-3 sm:py-1.5 transition-colors duration-150 ${
      active ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
    }`;
  const rightTabBtn = (active: boolean) =>
    `flex flex-1 sm:flex-none items-center justify-center gap-1.5 text-xs font-semibold rounded-medium px-3 py-3 sm:py-1.5 transition-colors duration-150 ${
      active ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
    }`;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center md:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Phone: full-bleed sheet — the backdrop's p-4 costs 32px of a 390px viewport,
          which is exactly the width the contents panel is starving for. `overflow-visible`
          stays so the header popovers can escape the card; they clamp their own width. */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[1140px] h-full md:h-[min(860px,92vh)] bg-content1 border-0 md:border border-divider rounded-none md:rounded-[18px] shadow-2xl flex flex-col overflow-visible"
      >
        {/* ══════ HEADER ══════ */}
        <div className="flex items-center gap-4 px-5 py-3 border-b border-divider flex-none">
          <div className="w-[42px] h-[42px] rounded-[13px] bg-primary text-white flex items-center justify-center flex-none shadow-[0_6px_16px_-4px_rgba(0,111,238,.5)]">
            <Package size={20} />
          </div>

          {/* pack name + rename popover */}
          <div className="relative flex flex-col gap-0.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-widest text-foreground-400">Statpack Editor</span>
            <button
              data-keepopen=""
              onClick={() => { setNameDraft(draft.name); setPopover(popover === 'name' ? null : 'name'); }}
              className="flex items-center gap-1.5 -ml-0.5 rounded-lg px-1.5 py-0.5 min-h-11 md:min-h-0 hover:bg-content2 transition-colors"
            >
              <span className="text-xl font-semibold text-foreground leading-none">{draft.name}</span>
              <Pencil size={14} className="text-foreground-400" />
            </button>
            {popover === 'name' && (
              <div data-keepopen="" className="absolute top-[calc(100%+8px)] left-0 z-40 w-72 max-w-[calc(100vw-2rem)] bg-content1 border border-divider rounded-large shadow-xl p-3.5">
                <span className="block text-[10px] font-semibold uppercase tracking-widest text-foreground-400 mb-1.5">Rename pack</span>
                <div className="flex gap-1.5">
                  <input
                    autoFocus value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { patchPack(p => { if (nameDraft.trim()) p.name = nameDraft.trim(); }); setPopover(null); } }}
                    className="flex-1 h-9 rounded-medium border border-divider bg-content1 px-2.5 text-[13px] font-semibold text-foreground outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => { patchPack(p => { if (nameDraft.trim()) p.name = nameDraft.trim(); }); setPopover(null); }}
                    className="h-9 rounded-medium bg-primary text-white text-xs font-semibold px-3.5"
                  >Save</button>
                </div>
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            {/* status */}
            <div className="relative" data-keepopen="">
              <button
                onClick={() => setPopover(popover === 'status' ? null : 'status')}
                className="flex items-center gap-2 h-11 md:h-9 rounded-medium border border-divider bg-content1 px-3 hover:bg-content2 transition-colors"
              >
                <span className={`w-[7px] h-[7px] rounded-[2px] ${st.dot}`} />
                <span className={`text-[13px] font-semibold ${st.text}`}>{draft.status}</span>
                <ChevronDown size={13} className="text-foreground-400" />
              </button>
              {popover === 'status' && (
                <div data-keepopen="" className="absolute top-[calc(100%+8px)] right-0 z-40 w-56 max-w-[calc(100vw-2rem)] bg-content1 border border-divider rounded-large shadow-xl p-1.5 flex flex-col gap-0.5">
                  {STATUS_OPTIONS.map(s => {
                    const m = statusMeta(s); const active = draft.status === s;
                    return (
                      <button key={s} onClick={() => { patchPack(p => { p.status = s; }); setPopover(null); }}
                        className={`flex items-center gap-2 rounded-medium px-2.5 py-3 md:py-2 text-left transition-colors ${active ? m.soft : 'hover:bg-content2'}`}>
                        <span className={`w-2 h-2 rounded-[3px] ${m.dot}`} />
                        <span className={`text-[13px] font-semibold ${m.text}`}>{s}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* location */}
            <div className="relative" data-keepopen="">
              <button
                onClick={() => { setLocDraft(draft.currentLocation || ''); setPopover(popover === 'location' ? null : 'location'); }}
                className="flex items-center gap-2 h-11 md:h-9 rounded-medium border border-divider bg-content1 px-3 hover:bg-content2 transition-colors"
              >
                <MapPin size={14} className="text-foreground-500" />
                <span className="text-[13px] font-semibold text-foreground-600">{draft.currentLocation || '—'}</span>
                <Pencil size={12} className="text-foreground-400" />
              </button>
              {popover === 'location' && (
                <div data-keepopen="" className="absolute top-[calc(100%+8px)] right-0 z-40 w-72 max-w-[calc(100vw-2rem)] bg-content1 border border-divider rounded-large shadow-xl p-3.5">
                  <span className="block text-[10px] font-semibold uppercase tracking-widest text-foreground-400 mb-1.5">Location</span>
                  <div className="flex gap-1.5 mb-2.5">
                    <input
                      autoFocus value={locDraft}
                      onChange={(e) => setLocDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { patchPack(p => { p.currentLocation = locDraft.trim(); }); setPopover(null); } }}
                      className="flex-1 h-9 rounded-medium border border-divider bg-content1 px-2.5 text-[13px] font-semibold text-foreground outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => { patchPack(p => { p.currentLocation = locDraft.trim(); }); setPopover(null); }}
                      className="h-9 rounded-medium bg-primary text-white text-xs font-semibold px-3.5"
                    >Save</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {LOCATION_PRESETS.map(p => (
                      <button key={p} onClick={() => { patchPack(pk => { pk.currentLocation = p; }); setPopover(null); }}
                        className="text-[11px] font-semibold text-foreground-600 bg-content2 hover:bg-content3 rounded-md px-2 py-2.5 md:py-1 transition-colors">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button onClick={onClose} aria-label="Close editor" className="w-11 h-11 md:w-[34px] md:h-[34px] rounded-medium bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors flex-none">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ══════ BODY ══════ */}
        {/* Phone: one column, one scroll region. A bare `w-[296px] flex-none` beside the
            contents panel left it 62px at 390px — that was the whole bug. Below `md` the
            bag pane becomes a full-width header block at the top of the body's scroller. */}
        <div className="flex flex-col md:flex-row items-stretch min-h-0 flex-1 max-md:overflow-y-auto">
          {/* LEFT — bag layout + meta */}
          <div className="w-full md:w-[296px] flex-none border-b md:border-b-0 md:border-r border-divider bg-content2 md:rounded-bl-[18px] p-4 flex flex-col gap-3.5 min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-widest text-foreground-400">Bag layout</span>
              {pocket !== 'all' && (
                <button onClick={() => setPocket('all')} className="text-[11px] font-semibold text-primary">View all pockets</button>
              )}
            </div>

            {/* bag diagram — deliberately NOT stacked on phone. Full-bleed it gets ~358px
                (vs 264px on desktop), so the LEFT/MAIN/RIGHT/FRONT spatial metaphor reads
                better there than here; only the height trims so it doesn't eat the fold. */}
            <div className="flex gap-1.5 h-[132px] md:h-[158px]">
              {(['side_left'] as Pocket[]).map(pid => {
                const c = pocketCounts(pid); const sel = pocket === pid;
                return (
                  <PocketCard key={pid} vertical label="LEFT" sel={sel} count={c.count} assets={c.assets}
                    onClick={() => setPocket(sel ? 'all' : pid)} className="w-11" />
                );
              })}
              <div className="flex-1 flex flex-col gap-1.5">
                <PocketCard label="MAIN" main sel={pocket === 'main'} count={pocketCounts('main').count}
                  onClick={() => setPocket(pocket === 'main' ? 'all' : 'main')} className="flex-1" />
                <PocketCard label="FRONT" row sel={pocket === 'front_aux'} count={pocketCounts('front_aux').count}
                  onClick={() => setPocket(pocket === 'front_aux' ? 'all' : 'front_aux')} className="h-[42px]" />
              </div>
              {(['side_right'] as Pocket[]).map(pid => {
                const c = pocketCounts(pid); const sel = pocket === pid;
                return (
                  <PocketCard key={pid} vertical label="RIGHT" sel={sel} count={c.count} assets={c.assets}
                    onClick={() => setPocket(sel ? 'all' : pid)} className="w-11" />
                );
              })}
            </div>

            <div className="h-px bg-divider" />

            {/* meta readouts — 2×2 on phone so they don't push the contents list past the fold */}
            <div className="grid grid-cols-2 md:grid-cols-1 gap-x-4 gap-y-2.5">
              <MetaRow label="Total items" value={items.length} />
              <MetaRow label="Assets tracked" value={derived.assets} valueClass="text-primary" />
              <MetaRow label="Needs attention" value={derived.attn} valueClass={derived.attn > 0 ? 'text-warning' : 'text-success'} />
              <div className="col-span-2 md:col-span-1 flex items-center justify-between pt-2.5 border-t border-divider">
                <span className="text-[11.5px] font-semibold text-foreground-500">Asset value</span>
                <span className="font-mono text-[15px] font-semibold tabular-nums text-foreground">
                  ${derived.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT — contents / exchange bags */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* tab switcher */}
            <div className="px-[18px] pt-3.5 flex-none">
              <div className="flex items-center gap-1 bg-content2 p-1 rounded-medium w-full sm:w-fit">
                <button className={rightTabBtn(rightTab === 'contents')} onClick={() => setRightTab('contents')}>
                  <Package size={13} /> Contents <span className="font-mono opacity-60">{items.length}</span>
                </button>
                <button className={rightTabBtn(rightTab === 'bags')} onClick={() => setRightTab('bags')}>
                  <PackagePlus size={13} /> Exchange Bags
                  {bagAssignments.length > 0 && <span className="font-mono opacity-60">{bagAssignments.length}</span>}
                </button>
              </div>
            </div>

            {rightTab === 'contents' ? (
              <>
                {/* toolbar */}
                <div className="px-[18px] pt-3 pb-3 flex flex-col gap-2.5 flex-none">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className="flex items-center gap-2">
                      {pocket !== 'all' && (
                        <span className="text-[10.5px] font-semibold text-primary bg-primary-50 dark:bg-primary-900/20 rounded-md px-2 py-0.5">
                          {POCKET_LABEL[pocket]}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 bg-content2 p-0.5 rounded-medium w-full sm:w-auto">
                      <button className={filterChip(filter === 'all')} onClick={() => setFilter('all')}>All <span className="font-mono opacity-60">{items.length}</span></button>
                      <button className={filterChip(filter === 'assets')} onClick={() => setFilter('assets')}>Assets <span className="font-mono opacity-60">{derived.assets}</span></button>
                      <button className={filterChip(filter === 'contents')} onClick={() => setFilter('contents')}>Consumables <span className="font-mono opacity-60">{derived.consumables}</span></button>
                    </div>
                    <div className="ml-auto max-md:w-full relative" data-keepopen="">
                      <button
                        onClick={() => { setAddItemError(''); setPopover(popover === 'additem' ? null : 'additem'); }}
                        className="flex max-md:w-full items-center justify-center gap-1.5 text-xs font-semibold text-white bg-primary rounded-medium px-3 py-3 md:py-2 hover:opacity-90 transition-opacity"
                      >
                        <Plus size={13} strokeWidth={2.6} /> Add item
                      </button>
                      {popover === 'additem' && (
                        <div data-keepopen="" className="absolute top-[calc(100%+8px)] right-0 z-40 w-80 max-w-[calc(100vw-2rem)] bg-content1 border border-divider rounded-large shadow-xl p-3.5">
                          <span className="block text-[10px] font-semibold uppercase tracking-widest text-foreground-400 mb-1.5">Add real inventory item</span>
                          <Autocomplete
                            aria-label="Inventory item"
                            placeholder="Search inventory…"
                            size="sm"
                            defaultItems={inventoryItems}
                            onSelectionChange={(key) => { if (key) addRealItem(String(key)); }}
                          >
                            {(it) => <AutocompleteItem key={it.id} textValue={it.name}>{it.name}</AutocompleteItem>}
                          </Autocomplete>
                          {addItemError && <p className="text-[11px] text-danger mt-1.5">{addItemError}</p>}
                          <div className="h-px bg-divider my-3" />
                          <button
                            onClick={addPlaceholderItem}
                            className="w-full flex items-center gap-1.5 text-[11.5px] font-semibold text-warning bg-warning-50 dark:bg-warning-900/20 border border-dashed border-warning/50 rounded-medium px-2.5 py-3 md:py-1.5 hover:bg-warning-100 dark:hover:bg-warning-900/30 transition-colors"
                          >
                            <AlertTriangle size={12} /> Add placeholder line (off-book item)
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 bg-content2 border border-divider rounded-large px-3">
                    <Search size={15} className="text-foreground-400 flex-none" />
                    <input
                      value={search} onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search contents, categories, serials…"
                      className="flex-1 bg-transparent outline-none text-[12.5px] text-foreground placeholder:text-foreground-400 py-2.5"
                    />
                    {search && <button onClick={() => setSearch('')} aria-label="Clear search" className="w-11 h-11 md:w-auto md:h-auto flex-none flex items-center justify-center text-foreground-400 hover:text-foreground-600"><X size={15} /></button>}
                  </div>
                </div>

                {/* list — `overflow-y-auto` alone computed overflow-x to `auto` (CSS makes a
                    `visible` axis `auto` when its sibling axis isn't), which is where the stray
                    sideways scroll came from. Pinning overflow-x is only safe because the row
                    reflow below makes the content genuinely fit first. */}
                <div ref={listRef} className="flex-1 min-h-0 md:overflow-y-auto overflow-x-hidden px-[18px] pb-2">
                  {view.length === 0 ? (
                    <div className="text-center py-12 text-foreground-400">
                      <div className="text-[13px] font-semibold text-foreground-500">Nothing here</div>
                      <div className="text-xs mt-1">No items match this filter or pocket.</div>
                    </div>
                  ) : view.map(({ it, idx }) => (
                    <ItemRow
                      key={idx}
                      it={it}
                      expanded={expanded === idx}
                      onToggleExpand={() => setExpanded(expanded === idx ? null : idx)}
                      patch={(fn) => patchItem(idx, fn)}
                      onRemove={() => { patchPack(p => { p.contents.splice(idx, 1); }); setExpanded(null); }}
                    />
                  ))}

                  {/* Phone-only danger zone. On desktop Delete lives in the footer, but at
                      390px that puts a destructive control a thumb-width from Save — so on
                      phone it moves to the end of the scroll, reachable only deliberately. */}
                  {canDelete && onDelete && (
                    <div className="md:hidden mt-6 mb-2 pt-4 border-t border-divider">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Danger zone</p>
                      <button
                        onClick={() => onDelete()}
                        className="w-full flex items-center justify-center gap-1.5 min-h-11 text-[12.5px] font-semibold text-danger bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-3 hover:opacity-80 transition-opacity"
                      >
                        <Trash2 size={14} /> Delete statpack
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* Exchange bag assignments — pocket-aware, out of contents[] */
              <div className="flex-1 min-h-0 overflow-y-auto px-[18px] py-3.5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Bag assignments</span>
                  <button onClick={addBagAssignment} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-primary rounded-medium px-3 py-3 md:py-1.5 hover:opacity-90 transition-opacity">
                    <Plus size={13} strokeWidth={2.6} /> Assign bag
                  </button>
                </div>
                {bagAssignments.length === 0 ? (
                  <div className="text-center py-12 text-foreground-400">
                    <div className="text-[13px] font-semibold text-foreground-500">No exchange bags assigned</div>
                    <div className="text-xs mt-1">Assign a bag to a pocket so crews grab it during checkout.</div>
                  </div>
                ) : bagAssignments.map((a, idx) => (
                  <BagAssignmentRow
                    key={idx}
                    assignment={a}
                    bags={exchangeBags}
                    onBag={(bagId) => patchBagAssignment(idx, x => { x.bagId = bagId; })}
                    onPocket={(p) => patchBagAssignment(idx, x => { x.pocket = p; })}
                    onQty={(n) => patchBagAssignment(idx, x => { x.qtyPerPack = n; })}
                    onRemove={() => removeBagAssignment(idx)}
                  />
                ))}
              </div>
            )}

            {/* footer — on phone the body is the scroller, so this must stick or Save
                scrolls off the end of a long pack. Needs its own bg: sticky chrome over
                scrolling content bleeds through otherwise. */}
            <div className="border-t border-divider bg-content1 px-[18px] py-3 flex items-center gap-2.5 flex-none max-md:sticky max-md:bottom-0 max-md:z-10">
              {/* Desktop keeps Delete here; on phone it lives in the danger zone above. */}
              {canDelete && onDelete && (
                <button onClick={() => onDelete()} className="hidden md:flex items-center gap-1.5 text-[12.5px] font-semibold text-danger px-1 py-2 hover:opacity-80 transition-opacity">
                  <Trash2 size={14} /> Delete statpack
                </button>
              )}
              <div className="ml-auto flex gap-2.5 max-md:w-full">
                <button onClick={onClose} className="text-[13px] font-semibold text-foreground-600 bg-content2 hover:bg-content3 rounded-large px-4 py-3 md:py-2.5 transition-colors">Close</button>
                <button onClick={doSave} disabled={saving} className="flex flex-1 md:flex-none items-center justify-center gap-1.5 text-[13px] font-semibold text-white bg-primary rounded-large px-5 py-3 md:py-2.5 shadow-[0_6px_16px_-5px_rgba(0,111,238,.55)] hover:opacity-90 transition-opacity disabled:opacity-60">
                  <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── bag pocket card ────────────────────────────────────────────────
function PocketCard({
  label, count, assets = 0, sel, onClick, className = '', vertical, row,
}: {
  label: string; count: number; assets?: number; sel: boolean; onClick: () => void;
  className?: string; vertical?: boolean; main?: boolean; row?: boolean;
}) {
  const base = `rounded-large flex cursor-pointer transition-all duration-150 ${
    sel ? 'border-2 border-primary bg-primary-50 dark:bg-primary-900/20 shadow-[0_4px_12px_-4px_rgba(0,111,238,.4)]' : 'border border-divider bg-content1'
  }`;
  const labelColor = sel ? 'text-primary' : 'text-foreground-400';
  const countColor = sel ? 'text-primary' : 'text-foreground';
  if (vertical) {
    return (
      <button onClick={onClick} className={`${base} ${className} flex-col items-center justify-center gap-1.5 p-1.5`}>
        <span className={`[writing-mode:vertical-rl] rotate-180 text-[9px] font-semibold tracking-wider ${labelColor}`}>{label}</span>
        <span className={`font-mono text-lg font-semibold ${countColor}`}>{count}</span>
        {assets > 0 && <span className="text-[8.5px] font-semibold text-primary bg-primary-50 dark:bg-primary-900/20 rounded px-1">{assets}A</span>}
      </button>
    );
  }
  if (row) {
    return (
      <button onClick={onClick} className={`${base} ${className} flex-row items-center justify-between px-2.5`}>
        <span className={`text-[9px] font-semibold tracking-wider ${labelColor}`}>{label}</span>
        <span className={`font-mono text-lg font-semibold ${countColor}`}>{count}</span>
      </button>
    );
  }
  // main
  return (
    <button onClick={onClick} className={`${base} ${className} flex-col items-stretch justify-start px-2.5 py-2`}>
      <span className={`text-[9px] font-semibold tracking-wider text-left ${labelColor}`}>{label}</span>
      <div className="flex-1 flex flex-col items-center justify-center">
        <span className={`font-mono text-lg font-semibold ${countColor}`}>{count}</span>
        <span className="text-[8.5px] font-semibold uppercase text-foreground-400">items</span>
      </div>
    </button>
  );
}

function MetaRow({ label, value, valueClass = 'text-foreground' }: { label: string; value: number; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11.5px] font-medium text-foreground-500">{label}</span>
      <span className={`font-mono text-[13px] font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ── statpack activity log (left column) ────────────────────────────
// ── item row ───────────────────────────────────────────────────────
function ItemRow({
  it, expanded, onToggleExpand, patch, onRemove,
}: {
  it: StatpackItem;
  expanded: boolean;
  onToggleExpand: () => void;
  patch: (fn: (it: StatpackItem) => void) => void;
  onRemove: () => void;
}) {
  const cat = getCatCfg(itemCategory(it));
  const asset = isAsset(it);
  const oxygen = isOxygen(it);
  const placeholder = isPlaceholder(it);
  const es = expState(it.expirationDate);
  const short = it.currentQuantity < it.requiredQuantity;
  const rules = it.verificationRules || {};
  const hasRules = !!(rules.requireSerial || rules.requireExpirationConfirmation || (rules.requireO2PsiMin && rules.requireO2PsiMin > 0) || rules.advisoryOnly);
  const warnings = it.customWarnings || [];
  const sub = asset && it.serialNumber
    ? `${itemCategory(it)} · #${it.serialNumber}`
    : `${itemCategory(it)} · $${itemValue(it).toFixed(2)} ea · on-hand ${it.currentQuantity}`;

  const borderClass = expanded ? 'border-primary' : (short || es === 'expired' ? 'border-warning/40' : 'border-divider');

  const setPocket = (p: Pocket) => patch(x => { x.pocket = p; });
  const setRule = (patchRules: Partial<StatpackItem['verificationRules']>) =>
    patch(x => { x.verificationRules = { ...(x.verificationRules || {}), ...patchRules }; });

  return (
    <div className={`border ${borderClass} rounded-large ${expanded ? 'bg-content2/40' : 'bg-content1'} mb-2.5 overflow-hidden`}>
      {/* head */}
      {/* `min-w-[60%] sm:min-w-0` on the name block is the lever: it forces the stepper and
          pocket select onto a second line on a phone, giving the name the full row width. */}
      <div onClick={onToggleExpand} className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none">
        <div className="flex-1 min-w-[60%] sm:min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-semibold text-foreground">{itemName(it)}</span>
            <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded ${cat.bg} ${cat.text}`}>{itemCategory(it)}</span>
            {asset && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary inline-flex items-center gap-1"><Link2 size={9} />{it.serialNumber || 'Asset'}</span>}
            {oxygen && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">O₂</span>}
            {es === 'expired' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-danger-50 dark:bg-danger-900/30 text-danger">Expired {expLabel(it.expirationDate)}</span>}
            {es === 'soon' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning">Expiring {expLabel(it.expirationDate)}</span>}
            {short && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning">Short {Math.max(0, it.requiredQuantity - it.currentQuantity)}</span>}
            {hasRules && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary inline-flex items-center gap-1"><Shield size={9} />Rules</span>}
            {placeholder && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning inline-flex items-center gap-1"><AlertTriangle size={9} />Placeholder — not inventory-linked</span>}
          </div>
          <div className="text-[11.5px] font-medium text-foreground-500 mt-0.5 truncate">{sub}</div>
        </div>

        {/* par stepper */}
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 flex-none">
          <button onClick={() => patch(x => { x.requiredQuantity = Math.max(0, x.requiredQuantity - 1); })}
            aria-label="Decrease par level"
            className="w-11 h-11 md:w-7 md:h-7 rounded-lg bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors"><Minus size={13} /></button>
          <div className="text-center min-w-[40px]">
            <div className="font-mono text-base font-semibold tabular-nums text-foreground leading-none">{it.requiredQuantity}</div>
            <div className="text-[8.5px] font-semibold uppercase tracking-wide text-foreground-400 mt-0.5">par</div>
          </div>
          <button onClick={() => patch(x => { x.requiredQuantity += 1; })}
            aria-label="Increase par level"
            className="w-11 h-11 md:w-7 md:h-7 rounded-lg bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-800/30 transition-colors"><Plus size={13} /></button>
        </div>

        {/* pocket quick select */}
        <select value={it.pocket || 'main'} onChange={(e) => setPocket(e.target.value as Pocket)}
          onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
          aria-label="Pocket"
          className="flex-none h-11 md:h-[34px] rounded-lg border border-divider bg-content1 text-xs font-semibold text-foreground-600 px-2 outline-none">
          {POCKETS.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
        </select>
      </div>

      {/* expanded rules */}
      {expanded && (
        <div className="border-t border-divider bg-content2/40 px-4 py-3.5">
          <div className="flex items-center gap-1.5 mb-3">
            <Shield size={12} className="text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-500">Item rules &amp; verification</span>
          </div>

          {/* basic grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-3.5">
            <Field label="Pocket / location">
              <select value={it.pocket || 'main'} onChange={(e) => setPocket(e.target.value as Pocket)}
                className="h-11 md:h-9 rounded-medium border border-divider bg-content1 text-[12.5px] font-semibold text-foreground-600 px-2.5 outline-none w-full">
                {POCKETS.map(p => <option key={p.id} value={p.id}>{p.long}</option>)}
              </select>
            </Field>
            <Field label="Par level (required qty)">
              <Stepper value={it.requiredQuantity}
                onDec={() => patch(x => { x.requiredQuantity = Math.max(0, x.requiredQuantity - 1); })}
                onInc={() => patch(x => { x.requiredQuantity += 1; })}
                onInput={(n) => patch(x => { x.requiredQuantity = n; })} editable />
            </Field>
            <Field label="On-hand quantity">
              <Stepper value={it.currentQuantity} valueClass={short ? 'text-warning' : 'text-success'}
                onDec={() => patch(x => { x.currentQuantity = Math.max(0, x.currentQuantity - 1); })}
                onInc={() => patch(x => { x.currentQuantity += 1; })} />
            </Field>
          </div>

          {/* verification toggles */}
          <div className="bg-content1 border border-divider rounded-large p-3 flex flex-col gap-3">
            <ToggleRow on={!!rules.requireSerial} onClick={() => setRule({ requireSerial: !rules.requireSerial })}
              title="Require serial scan" desc="Scan/enter serial at checkout & check-in" />
            <div className="h-px bg-content2" />
            <ToggleRow on={!!rules.requireExpirationConfirmation} onClick={() => setRule({ requireExpirationConfirmation: !rules.requireExpirationConfirmation })}
              title="Require expiration check" desc="Confirm month/year before deploying" />
            {rules.requireExpirationConfirmation && (
              <div className="flex items-center gap-2.5 ml-7 px-2.5 py-2 bg-content2 border border-divider rounded-medium">
                <span className="text-[12px] font-semibold text-foreground-600 flex-1">Expiration date</span>
                <input type="month" value={expToMonth(it.expirationDate)}
                  onChange={(e) => patch(x => {
                    const v = e.target.value;
                    if (!v) { delete (x as Partial<StatpackItem>).expirationDate; return; }
                    const [y, mo] = v.split('-').map(Number);
                    x.expirationDate = new Date(y, mo - 1, 1) as unknown as Date;
                  })}
                  className="font-mono h-11 md:h-9 rounded-medium border border-divider bg-content1 text-[12.5px] font-semibold text-foreground px-2.5 outline-none focus:border-primary" />
              </div>
            )}
            {oxygen && (
              <>
                <div className="h-px bg-content2" />
                <div className="flex items-center gap-2.5">
                  <span className="flex-1">
                    <span className="block text-[12.5px] font-semibold text-foreground">Minimum O₂ PSI</span>
                    <span className="block text-[11px] text-foreground-400">Block deploy below this cylinder pressure · 0 = off</span>
                  </span>
                  <input value={rules.requireO2PsiMin ? String(rules.requireO2PsiMin) : ''} placeholder="0"
                    onChange={(e) => { const n = parseInt(e.target.value, 10); setRule({ requireO2PsiMin: isNaN(n) ? 0 : n }); }}
                    className="font-mono w-[88px] h-11 md:h-9 text-center rounded-medium border border-divider bg-content2 text-[13px] font-semibold text-foreground outline-none focus:border-primary" />
                </div>
              </>
            )}
            <div className="h-px bg-content2" />
            <ToggleRow on={!!rules.advisoryOnly} onClick={() => setRule({ advisoryOnly: !rules.advisoryOnly })}
              title="Advisory only (non-blocking)" desc="Warn but don't block checkout" />
          </div>

          {/* custom warnings */}
          <div className="mt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertTriangle size={12} className="text-warning" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-500">Checkout warnings</span>
              {warnings.length > 0 && <span className="text-[9.5px] font-semibold text-warning bg-warning-50 dark:bg-warning-900/20 rounded px-1.5">{warnings.length}</span>}
            </div>
            {warnings.map((w) => (
              <WarningRow key={w.id} w={w}
                onSev={(sev) => patch(x => { const ww = (x.customWarnings || []).find(a => a.id === w.id); if (ww) ww.severity = sev; })}
                onMsg={(msg) => patch(x => { const ww = (x.customWarnings || []).find(a => a.id === w.id); if (ww) ww.message = msg; })}
                onAck={() => patch(x => { const ww = (x.customWarnings || []).find(a => a.id === w.id); if (ww) ww.requiresAcknowledgment = !ww.requiresAcknowledgment; })}
                onRemove={() => patch(x => { x.customWarnings = (x.customWarnings || []).filter(a => a.id !== w.id); })} />
            ))}
            <button onClick={() => patch(x => { x.customWarnings = [...(x.customWarnings || []), { id: `w${Date.now()}`, message: '', severity: 'warning', requiresAcknowledgment: true }]; })}
              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning bg-warning-50 dark:bg-warning-900/20 border border-dashed border-warning/50 rounded-medium px-2.5 py-3 md:py-1.5 hover:bg-warning-100 dark:hover:bg-warning-900/30 transition-colors">
              <Plus size={12} /> Add warning
            </button>
          </div>

          {/* footer actions */}
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-divider">
            <button onClick={onRemove}
              className="flex items-center gap-1.5 text-xs font-semibold text-danger bg-danger-50 dark:bg-danger-900/20 rounded-medium px-3 py-3 md:py-2 hover:opacity-80 transition-opacity">
              <Trash2 size={13} /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] font-semibold text-foreground-500">{label}</span>
      {children}
    </div>
  );
}

function Stepper({ value, onDec, onInc, onInput, editable, valueClass = 'text-foreground' }: {
  value: number; onDec: () => void; onInc: () => void; onInput?: (n: number) => void; editable?: boolean; valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 h-auto md:h-9 border border-divider rounded-medium bg-content1 px-1.5 py-1 md:py-0">
      <button onClick={onDec} aria-label="Decrease" className="w-11 h-11 md:w-6 md:h-6 rounded-md bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center flex-none"><Minus size={12} /></button>
      {editable ? (
        <input value={String(value)} onChange={(e) => { const n = parseInt(e.target.value, 10); onInput?.(isNaN(n) ? 0 : Math.max(0, n)); }}
          className={`font-mono flex-1 w-full text-center bg-transparent outline-none text-sm font-semibold ${valueClass}`} />
      ) : (
        <span className={`font-mono flex-1 text-center text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
      )}
      <button onClick={onInc} aria-label="Increase" className="w-11 h-11 md:w-6 md:h-6 rounded-md bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none"><Plus size={12} /></button>
    </div>
  );
}

function ToggleRow({ on, onClick, title, desc }: { on: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 text-left py-1.5 md:py-0">
      <span className={`w-[19px] h-[19px] rounded-md flex-none flex items-center justify-center border-2 transition-colors ${on ? 'bg-primary border-primary' : 'bg-content1 border-foreground-300'}`}>
        {on && <Check size={11} strokeWidth={3} className="text-white" />}
      </span>
      <span className="flex-1">
        <span className="block text-[12.5px] font-semibold text-foreground">{title}</span>
        <span className="block text-[11px] text-foreground-400">{desc}</span>
      </span>
    </button>
  );
}

function WarningRow({ w, onSev, onMsg, onAck, onRemove }: {
  w: StatpackWarning;
  onSev: (s: StatpackWarning['severity']) => void;
  onMsg: (m: string) => void;
  onAck: () => void;
  onRemove: () => void;
}) {
  const sevColor = w.severity === 'info' ? 'text-primary' : w.severity === 'critical' ? 'text-danger' : 'text-warning';
  return (
    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-content1 border border-divider rounded-medium p-2 mb-1.5">
      <select value={w.severity} onChange={(e) => onSev(e.target.value as StatpackWarning['severity'])}
        aria-label="Warning severity"
        className={`flex-none w-24 h-11 md:h-8 rounded-lg border border-divider bg-content2 text-[11.5px] font-semibold px-2 outline-none ${sevColor}`}>
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
      <input value={w.message} onChange={(e) => onMsg(e.target.value)} placeholder="Warning message…"
        className="flex-1 min-w-[55%] sm:min-w-0 h-11 md:h-8 rounded-lg border border-divider bg-content2 text-xs text-foreground px-2.5 outline-none focus:border-primary" />
      <button onClick={onAck} title="Requires acknowledgment"
        className={`h-11 md:h-8 rounded-lg border text-[11px] font-semibold px-2.5 flex-none transition-colors ${w.requiresAcknowledgment ? 'border-primary bg-primary-50 dark:bg-primary-900/20 text-primary' : 'border-divider bg-content1 text-foreground-400'}`}>Ack</button>
      <button onClick={onRemove} aria-label="Remove warning" className="w-11 h-11 md:w-[30px] md:h-8 rounded-lg bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center flex-none"><X size={13} /></button>
    </div>
  );
}

// ── exchange bag assignment row (pocket-aware; bags stay out of contents[]) ──
function BagAssignmentRow({
  assignment, bags, onBag, onPocket, onQty, onRemove,
}: {
  assignment: ExchangeBagAssignment;
  bags: ExchangeBag[];
  onBag: (bagId: string) => void;
  onPocket: (p: Pocket) => void;
  onQty: (n: number) => void;
  onRemove: () => void;
}) {
  const bag = bags.find((b) => b.id === assignment.bagId);
  return (
    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-content1 border border-divider rounded-large p-2.5 mb-2">
      <PackagePlus size={14} className="text-primary flex-none" />
      <Autocomplete
        aria-label="Exchange bag"
        placeholder="Select bag…"
        className="flex-1 min-w-[60%] sm:min-w-0"
        size="sm"
        selectedKey={assignment.bagId || null}
        onSelectionChange={(key) => onBag(key ? String(key) : '')}
        defaultItems={bags}
      >
        {(b) => <AutocompleteItem key={b.id} textValue={b.name}>{b.name}</AutocompleteItem>}
      </Autocomplete>
      <select value={assignment.pocket} onChange={(e) => onPocket(e.target.value as Pocket)}
        aria-label="Bag pocket"
        className="flex-none h-11 md:h-9 rounded-medium border border-divider bg-content1 text-xs font-semibold text-foreground-600 px-2 outline-none">
        {POCKETS.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
      </select>
      <div className="flex items-center gap-1 flex-none">
        <button onClick={() => onQty(Math.max(1, assignment.qtyPerPack - 1))}
          aria-label="Decrease quantity per pack"
          className="w-11 h-11 md:w-7 md:h-7 rounded-lg bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors"><Minus size={12} /></button>
        <span className="font-mono text-sm font-semibold tabular-nums w-6 text-center">{assignment.qtyPerPack}</span>
        <button onClick={() => onQty(assignment.qtyPerPack + 1)}
          aria-label="Increase quantity per pack"
          className="w-11 h-11 md:w-7 md:h-7 rounded-lg bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-800/30 transition-colors"><Plus size={12} /></button>
      </div>
      {bag && bag.lines?.length > 0 && (
        <span className="hidden lg:inline text-[10px] font-medium text-foreground-400 flex-none">
          {bag.lines.length} SKU{bag.lines.length !== 1 ? 's' : ''}
        </span>
      )}
      <button onClick={onRemove} aria-label="Remove bag assignment" className="w-11 h-11 md:w-8 md:h-8 rounded-lg bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center flex-none flex-shrink-0"><Trash2 size={13} /></button>
    </div>
  );
}
