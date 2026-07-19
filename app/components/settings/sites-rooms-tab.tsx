'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Input, Select, SelectItem, Button, useDisclosure, Modal, ModalContent, ModalHeader,
  ModalBody, ModalFooter, Checkbox,
} from '@heroui/react';
import {
  Plus, Trash2, Info, ChevronRight, ChevronDown, Warehouse, Package,
  Boxes, Edit2, Layers, AlertTriangle, Clock, Download, Search, X, MapPin,
  PackageMinus, Printer,
} from 'lucide-react';
import {
  collection, onSnapshot, query, orderBy, doc, deleteDoc, getDocs, where,
  writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { LocationDef } from '@/app/config/org-config';
import type { StorageZone, Shelf, Container, InventoryItem, StorageLocationRef } from '@/app/types';
import {
  computeStorageRollups, aggregateRollups, shelfFill, emptyRollup,
  type LocationRollup,
} from '@/app/lib/storage-analytics';
import { computeBagStock, getItemStatus, displayLocation, statusBarColor } from '@/app/lib/item-status';
import { moveItemsBulk, moveItemLocation, type AuditActor } from '@/app/lib/audit-actions';
import { useUserRole } from '@/app/hooks/useUserRole';
import { exportLabelsToPDF, DEFAULT_TEMPLATE } from '@/app/lib/print';
import ZoneEditor from '@/app/components/zone-editor';
import ShelfEditor from '@/app/components/shelf-editor';
import ContainerEditor from '@/app/components/container-editor';
import StorageLocationPicker from '@/app/components/storage-location-picker';
import { newId } from './settings-utils';

const LOCATION_TYPES: { key: LocationDef['type']; label: string }[] = [
  { key: 'headquarters', label: 'Headquarters' },
  { key: 'satellite', label: 'Satellite site' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'event', label: 'Event' },
  { key: 'other', label: 'Other' },
];

interface Props {
  locations: LocationDef[];
  onChange: (locations: LocationDef[]) => void;
}

// Firestore returns Timestamp objects, not JS Dates. The status/analytics
// helpers (getItemStatus, computeBagStock) and the rollup date math all expect
// real Dates — passing a raw Timestamp makes expiry comparisons silently wrong
// AND crashes fmtDate() (Timestamp has no toLocaleDateString). So convert the
// date fields these paths touch when hydrating each item off the snapshot.
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
  return { ...raw, batches, lastAuditDate: toDateVal(raw.lastAuditDate) } as unknown as InventoryItem;
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  const dd = d instanceof Date ? d : toDateVal(d);
  if (!dd || isNaN(dd.getTime())) return '—';
  return dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Small presentational helpers ─────────────────────────────────────────────
function RollupChips({ r }: { r: LocationRollup }) {
  if (r.itemCount === 0) {
    return <span className="text-[11px] text-foreground-400 font-medium">empty</span>;
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] font-mono tabular-nums text-foreground-500">{r.itemCount} items</span>
      {r.low > 0 && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-warning-50 dark:bg-warning-900/20 text-warning">{r.low} low</span>}
      {r.out > 0 && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-danger-50 dark:bg-danger-900/20 text-danger">{r.out} out</span>}
      {r.expiring > 0 && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-warning-50 dark:bg-warning-900/20 text-warning">{r.expiring} exp soon</span>}
      {r.expired > 0 && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md bg-danger-50 dark:bg-danger-900/20 text-danger">{r.expired} expired</span>}
    </div>
  );
}

function DetailPanel({ r }: { r: LocationRollup }) {
  return (
    <div className="mt-2 bg-content1 border border-divider rounded-large p-3 flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
          <AlertTriangle size={11} /> Restock here
        </div>
        {r.restockItems.length === 0 ? (
          <p className="text-xs text-foreground-400">Nothing below par here.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {r.restockItems.slice(0, 12).map((it) => (
              <div key={it.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-foreground truncate">{it.name}</span>
                <span className={`font-mono tabular-nums flex-none ${it.available === 0 ? 'text-danger' : 'text-warning'}`}>
                  {it.available} / {it.par || '—'}
                </span>
              </div>
            ))}
            {r.restockItems.length > 12 && (
              <p className="text-[11px] text-foreground-400 mt-0.5">+{r.restockItems.length - 12} more…</p>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-foreground-400 border-t border-divider pt-2">
        <Clock size={11} />
        <span>Oldest audit here: <span className="font-medium text-foreground-500">{fmtDate(r.oldestAudit)}</span></span>
        {r.neverAuditedCount > 0 && <span>· {r.neverAuditedCount} never audited</span>}
      </div>
    </div>
  );
}

/** Compact list of the actual items pinned to a shelf/box node, with a "move out" affordance. */
function ItemsList({
  label, items, onRemove, removeLabel,
}: {
  label?: string;
  items: InventoryItem[];
  onRemove: (item: InventoryItem) => void;
  removeLabel: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 bg-content1 border border-divider rounded-large p-2 flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
      {label && (
        <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 px-1.5 pb-1">{label}</p>
      )}
      {items.map((it) => {
        const status = getItemStatus(it);
        const available = computeBagStock(it).availableItems;
        return (
          <div key={it.id} className="flex items-center gap-2 px-1.5 py-1.5 rounded-medium hover:bg-content2 transition-colors duration-150">
            <span className={`w-2 h-2 rounded-full flex-none ${statusBarColor(status)}`} />
            <span className="text-[13px] text-foreground truncate flex-1 min-w-0">{it.name}</span>
            <span className="font-mono text-xs tabular-nums text-foreground-500 flex-none">{available}</span>
            <Button
              isIconOnly size="sm" variant="light" className="flex-none w-7 h-7 min-w-0"
              onPress={() => onRemove(it)} aria-label={removeLabel}
            >
              <PackageMinus size={13} className="text-foreground-400" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Destination context passed to the Add Items modal — describes the exact node being assigned into. */
interface AssignDest {
  zoneId: string;
  zoneName: string;
  shelfId?: string;
  shelfName?: string;
  containerId?: string;
  containerName?: string;
  label: string;
}

/** Modal: search hydrated inventory items and bulk-assign the selection into a zone/shelf/box via moveItemsBulk. */
function AssignItemsModal({
  isOpen, onOpenChange, dest, items, actor, onResult,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  dest: AssignDest | null;
  items: InventoryItem[];
  actor: AuditActor | null;
  onResult: (msg: string, ok: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) { setSearch(''); setSelected(new Set()); }
  }, [isOpen, dest?.containerId, dest?.shelfId, dest?.zoneId]);

  if (!dest) return null;

  const alreadyHereIds = new Set(
    items
      .filter((it) => {
        const loc = it.storageLocation;
        if (!loc) return false;
        if (dest.containerId) return loc.containerId === dest.containerId;
        if (dest.shelfId) return loc.shelfId === dest.shelfId && !loc.containerId;
        return loc.zoneId === dest.zoneId && !loc.shelfId;
      })
      .map((it) => it.id)
  );

  const q = search.trim().toLowerCase();
  const candidates = items.filter((it) => {
    if (alreadyHereIds.has(it.id)) return false;
    if (!q) return true;
    return it.name.toLowerCase().includes(q) || (it.category || '').toLowerCase().includes(q);
  }).slice(0, 200);

  const toggleSel = (id: string) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const handleConfirm = async () => {
    if (!actor || selected.size === 0) return;
    setSaving(true);
    try {
      const chosen = items.filter((it) => selected.has(it.id));
      const storageLocation: StorageLocationRef = {
        zoneId: dest.zoneId,
        zoneName: dest.zoneName,
        shelfId: dest.shelfId,
        shelfName: dest.shelfName,
        containerId: dest.containerId,
        containerName: dest.containerName,
      };
      await moveItemsBulk(chosen, { storageLocation }, actor, `Assigned into ${dest.label}`);
      onResult(`${chosen.length} item${chosen.length === 1 ? '' : 's'} moved into ${dest.label}`, true);
      onOpenChange(false);
    } catch (e) {
      onResult(e instanceof Error ? e.message : 'Failed to assign items', false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          <div className="flex flex-col">
            <span>Add items</span>
            <span className="text-xs font-normal text-foreground-400">{dest.label}</span>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="flex items-center gap-3 bg-content2 rounded-large px-3 py-1 mb-3">
            <Search size={15} className="text-foreground-400 flex-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search items by name or category…"
              className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
              autoFocus
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-foreground-400 hover:text-foreground-600" aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>
          <div className="flex flex-col divide-y divide-divider max-h-[360px] overflow-y-auto border border-divider rounded-large">
            {candidates.length === 0 ? (
              <p className="text-sm text-foreground-400 text-center py-6">No matching items.</p>
            ) : candidates.map((it) => {
              const status = getItemStatus(it);
              const available = computeBagStock(it).availableItems;
              const isSel = selected.has(it.id);
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => toggleSel(it.id)}
                  className={`flex items-center gap-3 px-3 py-2 text-left transition-colors duration-150 ${isSel ? 'bg-primary-50 dark:bg-primary-900/20' : 'hover:bg-content2'}`}
                >
                  <Checkbox size="sm" isSelected={isSel} onValueChange={() => toggleSel(it.id)} aria-label={`Select ${it.name}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{it.name}</p>
                    <p className="text-xs text-foreground-400 truncate">
                      {it.category}{it.storageLocation ? ` · currently ${displayLocation(it)}` : ' · unassigned'}
                    </p>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-foreground-500 flex-none">{available}</span>
                  <span className={`w-2 h-2 rounded-full flex-none ${statusBarColor(status)}`} />
                </button>
              );
            })}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={() => onOpenChange(false)}>Cancel</Button>
          <Button color="primary" isLoading={saving} isDisabled={selected.size === 0} onPress={handleConfirm}>
            Add {selected.size > 0 ? selected.size : ''} item{selected.size === 1 ? '' : 's'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function SitesRoomsTab({ locations, onChange }: Props) {
  const { user, userData } = useUserRole();
  const actor: AuditActor | null = useMemo(() => {
    if (!user) return null;
    return {
      uid: user.uid,
      name: userData?.fullName || user.displayName || user.email || 'Unknown',
      email: user.email,
    };
  }, [user, userData]);

  // ── Live storage docs + inventory (for analytics) ──────────────────────────
  const [zones, setZones] = useState<StorageZone[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);

  useEffect(() => {
    const subs = [
      onSnapshot(query(collection(db, 'storage_zones'), orderBy('name')),
        (s) => setZones(s.docs.map((d) => ({ id: d.id, ...d.data() } as StorageZone))),
        (e) => console.error('zones listener', e)),
      onSnapshot(query(collection(db, 'shelves'), orderBy('name')),
        (s) => setShelves(s.docs.map((d) => ({ id: d.id, ...d.data() } as Shelf))),
        (e) => console.error('shelves listener', e)),
      onSnapshot(query(collection(db, 'containers'), orderBy('name')),
        (s) => setContainers(s.docs.map((d) => ({ id: d.id, ...d.data() } as Container))),
        (e) => console.error('containers listener', e)),
      onSnapshot(collection(db, 'inventory'),
        (s) => setItems(s.docs.map((d) => hydrateItem({ id: d.id, ...d.data() }))),
        (e) => console.error('inventory listener', e)),
    ];
    return () => subs.forEach((u) => { try { u(); } catch { /* noop */ } });
  }, []);

  const rollups = useMemo(() => computeStorageRollups(items), [items]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  // ── Result toast (assign / move-out / print outcomes) ──────────────────────
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Node refs (for "scroll to" from the item finder) ────────────────────────
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerNodeRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(key, el); else nodeRefs.current.delete(key);
  };

  // ── Editor disclosures ─────────────────────────────────────────────────────
  const zoneDisc = useDisclosure();
  const shelfDisc = useDisclosure();
  const containerDisc = useDisclosure();
  const [editingZone, setEditingZone] = useState<StorageZone | null>(null);
  const [zonePrefill, setZonePrefill] = useState<{ locationType?: string; room?: string } | undefined>(undefined);
  const [editingShelf, setEditingShelf] = useState<Shelf | null>(null);
  const [shelfDefaultZone, setShelfDefaultZone] = useState<string | undefined>(undefined);
  const [editingContainer, setEditingContainer] = useState<Container | null>(null);
  const [containerDefaultShelf, setContainerDefaultShelf] = useState<string | undefined>(undefined);

  const openAddZone = (locationType?: string, room?: string) => {
    setEditingZone(null); setZonePrefill({ locationType, room }); zoneDisc.onOpen();
  };
  const openEditZone = (z: StorageZone) => { setEditingZone(z); setZonePrefill(undefined); zoneDisc.onOpen(); };
  const openAddShelf = (zoneId: string) => { setEditingShelf(null); setShelfDefaultZone(zoneId); shelfDisc.onOpen(); };
  const openEditShelf = (s: Shelf) => { setEditingShelf(s); setShelfDefaultZone(undefined); shelfDisc.onOpen(); };
  const openAddContainer = (shelfId: string) => { setEditingContainer(null); setContainerDefaultShelf(shelfId); containerDisc.onOpen(); };
  const openEditContainer = (c: Container) => { setEditingContainer(c); setContainerDefaultShelf(undefined); containerDisc.onOpen(); };

  // ── Assign-items-into-node modal (Task 3b) ──────────────────────────────────
  const assignDisc = useDisclosure();
  const [assignDest, setAssignDest] = useState<AssignDest | null>(null);
  const openAssign = (dest: AssignDest) => { setAssignDest(dest); assignDisc.onOpen(); };

  // ── Assign-a-single-item modal (finder "Assign" shortcut for unassigned items) ─
  const assignItemDisc = useDisclosure();
  const [assignItemTarget, setAssignItemTarget] = useState<InventoryItem | null>(null);
  const [assignItemLoc, setAssignItemLoc] = useState<StorageLocationRef | undefined>(undefined);
  const openAssignForItem = (item: InventoryItem) => {
    setAssignItemTarget(item);
    setAssignItemLoc(item.storageLocation);
    assignItemDisc.onOpen();
  };
  const handleAssignItemConfirm = async () => {
    if (!assignItemTarget || !actor) return;
    try {
      await moveItemLocation(assignItemTarget, { storageLocation: assignItemLoc ?? null }, actor);
      setToast({ ok: true, msg: `${assignItemTarget.name} assigned` });
      assignItemDisc.onClose();
    } catch (e) {
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to assign item' });
    }
  };

  // ── Move out / remove-from-node affordance ──────────────────────────────────
  const moveOutOfContainer = async (item: InventoryItem, shelf: Shelf, zone: StorageZone) => {
    if (!actor) return;
    try {
      await moveItemLocation(item, {
        storageLocation: { zoneId: zone.id, zoneName: zone.name, shelfId: shelf.id, shelfName: shelf.name },
      }, actor, 'Moved out of box');
      setToast({ ok: true, msg: `${item.name} moved onto ${shelf.name}` });
    } catch (e) {
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to move item' });
    }
  };
  const unassignFromShelf = async (item: InventoryItem) => {
    if (!actor) return;
    try {
      await moveItemLocation(item, { storageLocation: null }, actor, 'Removed from shelf');
      setToast({ ok: true, msg: `${item.name} unassigned` });
    } catch (e) {
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Failed to remove item' });
    }
  };

  // ── Print label (Task 3d) — hidden off-screen label rendered to PDF ────────
  const printRef = useRef<HTMLDivElement | null>(null);
  const [printTarget, setPrintTarget] = useState<{ kind: string; name: string; code: string; url: string } | null>(null);
  const openPrintLabel = (kind: string, name: string, code: string, path: string) => {
    const url = typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;
    setPrintTarget({ kind, name, code, url });
  };
  useEffect(() => {
    if (!printTarget) return;
    let cancelled = false;
    (async () => {
      await new Promise((r) => requestAnimationFrame(r));
      if (cancelled || !printRef.current) return;
      try {
        const safeName = printTarget.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        const safeKind = printTarget.kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        await exportLabelsToPDF([printRef.current], DEFAULT_TEMPLATE, `${safeKind}-${safeName}.pdf`);
      } catch (e) {
        console.error('Failed to export label', e);
        setToast({ ok: false, msg: 'Failed to generate label PDF' });
      } finally {
        if (!cancelled) setPrintTarget(null);
      }
    })();
    return () => { cancelled = true; };
  }, [printTarget]);

  // ── Staged config edits (site/room) — saved by the settings Save bar ───────
  const updateLocation = (id: string, patch: Partial<LocationDef>) =>
    onChange(locations.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLocation = (id: string) => {
    if (!confirm('Remove this site? Rooms and dropdown entries referencing it will disappear from new records.')) return;
    onChange(locations.filter((l) => l.id !== id));
  };
  const addLocation = () =>
    onChange([...locations, { id: newId('site'), name: 'New Site', type: 'satellite', rooms: [] }]);
  const addRoom = (locId: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, { rooms: [...loc.rooms, { id: newId('room'), name: 'New Room' }] });
  };
  const updateRoom = (locId: string, roomId: string, name: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, { rooms: loc.rooms.map((r) => (r.id === roomId ? { ...r, name } : r)) });
  };
  const removeRoom = (locId: string, roomId: string) => {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    updateLocation(locId, { rooms: loc.rooms.filter((r) => r.id !== roomId) });
  };

  // ── Live deletes (shelf/container) — preserve the dangling-ref cleanup ──────
  const clearItemRefs = async (field: string, value: string, patch: Record<string, unknown>) => {
    const snap = await getDocs(query(collection(db, 'inventory'), where(field, '==', value)));
    if (snap.empty) return;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach((d) => batch.update(doc(db, 'inventory', d.id), patch));
      await batch.commit();
    }
  };

  const deleteShelf = async (shelfId: string) => {
    if (!confirm('Delete this shelf? Items on it keep their zone but lose the shelf/container; containers on it are unassigned from the shelf.')) return;
    try {
      await clearItemRefs('storageLocation.shelfId', shelfId, {
        'storageLocation.shelfId': null, 'storageLocation.shelfName': null,
        'storageLocation.level': null, 'storageLocation.containerId': null, 'storageLocation.containerName': null,
      });
      const cSnap = await getDocs(query(collection(db, 'containers'), where('shelfId', '==', shelfId)));
      if (!cSnap.empty) {
        const cDocs = cSnap.docs;
        for (let i = 0; i < cDocs.length; i += 450) {
          const batch = writeBatch(db);
          cDocs.slice(i, i + 450).forEach((d) => batch.update(doc(db, 'containers', d.id), { shelfId: null, updatedAt: serverTimestamp() }));
          await batch.commit();
        }
      }
      await deleteDoc(doc(db, 'shelves', shelfId));
    } catch (e) { console.error('Delete shelf failed', e); alert('Failed to delete shelf.'); }
  };

  const deleteContainer = async (containerId: string) => {
    if (!confirm('Delete this container? Items in it keep their zone/shelf but lose the container.')) return;
    try {
      await clearItemRefs('storageLocation.containerId', containerId, {
        'storageLocation.containerId': null, 'storageLocation.containerName': null,
      });
      await deleteDoc(doc(db, 'containers', containerId));
    } catch (e) { console.error('Delete container failed', e); alert('Failed to delete container.'); }
  };

  const exportContainerLabels = () => {
    if (containers.length === 0) { alert('No containers to export.'); return; }
    const header = 'Container Name,Barcode,Container URL,Shelf,Zone';
    const rows = containers.map((c) => {
      const shelf = shelves.find((s) => s.id === c.shelfId);
      const zone = shelf ? zones.find((z) => z.id === shelf.zoneId) : null;
      const url = typeof window !== 'undefined' ? `${window.location.origin}/inventory?containerId=${c.id}` : `/inventory?containerId=${c.id}`;
      const q = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
      return [q(c.name), q(c.barcode || ''), q(url), q(shelf?.name || ''), q(zone?.name || '')].join(',');
    });
    const csv = [header, ...rows].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `container_labels_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Matching zones → sites/rooms (loose name-string link) ──────────────────
  const siteNames = useMemo(() => new Set(locations.map((l) => l.name)), [locations]);
  const zoneRollup = (zoneId: string) => rollups.byZone.get(zoneId) ?? emptyRollup();
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  const zonesForSite = (site: LocationDef) => zones.filter((z) => (z.locationType || '') === site.name);
  const orphanZones = zones.filter((z) => !siteNames.has(z.locationType || ''));
  const orphanShelves = shelves.filter((s) => !s.zoneId || !zones.some((z) => z.id === s.zoneId));
  const orphanContainers = containers.filter((c) => !c.shelfId || !shelves.some((s) => s.id === c.shelfId));

  const siteRollup = (site: LocationDef) => aggregateRollups(zonesForSite(site).map((z) => rollups.byZone.get(z.id)));

  // ── Item location finder (Task 4) ───────────────────────────────────────────
  const [finderQuery, setFinderQuery] = useState('');
  const finderResults = useMemo(() => {
    const q = finderQuery.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((it) => it.name.toLowerCase().includes(q) || (it.category || '').toLowerCase().includes(q))
      .slice(0, 15);
  }, [items, finderQuery]);

  const roomForItem = (item: InventoryItem): string => {
    const zoneId = item.storageLocation?.zoneId;
    const zone = zoneId ? zoneById.get(zoneId) : undefined;
    if (!zone) return '';
    return zone.room || zone.locationType || '';
  };

  const revealItem = (item: InventoryItem) => {
    const loc = item.storageLocation;
    if (!loc?.zoneId) return;
    setExpanded((prev) => {
      const n = new Set(prev);
      n.add(`zone:${loc.zoneId}`);
      if (loc.shelfId) n.add(`shelf:${loc.shelfId}`);
      if (loc.containerId) n.add(`container:${loc.containerId}`);
      return n;
    });
    const targetKey = loc.containerId ? `container:${loc.containerId}` : loc.shelfId ? `shelf:${loc.shelfId}` : `zone:${loc.zoneId}`;
    requestAnimationFrame(() => {
      setTimeout(() => {
        nodeRefs.current.get(targetKey)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
    });
  };

  // ── Renderers ──────────────────────────────────────────────────────────────
  const renderContainer = (c: Container, ctx?: { shelf: Shelf; zone: StorageZone }) => {
    const r = rollups.byContainer.get(c.id) ?? emptyRollup();
    const key = `container:${c.id}`;
    const open = expanded.has(key);
    const containerItems = items.filter((it) => it.storageLocation?.containerId === c.id);
    const canExpand = containerItems.length > 0;
    return (
      <div key={c.id} ref={registerNodeRef(key)} className="pl-6 ml-3 border-l border-divider">
        <div className="flex items-center justify-between gap-2 pr-2 py-1.5">
          <button
            className="flex items-center gap-2 min-w-0 text-left"
            onClick={() => (canExpand ? toggle(key) : undefined)}
          >
            {canExpand ? (open ? <ChevronDown size={12} className="text-foreground-400 flex-none" /> : <ChevronRight size={12} className="text-foreground-400 flex-none" />) : <span className="w-3 flex-none" />}
            <Boxes size={13} className="text-foreground-400 flex-none" />
            <span className="text-[13px] text-foreground truncate">{c.name}</span>
            {c.isSealed && <span className="text-[10px] font-semibold px-1 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary flex-none">SEALED</span>}
            <span className="text-[11px] font-mono tabular-nums text-foreground-400 flex-none">· {r.itemCount}</span>
          </button>
          <div className="flex items-center gap-1 flex-none">
            {ctx && (
              <Button isIconOnly size="sm" variant="light" onPress={() => openAssign({
                zoneId: ctx.zone.id, zoneName: ctx.zone.name, shelfId: ctx.shelf.id, shelfName: ctx.shelf.name,
                containerId: c.id, containerName: c.name, label: `${ctx.zone.name} › ${ctx.shelf.name} › ${c.name}`,
              })} aria-label="Add items"><Plus size={13} /></Button>
            )}
            <Button isIconOnly size="sm" variant="light" onPress={() => openPrintLabel('Box', c.name, c.barcode || c.id, `/inventory?containerId=${c.id}`)} aria-label="Print label"><Printer size={13} /></Button>
            <Button isIconOnly size="sm" variant="light" onPress={() => openEditContainer(c)} aria-label="Edit container"><Edit2 size={13} /></Button>
            <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => deleteContainer(c.id)} aria-label="Delete container"><Trash2 size={13} /></Button>
          </div>
        </div>
        {open && canExpand && (
          <div className="pb-2 pl-5">
            <ItemsList
              items={containerItems}
              removeLabel="Move out of box"
              onRemove={(it) => ctx ? moveOutOfContainer(it, ctx.shelf, ctx.zone) : unassignFromShelf(it)}
            />
          </div>
        )}
      </div>
    );
  };

  const renderShelf = (s: Shelf, zone?: StorageZone) => {
    const r = rollups.byShelf.get(s.id) ?? emptyRollup();
    const fill = shelfFill(s, r);
    const cs = containers.filter((c) => c.shelfId === s.id);
    const key = `shelf:${s.id}`;
    const open = expanded.has(key);
    const shelfDirectItems = items.filter((it) => it.storageLocation?.shelfId === s.id && !it.storageLocation?.containerId);
    return (
      <div key={s.id} ref={registerNodeRef(key)} className="border-l border-divider ml-3">
        <div className="flex items-center justify-between gap-2 pl-3 pr-2 py-1.5">
          <button className="flex items-center gap-2 min-w-0 text-left" onClick={() => toggle(key)}>
            {(cs.length > 0 || shelfDirectItems.length > 0 || r.itemCount > 0) ? (open ? <ChevronDown size={13} className="text-foreground-400 flex-none" /> : <ChevronRight size={13} className="text-foreground-400 flex-none" />) : <span className="w-[13px] flex-none" />}
            <Layers size={13} className="text-foreground-400 flex-none" />
            <span className="text-[13px] font-medium text-foreground truncate">{s.name}</span>
            {s.numberOfLevels ? <span className="text-[11px] text-foreground-400 flex-none">({s.numberOfLevels} lvl)</span> : null}
          </button>
          <div className="flex items-center gap-2 flex-none">
            {fill.capacity != null && (
              <div className="hidden sm:flex items-center gap-1.5">
                <div className="w-16 h-1.5 rounded-full bg-content3 overflow-hidden">
                  <div className={`h-full rounded-full ${(fill.pct ?? 0) >= 100 ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${fill.pct ?? 0}%` }} />
                </div>
                <span className="text-[11px] font-mono tabular-nums text-foreground-400">{fill.assigned}/{fill.capacity}</span>
              </div>
            )}
            <RollupChips r={r} />
            {zone && (
              <Button isIconOnly size="sm" variant="light" onPress={() => openAssign({
                zoneId: zone.id, zoneName: zone.name, shelfId: s.id, shelfName: s.name,
                label: `${zone.name} › ${s.name}`,
              })} aria-label="Add items"><Plus size={13} /></Button>
            )}
            <Button isIconOnly size="sm" variant="light" onPress={() => openPrintLabel('Shelf', s.name, s.barcode || s.id, `/inventory?shelfId=${s.id}`)} aria-label="Print label"><Printer size={13} /></Button>
            <Button isIconOnly size="sm" variant="light" onPress={() => openEditShelf(s)} aria-label="Edit shelf"><Edit2 size={13} /></Button>
            <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => deleteShelf(s.id)} aria-label="Delete shelf"><Trash2 size={13} /></Button>
          </div>
        </div>
        {open && (
          <div className="pl-3 pb-2">
            {r.itemCount > 0 && <DetailPanel r={r} />}
            {shelfDirectItems.length > 0 && (
              <ItemsList label="On shelf (no box)" items={shelfDirectItems} removeLabel="Remove from shelf" onRemove={unassignFromShelf} />
            )}
            {cs.map((c) => renderContainer(c, zone ? { shelf: s, zone } : undefined))}
            <Button size="sm" variant="light" className="text-foreground-400 ml-6 mt-1" startContent={<Plus size={12} />} onPress={() => openAddContainer(s.id)}>Add container</Button>
          </div>
        )}
      </div>
    );
  };

  const renderZone = (z: StorageZone) => {
    const r = zoneRollup(z.id);
    const zoneShelves = shelves.filter((s) => s.zoneId === z.id);
    const key = `zone:${z.id}`;
    const open = expanded.has(key);
    return (
      <div key={z.id} ref={registerNodeRef(key)} className="bg-content1 border border-divider rounded-large">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <button className="flex items-center gap-2 min-w-0 text-left" onClick={() => toggle(key)}>
            {open ? <ChevronDown size={15} className="text-foreground-400 flex-none" /> : <ChevronRight size={15} className="text-foreground-400 flex-none" />}
            <Warehouse size={15} className="text-primary flex-none" />
            <span className="text-sm font-semibold text-foreground truncate">{z.name}</span>
            {z.level && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-content3 text-foreground-500 flex-none">{z.level === 'upper' ? 'Upper' : 'Lower'}</span>}
          </button>
          <div className="flex items-center gap-2 flex-none">
            <RollupChips r={r} />
            <Button isIconOnly size="sm" variant="light" onPress={() => openPrintLabel('Storage Unit', z.name, z.id, `/inventory?zoneId=${z.id}`)} aria-label="Print label"><Printer size={14} /></Button>
            <Button isIconOnly size="sm" variant="light" onPress={() => openEditZone(z)} aria-label="Edit storage unit"><Edit2 size={14} /></Button>
          </div>
        </div>
        {open && (
          <div className="px-3 pb-3 flex flex-col gap-1">
            {r.itemCount > 0 && <DetailPanel r={r} />}
            {zoneShelves.map((s) => renderShelf(s, z))}
            <Button size="sm" variant="light" className="text-foreground-400 self-start ml-3 mt-1" startContent={<Plus size={12} />} onPress={() => openAddShelf(z.id)}>Add shelf</Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 bg-primary-50 dark:bg-primary-900/20 border border-primary/20 rounded-large px-4 py-3">
        <Info size={16} className="text-primary flex-none mt-0.5" />
        <p className="text-sm text-foreground-600">
          <span className="font-semibold">Site &amp; room names</span> save with the <span className="font-semibold">Save changes</span> button below.{' '}
          <span className="font-semibold">Storage units, shelves &amp; boxes</span> save instantly when you edit them. Renaming a site/room won&apos;t relabel records already saved under the old name.
        </p>
      </div>

      {/* Item location finder (Task 4) */}
      <div className="bg-content1 border border-divider rounded-large p-4">
        <div className="flex items-center gap-3 bg-content2 rounded-large px-3 py-1">
          <Search size={16} className="text-foreground-400 flex-none" />
          <input
            value={finderQuery}
            onChange={(e) => setFinderQuery(e.target.value)}
            placeholder="Find an item… (name or category)"
            className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
          />
          {finderQuery && (
            <button onClick={() => setFinderQuery('')} className="text-foreground-400 hover:text-foreground-600" aria-label="Clear search">
              <X size={15} />
            </button>
          )}
        </div>
        {finderQuery.trim() && (
          <div className="flex flex-col divide-y divide-divider mt-2 max-h-[360px] overflow-y-auto">
            {finderResults.length === 0 ? (
              <p className="text-sm text-foreground-400 py-4 text-center">No items match &quot;{finderQuery}&quot;.</p>
            ) : finderResults.map((it) => {
              const status = getItemStatus(it);
              const available = computeBagStock(it).availableItems;
              const room = roomForItem(it);
              const path = it.storageLocation ? displayLocation(it) : '';
              return (
                <div key={it.id} className="w-full flex items-center gap-3 px-2 py-2.5 hover:bg-content2 rounded-medium transition-colors duration-150">
                  <button
                    type="button"
                    onClick={() => revealItem(it)}
                    disabled={!it.storageLocation}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <span className={`w-2 h-2 rounded-full flex-none ${statusBarColor(status)}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{it.name}</p>
                      <p className="text-xs text-foreground-400 truncate flex items-center gap-1">
                        <MapPin size={10} className="flex-none" />
                        {it.storageLocation ? `${room ? `${room} › ` : ''}${path}` : 'Unassigned'}
                      </p>
                    </div>
                    <span className="font-mono text-xs tabular-nums text-foreground-500 flex-none">{available}</span>
                  </button>
                  {!it.storageLocation && (
                    <button
                      onClick={() => openAssignForItem(it)}
                      className="text-[11px] font-semibold text-primary flex-none px-2 py-1 rounded-medium hover:bg-primary-50 dark:hover:bg-primary-900/20"
                    >
                      Assign
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="flat" startContent={<Download size={14} />} onPress={exportContainerLabels}>
          Export container labels (CSV)
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {locations.map((loc) => {
          const siteZones = zonesForSite(loc);
          const roomlessZones = siteZones.filter((z) => !z.room);
          return (
            <div key={loc.id} className="bg-content1 border border-divider rounded-large p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                  <Input label="Site name" value={loc.name} onValueChange={(v) => updateLocation(loc.id, { name: v })} />
                  <Select
                    label="Type"
                    size="md"
                    selectedKeys={[loc.type]}
                    onChange={(e) => { const val = e.target.value as LocationDef['type']; if (val) updateLocation(loc.id, { type: val }); }}
                  >
                    {LOCATION_TYPES.map((t) => <SelectItem key={t.key}>{t.label}</SelectItem>)}
                  </Select>
                </div>
                <div className="flex items-center gap-2 flex-none mt-1">
                  <RollupChips r={siteRollup(loc)} />
                  <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeLocation(loc.id)} aria-label="Remove site"><Trash2 size={16} /></Button>
                </div>
              </div>

              <div className="bg-content2 rounded-large p-3 flex flex-col gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Rooms &amp; Storage</p>

                {loc.rooms.map((room) => {
                  const roomZones = siteZones.filter((z) => z.room === room.name);
                  return (
                    <div key={room.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <Package size={14} className="text-foreground-400 flex-none" />
                        <Input size="sm" value={room.name} onValueChange={(v) => updateRoom(loc.id, room.id, v)} className="flex-1" />
                        <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeRoom(loc.id, room.id)} aria-label="Remove room"><Trash2 size={14} /></Button>
                      </div>
                      <div className="flex flex-col gap-1.5 pl-6">
                        {roomZones.map(renderZone)}
                        <Button size="sm" variant="light" className="text-foreground-400 self-start" startContent={<Plus size={12} />} onPress={() => openAddZone(loc.name, room.name)}>Add storage unit</Button>
                      </div>
                    </div>
                  );
                })}

                {loc.rooms.length === 0 && (
                  <div className="flex flex-col gap-1.5">
                    {siteZones.map(renderZone)}
                    <Button size="sm" variant="light" className="text-foreground-400 self-start" startContent={<Plus size={12} />} onPress={() => openAddZone(loc.name)}>Add storage unit</Button>
                  </div>
                )}

                {loc.rooms.length > 0 && roomlessZones.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-[11px] text-foreground-400">Storage units not tied to a room</p>
                    {roomlessZones.map(renderZone)}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="flat" startContent={<Plus size={14} />} onPress={() => addRoom(loc.id)}>Add room</Button>
                  {loc.rooms.length > 0 && (
                    <Button size="sm" variant="light" className="text-foreground-400" startContent={<Plus size={14} />} onPress={() => openAddZone(loc.name)}>Add storage unit (no room)</Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Button color="primary" startContent={<Plus size={16} />} onPress={addLocation} className="self-start">Add site</Button>

      {(orphanZones.length > 0 || orphanShelves.length > 0 || orphanContainers.length > 0) && (
        <div className="bg-content1 border border-warning/30 rounded-large p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} className="text-warning" />
            <h3 className="text-sm font-semibold text-foreground">Other / Unassigned</h3>
            <span className="text-xs text-foreground-400">Storage not matched to a current site/room — edit to reassign.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {orphanZones.map(renderZone)}
            {orphanShelves.map((s) => renderShelf(s, undefined))}
            {orphanContainers.map((c) => renderContainer(c, undefined))}
          </div>
        </div>
      )}

      {/* Editors (live Firestore CRUD) */}
      <ZoneEditor zone={editingZone} prefill={zonePrefill} isOpen={zoneDisc.isOpen} onOpenChange={zoneDisc.onOpenChange} onSave={() => { setEditingZone(null); zoneDisc.onClose(); }} />
      <ShelfEditor shelf={editingShelf} zones={zones} defaultZoneId={shelfDefaultZone} isOpen={shelfDisc.isOpen} onOpenChange={shelfDisc.onOpenChange} onSave={() => { setEditingShelf(null); shelfDisc.onClose(); }} />
      <ContainerEditor container={editingContainer} shelves={shelves} defaultShelfId={containerDefaultShelf} isOpen={containerDisc.isOpen} onOpenChange={containerDisc.onOpenChange} onSave={() => { setEditingContainer(null); containerDisc.onClose(); }} />

      {/* Assign items into a node (Task 3b) */}
      <AssignItemsModal
        isOpen={assignDisc.isOpen}
        onOpenChange={assignDisc.onOpenChange}
        dest={assignDest}
        items={items}
        actor={actor}
        onResult={(msg, ok) => setToast({ ok, msg })}
      />

      {/* Assign a single (unassigned) item — finder shortcut */}
      <Modal isOpen={assignItemDisc.isOpen} onOpenChange={assignItemDisc.onOpenChange} size="md">
        <ModalContent>
          <ModalHeader>Assign &quot;{assignItemTarget?.name}&quot;</ModalHeader>
          <ModalBody>
            <StorageLocationPicker value={assignItemLoc} onChange={setAssignItemLoc} label="Storage location" />
          </ModalBody>
          <ModalFooter>
            <Button variant="bordered" onPress={() => assignItemDisc.onClose()}>Cancel</Button>
            <Button color="primary" isDisabled={!assignItemLoc?.zoneId} onPress={handleAssignItemConfirm}>Assign</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Hidden off-screen label used as the html2canvas source for Print label */}
      <div style={{ position: 'fixed', top: 0, left: '-9999px', zIndex: -1 }} aria-hidden="true">
        {printTarget && (
          <div
            ref={printRef}
            style={{
              width: `${DEFAULT_TEMPLATE.labelWidth}mm`,
              height: `${DEFAULT_TEMPLATE.labelHeight}mm`,
              boxSizing: 'border-box',
              padding: '3mm',
              border: '0.3mm solid #000',
              background: '#fff',
              color: '#000',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: '1mm',
            }}
          >
            <div style={{ fontSize: '8pt', fontWeight: 700, lineHeight: 1.15, overflow: 'hidden' }}>{printTarget.name}</div>
            <div style={{ fontSize: '7pt', fontFamily: 'monospace', color: '#333', wordBreak: 'break-all' }}>{printTarget.code}</div>
            <div style={{ fontSize: '6pt', color: '#555', wordBreak: 'break-all' }}>{printTarget.url}</div>
            <div style={{ fontSize: '6pt', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{printTarget.kind}</div>
          </div>
        )}
      </div>

      {/* Result toast (assign / move / print outcomes) */}
      {toast && (
        <div
          className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}
        >
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
