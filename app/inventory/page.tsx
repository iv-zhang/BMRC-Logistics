'use client';

import { useEffect, useState, useMemo, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import {
  Chip, Button, Spinner, Select, SelectItem,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  Radio, RadioGroup,
} from '@heroui/react';
import type { Selection } from '@heroui/react';
import {
  Plus, Minus, Search, MapPin, Download, ChevronDown, X, RotateCcw,
  PackageOpen, LayoutList, Table2, ArrowRight, SlidersHorizontal, Truck, Receipt,
  Check, Trash2, Copy, AlertTriangle, ScanBarcode,
} from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection, addDoc, updateDoc, doc, onSnapshot, query, orderBy,
  serverTimestamp, Timestamp, getDoc, where, limit,
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { recordAuditEvent } from '../lib/audit';
import InventoryModal from '@/app/components/additemmodal';
import ConsumeBoxModal from '@/app/components/consume-box-modal';
import MedicationCabinetModal from '@/app/components/medication-cabinet-modal';
import PurchaseModal from '@/app/components/purchase-modal';
import ReceiveDrawer from '@/app/components/receive-drawer';
import AssignBarcodeModal from '@/app/components/assign-barcode-modal';
import { getOldestValidBatch, isBatchExpired } from '@/app/utils/batchHelpers';
import { preparePayload, safeParseDate } from '@/app/utils/inventoryNormalization';
import { ITEM_CATEGORIES, getInventoryAreaOptions } from '@/app/config/org-config';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { CAT_CFG } from '@/app/components/category-badge';
import PanelShell from '@/app/components/panel-shell';
import { usePanelMode } from '@/app/hooks/usePanelMode';
import {
  computeBagStock, displayLocation, getItemStatus, formatExp, expTextColor,
  statusQtyColor, statusBarColor, isOnTheWay, incomingQty, type ItemStatus,
} from '@/app/lib/item-status';
import {
  findDuplicateCandidates, previewInventoryMerge, mergeInventoryItems,
  checkInventoryItemReferences, deleteInventoryItem, updateInventoryItemWithLog,
  type MergePreview,
} from '@/app/lib/inventory-merge';
import type {
  InventoryItem, InventoryBatch, ItemCategory, User, BatchStatus, MedicationInfo,
} from '@/app/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ITEM_CATEGORIES as readonly ItemCategory[];

const BATCH_STATUS_COLORS: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'primary'> = {
  sealed: 'primary', open: 'success', depleted: 'default', expired: 'danger', quarantined: 'warning',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardTint(s: ItemStatus): string {
  if (s === 'expired') return 'bg-danger-50/70 dark:bg-danger-950/40 border-danger/40 dark:border-danger/25';
  if (s === 'out')     return 'bg-danger-50/40 dark:bg-danger-950/25 border-danger/25 dark:border-danger/15';
  if (s === 'low')     return 'bg-warning-50/70 dark:bg-warning-950/30 border-warning/40 dark:border-warning/20';
  if (s === 'expiring') return 'bg-warning-50/40 dark:bg-warning-950/20 border-warning/25 dark:border-warning/15';
  return 'bg-content1 border-divider';
}

// ── Page Component ─────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const router = useRouter();
  // Location filter options (from org-config — live, admin-overridable).
  const { locations } = useOrgConfig();
  const LOCATION_OPTIONS = useMemo(
    // `getInventoryAreaOptions` reads the runtime store keyed by `locations`;
    // recompute when the live locations change.
    () => { void locations; return getInventoryAreaOptions(); },
    [locations],
  );
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [opLoading, setOpLoading] = useState(false);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilters, setCategoryFilters] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [locationFilter, setLocationFilter] = useState<string>('');

  // Views
  const [viewMode, setViewMode] = useState<'list' | 'table'>('list');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [tableExpanded, setTableExpanded] = useState<Set<string>>(new Set());
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  // Pop-out preference. In "dropdown" mode the list view expands the item detail
  // inline (accordion) instead of the shared PanelShell overlay; every other
  // mode/view keeps using PanelShell (which itself centers "dropdown").
  const { mode: panelMode } = usePanelMode();
  const inlineDropdown = panelMode === 'dropdown' && viewMode === 'list';

  // Shared item-detail content, rendered either inline (list + dropdown mode)
  // or inside PanelShell (drawer / center / table view).
  const renderItemDetail = (item: InventoryItem) => {
    const bag = computeBagStock(item);
    const status = getItemStatus(item);
    const cfg = CAT_CFG[item.category];
    const loc = displayLocation(item);
    const qtyColor = statusQtyColor(status);
    const onTheWay = isOnTheWay(item);
    const isPlaceholder = item.orderStatus === 'on_order';
    const sortedBatches = [...(item.batches || [])].sort(
      (a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity),
    );
    return (
      <>
              <div className="px-6 py-5 border-b border-divider">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-[46px] h-[46px] rounded-[12px] flex items-center justify-center font-mono font-semibold text-sm flex-none ${cfg.bg} ${cfg.text}`}>
                      {cfg.code}
                    </div>
                    <div>
                      <div className="font-semibold text-lg text-foreground leading-tight">{item.name}</div>
                      {loc && (
                        <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                          <MapPin size={11} /> {loc}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setDetailItem(null)}
                    className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none mt-0.5"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="flex gap-1.5 flex-wrap mt-4">
                  {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                  {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                  {status === 'out' && !isPlaceholder && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                  {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                  {status === 'ok'       && <Chip size="sm" variant="flat" color="success">OK</Chip>}
                  {item.isMedication     && <Chip size="sm" variant="flat" color="danger">Med</Chip>}
                  {item.isOxygen         && <Chip size="sm" variant="flat" color="secondary">O₂</Chip>}
                  {onTheWay && (
                    <Chip size="sm" variant="flat" color="primary" startContent={<Truck size={12} />}>
                      On the way · {incomingQty(item)} units
                    </Chip>
                  )}
                </div>
              </div>

              {/* Drawer body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* On the way — Receive action */}
                {onTheWay && (
                  <div className="bg-primary-50 dark:bg-primary-900/20 border border-primary/30 rounded-large px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Truck size={16} className="text-primary flex-none" />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-primary">On the way</div>
                        <div className="text-xs text-primary/80 truncate">{incomingQty(item)} units incoming</div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      color="primary"
                      className="flex-none"
                      onPress={() => { setDetailItem(null); setReceiveItem(item); }}
                    >
                      Receive
                    </Button>
                  </div>
                )}

                {/* Stock stats */}
                <div className="flex gap-3">
                  <div className="flex-1 bg-content2 rounded-large p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">On Hand</div>
                    <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${qtyColor}`}>
                      {item.isOxygen ? (item.oxygenPsi ?? 0) : (bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes)}
                      <span className="text-sm text-foreground-400 font-normal ml-1.5">
                        {item.isOxygen ? 'PSI' : (bag.hasBagTracking ? 'items' : (item.unit || 'units'))}
                      </span>
                    </div>
                    {bag.hasBagTracking && (
                      <div className="text-xs text-foreground-400 mt-1">
                        {bag.totalBags} bag{bag.totalBags !== 1 ? 's' : ''} · {bag.totalLoose} loose
                      </div>
                    )}
                  </div>
                  <div className="flex-1 bg-content2 rounded-large p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Reorder At</div>
                    <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground-600">
                      {item.reorderThreshold}
                    </div>
                    <div className={`text-xs font-semibold mt-1 ${
                      isPlaceholder ? 'text-primary' :
                      status === 'ok' ? 'text-success' :
                      status === 'low' ? 'text-warning' :
                      status === 'out' ? 'text-danger' :
                      status === 'expired' ? 'text-danger' : 'text-foreground-500'
                    }`}>
                      {isPlaceholder ? 'On the way' :
                       status === 'ok' ? 'Well stocked' :
                       status === 'low' ? 'Below threshold' :
                       status === 'out' ? 'Out of stock' :
                       status === 'expired' ? 'Has expired batches' : 'Expiring soon'}
                    </div>
                  </div>
                </div>

                {/* Batches */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">
                      Batches & Expiration
                    </h4>
                    <span className="text-xs text-foreground-400 font-semibold">FIFO — oldest first</span>
                  </div>
                  {sortedBatches.length === 0 ? (
                    <div className="text-xs text-foreground-400 text-center py-4 border border-dashed border-divider rounded-large">
                      No batch tracking — stock counted at item level.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {sortedBatches.map(bt => {
                        const bStatus = bt.status || (isBatchExpired(bt, item) ? 'expired' : (bt.bagCount ?? 0) > 0 ? 'sealed' : 'open');
                        const total = bt.bagCount !== undefined
                          ? (bt.bagCount ?? 0) * (bt.itemsPerBag ?? 0) + (bt.looseItems ?? 0)
                          : bt.stock;
                        const hasSealedBag = (bt.bagCount ?? 0) > 0 && bt.itemsPerBag;
                        return (
                          <div key={bt.id} className="border border-divider rounded-large p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold text-foreground">
                                  {bt.lotNumber || '(no lot)'}
                                </span>
                                <Chip size="sm" variant="flat" color={BATCH_STATUS_COLORS[bStatus] || 'default'}>
                                  {bStatus}
                                </Chip>
                              </div>
                              <span className="font-mono text-[15px] font-semibold text-foreground-500">{total}</span>
                            </div>
                            <div className="flex items-center justify-between mt-2">
                              <span className={`text-xs font-semibold ${expTextColor(bt.expirationDate)}`}>
                                Expires {formatExp(bt.expirationDate)}
                              </span>
                              {hasSealedBag && (
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  color="primary"
                                  startContent={<PackageOpen size={12} />}
                                  onPress={() => handleOpenBag(item, bt.id)}
                                >
                                  Open bag
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* History */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                      Activity History
                    </h4>
                    {historyLoading && <Spinner size="sm" color="primary" />}
                  </div>
                  {drawerHistory.length === 0 && !historyLoading ? (
                    <div className="text-xs text-foreground-400 text-center py-4 border border-dashed border-divider rounded-large">
                      No activity logged yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {drawerHistory.map(entry => {
                        const ACTION_LABELS: Record<string, string> = {
                          create_open_batch: 'Batch added', consume_box: 'Units consumed',
                          restock_needed: 'Restock alert', asset_checkout: 'Checked out',
                          asset_checkin: 'Checked in', asset_assign: 'Assigned',
                          asset_unassign: 'Unassigned', intake: 'Stock intake',
                          batch_added: 'Stock intake', quick_adjust: 'Quick adjust',
                        };
                        const label = ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, ' ');
                        const isIn = ['intake', 'batch_added', 'create_open_batch', 'asset_checkin'].includes(entry.action);
                        return (
                          <div key={entry.id} className="flex items-start gap-3 border border-divider rounded-large p-3">
                            <div className={`w-7 h-7 rounded-[8px] flex items-center justify-center flex-none mt-0.5 ${
                              isIn ? 'bg-success-50 dark:bg-success-900/20 text-success' : 'bg-content3 text-foreground-400'
                            }`}>
                              {isIn ? <Plus size={13} /> : <Minus size={13} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-foreground capitalize">{label}</span>
                                {entry.quantity !== undefined && (
                                  <span className={`font-mono text-sm font-semibold tabular-nums ${isIn ? 'text-success' : 'text-foreground-500'}`}>
                                    {isIn ? '+' : '−'}{Math.abs(entry.quantity)}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {entry.userName && <span className="text-xs text-foreground-400">{entry.userName}</span>}
                                {entry.supplier && <span className="text-xs text-primary font-medium">via {entry.supplier}</span>}
                                {entry.timestamp && (
                                  <span className="text-xs text-foreground-300">
                                    {entry.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                    {' · '}
                                    {entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </span>
                                )}
                              </div>
                              {entry.notes && <p className="text-xs text-foreground-400 mt-1">{entry.notes}</p>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Assign barcode / print label — any inventory item */}
                <Button
                  variant="flat"
                  color="primary"
                  fullWidth
                  startContent={<ScanBarcode size={15} />}
                  onPress={() => { setDetailItem(null); setAssignBarcodeItem(item); setAssignBarcodeOpen(true); }}
                >
                  Assign barcode / print label
                </Button>

                {/* Med cabinet link */}
                {item.isMedication && (
                  <Button
                    variant="flat"
                    color="danger"
                    fullWidth
                    onPress={() => { setDetailItem(null); setMedCabinetItem(item); setMedCabinetOpen(true); }}
                  >
                    Med Cabinet
                  </Button>
                )}
              </div>

              {/* Drawer footer */}
              <div className="px-6 py-4 border-t border-divider flex gap-3">
                <Button
                  variant="bordered"
                  className="flex-1"
                  startContent={<Plus size={15} />}
                  onPress={() => { setDetailItem(null); setSelectedItem(item); setIsOpen(true); }}
                >
                  Edit / Add batch
                </Button>
                <Button
                  color="primary"
                  className="flex-1"
                  startContent={<ArrowRight size={15} />}
                  onPress={() => { setDetailItem(null); handleRestockForward(item); }}
                >
                  Restock forward
                </Button>
              </div>
      </>
    );
  };


  // Modals
  const [isOpen, setIsOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [receiveItem, setReceiveItem] = useState<InventoryItem | null>(null);
  const [consumeBoxModalOpen, setConsumeBoxModalOpen] = useState(false);
  const [consumeBoxItem, setConsumeBoxItem] = useState<InventoryItem | null>(null);
  const [medCabinetOpen, setMedCabinetOpen] = useState(false);
  const [medCabinetItem, setMedCabinetItem] = useState<InventoryItem | null>(null);
  const [assignBarcodeItem, setAssignBarcodeItem] = useState<InventoryItem | null>(null);
  const [assignBarcodeOpen, setAssignBarcodeOpen] = useState(false);

  // ── Merge / delete (multi-select) ───────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dupBannerDismissed, setDupBannerDismissed] = useState(false);
  const [dupReviewOpen, setDupReviewOpen] = useState(false);

  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeCandidateIds, setMergeCandidateIds] = useState<string[]>([]);
  const [mergeSurvivorId, setMergeSurvivorId] = useState<string>('');
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeError, setMergeError] = useState<string>('');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);

  interface DeleteCheck { id: string; name: string; total: number; refCounts: Record<string, number>; error?: string }
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteChecks, setDeleteChecks] = useState<DeleteCheck[]>([]);
  const [deleteChecking, setDeleteChecking] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── Drawer history ─────────────────────────────────────────────────────────
  const [drawerHistory, setDrawerHistory] = useState<Array<{
    id: string; action: string; quantity?: number; userName?: string;
    timestamp?: Date; notes?: string; supplier?: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Auth ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) { setUser(u); setLoading(false); }
      else { router.push('/login'); }
    });
    return unsub;
  }, [router]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
          const data = snap.data() as User;
          setIsAdmin(data.role === 'admin' || data.role === 'quartermaster');
        }
      } catch (e) { console.error('Role fetch error', e); }
    })();
  }, [user]);

  // ── Inventory listener ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    return onSnapshot(q, (snap) => {
      // Archived (merged-away) losers stay in Firestore for audit history but
      // must not clutter normal browsing/duplicate-detection.
      const items: InventoryItem[] = snap.docs.filter((d) => !d.data().isArchived).map((d) => {
        const raw = d.data();
        const item: InventoryItem = {
          id: d.id,
          name: raw.name || '',
          category: raw.category || 'Other',
          location: raw.location || 'HQ',
          room: raw.room || '',
          shelf: raw.shelf,
          backShelf: raw.backShelf,
          backLevel: raw.backLevel ? Number(raw.backLevel) : undefined,
          storageLocation: raw.storageLocation || undefined,
          unopenedBoxes: Number(raw.unopenedBoxes ?? 0),
          itemsPerBox: raw.itemsPerBox ? Number(raw.itemsPerBox) : undefined,
          looseUnits: Number(raw.looseUnits ?? 0),
          totalStockQuantity: Number(raw.totalStockQuantity ?? 0),
          reorderThreshold: Number(raw.reorderThreshold ?? 0),
          tracksExpiration: raw.tracksExpiration ?? false,
          isOxygen: raw.isOxygen ?? false,
          oxygenPsi: raw.oxygenPsi ? Number(raw.oxygenPsi) : undefined,
          maxOxygenPsi: raw.maxOxygenPsi ? Number(raw.maxOxygenPsi) : undefined,
          oxygenModel: raw.oxygenModel,
          isReagent: raw.isReagent ?? false,
          daysValidAfterOpening: raw.daysValidAfterOpening ? Number(raw.daysValidAfterOpening) : undefined,
          isAsset: raw.isAsset ?? false,
          isMedication: raw.isMedication ?? false,
          medicationInfo: raw.medicationInfo as MedicationInfo | undefined,
          barcode: raw.barcode,
          unit: raw.unit,
          description: raw.description,
          hasVariants: false,
          createdAt: raw.createdAt instanceof Timestamp ? raw.createdAt.toDate() : new Date(raw.createdAt || Date.now()),
          updatedAt: raw.updatedAt instanceof Timestamp ? raw.updatedAt.toDate() : new Date(raw.updatedAt || Date.now()),
          orderStatus: raw.orderStatus,
          incomingOrders: Array.isArray(raw.incomingOrders)
            ? raw.incomingOrders.map((o: Record<string, unknown>) => ({
                purchaseId: o.purchaseId as string,
                lineId: o.lineId as string,
                qty: Number(o.qty ?? 0),
                unitsPerPackage: o.unitsPerPackage !== undefined ? Number(o.unitsPerPackage) : undefined,
                unit: o.unit as string | undefined,
                orderDate: o.orderDate instanceof Timestamp ? o.orderDate.toDate() : new Date((o.orderDate as string | Date | undefined) || Date.now()),
                vendor: o.vendor as string | undefined,
              }))
            : undefined,
          batches: [],
        };
        if (Array.isArray(raw.batches) && raw.batches.length > 0) {
          item.batches = raw.batches.map((b: Record<string, unknown>) => ({
            id: (b.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            lotNumber: (b.lotNumber as string) || '',
            expirationDate: safeParseDate(
              b.expirationDate instanceof Timestamp
                ? (b.expirationDate as Timestamp).toDate()
                : (b.expirationDate as string | Date | undefined),
            ),
            stock: Number(b.stock ?? 0),
            openDate: safeParseDate(
              b.openDate instanceof Timestamp ? (b.openDate as Timestamp).toDate() : (b.openDate as string | Date | undefined),
            ),
            receivedAt: safeParseDate(
              b.receivedAt instanceof Timestamp ? (b.receivedAt as Timestamp).toDate() : (b.receivedAt as string | Date | undefined),
            ),
            locations: Array.isArray(b.locations) ? (b.locations as InventoryBatch['locations']) : [],
            serialNumbers: Array.isArray(b.serialNumbers) ? (b.serialNumbers as string[]) : [],
            purchase: (b.purchase as InventoryBatch['purchase']) || undefined,
            bagCount: b.bagCount !== undefined ? Number(b.bagCount) : undefined,
            itemsPerBag: b.itemsPerBag !== undefined ? Number(b.itemsPerBag) : undefined,
            looseItems: b.looseItems !== undefined ? Number(b.looseItems) : undefined,
            status: (b.status as BatchStatus) || undefined,
            openedAt: safeParseDate(
              b.openedAt instanceof Timestamp ? (b.openedAt as Timestamp).toDate() : (b.openedAt as string | Date | undefined),
            ),
            openedBy: (b.openedBy as string) || undefined,
            supplier: (b.supplier as string) || undefined,
            notes: (b.notes as string) || undefined,
          }));
        }
        return item;
      });
      setInventory(items.filter(i => !i.isAsset));
    });
  }, [user]);

  // ── Drawer history listener ────────────────────────────────────────────────
  useEffect(() => {
    if (!detailItem) { setDrawerHistory([]); return; }
    setHistoryLoading(true);
    const q = query(
      collection(db, 'inventory_logs'),
      where('itemId', '==', detailItem.id),
      orderBy('timestamp', 'desc'),
      limit(20),
    );
    const unsub = onSnapshot(q, snap => {
      setDrawerHistory(snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          action: data.action ?? 'update',
          quantity: data.quantity ?? data.quantityDelta ?? undefined,
          userName: data.userName ?? undefined,
          timestamp: data.timestamp?.toDate?.() ?? undefined,
          notes: data.notes ?? undefined,
          supplier: data.supplier ?? data.supplierName ?? undefined,
        };
      }));
      setHistoryLoading(false);
    }, () => setHistoryLoading(false));
    return () => unsub();
  }, [detailItem]);

  // ── CRUD ───────────────────────────────────────────────────────────────────
  async function handleAddItem(data: Partial<InventoryItem>) {
    if (!user) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({ ...data, createdAt: serverTimestamp(), createdBy: user.uid });
      await addDoc(collection(db, 'inventory'), payload);
      await recordAuditEvent({
        eventType: 'item_added',
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name, category: data.category },
      });
    } catch (e) { console.error(e); alert('Failed to add item'); }
    finally { setOpLoading(false); }
  }

  async function handleUpdateItem(id: string, data: Partial<InventoryItem>) {
    if (!user || !id) return;
    setOpLoading(true);
    try {
      const payload = preparePayload({ ...data, updatedAt: serverTimestamp(), updatedBy: user.uid });
      const actorForLog = { uid: user.uid, name: user.displayName || user.email || 'Unknown' };
      // Routes the write through the shared helper so edits also land an
      // `inventory_logs` row (previously only the auditEvents entry below).
      await updateInventoryItemWithLog({ itemId: id, itemName: data.name, data: payload, actor: actorForLog });
      await recordAuditEvent({
        eventType: 'item_updated',
        sourceId: id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: data.name },
      });
    } catch (e) { console.error(e); alert('Failed to update item'); }
    finally { setOpLoading(false); }
  }

  async function handleOpenBag(item: InventoryItem, batchId?: string) {
    if (!user) return;
    const batches = item.batches || [];
    const targetBatch = batchId
      ? batches.find(b => b.id === batchId)
      : batches
          .filter(b => (b.bagCount ?? 0) > 0 && b.status !== 'expired' && b.status !== 'quarantined')
          .sort((a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity))[0];

    if (!targetBatch || (targetBatch.bagCount ?? 0) <= 0) { alert('No sealed bags available.'); return; }
    const perBag = targetBatch.itemsPerBag ?? 0;
    if (!confirm(`Open 1 sealed bag from Lot ${targetBatch.lotNumber || '(no lot)'}?\nReleases ${perBag} items as loose stock.`)) return;

    setOpLoading(true);
    try {
      const updatedBatches = batches.map(b => {
        if (b.id !== targetBatch.id) return b;
        const newBagCount = (b.bagCount ?? 0) - 1;
        const newLoose = (b.looseItems ?? 0) + perBag;
        return {
          ...b, bagCount: newBagCount, looseItems: newLoose,
          status: (newBagCount === 0 && newLoose === 0 ? 'depleted' : 'open') as BatchStatus,
          openedAt: new Date(), openedBy: user.displayName || user.email || user.uid,
        };
      });
      const totalBags = updatedBatches.reduce((s, b) => s + (b.bagCount ?? 0), 0);
      const totalLoose = updatedBatches.reduce((s, b) => s + (b.looseItems ?? 0), 0);
      const totalStock = updatedBatches.reduce((s, b) => s + (b.bagCount ?? 0) * (b.itemsPerBag ?? 0) + (b.looseItems ?? 0), 0);
      await updateDoc(doc(db, 'inventory', item.id), {
        batches: updatedBatches, unopenedBoxes: totalBags,
        looseUnits: totalLoose, totalStockQuantity: totalStock, updatedAt: serverTimestamp(),
      });
      await recordAuditEvent({
        eventType: 'bag_opened', sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: targetBatch.id, lotNumber: targetBatch.lotNumber, itemsReleased: perBag },
      });
    } catch (e) { console.error(e); alert('Failed to open bag'); }
    finally { setOpLoading(false); }
  }

  async function handleQuickAdjust(itemId: string, delta: number) {
    if (!user) return;
    setOpLoading(true);
    try {
      const itemDoc = await getDoc(doc(db, 'inventory', itemId));
      if (!itemDoc.exists()) return;
      const current = itemDoc.data();
      const newUnopened = Math.max(0, (Number(current.unopenedBoxes) || 0) + delta);
      const newTotal = Math.max(0, (Number(current.totalStockQuantity) || 0) + delta);
      await updateDoc(doc(db, 'inventory', itemId), {
        unopenedBoxes: newUnopened, totalStockQuantity: newTotal, updatedAt: serverTimestamp(),
      });
      const item = inventory.find(i => i.id === itemId);
      await recordAuditEvent({
        eventType: 'stock_adjusted', sourceId: itemId,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item?.name, delta, newStock: newUnopened },
      });
    } catch (e) { console.error(e); }
    finally { setOpLoading(false); }
  }

  async function handleRestockForward(item: InventoryItem) {
    if (!user) return;
    const oldest = getOldestValidBatch(item.batches || [], item);
    const info = oldest
      ? `Lot: ${oldest.lotNumber || 'N/A'}, Exp: ${oldest.expirationDate?.toLocaleDateString() || 'N/A'}`
      : '';
    if (!confirm(`Move oldest batch of "${item.name}" to front shelf?\n${info}`)) return;
    setOpLoading(true);
    try {
      await addDoc(collection(db, 'restock_reports'), {
        itemId: item.id, itemName: item.name, category: item.category,
        batchId: oldest?.id || null, lotNumber: oldest?.lotNumber || null,
        quantity: oldest?.stock || item.unopenedBoxes || 0,
        from: displayLocation(item), to: 'Front Restock Bin',
        userId: user.uid, userName: user.displayName || user.email || '',
        timestamp: serverTimestamp(),
      });
      await recordAuditEvent({
        eventType: 'restock_forward', sourceId: item.id,
        actor: { userId: user.uid, userName: user.displayName || user.email || '' },
        details: { itemName: item.name, batchId: oldest?.id, from: displayLocation(item) },
      });
      alert(`Restock report created for "${item.name}".`);
    } catch (e) { console.error(e); alert('Failed to create restock report'); }
    finally { setOpLoading(false); }
  }

  function exportCSV() {
    const headers = ['Name', 'Category', 'Location', 'Sealed Bags', 'Loose Items', 'Total Stock', 'Reorder Threshold', 'Unit'];
    const rows = filteredInventory.map(item => {
      const bag = computeBagStock(item);
      return [item.name, item.category, displayLocation(item), bag.totalBags, bag.totalLoose,
        bag.totalItems, item.reorderThreshold, item.unit || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Merge / delete (duplicate cleanup) ──────────────────────────────────────
  const actorForMerge = user ? { uid: user.uid, name: user.displayName || user.email || 'Unknown', email: user.email } : null;

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openMergeModal(ids: string[]) {
    const uniq = Array.from(new Set(ids));
    if (uniq.length < 2) return;
    setMergeCandidateIds(uniq);
    setMergeSurvivorId(uniq[0]);
    setMergeError('');
    setMergePreview(null);
    setDupReviewOpen(false);
    setMergeModalOpen(true);
  }

  // Load the merge preview whenever the modal opens or the chosen survivor changes.
  useEffect(() => {
    if (!mergeModalOpen || !mergeSurvivorId || mergeCandidateIds.length < 2) return;
    let cancelled = false;
    setMergePreviewLoading(true);
    setMergeError('');
    const loserIds = mergeCandidateIds.filter(id => id !== mergeSurvivorId);
    previewInventoryMerge(mergeSurvivorId, loserIds)
      .then(preview => { if (!cancelled) setMergePreview(preview); })
      .catch(e => { if (!cancelled) { setMergeError(e instanceof Error ? e.message : String(e)); setMergePreview(null); } })
      .finally(() => { if (!cancelled) setMergePreviewLoading(false); });
    return () => { cancelled = true; };
  }, [mergeModalOpen, mergeSurvivorId, mergeCandidateIds]);

  async function handleConfirmMerge() {
    if (!actorForMerge || !mergeSurvivorId) return;
    const loserIds = mergeCandidateIds.filter(id => id !== mergeSurvivorId);
    if (loserIds.length === 0) return;
    setMergeLoading(true);
    try {
      await mergeInventoryItems({ survivorId: mergeSurvivorId, loserIds, actor: actorForMerge });
      setMergeModalOpen(false);
      setMergeCandidateIds([]);
      setMergeSurvivorId('');
      setMergePreview(null);
      setSelectedIds(new Set());
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeLoading(false);
    }
  }

  async function openDeleteConfirm(ids: string[]) {
    const uniq = Array.from(new Set(ids));
    if (uniq.length === 0) return;
    setDeleteConfirmOpen(true);
    setDeleteChecking(true);
    setDeleteChecks(uniq.map(id => ({ id, name: inventory.find(i => i.id === id)?.name || id, total: -1, refCounts: {} })));
    try {
      const results = await Promise.all(uniq.map(async (id) => {
        const name = inventory.find(i => i.id === id)?.name || id;
        try {
          const { refCounts, total } = await checkInventoryItemReferences(id);
          return { id, name, total, refCounts };
        } catch (e) {
          return { id, name, total: -1, refCounts: {}, error: e instanceof Error ? e.message : String(e) };
        }
      }));
      setDeleteChecks(results);
    } finally {
      setDeleteChecking(false);
    }
  }

  async function handleConfirmDelete() {
    if (!actorForMerge) return;
    const deletable = deleteChecks.filter(c => c.total === 0);
    if (deletable.length === 0) return;
    setDeleteLoading(true);
    try {
      for (const c of deletable) {
        try {
          await deleteInventoryItem({ itemId: c.id, actor: actorForMerge });
        } catch (e) {
          console.error(`Failed to delete ${c.name}`, e);
        }
      }
      setDeleteConfirmOpen(false);
      setDeleteChecks([]);
      setSelectedIds(new Set());
    } finally {
      setDeleteLoading(false);
    }
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  const duplicateGroups = useMemo(() => findDuplicateCandidates(inventory), [inventory]);

  const statusCounts = useMemo(() => {
    const c = { ok: 0, low: 0, out: 0, expired: 0, expiring: 0 };
    for (const item of inventory) c[getItemStatus(item)]++;
    return c;
  }, [inventory]);

  const onTheWayCount = useMemo(() => inventory.filter(isOnTheWay).length, [inventory]);

  const namingReviewCount = useMemo(() => inventory.filter(i => !!i.namingReviewNeeded).length, [inventory]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const cat of CATEGORIES) m[cat] = inventory.filter(i => i.category === cat).length;
    return m;
  }, [inventory]);

  const filteredInventory = useMemo(() => {
    let list = [...inventory];
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      list = list.filter(i =>
        i.name.toLowerCase().includes(t) ||
        (i.barcode || '').toLowerCase().includes(t) ||
        displayLocation(i).toLowerCase().includes(t) ||
        (i.batches || []).some(b => (b.lotNumber || '').toLowerCase().includes(t)),
      );
    }
    if (categoryFilters.length > 0) list = list.filter(i => categoryFilters.includes(i.category));
    if (statusFilter) {
      list = list.filter(i => {
        const s = getItemStatus(i);
        if (statusFilter === 'ok') return s === 'ok';
        if (statusFilter === 'low') return s === 'low' || s === 'out';
        if (statusFilter === 'expired') return s === 'expired';
        if (statusFilter === 'expiring') return s === 'expiring';
        if (statusFilter === 'on_the_way') return isOnTheWay(i);
        if (statusFilter === 'naming_review') return !!i.namingReviewNeeded;
        return true;
      });
    }
    if (locationFilter) {
      const lf = locationFilter.toLowerCase();
      list = list.filter(i =>
        displayLocation(i).toLowerCase().includes(lf) ||
        (i.location || '').toLowerCase().includes(lf) ||
        (i.room || '').toLowerCase().includes(lf),
      );
    }
    return list;
  }, [inventory, searchTerm, categoryFilters, statusFilter, locationFilter]);

  function resetFilters() {
    setSearchTerm(''); setCategoryFilters([]); setStatusFilter(''); setLocationFilter('');
  }

  function toggleCategoryFilter(cat: string) {
    setCategoryFilters(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  }

  function toggleTableRow(id: string) {
    setTableExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  // ── Loading guard ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Spinner size="lg" color="primary" />
    </div>
  );
  if (!user) return null;

  // ── Actor for Log Purchase / Receive writes ─────────────────────────────────
  const actor = { uid: user.uid, name: user.displayName || user.email || undefined, email: user.email };

  // ── Status pill config ─────────────────────────────────────────────────────
  const statusPills = [
    { key: '',           label: 'All Items',     count: inventory.length,                    dot: 'bg-foreground-300', icon: false },
    { key: 'ok',         label: 'OK',            count: statusCounts.ok,                     dot: 'bg-success',        icon: false },
    { key: 'low',        label: 'Low / Out',     count: statusCounts.low + statusCounts.out, dot: 'bg-warning',        icon: false },
    { key: 'expired',    label: 'Expired',       count: statusCounts.expired,                dot: 'bg-danger',         icon: false },
    { key: 'expiring',   label: 'Expiring Soon', count: statusCounts.expiring,               dot: 'bg-warning/60',     icon: false },
    { key: 'on_the_way', label: 'On the way',    count: onTheWayCount,                       dot: 'bg-primary',        icon: true },
    { key: 'naming_review', label: 'Naming Review', count: namingReviewCount,                dot: 'bg-warning',        icon: false },
  ] as const;

  // ── Shared toolbar cluster (view toggle + Export + Log Purchase) ───────────
  const toolbarControls = (
    <div className="flex items-center gap-2 flex-none">
      <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
        {([
          { mode: 'list' as const, icon: <LayoutList size={14} />, label: 'List' },
          { mode: 'table' as const, icon: <Table2 size={14} />, label: 'Table' },
        ]).map(({ mode, icon, label }) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
              viewMode === mode
                ? 'bg-primary text-white'
                : 'text-foreground-500 hover:bg-content2'
            }`}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      <Button size="sm" variant="flat" startContent={<Download size={14} />} onPress={exportCSV}>
        Export
      </Button>
      {isAdmin && (
        <Button
          color="primary"
          size="sm"
          startContent={<Receipt size={15} />}
          onPress={() => setPurchaseOpen(true)}
        >
          Log Purchase
        </Button>
      )}
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex flex-col">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 md:pb-3 md:h-full md:min-h-0 w-full flex flex-col">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex-none mb-6">
          <h1 className="text-2xl font-semibold text-foreground">Inventory</h1>
        </div>

        {/* ── Possible duplicates banner ────────────────────────────────── */}
        {duplicateGroups.length > 0 && !dupBannerDismissed && (
          <div className="flex-none flex items-center gap-3 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-4 py-2.5 mb-4 flex-wrap">
            <AlertTriangle size={16} className="text-warning flex-none" />
            <span className="text-sm font-semibold text-warning">
              <span className="font-mono tabular-nums">{duplicateGroups.length}</span> possible duplicate group{duplicateGroups.length !== 1 ? 's' : ''} found
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <Button size="sm" variant="flat" color="warning" onPress={() => setDupReviewOpen(true)}>
                Review
              </Button>
              <button
                onClick={() => setDupBannerDismissed(true)}
                aria-label="Dismiss"
                className="w-7 h-7 rounded-medium flex items-center justify-center text-warning/70 hover:bg-warning-100 dark:hover:bg-warning-900/30 transition-colors"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        {/* ── Selection bar ─────────────────────────────────────────────── */}
        {selectedIds.size > 0 && (
          <div className="flex-none flex items-center gap-3 bg-primary-50 dark:bg-primary-900/20 border border-primary/30 rounded-large px-4 py-2.5 mb-4 flex-wrap">
            <span className="text-sm font-semibold text-primary">
              <span className="font-mono tabular-nums">{selectedIds.size}</span> selected
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <Button size="sm" variant="flat" onPress={() => setSelectedIds(new Set())}>
                Clear
              </Button>
              <Button
                size="sm"
                color="primary"
                variant="flat"
                startContent={<Copy size={14} />}
                isDisabled={selectedIds.size < 2}
                onPress={() => openMergeModal(Array.from(selectedIds))}
              >
                Merge selected
              </Button>
              {isAdmin && (
                <Button
                  size="sm"
                  color="danger"
                  variant="flat"
                  startContent={<Trash2 size={14} />}
                  onPress={() => openDeleteConfirm(Array.from(selectedIds))}
                >
                  Delete selected
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ══ LIST VIEW ══════════════════════════════════════════════════════ */}
        {viewMode === 'list' && (
          <div className="md:flex-1 md:min-h-0 flex flex-col">

            {/* Mobile filter toggle — collapses the sidebar into a disclosure below md */}
            <button
              onClick={() => setMobileFiltersOpen(o => !o)}
              className="md:hidden w-full flex items-center gap-2 bg-content1 border border-divider rounded-large px-4 py-2.5 mb-3 text-sm font-semibold text-foreground-600 dark:text-foreground-300"
            >
              <SlidersHorizontal size={16} className="text-foreground-400" />
              Filters
              {(statusFilter ? 1 : 0) + categoryFilters.length + (locationFilter ? 1 : 0) > 0 && (
                <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary tabular-nums">
                  {(statusFilter ? 1 : 0) + categoryFilters.length + (locationFilter ? 1 : 0)}
                </span>
              )}
              <ChevronDown size={16} className={`ml-auto text-foreground-400 transition-transform duration-200 ${mobileFiltersOpen ? 'rotate-180' : ''}`} />
            </button>

          <div className="flex flex-col md:flex-row gap-4 md:gap-6 items-stretch md:flex-1 md:min-h-0">

            {/* Sidebar ────────────────────────────────────────────────────── */}
            <aside className={`w-full md:w-64 md:flex-none md:h-full md:min-h-0 md:overflow-hidden flex-col gap-3 ${mobileFiltersOpen ? 'flex' : 'hidden md:flex'}`}>

              {/* Stock Status */}
              <div className="bg-content1 border border-divider rounded-large p-3 flex-none">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  Stock Status
                </p>
                <div className="flex flex-col gap-1">
                  {statusPills.map(({ key, label, count, dot, icon }) => (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(statusFilter === key ? '' : key)}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-medium text-[13px] font-semibold transition-colors duration-150 border ${
                        statusFilter === key
                          ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20 dark:border-primary/40'
                          : 'border-transparent hover:bg-content2 text-foreground-600 dark:text-foreground-300'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {icon
                          ? <Truck size={12} className="text-primary flex-none" />
                          : <span className={`w-2 h-2 rounded-sm flex-none ${dot}`} />}
                        {label}
                      </span>
                      <span className="tabular-nums text-xs text-foreground-400">{count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Category */}
              <div className="bg-content1 border border-divider rounded-large p-3 flex-none md:flex-1 md:min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2 flex-none">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                    Category
                  </p>
                  {categoryFilters.length > 0 && (
                    <button
                      onClick={() => setCategoryFilters([])}
                      className="text-xs font-semibold text-primary"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {/* Bounded scroll: the only exception to "the aside never scrolls" —
                    the category list flexes to absorb overflow so Stock Status and
                    Location (both flex-none) always stay pinned in one viewport. */}
                <div className="flex flex-col gap-0.5 md:flex-1 md:min-h-0 md:overflow-y-auto">
                  {CATEGORIES.map(cat => {
                    const cfg = CAT_CFG[cat];
                    const active = categoryFilters.includes(cat);
                    return (
                      <button
                        key={cat}
                        onClick={() => toggleCategoryFilter(cat)}
                        className={`flex items-center justify-between px-2 py-1 rounded-medium text-[13px] transition-colors duration-150 ${
                          active ? 'bg-content2 font-semibold' : 'hover:bg-content2 font-normal'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-semibold flex-none ${cfg.bg} ${cfg.text}`}>
                            {cfg.code}
                          </span>
                          <span className="text-foreground-700 dark:text-foreground-300">{cat}</span>
                        </span>
                        <span className="tabular-nums text-xs text-foreground-400">{catCounts[cat] || 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Location + reset */}
              <div className="bg-content1 border border-divider rounded-large p-3 flex-none">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">
                  Location
                </p>
                <select
                  value={locationFilter}
                  onChange={e => setLocationFilter(e.target.value)}
                  className="w-full text-[13px] font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-1.5 cursor-pointer outline-none"
                >
                  <option value="">All locations</option>
                  {LOCATION_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  onClick={resetFilters}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-primary py-1"
                >
                  <RotateCcw size={11} /> Reset filters
                </button>
              </div>
            </aside>

            {/* Item list ──────────────────────────────────────────────────── */}
            <main className="flex-1 min-w-0 flex flex-col gap-3 md:min-h-0 md:h-full">
              {/* Toolbar: search + view toggle + Export + Intake */}
              <div className="flex-none flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-[220px] flex items-center gap-3 bg-content1 border border-divider rounded-large px-4 py-1">
                  <Search size={16} className="text-foreground-400 flex-none" />
                  <input
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    placeholder="Search items, locations, lot numbers…"
                    className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
                  />
                  {searchTerm && (
                    <button onClick={() => setSearchTerm('')} className="text-foreground-400 hover:text-foreground-600 transition-colors">
                      <X size={15} />
                    </button>
                  )}
                </div>
                {toolbarControls}
              </div>

              <div className="md:flex-1 md:min-h-0 md:overflow-y-auto flex flex-col gap-3 pr-1">
              {filteredInventory.length === 0 ? (
                <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                  <PackageOpen size={32} className="mx-auto text-foreground-300 mb-2" />
                  <p className="text-sm font-semibold text-foreground-500">No items match these filters</p>
                  <p className="text-xs text-foreground-400 mt-1">Try clearing the search or status filter.</p>
                </div>
              ) : (
                filteredInventory.map(item => {
                  const bag = computeBagStock(item);
                  const status = getItemStatus(item);
                  const loc = displayLocation(item);
                  const cfg = CAT_CFG[item.category];
                  const qtyColor = statusQtyColor(status);
                  const barColor = statusBarColor(status);
                  const onTheWay = isOnTheWay(item);
                  const isPlaceholder = item.orderStatus === 'on_order';
                  const maxForBar = item.isOxygen
                    ? (item.maxOxygenPsi ?? 2000)
                    : (item.maxUnits ?? (item.reorderThreshold > 0 ? item.reorderThreshold * 2 : Math.max(bag.totalItems, 1)));
                  const barPct = item.isOxygen
                    ? Math.min(100, ((item.oxygenPsi ?? 0) / maxForBar) * 100)
                    : Math.min(100, (bag.totalItems / maxForBar) * 100);
                  const cardTint = isPlaceholder
                    ? 'bg-primary-50/40 dark:bg-primary-950/20 border-primary/25 dark:border-primary/15'
                    : getCardTint(status);

                  const isSelected = selectedIds.has(item.id);
                  const isExpandedInline = inlineDropdown && detailItem?.id === item.id;
                  return (
                    <Fragment key={item.id}>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
                        aria-label={isSelected ? 'Deselect item' : 'Select item'}
                        className={`flex-none w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors duration-150 ${
                          isSelected ? 'bg-primary border-primary' : 'bg-content1 border-divider hover:border-primary/50'
                        }`}
                      >
                        {isSelected && <Check size={13} strokeWidth={3.5} className="text-white" />}
                      </button>
                      <div
                      onClick={() => setDetailItem(prev => prev?.id === item.id ? null : item)}
                      className={`flex-1 min-w-0 flex flex-wrap sm:flex-nowrap gap-3 sm:gap-4 items-center border rounded-[14px] px-4 py-4 cursor-pointer transition-all duration-150 hover:-translate-y-px hover:shadow-[0_6px_22px_rgba(16,24,40,0.09)] dark:hover:shadow-[0_6px_22px_rgba(0,0,0,0.35)] ${cardTint}`}
                    >
                      {/* Category badge */}
                      <div className={`w-[50px] h-[50px] rounded-[13px] flex items-center justify-center font-mono font-semibold text-[15px] flex-none ${cfg.bg} ${cfg.text}`}>
                        {cfg.code}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-[55%] sm:min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="font-semibold text-foreground">{item.name}</span>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}>
                            {item.category}
                          </span>
                        </div>
                        {loc && (
                          <div className="flex items-center gap-1 text-xs text-foreground-500 mb-2">
                            <MapPin size={11} className="flex-none" /> {loc}
                          </div>
                        )}
                        <div className="flex gap-1.5 flex-wrap items-center">
                          {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                          {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                          {status === 'out' && !isPlaceholder && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                          {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                          {(item.batches || []).length > 0 && (
                            <Chip size="sm" variant="flat" color="default">
                              {(item.batches || []).length} batch{(item.batches || []).length !== 1 ? 'es' : ''}
                            </Chip>
                          )}
                          {item.isMedication && <Chip size="sm" variant="flat" color="danger">Med</Chip>}
                          {onTheWay && (
                            <>
                              <Chip size="sm" variant="flat" color="primary" startContent={<Truck size={12} />}>
                                On the way · {incomingQty(item)} units
                              </Chip>
                              <button
                                onClick={e => { e.stopPropagation(); setReceiveItem(item); }}
                                className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-primary-50 hover:bg-primary-100 dark:bg-primary-900/20 dark:hover:bg-primary-800/30 text-primary transition-colors duration-150"
                              >
                                Receive
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Quantity */}
                      {item.isOxygen ? (
                        <div className="w-full sm:w-36 flex-none flex flex-col items-end gap-1.5">
                          <div className="flex items-baseline gap-1">
                            <span className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
                              {item.oxygenPsi ?? 0}
                            </span>
                            <span className="text-xs font-semibold text-foreground-400">PSI</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barColor}`}
                              style={{ width: `${Math.min(100, ((item.oxygenPsi ?? 0) / (item.maxOxygenPsi ?? 1)) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[11px] text-foreground-400">Max {item.maxOxygenPsi} · O₂</span>
                        </div>
                      ) : (
                        <div className="w-full sm:w-44 flex-none flex flex-col items-end gap-1.5">
                          <div className="flex items-center gap-3">
                            <button
                              onClick={e => { e.stopPropagation(); handleQuickAdjust(item.id, -1); }}
                              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors duration-150"
                              aria-label="Decrease stock"
                            >
                              <Minus size={14} />
                            </button>
                            <div className="text-center min-w-[54px]">
                              <div className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
                                {bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes}
                              </div>
                              <div className="text-[9px] uppercase tracking-wider text-foreground-400 mt-1 font-semibold">
                                {bag.hasBagTracking ? 'Items' : (item.unit || 'Units')}
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); handleQuickAdjust(item.id, 1); }}
                              className="w-8 h-8 rounded-medium bg-primary-50 hover:bg-primary-100 text-primary flex items-center justify-center transition-colors duration-150 dark:bg-primary-900/20 dark:hover:bg-primary-800/30"
                              aria-label="Increase stock"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          <div className="w-full h-[5px] rounded-full bg-content3 overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-300 ${barColor}`} style={{ width: `${barPct}%` }} />
                          </div>
                          {(!!item.maxUnits || item.reorderThreshold > 0) && (
                            <div className="flex items-center gap-1 justify-end flex-wrap">
                              {!!item.maxUnits && (
                                <Chip size="sm" variant="flat" color="default">Par {item.maxUnits}</Chip>
                              )}
                              {item.reorderThreshold > 0 && (
                                <Chip size="sm" variant="flat" color="default">Reorder ≤{item.reorderThreshold}</Chip>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      </div>
                    </div>
                    {isExpandedInline && (
                      <div className="rounded-[14px] border border-divider bg-content1 shadow-sm overflow-hidden transition-all duration-200">
                        {renderItemDetail(item)}
                      </div>
                    )}
                    </Fragment>
                  );
                })
              )}
              </div>
            </main>
          </div>
          </div>
        )}

        {/* ══ TABLE VIEW ═════════════════════════════════════════════════════ */}
        {viewMode === 'table' && (
          <div className="md:flex-1 md:min-h-0 flex flex-col">
            {/* Filter bar */}
            <div className="flex-none bg-content1 border border-divider rounded-large p-3 mb-4 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px] flex items-center gap-2 bg-content2 border border-divider rounded-medium px-3 py-0.5">
                <Search size={15} className="text-foreground-400 flex-none" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search items, locations, lot numbers…"
                  className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
                />
              </div>
              <Select
                selectionMode="multiple"
                size="sm"
                placeholder="All categories"
                aria-label="Filter by category"
                selectedKeys={new Set(categoryFilters)}
                onSelectionChange={(keys: Selection) => {
                  if (keys === 'all') { setCategoryFilters([...CATEGORIES]); return; }
                  setCategoryFilters(Array.from(keys as Set<string>));
                }}
                className="w-44"
              >
                {CATEGORIES.map(c => <SelectItem key={c}>{c}</SelectItem>)}
              </Select>
              <select
                value={locationFilter}
                onChange={e => setLocationFilter(e.target.value)}
                className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
              >
                <option value="">All locations</option>
                {LOCATION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div className="flex gap-1.5 flex-wrap">
                {statusPills.slice(1).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(statusFilter === key ? '' : key)}
                    className={`px-3 py-1.5 rounded-medium text-xs font-semibold border transition-colors duration-150 ${
                      statusFilter === key
                        ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                        : 'border-divider hover:bg-content2 text-foreground-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="ml-auto">
                {toolbarControls}
              </div>
            </div>

            {/* Table — single scroll region: vertical on desktop, horizontal on narrow screens */}
            <div className="bg-content1 border border-divider rounded-large overflow-auto md:flex-1 md:min-h-0">
              <div className="min-w-[760px]">
              {/* Header */}
              <div className="grid gap-4 px-5 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400"
                style={{ gridTemplateColumns: '32px 2.3fr 1.3fr 1.2fr 100px 1.4fr 104px' }}>
                <span />
                <span>Item</span>
                <span>Location</span>
                <span>Lot · Expires</span>
                <span className="text-center">On Hand</span>
                <span>Status</span>
                <span className="text-right">Actions</span>
              </div>

              {/* Rows */}
              <div className="divide-y divide-divider">
                {filteredInventory.map(item => {
                  const bag = computeBagStock(item);
                  const status = getItemStatus(item);
                  const cfg = CAT_CFG[item.category];
                  const isExpanded = tableExpanded.has(item.id);
                  const loc = displayLocation(item);
                  const qtyColor = statusQtyColor(status);
                  const onTheWay = isOnTheWay(item);
                  const isPlaceholder = item.orderStatus === 'on_order';
                  const isSelected = selectedIds.has(item.id);
                  const sortedBatches = [...(item.batches || [])].sort(
                    (a, b) => (a.expirationDate?.getTime() ?? Infinity) - (b.expirationDate?.getTime() ?? Infinity),
                  );
                  const nearestBatch = sortedBatches[0];

                  return (
                    <div key={item.id}>
                      <div
                        onClick={() => setDetailItem(item)}
                        className="grid gap-4 px-5 py-3 cursor-pointer hover:bg-content2 transition-colors duration-150"
                        style={{ gridTemplateColumns: '32px 2.3fr 1.3fr 1.2fr 100px 1.4fr 104px' }}
                      >
                        {/* Select */}
                        <div className="self-center" onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => toggleSelect(item.id)}
                            aria-label={isSelected ? 'Deselect item' : 'Select item'}
                            className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors duration-150 ${
                              isSelected ? 'bg-primary border-primary' : 'bg-content1 border-divider hover:border-primary/50'
                            }`}
                          >
                            {isSelected && <Check size={11} strokeWidth={3.5} className="text-white" />}
                          </button>
                        </div>
                        {/* Item */}
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center font-mono font-semibold text-[11px] flex-none ${cfg.bg} ${cfg.text}`}>
                            {cfg.code}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-sm text-foreground truncate">{item.name}</div>
                            <div className="text-xs text-foreground-400">{item.category}</div>
                          </div>
                        </div>
                        {/* Location */}
                        <div className="text-xs text-foreground-500 truncate self-center">{loc}</div>
                        {/* Lot/Exp */}
                        <div className="self-center min-w-0">
                          {nearestBatch ? (
                            <>
                              <div className="font-mono text-xs text-foreground-500 truncate">{nearestBatch.lotNumber || '—'}</div>
                              <div className={`text-xs font-semibold ${expTextColor(nearestBatch.expirationDate)}`}>
                                {formatExp(nearestBatch.expirationDate)}
                              </div>
                            </>
                          ) : <span className="text-xs text-foreground-400">—</span>}
                        </div>
                        {/* On Hand */}
                        <div className="text-center self-center">
                          <span className={`font-mono text-lg font-semibold tabular-nums ${qtyColor}`}>
                            {item.isOxygen ? (item.oxygenPsi ?? 0) : (bag.hasBagTracking ? bag.totalItems : item.unopenedBoxes)}
                          </span>
                          <div className="text-[9px] uppercase tracking-wider text-foreground-400 font-semibold">
                            {item.isOxygen ? 'PSI' : (bag.hasBagTracking ? 'Items' : (item.unit || 'Units'))}
                          </div>
                        </div>
                        {/* Status */}
                        <div className="flex gap-1 flex-wrap items-center self-center">
                          {status === 'expired'  && <Chip size="sm" variant="flat" color="danger">Expired</Chip>}
                          {status === 'low'      && <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>}
                          {status === 'out' && !isPlaceholder && <Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>}
                          {status === 'expiring' && <Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>}
                          {status === 'ok'       && <Chip size="sm" variant="flat" color="success">OK</Chip>}
                          {onTheWay && (
                            <>
                              <Chip size="sm" variant="flat" color="primary" startContent={<Truck size={11} />}>
                                On the way
                              </Chip>
                              <button
                                onClick={e => { e.stopPropagation(); setReceiveItem(item); }}
                                className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-primary-50 hover:bg-primary-100 dark:bg-primary-900/20 dark:hover:bg-primary-800/30 text-primary transition-colors duration-150"
                              >
                                Receive
                              </button>
                            </>
                          )}
                        </div>
                        {/* Actions */}
                        <div className="flex items-center justify-end gap-1.5 self-center" onClick={e => e.stopPropagation()}>
                          {!item.isOxygen && (
                            <>
                              <button
                                onClick={() => handleQuickAdjust(item.id, -1)}
                                className="w-7 h-7 rounded-[7px] bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors"
                                aria-label="Decrease"
                              >
                                <Minus size={12} />
                              </button>
                              <button
                                onClick={() => handleQuickAdjust(item.id, 1)}
                                className="w-7 h-7 rounded-[7px] bg-primary-50 hover:bg-primary-100 text-primary flex items-center justify-center transition-colors dark:bg-primary-900/20"
                                aria-label="Increase"
                              >
                                <Plus size={12} />
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => toggleTableRow(item.id)}
                            className="w-7 h-7 rounded-[7px] bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors"
                            aria-label="Expand batches"
                          >
                            <ChevronDown size={13} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </div>

                      {/* Expanded batches */}
                      {isExpanded && (
                        <div className="px-5 pb-4 pt-1 bg-content2/50">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2 mt-2">Batches</p>
                          {sortedBatches.length === 0 ? (
                            <p className="text-xs text-foreground-400">No batch/lot tracking — counted at item level.</p>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {sortedBatches.map(bt => {
                                const bStatus = bt.status || (isBatchExpired(bt, item) ? 'expired' : 'sealed');
                                const total = bt.bagCount !== undefined
                                  ? (bt.bagCount ?? 0) * (bt.itemsPerBag ?? 0) + (bt.looseItems ?? 0)
                                  : bt.stock;
                                return (
                                  <div key={bt.id} className="flex items-center gap-4 bg-content1 border border-divider rounded-medium px-3 py-2.5">
                                    <span className="font-mono text-[12.5px] font-semibold text-foreground min-w-[110px]">
                                      {bt.lotNumber || '(no lot)'}
                                    </span>
                                    <span className={`text-xs font-semibold min-w-[120px] ${expTextColor(bt.expirationDate)}`}>
                                      {formatExp(bt.expirationDate)}
                                    </span>
                                    <Chip size="sm" variant="flat" color={BATCH_STATUS_COLORS[bStatus] || 'default'}>
                                      {bStatus}
                                    </Chip>
                                    <span className="font-mono text-sm text-foreground-500 ml-auto">
                                      {total} units
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              </div>
            </div>

            <div className="flex-none flex items-center justify-between mt-3 text-xs text-foreground-400">
              <span>
                Showing{' '}
                <span className="font-semibold text-foreground-600">{filteredInventory.length}</span>
                {' '}of {inventory.length} items
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ══ Detail Drawer ═══════════════════════════════════════════════════════ */}
      {/* In drawer/center mode (and table view) the detail renders in PanelShell.
          In list + dropdown mode it renders inline within the list (see the map). */}
      {detailItem && !inlineDropdown && (
        <PanelShell isOpen onClose={() => setDetailItem(null)} ariaLabel={`Details for ${detailItem.name}`}>
          {renderItemDetail(detailItem)}
        </PanelShell>
      )}

      {/* ══ Modals ═══════════════════════════════════════════════════════════ */}
      <InventoryModal
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        initialData={selectedItem}
        onAddItem={handleAddItem}
        onUpdateItem={handleUpdateItem}
      />
      {consumeBoxItem && (
        <ConsumeBoxModal
          isOpen={consumeBoxModalOpen}
          onClose={() => { setConsumeBoxModalOpen(false); setConsumeBoxItem(null); }}
          item={consumeBoxItem}
          onSuccess={() => { setConsumeBoxModalOpen(false); setConsumeBoxItem(null); }}
        />
      )}
      {medCabinetItem && (
        <MedicationCabinetModal
          isOpen={medCabinetOpen}
          onOpenChange={(open) => { setMedCabinetOpen(open); if (!open) setMedCabinetItem(null); }}
          medication={medCabinetItem}
          userId={user?.uid || ''}
          userName={user?.displayName || user?.email || ''}
        />
      )}

      <PurchaseModal
        isOpen={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        actor={actor}
        defaultKind="inventory"
        items={inventory.map(i => ({ id: i.id, name: i.name, category: i.category, isAsset: i.isAsset }))}
      />
      <ReceiveDrawer
        isOpen={!!receiveItem}
        item={receiveItem}
        onClose={() => setReceiveItem(null)}
        actor={actor}
        onReceived={() => setReceiveItem(null)}
      />
      <AssignBarcodeModal
        isOpen={assignBarcodeOpen}
        onClose={() => { setAssignBarcodeOpen(false); setAssignBarcodeItem(null); }}
        item={assignBarcodeItem}
        user={user ? { id: user.uid, fullName: user.displayName || user.email || 'Unknown' } : null}
      />

      {/* ── Duplicate review modal ────────────────────────────────────────── */}
      <Modal isOpen={dupReviewOpen} onOpenChange={setDupReviewOpen} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <>
            <ModalHeader>Possible duplicates</ModalHeader>
            <ModalBody className="pb-6">
              {duplicateGroups.length === 0 ? (
                <p className="text-sm text-foreground-400">No duplicate groups found.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {duplicateGroups.map(group => (
                    <div key={group.key} className="border border-divider rounded-large p-3">
                      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                        <Chip size="sm" variant="flat" color={group.reason === 'fuzzy' ? 'warning' : 'primary'}>
                          {group.reason === 'sku' ? 'Same SKU'
                            : group.reason === 'barcode' ? 'Same barcode'
                            : group.reason === 'name' ? 'Same name'
                            : 'Similar name'}
                        </Chip>
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          startContent={<Copy size={13} />}
                          onPress={() => openMergeModal(group.items.map(i => i.id))}
                        >
                          Merge these {group.items.length}
                        </Button>
                      </div>
                      <div className="flex flex-col gap-1">
                        {group.items.map(it => (
                          <div key={it.id} className="flex items-center justify-between text-sm">
                            <span className="text-foreground">{it.name}</span>
                            <span className="text-xs font-mono tabular-nums text-foreground-400">
                              {computeBagStock(it).totalItems} on hand
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ModalBody>
          </>
        </ModalContent>
      </Modal>

      {/* ── Merge modal ────────────────────────────────────────────────────── */}
      <Modal isOpen={mergeModalOpen} onOpenChange={setMergeModalOpen} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <>
            <ModalHeader>Merge duplicate items</ModalHeader>
            <ModalBody className="pb-2 gap-4">
              <p className="text-sm text-foreground-500">
                Choose the item that survives. Its stock absorbs the others&apos; (same tracking mode only), and any
                statpack, exchange bag, buy list, task, or purchase line pointing at a merged item is repointed to the
                survivor. The merged items are archived, never deleted.
              </p>
              <RadioGroup value={mergeSurvivorId} onValueChange={setMergeSurvivorId} label="Survivor">
                {mergeCandidateIds.map(id => {
                  const it = inventory.find(i => i.id === id);
                  if (!it) return null;
                  const bag = computeBagStock(it);
                  return (
                    <Radio key={id} value={id} description={`${bag.totalItems} on hand · ${it.category}`}>
                      {it.name}
                    </Radio>
                  );
                })}
              </RadioGroup>

              {mergePreviewLoading && (
                <div className="flex items-center gap-2 text-sm text-foreground-400">
                  <Spinner size="sm" color="primary" /> Checking references…
                </div>
              )}

              {mergeError && (
                <div className="bg-danger-50 dark:bg-danger-950/20 border border-danger/30 rounded-large p-3 text-sm text-danger">
                  {mergeError}
                </div>
              )}

              {mergePreview && !mergeError && (
                <div className="bg-content2 rounded-large p-4 flex flex-col gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
                      Stock summary — {mergePreview.mode}
                    </div>
                    <div className="flex flex-col gap-1 text-sm">
                      {mergePreview.stockBefore.map(s => (
                        <div key={s.id} className="flex items-center justify-between">
                          <span className={s.id === mergePreview.survivorId ? 'font-semibold text-foreground' : 'text-foreground-500'}>
                            {s.name}{s.id === mergePreview.survivorId ? ' (survivor)' : ''}
                          </span>
                          <span className="font-mono tabular-nums text-foreground-500">{s.total}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between border-t border-divider pt-1.5 mt-0.5">
                        <span className="font-semibold text-foreground">Total after merge</span>
                        <span className="font-mono font-semibold tabular-nums text-success">{mergePreview.stockAfterSurvivor}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
                      References to repoint
                    </div>
                    {mergePreview.repointedTotal === 0 ? (
                      <p className="text-xs text-foreground-400">No other records reference the merged item(s).</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(mergePreview.repointedCounts).filter(([, n]) => n > 0).map(([k, n]) => (
                          <Chip key={k} size="sm" variant="flat" color="primary">{n} {k}</Chip>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setMergeModalOpen(false)}>Cancel</Button>
              <Button
                color="primary"
                isDisabled={!mergePreview || !!mergeError || mergeLoading || mergePreviewLoading}
                isLoading={mergeLoading}
                onPress={handleConfirmMerge}
              >
                Confirm merge
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      {/* ── Delete confirmation modal ──────────────────────────────────────── */}
      <Modal isOpen={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen} size="lg" scrollBehavior="inside">
        <ModalContent>
          <>
            <ModalHeader>Delete items</ModalHeader>
            <ModalBody className="pb-2">
              {deleteChecking ? (
                <div className="flex items-center gap-2 text-sm text-foreground-400">
                  <Spinner size="sm" color="primary" /> Checking references…
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {deleteChecks.map(c => (
                    <div
                      key={c.id}
                      className={`border rounded-large p-3 ${
                        c.total === 0
                          ? 'border-success/30 bg-success-50/60 dark:bg-success-950/20'
                          : 'border-danger/30 bg-danger-50/60 dark:bg-danger-950/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{c.name}</span>
                        {c.total === 0 ? (
                          <Chip size="sm" variant="flat" color="success">Deletable</Chip>
                        ) : (
                          <Chip size="sm" variant="flat" color="danger">Blocked</Chip>
                        )}
                      </div>
                      {c.total > 0 && (
                        <>
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {Object.entries(c.refCounts).filter(([, n]) => n > 0).map(([k, n]) => (
                              <Chip key={k} size="sm" variant="flat" color="warning">{n} {k}</Chip>
                            ))}
                          </div>
                          <p className="text-xs text-foreground-500 mt-1.5">
                            Still referenced elsewhere — merge into another item instead of deleting.
                          </p>
                        </>
                      )}
                      {c.error && <p className="text-xs text-danger mt-1.5">{c.error}</p>}
                    </div>
                  ))}
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setDeleteConfirmOpen(false)}>Cancel</Button>
              <Button
                color="danger"
                isDisabled={deleteChecking || deleteLoading || deleteChecks.filter(c => c.total === 0).length === 0}
                isLoading={deleteLoading}
                onPress={handleConfirmDelete}
              >
                Delete {deleteChecks.filter(c => c.total === 0).length} item(s)
              </Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>

      {opLoading && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}
    </div>
  );
}
