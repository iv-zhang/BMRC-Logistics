'use client';
import React, { useEffect, useState } from 'react';
import { Button, Input, Textarea, Spinner } from '@heroui/react';
import { AlertTriangle, PackageCheck, PackagePlus, ScanBarcode, X } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import { receivePurchaseLine, type PurchaseActor, type ReceiveLineInput } from '@/app/lib/purchases';
import { addShipment, type AuditActor } from '@/app/lib/audit-actions';
import { resolveScan } from '@/app/lib/scan-resolve';
import ScannerInput from '@/app/components/scanner-input';
import type { InventoryItem, Purchase, PurchaseLine } from '@/app/types';

interface ReceiveDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** The clicked inventory item that has incomingOrders. */
  item: InventoryItem | null;
  actor: PurchaseActor;
  onReceived?: () => void;
}

interface ReceivableLine {
  key: string;
  /** Which item this line belongs to — scanning a DIFFERENT item with its
   * own open order adds its lines here too, so a single scan session can
   * receive a whole mixed-SKU delivery, not just the item the drawer opened for. */
  itemId: string;
  itemName: string;
  itemRequiresExp: boolean;
  purchase: Purchase;
  line: PurchaseLine;
  incoming: NonNullable<InventoryItem['incomingOrders']>[number];
}

/** A scanned item with NO open PO line — received directly via `addShipment`
 * instead of `receivePurchaseLine`. */
interface FreeReceiveState {
  item: InventoryItem;
  qty: string;
  perUnit: string;
  lotNumber: string;
  expirationMonth: string;
  supplier: string;
  notes: string;
}

interface LineFormState {
  receivedQty: string;
  unitsPerPackage: string;
  lotNumber: string;
  expirationMonth: string;
  notes: string;
}

/** Duck-types a Firestore Timestamp or a plain Date into a Date. */
function toJsDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate();
  }
  return null;
}

function formatDate(v: unknown): string {
  const d = toJsDate(v);
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Loads every un-received PO line for `target`'s own `incomingOrders`. Used
 * both for the drawer's bound item on open, and for a DIFFERENT item that
 * gets scanned mid-session. Purchase loads are deduplicated by id. */
async function buildReceivablesForItem(
  target: InventoryItem
): Promise<{ lines: ReceivableLine[]; forms: Record<string, LineFormState> }> {
  const incoming = target.incomingOrders || [];
  const purchaseIds = Array.from(new Set(incoming.map(o => o.purchaseId)));
  const purchaseMap = new Map<string, Purchase>();
  await Promise.all(
    purchaseIds.map(async pid => {
      const snap = await getDoc(doc(db, 'purchases', pid));
      if (snap.exists()) {
        purchaseMap.set(pid, { ...(snap.data() as Purchase), id: snap.id });
      }
    })
  );

  const itemRequiresExp = Boolean(target.tracksExpiration || target.requiresExpirationCheck);
  const lines: ReceivableLine[] = [];
  const forms: Record<string, LineFormState> = {};
  for (const inc of incoming) {
    const purchase = purchaseMap.get(inc.purchaseId);
    if (!purchase) continue;
    const line = purchase.lines.find(l => l.lineId === inc.lineId);
    if (!line || line.received) continue;
    const key = `${inc.purchaseId}:${inc.lineId}`;
    lines.push({ key, itemId: target.id, itemName: target.name, itemRequiresExp, purchase, line, incoming: inc });
    forms[key] = {
      receivedQty: String(inc.qty ?? line.orderedQty ?? 1),
      unitsPerPackage: String(line.unitsPerPackage ?? inc.unitsPerPackage ?? ''),
      lotNumber: '',
      expirationMonth: '',
      notes: '',
    };
  }
  return { lines, forms };
}

export default function ReceiveDrawer({ isOpen, onClose, item, actor, onReceived }: ReceiveDrawerProps) {
  const [receivables, setReceivables] = useState<ReceivableLine[]>([]);
  const [forms, setForms] = useState<Record<string, LineFormState>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Scan-to-receive: resolves a scanned code to an item, matches it against
  // an open PO line if one exists (adding it here if it's for a different
  // item than the drawer is bound to), or falls to a free receive when
  // there's no PO line at all.
  const [scanStatus, setScanStatus] = useState<'success' | 'error' | 'warning' | null>(null);
  const [scanMessage, setScanMessage] = useState('');
  const [freeReceive, setFreeReceive] = useState<FreeReceiveState | null>(null);
  const [freeReceiveError, setFreeReceiveError] = useState('');
  const [freeReceiveSaving, setFreeReceiveSaving] = useState(false);

  // Load the purchase doc(s) behind this item's incoming orders whenever the
  // drawer opens for a given item.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!isOpen || !item) return;
      setLoading(true);
      setLoadError('');
      setReceivables([]);
      setForms({});
      setLineErrors({});
      setScanStatus(null);
      setScanMessage('');
      setFreeReceive(null);
      setFreeReceiveError('');
      try {
        const { lines, forms: initialForms } = await buildReceivablesForItem(item);
        if (cancelled) return;
        setReceivables(lines);
        setForms(initialForms);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load purchase orders.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, item?.id]);

  if (!isOpen || !item) return null;

  function updateForm(key: string, patch: Partial<LineFormState>) {
    setForms(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  /** Closing the drawer (manually, or once every line is received) always
   * lets the caller re-sync — matches the spec's "when the list is empty
   * (or user closes) call onReceived?.() and onClose()". */
  function finish() {
    onReceived?.();
    onClose();
  }

  async function handleReceive(r: ReceivableLine) {
    const form = forms[r.key];
    if (!form) return;
    const qty = Number(form.receivedQty);
    if (!qty || qty <= 0) {
      setLineErrors(prev => ({ ...prev, [r.key]: 'Enter a received quantity greater than 0.' }));
      return;
    }
    setLineErrors(prev => {
      const next = { ...prev };
      delete next[r.key];
      return next;
    });
    setSavingKey(r.key);
    try {
      const receiveInput: ReceiveLineInput = {
        receivedQty: qty,
        unitsPerPackage: form.unitsPerPackage ? Number(form.unitsPerPackage) : undefined,
        lotNumber: form.lotNumber.trim() || undefined,
        expirationMonth: form.expirationMonth || undefined,
        notes: form.notes.trim() || undefined,
      };
      await receivePurchaseLine(r.purchase, r.line.lineId, receiveInput, actor);
      setReceivables(prev => {
        const next = prev.filter(x => x.key !== r.key);
        if (next.length === 0) {
          // Defer so React finishes this state update before we tear the drawer down.
          setTimeout(finish, 0);
        }
        return next;
      });
    } catch (e) {
      setLineErrors(prev => ({ ...prev, [r.key]: e instanceof Error ? e.message : 'Failed to receive this line.' }));
    } finally {
      setSavingKey(null);
    }
  }

  /** Scan a case/box barcode: resolve it to an item, then either prefill an
   * already-open line for it, load its own open PO lines in (for a
   * different item than the drawer is bound to), or fall to a free receive
   * when it has no PO line at all. */
  async function handleScan(code: string) {
    setFreeReceiveError('');
    try {
      const match = await resolveScan(code);
      if (match.kind !== 'item') {
        setScanStatus('error');
        setScanMessage(`No inventory item matched "${code}".`);
        return;
      }
      const scanned = match.item;
      const lot = match.gs1?.lot;
      const expirationMonth = match.gs1?.expiration ? match.gs1.expiration.slice(0, 7) : undefined;

      const alreadyLoaded = receivables.filter(r => r.itemId === scanned.id);
      if (alreadyLoaded.length > 0) {
        setForms(prev => {
          const next = { ...prev };
          for (const r of alreadyLoaded) {
            next[r.key] = {
              ...next[r.key],
              lotNumber: lot || next[r.key].lotNumber,
              expirationMonth: expirationMonth || next[r.key].expirationMonth,
            };
          }
          return next;
        });
        setScanStatus('success');
        setScanMessage(`Matched ${scanned.name} — prefilled ${alreadyLoaded.length} line${alreadyLoaded.length === 1 ? '' : 's'} from scan.`);
        return;
      }

      const { lines, forms: newForms } = await buildReceivablesForItem(scanned);
      if (lines.length > 0) {
        if (lot || expirationMonth) {
          for (const l of lines) {
            newForms[l.key] = {
              ...newForms[l.key],
              lotNumber: lot || newForms[l.key].lotNumber,
              expirationMonth: expirationMonth || newForms[l.key].expirationMonth,
            };
          }
        }
        setReceivables(prev => [...prev, ...lines]);
        setForms(prev => ({ ...prev, ...newForms }));
        setScanStatus('success');
        setScanMessage(`Found an open order for ${scanned.name} — added below.`);
        return;
      }

      // No open PO line at all — free receive.
      setFreeReceive({
        item: scanned,
        qty: '1',
        perUnit: scanned.itemsPerBox ? String(scanned.itemsPerBox) : '1',
        lotNumber: lot || '',
        expirationMonth: expirationMonth || '',
        supplier: '',
        notes: '',
      });
      setScanStatus('warning');
      setScanMessage(`No open order for ${scanned.name} — receiving as a free shipment (no PO).`);
    } catch (e) {
      setScanStatus('error');
      setScanMessage(e instanceof Error ? e.message : 'Scan lookup failed.');
    }
  }

  async function handleFreeReceive() {
    if (!freeReceive) return;
    const qty = Number(freeReceive.qty);
    if (!qty || qty <= 0) {
      setFreeReceiveError('Enter a received quantity greater than 0.');
      return;
    }
    const requiresExp = Boolean(freeReceive.item.tracksExpiration || freeReceive.item.requiresExpirationCheck);
    if (requiresExp && !freeReceive.expirationMonth) {
      setFreeReceiveError('Expiration is required for this item.');
      return;
    }
    setFreeReceiveError('');
    setFreeReceiveSaving(true);
    try {
      const auditActor: AuditActor = { uid: actor.uid, name: actor.name || '', email: actor.email };
      await addShipment(
        freeReceive.item,
        {
          qty,
          perUnit: Math.max(1, Number(freeReceive.perUnit) || 1),
          lotNumber: freeReceive.lotNumber.trim() || undefined,
          expirationMonth: freeReceive.expirationMonth || undefined,
          supplier: freeReceive.supplier.trim() || undefined,
          notes: freeReceive.notes.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        },
        auditActor,
      );
      setScanStatus('success');
      setScanMessage(`Received ${qty} × ${freeReceive.perUnit || 1} unit(s) of ${freeReceive.item.name} (no PO).`);
      setFreeReceive(null);
      onReceived?.();
    } catch (e) {
      setFreeReceiveError(e instanceof Error ? e.message : 'Failed to receive this shipment.');
    } finally {
      setFreeReceiveSaving(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={finish} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw] bg-content1 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex-none">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-[38px] h-[38px] rounded-[11px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                <PackageCheck size={19} />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">Receive Shipment</div>
                <div className="text-xs text-foreground-500 mt-0.5 truncate">{item.name}</div>
              </div>
            </div>
            <button
              onClick={finish}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="mt-3 text-xs text-foreground-400 font-medium">
            {loading
              ? 'Loading order details…'
              : `${receivables.length} line${receivables.length === 1 ? '' : 's'} awaiting receipt`}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          {/* Scan-to-receive */}
          <div className="bg-content2 rounded-large p-4">
            <ScannerInput
              compact
              showLastScan={false}
              label="Scan case barcode"
              placeholder="Scan or type a barcode/QR/tag..."
              onScan={handleScan}
              scanStatus={scanStatus}
              statusMessage={scanMessage || undefined}
            />
          </div>

          {/* Free receive — a scanned item with no open PO line */}
          {freeReceive && (
            <div className="bg-warning-50 dark:bg-warning-950/20 border border-warning/30 rounded-large p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <PackagePlus size={15} className="text-warning flex-none" />
                  <span className="text-sm font-semibold text-foreground truncate">{freeReceive.item.name}</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning-50 dark:bg-warning-900/30 text-warning flex-none">
                    No PO
                  </span>
                </div>
                <button
                  onClick={() => { setFreeReceive(null); setFreeReceiveError(''); }}
                  className="w-6 h-6 rounded-medium bg-content1 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
                  aria-label="Dismiss free receive"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  type="number"
                  size="sm"
                  label="Received qty"
                  value={freeReceive.qty}
                  onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, qty: v } : prev))}
                />
                <Input
                  type="number"
                  size="sm"
                  label="Units per package"
                  value={freeReceive.perUnit}
                  onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, perUnit: v } : prev))}
                />
                <Input
                  size="sm"
                  label="Lot number"
                  placeholder="Optional"
                  value={freeReceive.lotNumber}
                  onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, lotNumber: v } : prev))}
                />
                <Input
                  type="month"
                  size="sm"
                  label="Expiration month"
                  value={freeReceive.expirationMonth}
                  onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, expirationMonth: v } : prev))}
                />
              </div>
              <Input
                size="sm"
                label="Supplier"
                placeholder="Optional"
                value={freeReceive.supplier}
                onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, supplier: v } : prev))}
              />
              <Textarea
                size="sm"
                minRows={2}
                label="Notes (optional)"
                value={freeReceive.notes}
                onValueChange={v => setFreeReceive(prev => (prev ? { ...prev, notes: v } : prev))}
              />

              {freeReceiveError && (
                <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
                  <AlertTriangle size={12} className="flex-none" />
                  {freeReceiveError}
                </div>
              )}

              <Button
                color="warning"
                size="sm"
                className="self-end"
                onPress={handleFreeReceive}
                isLoading={freeReceiveSaving}
              >
                Receive without PO
              </Button>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-10">
              <Spinner size="md" color="primary" />
            </div>
          )}

          {!loading && loadError && (
            <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-950/20 border border-danger/30 rounded-large px-4 py-3">
              <AlertTriangle size={15} className="text-danger flex-none" />
              <span className="text-xs font-semibold text-danger">{loadError}</span>
            </div>
          )}

          {!loading && !loadError && receivables.length === 0 && (
            <div className="bg-content2 rounded-large px-4 py-6 text-center text-sm text-foreground-500">
              Nothing left to receive for this item.
            </div>
          )}

          {!loading &&
            receivables.map(r => {
              const form = forms[r.key];
              if (!form) return null;
              const isAssetLine = r.line.kind === 'asset';
              return (
                <div key={r.key} className="bg-content2 rounded-large p-4 flex flex-col gap-3">
                  {/* Item name — only shown when this line belongs to a DIFFERENT
                      item than the drawer opened for (added via scan). */}
                  {r.itemId !== item.id && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary-50 dark:bg-primary-900/20 text-primary self-start">
                      {r.itemName}
                    </span>
                  )}
                  {/* Vendor + order date */}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-foreground truncate">{r.purchase.vendor}</span>
                    <span className="text-xs text-foreground-400 font-medium flex-none">
                      Ordered {formatDate(r.purchase.orderDate)}
                    </span>
                  </div>

                  {/* Vendor item # to verify */}
                  {r.line.itemNumber && (
                    <div className="flex items-center gap-2 bg-primary-50 dark:bg-primary-900/20 border border-dashed border-primary-200 dark:border-primary-800 rounded-xl px-3 py-2">
                      <ScanBarcode size={15} className="text-primary flex-none" />
                      <span className="text-xs font-semibold text-primary">
                        Verify item #: <span className="font-mono">{r.line.itemNumber}</span>
                      </span>
                    </div>
                  )}

                  {/* Ordered qty/unit */}
                  <div className="text-xs text-foreground-500">
                    Ordered{' '}
                    <span className="font-mono font-semibold text-foreground">
                      {r.line.orderedQty} {r.line.unit || ''}
                    </span>
                    {r.line.unitsPerPackage ? ` × ${r.line.unitsPerPackage}/package` : ''}
                  </div>

                  <Input
                    type="number"
                    size="sm"
                    label="Received qty"
                    value={form.receivedQty}
                    onValueChange={v => updateForm(r.key, { receivedQty: v })}
                  />

                  {isAssetLine ? (
                    <div className="bg-content1 border border-dashed border-divider rounded-large px-3 py-2 text-xs text-foreground-500">
                      Serial assignment coming soon — receiving clears this line&apos;s on-order status; assign serials manually afterward.
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          type="number"
                          size="sm"
                          label="Units per package"
                          value={form.unitsPerPackage}
                          onValueChange={v => updateForm(r.key, { unitsPerPackage: v })}
                        />
                        <Input
                          size="sm"
                          label="Lot number"
                          placeholder="Optional"
                          value={form.lotNumber}
                          onValueChange={v => updateForm(r.key, { lotNumber: v })}
                        />
                      </div>
                      <Input
                        type="month"
                        size="sm"
                        label="Expiration month"
                        value={form.expirationMonth}
                        onValueChange={v => updateForm(r.key, { expirationMonth: v })}
                      />
                      {r.itemRequiresExp && (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                          <AlertTriangle size={12} className="flex-none" />
                          Expiration is required for this item — receiving will be rejected without it.
                        </div>
                      )}
                    </>
                  )}

                  <Textarea
                    size="sm"
                    minRows={2}
                    label="Notes (optional)"
                    value={form.notes}
                    onValueChange={v => updateForm(r.key, { notes: v })}
                  />

                  {lineErrors[r.key] && (
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-danger">
                      <AlertTriangle size={12} className="flex-none" />
                      {lineErrors[r.key]}
                    </div>
                  )}

                  <Button
                    color="primary"
                    size="sm"
                    className="self-end"
                    onPress={() => handleReceive(r)}
                    isLoading={savingKey === r.key}
                  >
                    Receive this line
                  </Button>
                </div>
              );
            })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-divider flex items-center justify-end flex-none">
          <Button variant="bordered" onPress={finish}>
            Close
          </Button>
        </div>
      </div>
    </>
  );
}
