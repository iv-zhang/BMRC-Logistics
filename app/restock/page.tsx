'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Input, Spinner, Chip, Modal, ModalContent, ModalHeader, ModalBody,
  ModalFooter, Checkbox, Card, CardBody, useDisclosure,
} from '@heroui/react';
import {
  RefreshCw, Plus, Trash2, Edit2, Info, X, Warehouse, Layers, Boxes,
  AlertTriangle, PackageCheck, ChevronDown, ChevronRight, Repeat, Package,
  ScanBarcode, Printer, MapPin,
} from 'lucide-react';
import {
  collection, onSnapshot, query, orderBy, doc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, arrayUnion, arrayRemove, Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useStorageLocations } from '@/app/hooks/useStorageLocations';
import {
  computeBagStock, getItemStatus, statusBarColor, isShelfCheckCurrent, type ItemStatus,
} from '@/app/lib/item-status';
import { reserveUnits, shelfUnits } from '@/app/lib/stock-pools';
import { refillShelf } from '@/app/lib/restock-actions';
import { subscribeExchangeBags, refillBag, swapBag, parseBagQr } from '@/app/lib/exchange-bags';
import ExchangeBagEditor from '@/app/components/exchange-bag-editor';
import BarcodeScanner from '@/app/components/barcode-scanner';
import type { InventoryItem, Shelf, StorageZone, Container, ExchangeBag } from '@/app/types';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Accountability record of the last time a member marked an item restocked
 *  from this category's view. Display-only — never feeds stock math. */
interface ItemRestockInfo {
  at?: Date;
  byName?: string;
}

interface RestockCategory {
  id: string;
  name: string;
  /** Real storage shelves (by id) that fall under this category. */
  shelfIds: string[];
  /** Per-item accountability stamps, keyed by inventory item id. */
  itemRestocks?: Record<string, ItemRestockInfo>;
  createdAt?: Date;
  updatedAt?: Date;
}

const LEGACY_NOTICE_KEY = 'bmrc_restock_legacy_notice_dismissed';

// ── Hydration helpers (Timestamp → Date), same pattern as sites-rooms-tab ───────
// computeBagStock/getItemStatus expect real Dates; Firestore returns Timestamps.
function toDateVal(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  const anyV = v as { toDate?: () => Date };
  if (typeof anyV.toDate === 'function') return anyV.toDate();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? undefined : d;
}

function hydrateItem(raw: Record<string, unknown>): InventoryItem {
  const rawBatches = raw.batches;
  const batches = Array.isArray(rawBatches)
    ? rawBatches.map((b: Record<string, unknown>) => ({
        ...b,
        expirationDate: toDateVal(b?.expirationDate),
        openDate: toDateVal(b?.openDate),
        openedAt: toDateVal(b?.openedAt),
        receivedAt: toDateVal(b?.receivedAt),
      }))
    : rawBatches;
  return {
    ...raw,
    batches,
    lastAuditDate: toDateVal(raw.lastAuditDate),
    lastShelfCheckAt: toDateVal(raw.lastShelfCheckAt),
  } as unknown as InventoryItem;
}

function hydrateCategory(id: string, raw: Record<string, unknown>): RestockCategory {
  const rawRestocks = (raw.itemRestocks as Record<string, Record<string, unknown>> | undefined) || {};
  const itemRestocks: Record<string, ItemRestockInfo> = {};
  for (const [itemId, v] of Object.entries(rawRestocks)) {
    itemRestocks[itemId] = { at: toDateVal(v?.at), byName: (v?.byName as string) || undefined };
  }
  return {
    id,
    name: (raw.name as string) || 'Untitled category',
    shelfIds: Array.isArray(raw.shelfIds) ? (raw.shelfIds as string[]) : [],
    itemRestocks,
    createdAt: toDateVal(raw.createdAt),
    updatedAt: toDateVal(raw.updatedAt),
  };
}

function fmtWhen(d?: Date): string {
  if (!d) return 'Never restocked';
  return `Restocked ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** Last time the front shelf was physically counted (weekly re-anchor check). */
function fmtChecked(d?: Date): string {
  if (!d) return 'Never checked';
  return `Checked ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

const STATUS_CHIP: Record<ItemStatus, { color: 'success' | 'warning' | 'danger'; label: string }> = {
  ok: { color: 'success', label: 'OK' },
  low: { color: 'warning', label: 'Low Stock' },
  out: { color: 'danger', label: 'Out of Stock' },
  expired: { color: 'danger', label: 'Expired' },
  expiring: { color: 'warning', label: 'Exp. Soon' },
};

function isBelowPar(item: InventoryItem): boolean {
  const available = computeBagStock(item).availableItems;
  return item.reorderThreshold > 0 && available <= item.reorderThreshold;
}

// ── Item row ─────────────────────────────────────────────────────────────────

function RestockItemRow({
  item, restockInfo, onRefill, onEditLevels,
}: {
  item: InventoryItem;
  restockInfo?: ItemRestockInfo;
  onRefill: (item: InventoryItem) => void;
  onEditLevels: (item: InventoryItem) => void;
}) {
  const status = getItemStatus(item);
  const reserve = reserveUnits(item);
  const shelf = shelfUnits(item);
  const par = item.reorderThreshold;
  const max = item.maxUnits;
  // Restock need is measured against the FRONT shelf pool — reserve is the
  // back room supply that refills feed FROM, not what the shelf needs.
  const restockNeeded = Math.max(0, (max ?? par) - shelf);
  const belowPar = isBelowPar(item);
  const chip = STATUS_CHIP[status];
  const capLabel = max ?? (par || '—');
  const checkCurrent = isShelfCheckCurrent(item);

  return (
    <div
      className={`flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-2 rounded-medium transition-colors duration-150 ${
        belowPar ? 'bg-warning-50 dark:bg-warning-950/20' : 'hover:bg-content2'
      }`}
    >
      <span className={`w-2 h-2 rounded-full flex-none ${statusBarColor(status)}`} />
      <div className="flex-1 min-w-[55%] sm:min-w-0">
        <p className="text-sm text-foreground truncate">{item.name}</p>
        <p className="text-xs text-foreground-400 truncate">
          {fmtWhen(restockInfo?.at)}
          <span className="mx-1 text-foreground-300">·</span>
          {fmtChecked(item.lastShelfCheckAt)}
        </p>
      </div>
      <span className="font-mono text-xs tabular-nums flex-none text-foreground-500">
        Reserve {reserve}
      </span>
      <span className={`font-mono text-xs tabular-nums flex-none ${restockNeeded > 0 ? 'text-warning' : 'text-foreground-500'}`}>
        Shelf {shelf} / {capLabel}
      </span>
      {restockNeeded > 0 && (
        <Chip size="sm" variant="flat" color="warning" className="flex-none">Restock {restockNeeded}</Chip>
      )}
      {!checkCurrent && (
        <Chip size="sm" variant="flat" color="warning" className="flex-none">Shelf check due</Chip>
      )}
      <Chip size="sm" variant="flat" color={chip.color} className="flex-none">{chip.label}</Chip>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        className="flex-none"
        aria-label="Set stocking levels"
        onPress={() => onEditLevels(item)}
      >
        <Edit2 size={13} />
      </Button>
      <Button
        size="sm"
        variant={restockNeeded > 0 ? 'flat' : 'light'}
        color={restockNeeded > 0 ? 'warning' : 'default'}
        className="flex-none w-full sm:w-auto"
        startContent={<PackageCheck size={13} />}
        onPress={() => onRefill(item)}
      >
        Refill
      </Button>
    </div>
  );
}

// ── Shelf group (shelf → boxes → items) ─────────────────────────────────────────

function ShelfGroup({
  shelf, zone, containers, directItems, itemsForContainer, restocks, onRefillItem, onMarkAllBelowPar, onEditLevels,
}: {
  shelf: Shelf;
  zone?: StorageZone;
  containers: Container[];
  directItems: InventoryItem[];
  itemsForContainer: (containerId: string) => InventoryItem[];
  restocks: Record<string, ItemRestockInfo>;
  onRefillItem: (shelf: Shelf, item: InventoryItem) => void;
  onMarkAllBelowPar: (shelf: Shelf, items: InventoryItem[]) => void;
  onEditLevels: (item: InventoryItem) => void;
}) {
  const belowParItems = useMemo(() => {
    const all = [...directItems, ...containers.flatMap((c) => itemsForContainer(c.id))];
    return all.filter(isBelowPar);
  }, [directItems, containers, itemsForContainer]);

  const zoneLabel = zone ? [zone.locationType, zone.room, zone.name].filter(Boolean).join(' › ') : null;
  const isEmpty = directItems.length === 0 && containers.every((c) => itemsForContainer(c.id).length === 0);

  return (
    <div className="border border-divider rounded-large bg-content2/40 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={14} className="text-foreground-400 flex-none" />
          <span className="text-sm font-semibold text-foreground truncate">{shelf.name}</span>
          {zoneLabel && <span className="text-xs text-foreground-400 truncate">{zoneLabel}</span>}
        </div>
        {belowParItems.length > 0 && (
          <Button
            size="sm"
            variant="flat"
            color="warning"
            startContent={<PackageCheck size={13} />}
            onPress={() => onMarkAllBelowPar(shelf, belowParItems)}
          >
            Restock all below par ({belowParItems.length})
          </Button>
        )}
      </div>

      {directItems.length > 0 && (
        <div className="flex flex-col gap-1">
          {directItems.map((it) => (
            <RestockItemRow key={it.id} item={it} restockInfo={restocks[it.id]} onRefill={(i) => onRefillItem(shelf, i)} onEditLevels={onEditLevels} />
          ))}
        </div>
      )}

      {containers.map((c) => {
        const cItems = itemsForContainer(c.id);
        return (
          <div key={c.id} className="pl-4 border-l border-divider ml-1 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
              <Boxes size={12} /> {c.name}
            </div>
            {cItems.length === 0 ? (
              <p className="text-xs text-foreground-400 pl-1">No items assigned to this box.</p>
            ) : (
              cItems.map((it) => (
                <RestockItemRow key={it.id} item={it} restockInfo={restocks[it.id]} onRefill={(i) => onRefillItem(shelf, i)} onEditLevels={onEditLevels} />
              ))
            )}
          </div>
        );
      })}

      {isEmpty && <p className="text-xs text-foreground-400">No items or boxes on this shelf.</p>}
    </div>
  );
}

// ── Shelf picker modal ("select which shelves fall under this category") ───────

function ShelfPickerModal({
  isOpen, onOpenChange, category, zones, getShelvesForZone, onToggleShelf,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  category: RestockCategory | null;
  zones: StorageZone[];
  getShelvesForZone: (zoneId: string) => Shelf[];
  onToggleShelf: (category: RestockCategory, shelfId: string) => void;
}) {
  if (!category) return null;
  const zonesWithShelves = zones
    .map((z) => ({ zone: z, shelves: getShelvesForZone(z.id) }))
    .filter((g) => g.shelves.length > 0);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>Select shelves</span>
            <span className="text-xs font-normal text-foreground-400">{category.name}</span>
          </div>
        </ModalHeader>
        <ModalBody>
          {zonesWithShelves.length === 0 ? (
            <p className="text-sm text-foreground-400 text-center py-6">
              No storage shelves yet. Add storage units &amp; shelves in Settings → Sites &amp; Storage.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {zonesWithShelves.map(({ zone, shelves }) => (
                <div key={zone.id} className="bg-content2 rounded-large p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Warehouse size={14} className="text-primary flex-none" />
                    <span className="text-sm font-semibold text-foreground truncate">{zone.name}</span>
                    <span className="text-xs text-foreground-400 truncate">
                      {[zone.locationType, zone.room].filter(Boolean).join(' › ')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {shelves.map((shelf) => (
                      <label
                        key={shelf.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-medium hover:bg-content1 cursor-pointer transition-colors duration-150"
                      >
                        <Checkbox
                          size="sm"
                          isSelected={category.shelfIds.includes(shelf.id)}
                          onValueChange={() => onToggleShelf(category, shelf.id)}
                        />
                        <Layers size={12} className="text-foreground-400 flex-none" />
                        <span className="text-sm text-foreground">{shelf.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button color="primary" onPress={() => onOpenChange(false)}>Done</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Rename category modal ───────────────────────────────────────────────────────

function RenameCategoryModal({
  isOpen, onOpenChange, category, onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  category: RestockCategory | null;
  onSave: (id: string, name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (isOpen) setName(category?.name || ''); }, [isOpen, category]);
  if (!category) return null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" size="sm">
      <ModalContent>
        <ModalHeader>Rename category</ModalHeader>
        <ModalBody>
          <Input label="Category name" value={name} onValueChange={setName} autoFocus />
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button
            color="primary"
            isLoading={saving}
            isDisabled={!name.trim()}
            onPress={async () => {
              setSaving(true);
              try { await onSave(category.id, name.trim()); onOpenChange(false); } finally { setSaving(false); }
            }}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Refill (reserve → shelf) modal ──────────────────────────────────────────────

interface RefillTarget {
  item: InventoryItem;
  cat: RestockCategory;
  shelf: Shelf;
}

function RefillModal({
  isOpen, onOpenChange, target, onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  target: RefillTarget | null;
  onConfirm: (target: RefillTarget, qty: number, observedShelfQty: number) => Promise<void>;
}) {
  // Flow: count what's physically there → decide how many to bring from the
  // back → confirm. "On shelf now" re-anchors `shelfQuantity`; the transfer
  // amount is suggested off THAT observed count, not the stale stored value.
  const [observed, setObserved] = useState('');
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);
  const reserve = target ? reserveUnits(target.item) : 0;
  const storedShelf = target ? shelfUnits(target.item) : 0;
  const par = target?.item.reorderThreshold ?? 0;
  const max = target?.item.maxUnits;

  useEffect(() => {
    if (isOpen && target) {
      const shelfNow = shelfUnits(target.item);
      setObserved(String(shelfNow));
      const suggested = Math.max(0, (max ?? par) - shelfNow);
      setQty(String(Math.min(suggested, reserveUnits(target.item))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target]);

  if (!target) return null;
  const observedNum = Math.max(0, Number(observed) || 0);
  const qtyNum = Number(qty) || 0;
  const invalid = observedNum < 0 || qtyNum < 0 || qtyNum > reserve;
  const resultingShelf = observedNum + qtyNum;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" size="sm">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>Check &amp; refill shelf</span>
            <span className="text-xs font-normal text-foreground-400">{target.item.name}</span>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-content2 rounded-medium px-3 py-2">
                <p className="text-xs text-foreground-400">Reserve</p>
                <p className="font-mono tabular-nums text-foreground">{reserve}</p>
              </div>
              <div className="bg-content2 rounded-medium px-3 py-2">
                <p className="text-xs text-foreground-400">Recorded on shelf</p>
                <p className="font-mono tabular-nums text-foreground">{storedShelf}</p>
              </div>
              <div className="bg-content2 rounded-medium px-3 py-2">
                <p className="text-xs text-foreground-400">Par</p>
                <p className="font-mono tabular-nums text-foreground">{par || '—'}</p>
              </div>
              <div className="bg-content2 rounded-medium px-3 py-2">
                <p className="text-xs text-foreground-400">Max</p>
                <p className="font-mono tabular-nums text-foreground">{max ?? '—'}</p>
              </div>
            </div>
            <Input
              label="On shelf now"
              type="number"
              value={observed}
              onValueChange={setObserved}
              description="Count what's physically on the shelf first"
              autoFocus
            />
            <Input
              label="Units to bring from reserve"
              type="number"
              value={qty}
              onValueChange={setQty}
              description={`Pulls from reserve (${reserve} available)`}
              isInvalid={invalid && qtyNum > reserve}
              errorMessage={qtyNum > reserve ? 'Not enough reserve stock' : undefined}
            />
            <div className="flex items-center justify-between bg-primary-50 dark:bg-primary-900/20 rounded-medium px-3 py-2">
              <span className="text-xs font-semibold text-primary">Shelf total after this check</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-primary">{resultingShelf}</span>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button
            color="primary"
            isLoading={saving}
            isDisabled={invalid}
            onPress={async () => {
              setSaving(true);
              try {
                await onConfirm(target, qtyNum, observedNum);
                onOpenChange(false);
              } finally { setSaving(false); }
            }}
          >
            {qtyNum > 0 ? 'Refill' : 'Record count'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Weekly shelf sweep modal ────────────────────────────────────────────────────
// Guided re-anchor: walk below-par items on a shelf one at a time and capture
// an observed shelf count for each, instead of blind-refilling to par.

export interface SweepEntry {
  item: InventoryItem;
  observedShelfQty: number;
  qty: number;
}

function ShelfSweepModal({
  isOpen, onOpenChange, shelf, items, onSubmit,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  shelf: Shelf | null;
  items: InventoryItem[];
  onSubmit: (entries: SweepEntry[]) => Promise<void>;
}) {
  const [observedMap, setObservedMap] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const init: Record<string, string> = {};
      for (const it of items) init[it.id] = String(shelfUnits(it));
      setObservedMap(init);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, shelf]);

  if (!shelf) return null;

  const rows = items.map((item) => {
    const reserve = reserveUnits(item);
    const par = item.reorderThreshold;
    const max = item.maxUnits;
    const observed = Math.max(0, Number(observedMap[item.id] ?? 0) || 0);
    const suggested = Math.max(0, (max ?? par) - observed);
    const qty = Math.min(suggested, reserve);
    return { item, reserve, observed, qty };
  });

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>Weekly shelf check</span>
            <span className="text-xs font-normal text-foreground-400">
              {shelf.name} — count what&apos;s on the shelf for each item, then confirm
            </span>
          </div>
        </ModalHeader>
        <ModalBody>
          {items.length === 0 ? (
            <p className="text-sm text-foreground-400 text-center py-4">Nothing below par on this shelf.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map(({ item, reserve, observed, qty }) => (
                <div key={item.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 bg-content2 rounded-medium px-3 py-2">
                  <div className="flex-1 min-w-[55%] sm:min-w-0">
                    <p className="text-sm text-foreground truncate">{item.name}</p>
                    <p className="text-xs text-foreground-400 truncate">
                      Reserve {reserve} <span className="mx-1 text-foreground-300">·</span>
                      Will bring {qty} <span className="mx-1 text-foreground-300">·</span>
                      Shelf total {observed + qty}
                    </p>
                  </div>
                  <Input
                    aria-label={`On shelf now — ${item.name}`}
                    type="number"
                    size="sm"
                    className="w-full sm:w-28 flex-none"
                    value={observedMap[item.id] ?? ''}
                    onValueChange={(v) => setObservedMap((prev) => ({ ...prev, [item.id]: v }))}
                  />
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button
            color="primary"
            isLoading={saving}
            isDisabled={items.length === 0}
            onPress={async () => {
              setSaving(true);
              try {
                const entries: SweepEntry[] = rows.map(({ item, observed, qty }) => ({
                  item, observedShelfQty: observed, qty,
                }));
                await onSubmit(entries);
                onOpenChange(false);
              } finally { setSaving(false); }
            }}
          >
            Record checks &amp; refill
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Set stocking levels modal ───────────────────────────────────────────────────

function SetLevelsModal({
  isOpen, onOpenChange, item, onSave,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  item: InventoryItem | null;
  onSave: (item: InventoryItem, par: number, max: number | null) => Promise<void>;
}) {
  const [par, setPar] = useState('');
  const [max, setMax] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setPar(item?.reorderThreshold != null ? String(item.reorderThreshold) : '');
      setMax(item?.maxUnits != null ? String(item.maxUnits) : '');
    }
  }, [isOpen, item]);
  if (!item) return null;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" size="sm">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>Set stocking levels</span>
            <span className="text-xs font-normal text-foreground-400">{item.name}</span>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <Input
              label="Par level"
              type="number"
              value={par}
              onValueChange={setPar}
              autoFocus
            />
            <Input
              label="Max units"
              type="number"
              value={max}
              onValueChange={setMax}
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button
            color="primary"
            isLoading={saving}
            onPress={async () => {
              setSaving(true);
              try {
                const parNum = Number(par);
                const maxNum = max.trim() === '' ? null : Number(max);
                await onSave(item, parNum, maxNum);
                onOpenChange(false);
              } finally { setSaving(false); }
            }}
          >
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ── Exchange Bags (two-bin / kanban swap system) ────────────────────────────
// Pre-stocked multi-SKU bags: crews grab a FULL bag and drop the EMPTY;
// empties are refilled from back-room reserve (`refillBag`) and re-staged.

function ExchangeBagRow({
  bag, locationLabel, onRefill, onSwap, onEdit, onPrintLabel,
}: {
  bag: ExchangeBag;
  locationLabel?: string;
  onRefill: (bag: ExchangeBag) => void;
  onSwap: (bag: ExchangeBag) => void;
  onEdit: (bag: ExchangeBag) => void;
  onPrintLabel: (bag: ExchangeBag) => void;
}) {
  const contentsLabel = bag.lines.length > 0
    ? bag.lines.map((l) => `${l.qtyPerBag}× ${l.itemName}`).join(', ')
    : 'No contents defined';
  const belowPar = (bag.parBags ?? 0) > 0 && bag.fullCount < (bag.parBags ?? 0);

  return (
    <div className={`flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-2 rounded-medium transition-colors duration-150 ${
      belowPar ? 'bg-warning-50 dark:bg-warning-950/20' : 'hover:bg-content2'
    }`}>
      <Package size={14} className="text-foreground-400 flex-none" />
      <div className="flex-1 min-w-[55%] sm:min-w-0">
        <p className="text-sm text-foreground truncate">{bag.name}</p>
        <p className="text-xs text-foreground-400 truncate">{contentsLabel}</p>
        {locationLabel && (
          <p className="flex items-center gap-1 text-xs text-foreground-400 truncate mt-0.5">
            <MapPin size={10} className="flex-none" /> {locationLabel}
          </p>
        )}
      </div>
      <Chip size="sm" variant="flat" color="success" className="flex-none font-mono">Full {bag.fullCount}</Chip>
      <Chip size="sm" variant="flat" color="warning" className="flex-none font-mono">Empty {bag.emptyCount}</Chip>
      {bag.parBags != null && (
        <Chip size="sm" variant="flat" color="default" className="flex-none font-mono">Par {bag.parBags}</Chip>
      )}
      <Button isIconOnly size="sm" variant="light" className="flex-none" aria-label="Print bag label" onPress={() => onPrintLabel(bag)}>
        <Printer size={13} />
      </Button>
      <Button isIconOnly size="sm" variant="light" className="flex-none" aria-label="Edit bag" onPress={() => onEdit(bag)}>
        <Edit2 size={13} />
      </Button>
      <Button
        size="sm"
        variant="flat"
        color="primary"
        className="flex-none"
        startContent={<Repeat size={13} />}
        isDisabled={bag.fullCount <= 0}
        onPress={() => onSwap(bag)}
      >
        Swap
      </Button>
      <Button
        size="sm"
        variant={bag.emptyCount > 0 ? 'flat' : 'light'}
        color={bag.emptyCount > 0 ? 'warning' : 'default'}
        className="flex-none"
        startContent={<PackageCheck size={13} />}
        isDisabled={bag.emptyCount <= 0}
        onPress={() => onRefill(bag)}
      >
        Refill
      </Button>
    </div>
  );
}

function ExchangeBagsSection({
  bags, getShelfById, getZoneById, onRefill, onSwap, onEdit, onNew, onPrintLabel, onScan,
}: {
  bags: ExchangeBag[];
  getShelfById: (shelfId: string) => Shelf | undefined;
  getZoneById: (zoneId: string) => StorageZone | undefined;
  onRefill: (bag: ExchangeBag) => void;
  onSwap: (bag: ExchangeBag) => void;
  onEdit: (bag: ExchangeBag) => void;
  onNew: () => void;
  onPrintLabel: (bag: ExchangeBag) => void;
  onScan: () => void;
}) {
  // Group bags by their assigned shelf so they render alongside the items on
  // that shelf's category group. Bags with no `storageLocation` fall into an
  // "Unassigned" bucket rather than being silently dropped.
  const { shelfGroups, unassigned } = useMemo(() => {
    const map = new Map<string, ExchangeBag[]>();
    const loose: ExchangeBag[] = [];
    for (const bag of bags) {
      const shelfId = bag.storageLocation?.shelfId;
      if (!shelfId) { loose.push(bag); continue; }
      const arr = map.get(shelfId) || [];
      arr.push(bag);
      map.set(shelfId, arr);
    }
    return { shelfGroups: map, unassigned: loose };
  }, [bags]);

  return (
    <Card className="mb-6">
      <CardBody className="gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Repeat size={16} className="text-primary" />
            <h2 className="text-base font-semibold text-foreground">Exchange Bags</h2>
            <span className="text-xs text-foreground-400">Grab full, drop empty — refill from reserve</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="flat" startContent={<ScanBarcode size={14} />} onPress={onScan}>
              Scan to refill
            </Button>
            <Button size="sm" color="primary" variant="flat" startContent={<Plus size={14} />} onPress={onNew}>
              New Exchange Bag
            </Button>
          </div>
        </div>
        {bags.length === 0 ? (
          <p className="text-sm text-foreground-400">No exchange bags yet. Create one to start the two-bin swap system.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {Array.from(shelfGroups.entries()).map(([shelfId, shelfBags]) => {
              const shelf = getShelfById(shelfId);
              const zone = shelf?.zoneId ? getZoneById(shelf.zoneId) : undefined;
              const zoneLabel = zone ? [zone.locationType, zone.room, zone.name].filter(Boolean).join(' › ') : null;
              return (
                <div key={shelfId} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                    <Layers size={12} />
                    {shelf?.name ?? 'Unknown shelf'}
                    {zoneLabel && <span className="normal-case font-medium">{zoneLabel}</span>}
                  </div>
                  {shelfBags.map((bag) => (
                    <ExchangeBagRow
                      key={bag.id}
                      bag={bag}
                      locationLabel={[zone?.name, shelf?.name].filter(Boolean).join(' › ') || undefined}
                      onRefill={onRefill}
                      onSwap={onSwap}
                      onEdit={onEdit}
                      onPrintLabel={onPrintLabel}
                    />
                  ))}
                </div>
              );
            })}
            {unassigned.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Unassigned</div>
                {unassigned.map((bag) => (
                  <ExchangeBagRow
                    key={bag.id}
                    bag={bag}
                    onRefill={onRefill}
                    onSwap={onSwap}
                    onEdit={onEdit}
                    onPrintLabel={onPrintLabel}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RestockPage() {
  const router = useRouter();
  const { loading: authLoading, role, userData, user } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const storageLocationsData = useStorageLocations();
  const { zones, getShelvesForZone, getContainersForShelf, getShelfById, getZoneById, loading: locLoading } = storageLocationsData;

  const [categories, setCategories] = useState<RestockCategory[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [catsLoading, setCatsLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [opLoading, setOpLoading] = useState(false);
  const [exchangeBags, setExchangeBags] = useState<ExchangeBag[]>([]);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [legacyNoticeDismissed, setLegacyNoticeDismissed] = useState(true);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setLegacyNoticeDismissed(localStorage.getItem(LEGACY_NOTICE_KEY) === '1');
    }
  }, []);

  useEffect(() => {
    const unsubCats = onSnapshot(
      query(collection(db, 'restock_categories'), orderBy('name')),
      (snap) => {
        setCategories(snap.docs.map((d) => hydrateCategory(d.id, d.data())));
        setCatsLoading(false);
      },
      (e) => { console.error('[restock] categories listener', e); setCatsLoading(false); }
    );
    const unsubItems = onSnapshot(
      collection(db, 'inventory'),
      (snap) => {
        setItems(snap.docs.map((d) => hydrateItem({ id: d.id, ...d.data() })));
        setItemsLoading(false);
      },
      (e) => { console.error('[restock] inventory listener', e); setItemsLoading(false); }
    );
    const unsubBags = subscribeExchangeBags(setExchangeBags);
    return () => { unsubCats(); unsubItems(); unsubBags(); };
  }, []);

  const loading = authLoading || locLoading || catsLoading || itemsLoading;

  const itemsForContainer = (containerId: string) =>
    items.filter((it) => it.storageLocation?.containerId === containerId);
  const itemsDirectOnShelf = (shelfId: string) =>
    items.filter((it) => it.storageLocation?.shelfId === shelfId && !it.storageLocation?.containerId);

  const itemsById = useMemo(() => {
    const map: Record<string, InventoryItem> = {};
    for (const it of items) map[it.id] = it;
    return map;
  }, [items]);

  // ── Toast ───────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const actorName = userData?.fullName || 'Unknown';

  // ── Category CRUD ────────────────────────────────────────────────────────────
  const createCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    setOpLoading(true);
    try {
      await addDoc(collection(db, 'restock_categories'), {
        name, shelfIds: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      setNewCategoryName('');
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: 'Failed to create category' });
    }
    setOpLoading(false);
  };

  const renameCategory = async (id: string, name: string) => {
    try {
      await updateDoc(doc(db, 'restock_categories', id), { name, updatedAt: serverTimestamp() });
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: 'Failed to rename category' });
    }
  };

  const deleteCategory = async (cat: RestockCategory) => {
    if (!confirm(`Delete category "${cat.name}"? This does not affect the shelves or items themselves.`)) return;
    try {
      await deleteDoc(doc(db, 'restock_categories', cat.id));
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: 'Failed to delete category' });
    }
  };

  const toggleShelf = async (cat: RestockCategory, shelfId: string) => {
    try {
      const has = cat.shelfIds.includes(shelfId);
      await updateDoc(doc(db, 'restock_categories', cat.id), {
        shelfIds: has ? arrayRemove(shelfId) : arrayUnion(shelfId),
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: 'Failed to update shelves' });
    }
  };

  // ── Refill (reserve → shelf) — actually decrements inventory; see
  // app/lib/restock-actions.ts / app/lib/stock-pools.ts for the two-pool model ──
  const doRefillItem = async (target: RefillTarget, qty: number, observedShelfQty: number) => {
    setOpLoading(true);
    try {
      const { consumed } = await refillShelf({
        item: target.item,
        qty,
        categoryId: target.cat.id,
        shelfId: target.shelf.id,
        actor: { id: user?.uid, name: actorName },
        observedShelfQty,
      });
      setToast({ ok: true, msg: consumed > 0 ? `Refilled ${consumed} to shelf` : 'Shelf count recorded' });
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to refill shelf' });
    }
    setOpLoading(false);
  };

  // Guided weekly sweep: entries already carry the count the member observed
  // on the shelf (captured in ShelfSweepModal) — each write re-anchors that
  // item's `shelfQuantity` rather than blind-refilling to par.
  const submitShelfSweep = async (cat: RestockCategory, shelf: Shelf, entries: SweepEntry[]) => {
    if (entries.length === 0) return;
    setOpLoading(true);
    let checkedCount = 0;
    let refilledCount = 0;
    let skippedCount = 0;
    for (const { item, observedShelfQty, qty } of entries) {
      try {
        const { consumed } = await refillShelf({
          item,
          qty,
          categoryId: cat.id,
          shelfId: shelf.id,
          actor: { id: user?.uid, name: actorName },
          observedShelfQty,
        });
        checkedCount++;
        if (consumed > 0) refilledCount++;
      } catch (e) {
        // Best-effort: a genuinely failed write (e.g. no reserve stock left
        // for an actual transfer) is skipped, not fatal — the next sweep or
        // admin audit will catch it up.
        console.error(e);
        skippedCount++;
      }
    }
    setToast({
      ok: checkedCount > 0,
      msg: checkedCount === 0
        ? `Could not record checks on ${shelf.name}`
        : `Checked ${checkedCount} item${checkedCount === 1 ? '' : 's'} on ${shelf.name}, refilled ${refilledCount}${skippedCount ? ` (${skippedCount} skipped)` : ''}`,
    });
    setOpLoading(false);
  };

  // ── Shelf picker + rename modal state ───────────────────────────────────────
  const shelfPickerDisc = useDisclosure();
  const [pickerCategory, setPickerCategory] = useState<RestockCategory | null>(null);
  const openShelfPicker = (cat: RestockCategory) => { setPickerCategory(cat); shelfPickerDisc.onOpen(); };
  // keep the modal's category in sync with live snapshot updates while open
  useEffect(() => {
    if (!pickerCategory) return;
    const fresh = categories.find((c) => c.id === pickerCategory.id);
    if (fresh) setPickerCategory(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  const renameDisc = useDisclosure();
  const [renameCategoryTarget, setRenameCategoryTarget] = useState<RestockCategory | null>(null);
  const openRename = (cat: RestockCategory) => { setRenameCategoryTarget(cat); renameDisc.onOpen(); };

  // ── Refill (reserve → shelf) modal state ────────────────────────────────────
  const refillDisc = useDisclosure();
  const [refillTarget, setRefillTarget] = useState<RefillTarget | null>(null);
  const openRefill = (cat: RestockCategory, shelf: Shelf, item: InventoryItem) => {
    setRefillTarget({ cat, shelf, item });
    refillDisc.onOpen();
  };
  // keep the modal's item in sync with live snapshot updates while open
  useEffect(() => {
    if (!refillTarget) return;
    const fresh = items.find((it) => it.id === refillTarget.item.id);
    if (fresh) setRefillTarget((prev) => (prev ? { ...prev, item: fresh } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ── Weekly shelf sweep modal state ──────────────────────────────────────────
  const sweepDisc = useDisclosure();
  const [sweepTarget, setSweepTarget] = useState<{ cat: RestockCategory; shelf: Shelf; items: InventoryItem[] } | null>(null);
  const openSweep = (cat: RestockCategory, shelf: Shelf, belowParItems: InventoryItem[]) => {
    setSweepTarget({ cat, shelf, items: belowParItems });
    sweepDisc.onOpen();
  };

  // ── Stocking levels (par / max) modal state ─────────────────────────────────
  const levelsDisc = useDisclosure();
  const [levelsTarget, setLevelsTarget] = useState<InventoryItem | null>(null);
  const openLevels = (item: InventoryItem) => { setLevelsTarget(item); levelsDisc.onOpen(); };
  const saveLevels = async (item: InventoryItem, par: number, max: number | null) => {
    try {
      await updateDoc(doc(db, 'inventory', item.id), {
        reorderThreshold: Number.isFinite(par) ? par : 0,
        ...(max != null ? { maxUnits: max } : {}),
      });
      setToast({ ok: true, msg: `Updated levels for ${item.name}` });
    } catch (e) { console.error(e); setToast({ ok: false, msg: 'Failed to update levels' }); }
  };

  // ── Exchange Bags (two-bin swap system) ─────────────────────────────────────
  const exchangeBagEditorDisc = useDisclosure();
  const [exchangeBagTarget, setExchangeBagTarget] = useState<ExchangeBag | null>(null);
  const openNewExchangeBag = () => { setExchangeBagTarget(null); exchangeBagEditorDisc.onOpen(); };
  const openEditExchangeBag = (bag: ExchangeBag) => { setExchangeBagTarget(bag); exchangeBagEditorDisc.onOpen(); };

  const doRefillBag = async (bag: ExchangeBag) => {
    setOpLoading(true);
    try {
      await refillBag(bag, itemsById, { id: user?.uid, name: actorName });
      setToast({ ok: true, msg: `Refilled ${bag.name}` });
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to refill bag' });
    }
    setOpLoading(false);
  };

  const doSwapBag = async (bag: ExchangeBag) => {
    setOpLoading(true);
    try {
      await swapBag(bag, { id: user?.uid, name: actorName });
      setToast({ ok: true, msg: `Swapped ${bag.name}` });
    } catch (e) {
      console.error(e);
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to swap bag' });
    }
    setOpLoading(false);
  };

  // Queue a single bag for the print-labels flow — same handoff mechanism
  // (localStorage `printAssetIds` + navigate) used by /assets.
  const printBagLabel = (bag: ExchangeBag) => {
    localStorage.setItem('printAssetIds', JSON.stringify([bag.id]));
    router.push('/print-labels');
  };

  // ── Scan-to-refill: scanning a bag's type-level QR (`BAG:<id>`) triggers the
  // same refill action as tapping "Refill" on that row.
  const [bagScannerOpen, setBagScannerOpen] = useState(false);
  const handleBagScanned = (code: string) => {
    const bagId = parseBagQr(code);
    if (!bagId) {
      setToast({ ok: false, msg: 'Not a recognized exchange bag code' });
      return;
    }
    const bag = exchangeBags.find((b) => b.id === bagId);
    if (!bag) {
      setToast({ ok: false, msg: 'No exchange bag matches that code' });
      return;
    }
    doRefillBag(bag);
  };

  const toggleExpanded = (id: string) => setExpandedIds((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const dismissLegacyNotice = () => {
    setLegacyNoticeDismissed(true);
    if (typeof window !== 'undefined') localStorage.setItem(LEGACY_NOTICE_KEY, '1');
  };

  // ── Header stats ─────────────────────────────────────────────────────────────
  const totalShelvesTracked = useMemo(
    () => new Set(categories.flatMap((c) => c.shelfIds)).size,
    [categories]
  );
  const totalBelowPar = useMemo(() => {
    let n = 0;
    for (const cat of categories) {
      for (const shelfId of cat.shelfIds) {
        n += itemsDirectOnShelf(shelfId).filter(isBelowPar).length;
        for (const c of getContainersForShelf(shelfId)) {
          n += itemsForContainer(c.id).filter(isBelowPar).length;
        }
      }
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, items]);

  // ── Auth gate ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading) return;
    if (!userData) return;
  }, [authLoading, userData]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-foreground-500">You do not have permission to view the Restock area.</p>
              <div className="mt-4">
                <Button onPress={() => router.push('/dashboard')}>Back to Dashboard</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5 flex items-center gap-2">
              <RefreshCw className="text-primary" size={22} /> Restock
            </h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span><span className="font-semibold text-foreground tabular-nums">{categories.length}</span> categories</span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span><span className="font-semibold text-foreground tabular-nums">{totalShelvesTracked}</span> shelves tracked</span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span><span className="font-semibold text-warning tabular-nums">{totalBelowPar}</span> below par</span>
            </div>
          </div>
        </div>

        {!legacyNoticeDismissed && (
          <div className="flex items-start gap-2.5 bg-primary-50 dark:bg-primary-900/20 border border-primary/20 rounded-large px-4 py-3 mb-4">
            <Info size={16} className="text-primary flex-none mt-0.5" />
            <p className="text-sm text-foreground-600 flex-1">
              Restock now works off your storage shelves. Old restock shelves are no longer shown here — recreate them as categories.
            </p>
            <button onClick={dismissLegacyNotice} className="text-foreground-400 hover:text-foreground-600 flex-none" aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        )}

        <div className="bg-content1 border border-divider rounded-large p-4 mb-6 flex flex-col sm:flex-row gap-3">
          <Input
            placeholder="New category name (e.g. Trauma Bag Restock)"
            value={newCategoryName}
            onValueChange={setNewCategoryName}
            className="flex-1"
            onKeyDown={(e) => { if (e.key === 'Enter') createCategory(); }}
          />
          <Button
            color="primary"
            startContent={<Plus size={15} />}
            isLoading={opLoading}
            isDisabled={!newCategoryName.trim()}
            onPress={createCategory}
            className="flex-none"
          >
            Create category
          </Button>
        </div>

        <ExchangeBagsSection
          bags={exchangeBags}
          getShelfById={getShelfById}
          getZoneById={getZoneById}
          onRefill={doRefillBag}
          onSwap={doSwapBag}
          onEdit={openEditExchangeBag}
          onNew={openNewExchangeBag}
          onPrintLabel={printBagLabel}
          onScan={() => setBagScannerOpen(true)}
        />

        {loading ? (
          <div className="flex justify-center py-12"><Spinner size="lg" color="primary" /></div>
        ) : categories.length === 0 ? (
          <div className="bg-content1 border border-divider rounded-large p-8 text-center">
            <p className="text-sm text-foreground-500">No restock categories yet. Create one above, then select which shelves belong to it.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {categories.map((cat) => {
              const validShelves = cat.shelfIds.map((id) => getShelfById(id)).filter((s): s is Shelf => !!s);
              const danglingCount = cat.shelfIds.length - validShelves.length;
              const isOpen = expandedIds.has(cat.id);
              return (
                <div key={cat.id} className="bg-content1 border border-divider rounded-large">
                  <div
                    role="button"
                    tabIndex={0}
                    className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-content2 transition-colors duration-150 rounded-large"
                    onClick={() => toggleExpanded(cat.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(cat.id); } }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isOpen ? <ChevronDown size={16} className="text-foreground-400 flex-none" /> : <ChevronRight size={16} className="text-foreground-400 flex-none" />}
                      <span className="text-base font-semibold text-foreground truncate">{cat.name}</span>
                      <span className="text-xs font-mono tabular-nums text-foreground-400 px-2 py-0.5 rounded-full bg-content2 flex-none">
                        {validShelves.length} shelf{validShelves.length === 1 ? '' : 'ves'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-none" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="flat" color="primary" onPress={() => openShelfPicker(cat)}>Select shelves</Button>
                      <Button isIconOnly size="sm" variant="light" onPress={() => openRename(cat)} aria-label="Rename category"><Edit2 size={15} /></Button>
                      <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => deleteCategory(cat)} aria-label="Delete category"><Trash2 size={15} /></Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="px-4 pb-4 flex flex-col gap-3">
                      {danglingCount > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-warning">
                          <AlertTriangle size={12} /> {danglingCount} shelf{danglingCount === 1 ? '' : 'es'} referenced here {danglingCount === 1 ? 'was' : 'were'} deleted from Storage Management.
                        </div>
                      )}
                      {validShelves.length === 0 ? (
                        <p className="text-sm text-foreground-400">No shelves selected yet. Click &quot;Select shelves&quot; to add some.</p>
                      ) : (
                        validShelves.map((shelf) => (
                          <ShelfGroup
                            key={shelf.id}
                            shelf={shelf}
                            zone={shelf.zoneId ? getZoneById(shelf.zoneId) : undefined}
                            containers={getContainersForShelf(shelf.id)}
                            directItems={itemsDirectOnShelf(shelf.id)}
                            itemsForContainer={itemsForContainer}
                            restocks={cat.itemRestocks || {}}
                            onRefillItem={(shelf, item) => openRefill(cat, shelf, item)}
                            onMarkAllBelowPar={(shelf, itemsBelowPar) => openSweep(cat, shelf, itemsBelowPar)}
                            onEditLevels={openLevels}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      <ShelfPickerModal
        isOpen={shelfPickerDisc.isOpen}
        onOpenChange={shelfPickerDisc.onOpenChange}
        category={pickerCategory}
        zones={zones}
        getShelvesForZone={getShelvesForZone}
        onToggleShelf={toggleShelf}
      />

      <RenameCategoryModal
        isOpen={renameDisc.isOpen}
        onOpenChange={renameDisc.onOpenChange}
        category={renameCategoryTarget}
        onSave={renameCategory}
      />

      <SetLevelsModal
        isOpen={levelsDisc.isOpen}
        onOpenChange={levelsDisc.onOpenChange}
        item={levelsTarget}
        onSave={saveLevels}
      />

      <RefillModal
        isOpen={refillDisc.isOpen}
        onOpenChange={refillDisc.onOpenChange}
        target={refillTarget}
        onConfirm={doRefillItem}
      />

      <ShelfSweepModal
        isOpen={sweepDisc.isOpen}
        onOpenChange={sweepDisc.onOpenChange}
        shelf={sweepTarget?.shelf ?? null}
        items={sweepTarget?.items ?? []}
        onSubmit={(entries) => {
          if (!sweepTarget) return Promise.resolve();
          return submitShelfSweep(sweepTarget.cat, sweepTarget.shelf, entries);
        }}
      />

      <ExchangeBagEditor
        isOpen={exchangeBagEditorDisc.isOpen}
        onOpenChange={exchangeBagEditorDisc.onOpenChange}
        bag={exchangeBagTarget}
        items={items}
        categories={categories}
        actor={{ id: user?.uid, name: actorName }}
        storageData={storageLocationsData}
      />

      <BarcodeScanner
        isOpen={bagScannerOpen}
        onClose={() => setBagScannerOpen(false)}
        onDetected={handleBagScanned}
      />

      {opLoading && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}

      {toast && (
        <div className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
