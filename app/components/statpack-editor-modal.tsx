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
import {
  Plus, Minus, Link2, Search, MapPin, ChevronDown, Pencil, X, Check,
  Trash2, Shield, AlertTriangle, GripVertical, RefreshCw, Save, Package,
} from 'lucide-react';
import type { Statpack, StatpackItem, StatpackPocket, StatpackWarning, InventoryItem } from '@/app/types';
import { getCatCfg } from '@/app/components/category-badge';

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
const SWAP_CHOICES: { name: string; category: string }[] = [
  { name: 'Combat Gauze (QuikClot)', category: 'Trauma' },
  { name: 'Israeli Bandage 6"', category: 'Trauma' },
  { name: 'Nasopharyngeal Airway', category: 'Airway' },
  { name: 'Nitrile Gloves — L', category: 'PPE' },
  { name: 'Oral Glucose 15g', category: 'Meds' },
];

// ── item-level derived helpers ─────────────────────────────────────
const isAsset = (it: StatpackItem) => !!(it.serialNumber || it.assetInstanceId);
const isOxygen = (it: StatpackItem) => !!it.itemDetails?.isOxygen;
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

type Popover = null | 'name' | 'status' | 'location';

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
  const [swapOpen, setSwapOpen] = useState<number | null>(null);
  const [popover, setPopover] = useState<Popover>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [locDraft, setLocDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Seed the local draft ONCE per open. `pack` may be a live onSnapshot object
  // (it changes reference on every Firestore update); re-seeding on those changes
  // would clobber the user's unsaved edits, so we only seed on the closed→open
  // transition (and once `pack` first becomes available if it opened early).
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isOpen) { seededRef.current = false; return; }
    if (!seededRef.current && pack) {
      setDraft(JSON.parse(JSON.stringify(pack)) as Statpack);
      setFilter('all'); setPocket('all'); setSearch('');
      setExpanded(null); setSwapOpen(null); setPopover(null);
      seededRef.current = true;
    }
  }, [isOpen, pack]);

  // dismiss popovers / swap menus on outside click
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest && t.closest('[data-keepopen]')) return;
      setPopover(null);
      setSwapOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  const patchPack = (fn: (p: Statpack) => void) =>
    setDraft(prev => { if (!prev) return prev; const next = structuredClone(prev); fn(next); return next; });
  const patchItem = (idx: number, fn: (it: StatpackItem) => void) =>
    setDraft(prev => { if (!prev) return prev; const next = structuredClone(prev); const it = next.contents[idx]; if (it) fn(it); return next; });

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

  const addItem = (asset: boolean) => {
    const target: Pocket = pocket !== 'all' ? pocket : 'main';
    const details = { name: asset ? 'New asset' : 'New item', category: asset ? 'Vitals' : 'Other' } as unknown as InventoryItem;
    const base: StatpackItem = {
      itemId: `manual-${Date.now()}`,
      batchId: 'manual',
      requiredQuantity: 1,
      // New expected items start at 0 on-hand: the pack physically lacks the item
      // until someone stocks it, so the next check-off surfaces it as short.
      currentQuantity: 0,
      pocket: target,
      itemValue: 0,
      itemDetails: details,
      verificationRules: asset ? { requireSerial: true } : {},
      customWarnings: [],
      ...(asset ? { serialNumber: `ASSET-${Math.floor(Math.random() * 900 + 100)}` } : {}),
    };
    patchPack(p => { p.contents.unshift(base); });
    setExpanded(0);
    setSwapOpen(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

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

  const filterChip = (active: boolean) =>
    `flex items-center gap-1.5 text-xs font-semibold rounded-medium px-3 py-1.5 transition-colors duration-150 ${
      active ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
    }`;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[1140px] h-[min(860px,92vh)] bg-content1 border border-divider rounded-[18px] shadow-2xl flex flex-col overflow-visible"
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
              className="flex items-center gap-1.5 -ml-0.5 rounded-lg px-1.5 py-0.5 hover:bg-content2 transition-colors"
            >
              <span className="text-xl font-semibold text-foreground leading-none">{draft.name}</span>
              <Pencil size={14} className="text-foreground-400" />
            </button>
            {popover === 'name' && (
              <div data-keepopen="" className="absolute top-[calc(100%+8px)] left-0 z-40 w-72 bg-content1 border border-divider rounded-large shadow-xl p-3.5">
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
                className="flex items-center gap-2 h-9 rounded-medium border border-divider bg-content1 px-3 hover:bg-content2 transition-colors"
              >
                <span className={`w-[7px] h-[7px] rounded-[2px] ${st.dot}`} />
                <span className={`text-[13px] font-semibold ${st.text}`}>{draft.status}</span>
                <ChevronDown size={13} className="text-foreground-400" />
              </button>
              {popover === 'status' && (
                <div data-keepopen="" className="absolute top-[calc(100%+8px)] right-0 z-40 w-56 bg-content1 border border-divider rounded-large shadow-xl p-1.5 flex flex-col gap-0.5">
                  {STATUS_OPTIONS.map(s => {
                    const m = statusMeta(s); const active = draft.status === s;
                    return (
                      <button key={s} onClick={() => { patchPack(p => { p.status = s; }); setPopover(null); }}
                        className={`flex items-center gap-2 rounded-medium px-2.5 py-2 text-left transition-colors ${active ? m.soft : 'hover:bg-content2'}`}>
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
                className="flex items-center gap-2 h-9 rounded-medium border border-divider bg-content1 px-3 hover:bg-content2 transition-colors"
              >
                <MapPin size={14} className="text-foreground-500" />
                <span className="text-[13px] font-semibold text-foreground-600">{draft.currentLocation || '—'}</span>
                <Pencil size={12} className="text-foreground-400" />
              </button>
              {popover === 'location' && (
                <div data-keepopen="" className="absolute top-[calc(100%+8px)] right-0 z-40 w-72 bg-content1 border border-divider rounded-large shadow-xl p-3.5">
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
                        className="text-[11px] font-semibold text-foreground-600 bg-content2 hover:bg-content3 rounded-md px-2 py-1 transition-colors">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button onClick={onClose} className="w-[34px] h-[34px] rounded-medium bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ══════ BODY ══════ */}
        <div className="flex items-stretch min-h-0 flex-1">
          {/* LEFT — bag layout + meta */}
          <div className="w-[296px] flex-none border-r border-divider bg-content2 rounded-bl-[18px] p-4 flex flex-col gap-3.5 min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-widest text-foreground-400">Bag layout</span>
              {pocket !== 'all' && (
                <button onClick={() => setPocket('all')} className="text-[11px] font-semibold text-primary">View all pockets</button>
              )}
            </div>

            {/* bag diagram */}
            <div className="flex gap-1.5 h-[158px]">
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

            {/* meta readouts */}
            <div className="flex flex-col gap-2.5">
              <MetaRow label="Total items" value={items.length} />
              <MetaRow label="Assets tracked" value={derived.assets} valueClass="text-primary" />
              <MetaRow label="Needs attention" value={derived.attn} valueClass={derived.attn > 0 ? 'text-warning' : 'text-success'} />
              <div className="flex items-center justify-between pt-2.5 border-t border-divider">
                <span className="text-[11.5px] font-semibold text-foreground-500">Asset value</span>
                <span className="font-mono text-[15px] font-semibold tabular-nums text-foreground">
                  ${derived.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT — contents */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* toolbar */}
            <div className="px-[18px] pt-3.5 pb-3 flex flex-col gap-2.5 flex-none">
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-foreground">Contents</span>
                  {pocket !== 'all' && (
                    <span className="text-[10.5px] font-semibold text-primary bg-primary-50 dark:bg-primary-900/20 rounded-md px-2 py-0.5">
                      {POCKET_LABEL[pocket]}
                    </span>
                  )}
                </div>
                <div className="flex gap-1 bg-content2 p-0.5 rounded-medium">
                  <button className={filterChip(filter === 'all')} onClick={() => setFilter('all')}>All <span className="font-mono opacity-60">{items.length}</span></button>
                  <button className={filterChip(filter === 'assets')} onClick={() => setFilter('assets')}>Assets <span className="font-mono opacity-60">{derived.assets}</span></button>
                  <button className={filterChip(filter === 'contents')} onClick={() => setFilter('contents')}>Consumables <span className="font-mono opacity-60">{derived.consumables}</span></button>
                </div>
                <div className="ml-auto flex gap-2">
                  <button onClick={() => addItem(false)} className="flex items-center gap-1.5 text-xs font-semibold text-white bg-primary rounded-medium px-3 py-2 hover:opacity-90 transition-opacity">
                    <Plus size={13} strokeWidth={2.6} /> Add item
                  </button>
                  <button onClick={() => addItem(true)} className="flex items-center gap-1.5 text-xs font-semibold text-foreground-600 bg-content1 border border-divider rounded-medium px-3 py-2 hover:bg-content2 transition-colors">
                    <Link2 size={13} /> Attach asset
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2.5 bg-content2 border border-divider rounded-large px-3">
                <Search size={15} className="text-foreground-400 flex-none" />
                <input
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search contents, categories, serials…"
                  className="flex-1 bg-transparent outline-none text-[12.5px] text-foreground placeholder:text-foreground-400 py-2.5"
                />
                {search && <button onClick={() => setSearch('')} className="text-foreground-400 hover:text-foreground-600"><X size={15} /></button>}
              </div>
            </div>

            {/* list */}
            <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-[18px] pb-2">
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
                  swapOpen={swapOpen === idx}
                  onToggleExpand={() => { setExpanded(expanded === idx ? null : idx); setSwapOpen(null); }}
                  onToggleSwap={() => setSwapOpen(swapOpen === idx ? null : idx)}
                  patch={(fn) => patchItem(idx, fn)}
                  onRemove={() => { patchPack(p => { p.contents.splice(idx, 1); }); setExpanded(null); }}
                />
              ))}
            </div>

            {/* footer */}
            <div className="border-t border-divider px-[18px] py-3 flex items-center gap-2.5 flex-none">
              {canDelete && onDelete && (
                <button onClick={() => onDelete()} className="flex items-center gap-1.5 text-[12.5px] font-semibold text-danger px-1 py-2 hover:opacity-80 transition-opacity">
                  <Trash2 size={14} /> Delete statpack
                </button>
              )}
              <div className="ml-auto flex gap-2.5">
                <button onClick={onClose} className="text-[13px] font-semibold text-foreground-600 bg-content2 hover:bg-content3 rounded-large px-4 py-2.5 transition-colors">Close</button>
                <button onClick={doSave} disabled={saving} className="flex items-center gap-1.5 text-[13px] font-semibold text-white bg-primary rounded-large px-5 py-2.5 shadow-[0_6px_16px_-5px_rgba(0,111,238,.55)] hover:opacity-90 transition-opacity disabled:opacity-60">
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
  it, expanded, swapOpen, onToggleExpand, onToggleSwap, patch, onRemove,
}: {
  it: StatpackItem;
  expanded: boolean;
  swapOpen: boolean;
  onToggleExpand: () => void;
  onToggleSwap: () => void;
  patch: (fn: (it: StatpackItem) => void) => void;
  onRemove: () => void;
}) {
  const cat = getCatCfg(itemCategory(it));
  const asset = isAsset(it);
  const oxygen = isOxygen(it);
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
      <div onClick={onToggleExpand} className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none">
        <GripVertical onClick={(e) => e.stopPropagation()} size={15} className="text-foreground-300 flex-none cursor-grab" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-semibold text-foreground">{itemName(it)}</span>
            <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded ${cat.bg} ${cat.text}`}>{itemCategory(it)}</span>
            {asset && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary inline-flex items-center gap-1"><Link2 size={9} />{it.serialNumber || 'Asset'}</span>}
            {oxygen && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">O₂</span>}
            {es === 'expired' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-danger-50 dark:bg-danger-900/30 text-danger">Expired {expLabel(it.expirationDate)}</span>}
            {es === 'soon' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning">Expiring {expLabel(it.expirationDate)}</span>}
            {short && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/20 text-warning">Short {Math.max(0, it.requiredQuantity - it.currentQuantity)}</span>}
            {hasRules && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary inline-flex items-center gap-1"><Shield size={9} />Rules</span>}
          </div>
          <div className="text-[11.5px] font-medium text-foreground-500 mt-0.5 truncate">{sub}</div>
        </div>

        {/* par stepper */}
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 flex-none">
          <button onClick={() => patch(x => { x.requiredQuantity = Math.max(0, x.requiredQuantity - 1); })}
            className="w-7 h-7 rounded-lg bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors"><Minus size={13} /></button>
          <div className="text-center min-w-[40px]">
            <div className="font-mono text-base font-semibold tabular-nums text-foreground leading-none">{it.requiredQuantity}</div>
            <div className="text-[8.5px] font-semibold uppercase tracking-wide text-foreground-400 mt-0.5">par</div>
          </div>
          <button onClick={() => patch(x => { x.requiredQuantity += 1; })}
            className="w-7 h-7 rounded-lg bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center hover:bg-primary-100 dark:hover:bg-primary-800/30 transition-colors"><Plus size={13} /></button>
        </div>

        {/* pocket quick select */}
        <select value={it.pocket || 'main'} onChange={(e) => setPocket(e.target.value as Pocket)}
          onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
          className="flex-none h-[34px] rounded-lg border border-divider bg-content1 text-xs font-semibold text-foreground-600 px-2 outline-none">
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
          <div className="grid grid-cols-3 gap-2.5 mb-3.5">
            <Field label="Pocket / location">
              <select value={it.pocket || 'main'} onChange={(e) => setPocket(e.target.value as Pocket)}
                className="h-9 rounded-medium border border-divider bg-content1 text-[12.5px] font-semibold text-foreground-600 px-2.5 outline-none w-full">
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
                  className="font-mono h-9 rounded-medium border border-divider bg-content1 text-[12.5px] font-semibold text-foreground px-2.5 outline-none focus:border-primary" />
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
                    className="font-mono w-[88px] h-9 text-center rounded-medium border border-divider bg-content2 text-[13px] font-semibold text-foreground outline-none focus:border-primary" />
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
              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning bg-warning-50 dark:bg-warning-900/20 border border-dashed border-warning/50 rounded-medium px-2.5 py-1.5 hover:bg-warning-100 dark:hover:bg-warning-900/30 transition-colors">
              <Plus size={12} /> Add warning
            </button>
          </div>

          {/* footer actions */}
          <div className="relative flex items-center gap-2 mt-3 pt-3 border-t border-divider">
            <button data-keepopen="" onClick={onToggleSwap}
              className="flex items-center gap-1.5 text-xs font-semibold text-foreground-600 bg-content1 border border-divider rounded-medium px-3 py-2 hover:bg-content2 transition-colors">
              <RefreshCw size={13} /> {asset ? 'Swap asset' : 'Replace item'}
            </button>
            <button onClick={onRemove}
              className="flex items-center gap-1.5 text-xs font-semibold text-danger bg-danger-50 dark:bg-danger-900/20 rounded-medium px-3 py-2 hover:opacity-80 transition-opacity">
              <Trash2 size={13} /> Remove
            </button>
            {swapOpen && (
              <div data-keepopen="" className="absolute bottom-11 left-0 z-40 w-72 bg-content1 border border-divider rounded-large shadow-xl p-2">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground-400 px-1.5 pt-1 pb-1.5">Replace with</div>
                {SWAP_CHOICES.map((c) => {
                  const cc = getCatCfg(c.category);
                  return (
                    <button key={c.name} onClick={() => { patch(x => { x.itemDetails = { ...(x.itemDetails || {} as InventoryItem), name: c.name, category: c.category as InventoryItem['category'] }; }); onToggleSwap(); }}
                      className="w-full flex items-center justify-between gap-2 rounded-medium px-2 py-2 hover:bg-content2 transition-colors text-left">
                      <span className="text-[12.5px] font-semibold text-foreground">{c.name}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${cc.bg} ${cc.text}`}>{c.category}</span>
                    </button>
                  );
                })}
              </div>
            )}
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
    <div className="flex items-center gap-1.5 h-9 border border-divider rounded-medium bg-content1 px-1.5">
      <button onClick={onDec} className="w-6 h-6 rounded-md bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center flex-none"><Minus size={12} /></button>
      {editable ? (
        <input value={String(value)} onChange={(e) => { const n = parseInt(e.target.value, 10); onInput?.(isNaN(n) ? 0 : Math.max(0, n)); }}
          className={`font-mono flex-1 w-full text-center bg-transparent outline-none text-sm font-semibold ${valueClass}`} />
      ) : (
        <span className={`font-mono flex-1 text-center text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
      )}
      <button onClick={onInc} className="w-6 h-6 rounded-md bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none"><Plus size={12} /></button>
    </div>
  );
}

function ToggleRow({ on, onClick, title, desc }: { on: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 text-left">
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
    <div className="flex items-center gap-2 bg-content1 border border-divider rounded-medium p-2 mb-1.5">
      <select value={w.severity} onChange={(e) => onSev(e.target.value as StatpackWarning['severity'])}
        className={`flex-none w-24 h-8 rounded-lg border border-divider bg-content2 text-[11.5px] font-semibold px-2 outline-none ${sevColor}`}>
        <option value="info">Info</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
      <input value={w.message} onChange={(e) => onMsg(e.target.value)} placeholder="Warning message…"
        className="flex-1 h-8 rounded-lg border border-divider bg-content2 text-xs text-foreground px-2.5 outline-none focus:border-primary" />
      <button onClick={onAck} title="Requires acknowledgment"
        className={`h-8 rounded-lg border text-[11px] font-semibold px-2.5 flex-none transition-colors ${w.requiresAcknowledgment ? 'border-primary bg-primary-50 dark:bg-primary-900/20 text-primary' : 'border-divider bg-content1 text-foreground-400'}`}>Ack</button>
      <button onClick={onRemove} className="w-[30px] h-8 rounded-lg bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center flex-none"><X size={13} /></button>
    </div>
  );
}
