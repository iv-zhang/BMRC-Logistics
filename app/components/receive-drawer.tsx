'use client';
import React, { useEffect, useState } from 'react';
import { Button, Input, Textarea, Spinner } from '@heroui/react';
import { AlertTriangle, PackageCheck, ScanBarcode, X } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import { receivePurchaseLine, type PurchaseActor, type ReceiveLineInput } from '@/app/lib/purchases';
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
  purchase: Purchase;
  line: PurchaseLine;
  incoming: NonNullable<InventoryItem['incomingOrders']>[number];
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

export default function ReceiveDrawer({ isOpen, onClose, item, actor, onReceived }: ReceiveDrawerProps) {
  const [receivables, setReceivables] = useState<ReceivableLine[]>([]);
  const [forms, setForms] = useState<Record<string, LineFormState>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Load the purchase doc(s) behind this item's incoming orders whenever the
  // drawer opens for a given item. Purchase loads are deduplicated by id.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!isOpen || !item) return;
      setLoading(true);
      setLoadError('');
      setReceivables([]);
      setForms({});
      setLineErrors({});
      try {
        const incoming = item.incomingOrders || [];
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
        if (cancelled) return;

        const lines: ReceivableLine[] = [];
        const initialForms: Record<string, LineFormState> = {};
        for (const inc of incoming) {
          const purchase = purchaseMap.get(inc.purchaseId);
          if (!purchase) continue;
          const line = purchase.lines.find(l => l.lineId === inc.lineId);
          if (!line || line.received) continue;
          const key = `${inc.purchaseId}:${inc.lineId}`;
          lines.push({ key, purchase, line, incoming: inc });
          initialForms[key] = {
            receivedQty: String(inc.qty ?? line.orderedQty ?? 1),
            unitsPerPackage: String(line.unitsPerPackage ?? inc.unitsPerPackage ?? ''),
            lotNumber: '',
            expirationMonth: '',
            notes: '',
          };
        }
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

  const requiresExp = Boolean(item.tracksExpiration || item.requiresExpirationCheck);

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
                      {requiresExp && (
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
