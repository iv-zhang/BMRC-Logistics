/**
 * Log Purchase → Receive (two-phase procurement).
 *
 * Phase 1 (`logPurchase`) records what was ordered, from whom, and for how
 * much — at order time, before anything physically arrives. It never touches
 * stock: an existing item gets an `incomingOrders` pointer, a brand-new SKU
 * gets a zero-stock placeholder `inventory` doc (`orderStatus: 'on_order'`).
 *
 * Phase 2 (`receivePurchaseLine`) is what happens when the delivery actually
 * arrives: it routes through `addShipment` (`./audit-actions`) so every
 * existing invariant — INV-4 dated-SKU expiry, HR-8 duplicate-intake guard,
 * bag vs. box branching, the inventory_logs + auditEvents triple-write — is
 * preserved. This file only adds the purchase-order bookkeeping around that
 * call: clearing the incoming pointer, marking the line received, and rolling
 * the purchase status up.
 */

import {
  addDoc,
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { removeUndefined } from '@/app/lib/audit';
import { addShipment, type AuditActor } from '@/app/lib/audit-actions';
import type { InventoryItem, Purchase, PurchaseInfo, PurchaseLine } from '@/app/types';

export interface PurchaseActor {
  uid: string;
  name?: string;
  email?: string | null;
}

export interface PurchaseLineInput {
  kind: 'inventory' | 'asset';
  itemName: string;
  linkedInventoryId?: string;
  itemNumber?: string;
  category?: string;
  orderedQty: number;
  unit?: string;
  unitsPerPackage?: number;
  lineCost?: number;
}

export interface PurchaseInput {
  vendor: string;
  orderDate: Date;
  currency?: string;
  subtotal?: number;
  shipping?: number;
  tax?: number;
  discount?: number;
  poNumber?: string;
  invoiceRef?: string;
  notes?: string;
  lines: PurchaseLineInput[];
}

export interface ReceiveLineInput {
  receivedQty: number;
  unitsPerPackage?: number;
  lotNumber?: string;
  expirationMonth?: string;
  notes?: string;
}

// ─── Cost helpers (pure) ───────────────────────────────────────────────────

type CostFields = { subtotal?: number; shipping?: number; tax?: number; discount?: number };

/** Grand total: subtotal - discount + shipping + tax. */
export function purchaseTotal(p: CostFields): number {
  return (p.subtotal || 0) - (p.discount || 0) + (p.shipping || 0) + (p.tax || 0);
}

/** Shipping as a fraction of the order total (0 when total is 0). */
export function shippingPct(p: CostFields): number {
  const total = purchaseTotal(p);
  return total ? (p.shipping || 0) / total : 0;
}

/** Tax as a fraction of the order total (0 when total is 0). */
export function taxPct(p: CostFields): number {
  const total = purchaseTotal(p);
  return total ? (p.tax || 0) / total : 0;
}

// ─── Log Purchase ───────────────────────────────────────────────────────────

/**
 * Record a new purchase order. Creates the `purchases` doc and, per line,
 * either points an existing item's `incomingOrders` at it or creates a
 * zero-stock placeholder `inventory` doc for a brand-new SKU. Stock is never
 * touched here — on-order is not on-hand.
 */
export async function logPurchase(input: PurchaseInput, actor: PurchaseActor): Promise<string> {
  const batch = writeBatch(db);
  const purchaseRef = doc(collection(db, 'purchases'));

  const lines: PurchaseLine[] = [];

  for (const lineInput of input.lines) {
    const lineId = crypto.randomUUID();
    let linkedInventoryId = lineInput.linkedInventoryId;
    let createdInventoryId: string | undefined;

    const incomingEntry = removeUndefined({
      purchaseId: purchaseRef.id,
      lineId,
      qty: lineInput.orderedQty,
      unitsPerPackage: lineInput.unitsPerPackage,
      unit: lineInput.unit,
      orderDate: input.orderDate,
      vendor: input.vendor,
    });

    if (linkedInventoryId) {
      const itemRef = doc(db, 'inventory', linkedInventoryId);
      batch.update(itemRef, {
        incomingOrders: arrayUnion(incomingEntry),
        updatedAt: serverTimestamp(),
      });
    } else {
      const newItemRef = doc(collection(db, 'inventory'));
      createdInventoryId = newItemRef.id;
      linkedInventoryId = newItemRef.id;
      // Estimated worth for a brand-new placeholder SKU: lineCost spread over
      // the ordered quantity. Only stamped when a cost was actually entered;
      // never overwrites anything since the doc doesn't exist yet. Lines
      // linked to an EXISTING item never get this estimate write — their
      // value is only ever set on receive, so a real prior value is never
      // clobbered by a guess.
      const estimatedUnitValue =
        lineInput.lineCost && lineInput.orderedQty
          ? lineInput.lineCost / (lineInput.orderedQty * (lineInput.unitsPerPackage || 1))
          : undefined;
      batch.set(newItemRef, removeUndefined({
        name: lineInput.itemName.trim(),
        category: lineInput.category || 'Other',
        isAsset: lineInput.kind === 'asset',
        unopenedBoxes: 0,
        reorderThreshold: 0,
        orderStatus: 'on_order' as const,
        incomingOrders: [incomingEntry],
        batches: [],
        itemValue: lineInput.kind === 'inventory' ? estimatedUnitValue : undefined,
        assetValue: lineInput.kind === 'asset' ? estimatedUnitValue : undefined,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));
    }

    const logRef = doc(collection(db, 'inventory_logs'));
    batch.set(logRef, removeUndefined({
      itemId: linkedInventoryId,
      itemName: lineInput.itemName,
      action: 'purchase_ordered',
      quantity: lineInput.orderedQty,
      userId: actor.uid,
      userName: actor.name,
      timestamp: serverTimestamp(),
      notes: `Ordered from ${input.vendor}${input.poNumber ? ` (PO ${input.poNumber})` : ''}`,
      details: { purchaseId: purchaseRef.id, lineId },
    }));

    const line: PurchaseLine = removeUndefined({
      lineId,
      kind: lineInput.kind,
      itemName: lineInput.itemName,
      linkedInventoryId,
      createdInventoryId,
      itemNumber: lineInput.itemNumber,
      category: lineInput.category,
      orderedQty: lineInput.orderedQty,
      unit: lineInput.unit,
      unitsPerPackage: lineInput.unitsPerPackage,
      lineCost: lineInput.lineCost,
      received: false,
    });
    lines.push(line);
  }

  batch.set(purchaseRef, removeUndefined({
    vendor: input.vendor,
    orderDate: input.orderDate,
    status: 'ordered' as const,
    currency: input.currency || 'USD',
    subtotal: input.subtotal,
    shipping: input.shipping,
    tax: input.tax,
    discount: input.discount,
    total: purchaseTotal(input),
    poNumber: input.poNumber,
    invoiceRef: input.invoiceRef,
    notes: input.notes,
    lines,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: serverTimestamp(),
  }));

  await batch.commit();
  return purchaseRef.id;
}

// ─── Receive ────────────────────────────────────────────────────────────────

/**
 * Receive one line of a purchase. Inventory-kind lines route through
 * `addShipment` so stock math, dated-SKU expiry (INV-4), and the
 * duplicate-intake guard (HR-8) all still apply. Asset-kind lines are a
 * minimal placeholder path for now (see TODO below) — a later sub-task wires
 * up full asset-instance creation.
 */
export async function receivePurchaseLine(
  purchase: Purchase,
  lineId: string,
  receive: ReceiveLineInput,
  actor: PurchaseActor,
): Promise<void> {
  if (!purchase.id) throw new Error('Purchase must have an id to receive a line');
  const line = purchase.lines.find((l) => l.lineId === lineId);
  if (!line) throw new Error(`Purchase line '${lineId}' not found`);
  if (!line.linkedInventoryId) throw new Error(`Purchase line '${lineId}' has no linked inventory item`);

  const itemRef = doc(db, 'inventory', line.linkedInventoryId);
  const itemSnap = await getDoc(itemRef);
  if (!itemSnap.exists()) throw new Error(`Inventory item '${line.linkedInventoryId}' not found`);
  const item = { ...(itemSnap.data() as InventoryItem), id: itemSnap.id };

  const auditActor: AuditActor = { uid: actor.uid, name: actor.name || '', email: actor.email };

  // Unit cost derivation, shared by both kinds: what one unit (inventory) or
  // one item (asset) actually cost, based on what was really received. Only
  // defined when a cost was entered and something was actually received —
  // that's also the gate for stamping itemValue/assetValue below.
  const unitsPerPackage = receive.unitsPerPackage || line.unitsPerPackage || 1;
  const pricePerUnit =
    line.lineCost && receive.receivedQty
      ? line.lineCost / (receive.receivedQty * unitsPerPackage)
      : undefined;

  if (line.kind === 'inventory') {
    const purchaseInfo: PurchaseInfo = removeUndefined({
      supplierName: purchase.vendor,
      purchaseOrderId: purchase.id,
      orderDate: purchase.orderDate,
      quantityReceived: receive.receivedQty,
      pricePerUnit,
      currency: purchase.currency || 'USD',
    });

    await addShipment(
      item,
      {
        qty: receive.receivedQty,
        perUnit: unitsPerPackage,
        lotNumber: receive.lotNumber,
        expirationMonth: receive.expirationMonth,
        supplier: purchase.vendor,
        notes: receive.notes,
        purchase: purchaseInfo,
        purchaseOrderId: purchase.id,
      },
      auditActor,
    );
  } else {
    // TODO(asset-receive): assign serials / create asset instances. For now,
    // receiving an asset-kind line only clears the on-order pointer below —
    // no asset instance or stock is created yet.
  }

  // Clear the incoming pointer + on_order placeholder state. `item` was read
  // before addShipment ran; addShipment only touches batches/unopenedBoxes,
  // never incomingOrders/orderStatus, so this snapshot is still current.
  const remainingIncoming = (item.incomingOrders || []).filter((o) => o.lineId !== lineId);
  const itemUpdate: Record<string, unknown> = {
    incomingOrders: remainingIncoming,
    updatedAt: serverTimestamp(),
  };
  if (item.orderStatus === 'on_order') {
    itemUpdate.orderStatus = deleteField();
  }
  // Stamp item worth from the actual receipt — only when a real unit cost
  // was derived above, so a missing/zero cost never clobbers an existing
  // value (the key is simply omitted from the update).
  if (pricePerUnit) {
    if (line.kind === 'inventory') {
      itemUpdate.itemValue = pricePerUnit;
    } else {
      itemUpdate.assetValue = pricePerUnit;
    }
  }
  await updateDoc(itemRef, itemUpdate);

  // Roll the receipt onto the purchase doc (rebuild the lines array
  // immutably — Firestore has no partial-array-element update).
  const updatedLines: PurchaseLine[] = purchase.lines.map((l) =>
    l.lineId === lineId
      ? removeUndefined({
          ...l,
          received: true,
          receivedQty: receive.receivedQty,
          lotNumber: receive.lotNumber,
          expirationMonth: receive.expirationMonth,
          receivedAt: new Date(),
          receivedBy: actor.uid,
        })
      : l,
  );
  const allReceived = updatedLines.every((l) => l.received);
  const anyReceived = updatedLines.some((l) => l.received);
  const newStatus: Purchase['status'] = allReceived
    ? 'received'
    : anyReceived
      ? 'partially_received'
      : purchase.status;

  await updateDoc(doc(db, 'purchases', purchase.id), {
    lines: updatedLines,
    status: newStatus,
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: line.linkedInventoryId,
    itemName: line.itemName,
    action: 'purchase_received',
    quantity: receive.receivedQty,
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `Received against purchase from ${purchase.vendor}`,
    details: removeUndefined({
      purchaseId: purchase.id,
      lineId,
      lot: receive.lotNumber,
      exp: receive.expirationMonth,
    }),
  }));
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

/**
 * Cancel a purchase. Strips the incoming-order pointer from every
 * not-yet-received line's linked item, and deletes placeholder docs that
 * never received any stock (guarded: a doc with real stock or another
 * pending order is never deleted).
 */
export async function cancelPurchase(purchase: Purchase, actor: PurchaseActor): Promise<void> {
  if (!purchase.id) throw new Error('Purchase must have an id to cancel');
  void actor; // reserved for future audit-event stamping on cancellation

  const batch = writeBatch(db);

  for (const line of purchase.lines) {
    if (line.received || !line.linkedInventoryId) continue;

    const itemRef = doc(db, 'inventory', line.linkedInventoryId);
    const itemSnap = await getDoc(itemRef);
    if (!itemSnap.exists()) continue;
    const itemData = itemSnap.data() as InventoryItem;

    const remainingIncoming = (itemData.incomingOrders || []).filter((o) => o.lineId !== line.lineId);
    const isPlaceholder =
      itemData.orderStatus === 'on_order' &&
      (itemData.batches || []).length === 0 &&
      (itemData.unopenedBoxes || 0) === 0;

    if (isPlaceholder && remainingIncoming.length === 0) {
      // Never delete a doc that has stock — this guard only fires when the
      // placeholder never received anything and has no other pending order.
      batch.delete(itemRef);
    } else {
      batch.update(itemRef, removeUndefined({
        incomingOrders: remainingIncoming,
        orderStatus:
          itemData.orderStatus === 'on_order' && remainingIncoming.length === 0
            ? deleteField()
            : undefined,
        updatedAt: serverTimestamp(),
      }));
    }
  }

  batch.update(doc(db, 'purchases', purchase.id), {
    status: 'cancelled' as const,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
}
