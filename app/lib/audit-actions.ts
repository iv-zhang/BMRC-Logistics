/**
 * Write helpers for the audit workbench.
 *
 * Every physical action a member takes while working through the supply room —
 * moving an item, receiving a shipment, reporting a problem, recording a fix —
 * writes three things: the inventory change itself, an `inventory_logs` row,
 * and an `auditEvents` ledger entry. That keeps usage metrics derivable from
 * the ledger without any extra bookkeeping.
 */

import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  increment,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { recordAuditEvent, removeUndefined } from '@/app/lib/audit';
import { createReport } from '@/app/lib/reports';
import { computeBagStock, displayLocation } from '@/app/lib/item-status';
import type {
  HQRoom,
  InventoryItem,
  LocationType,
  StorageLocationRef,
} from '@/app/types';

export interface AuditActor {
  uid: string;
  name: string;
  email?: string | null;
}

// ─── Move / relocate ──────────────────────────────────────────────────────────

export interface MoveDestination {
  /** Structured zone → shelf → level → container ref (preferred) */
  storageLocation?: StorageLocationRef | null;
  /** Legacy area fields — set when the user picks a quick area instead */
  location?: LocationType;
  room?: HQRoom | null;
}

/**
 * Relocate an item (reorganizing: grab it, put it in a box, put the box on a
 * shelf) and log the from → to path.
 */
export async function moveItemLocation(
  item: InventoryItem,
  dest: MoveDestination,
  actor: AuditActor,
  note?: string
): Promise<void> {
  const fromLabel = displayLocation(item) || 'Unknown';

  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (dest.storageLocation !== undefined) {
    payload.storageLocation = dest.storageLocation
      ? removeUndefined({ ...dest.storageLocation })
      : null;
  }
  if (dest.location !== undefined) payload.location = dest.location;
  if (dest.room !== undefined) payload.room = dest.room;

  await updateDoc(doc(db, 'inventory', item.id), payload);

  const toLabel =
    displayLocation({
      ...item,
      ...(dest.storageLocation !== undefined
        ? { storageLocation: dest.storageLocation ?? undefined }
        : {}),
      ...(dest.location !== undefined ? { location: dest.location } : {}),
      ...(dest.room !== undefined ? { room: dest.room ?? undefined } : {}),
    }) || 'Unknown';

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'location_change',
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    location: toLabel,
    notes: note,
    details: { from: fromLabel, to: toLabel },
  }));

  await recordAuditEvent(removeUndefined({
    eventType: 'item_location_changed',
    source: 'supply_audit',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    before: { location: fromLabel },
    after: { location: toLabel },
    details: note ? { note } : undefined,
  }));
}

// ─── Receive shipment / restock ───────────────────────────────────────────────

export interface ShipmentInput {
  /** Sealed boxes/bags received */
  qty: number;
  /** Units inside each sealed box/bag */
  perUnit: number;
  lotNumber?: string;
  /** "YYYY-MM" from a month input */
  expirationMonth?: string;
  supplier?: string;
  notes?: string;
}

/**
 * Record a new shipment for an existing item. Bag-tracked items get a sealed
 * batch (batches are their stock source of truth); box-tracked items get an
 * atomic `unopenedBoxes` increment plus a zero-stock metadata batch when a
 * lot/expiration was recorded, so expiry tracking still works.
 */
export async function addShipment(
  item: InventoryItem,
  input: ShipmentInput,
  actor: AuditActor
): Promise<void> {
  const bagTracked = computeBagStock(item).hasBagTracking;
  const expirationDate = input.expirationMonth
    ? new Date(input.expirationMonth + '-01')
    : undefined;
  const units = input.qty * input.perUnit;
  const itemRef = doc(db, 'inventory', item.id);

  if (bagTracked) {
    const newBatch = removeUndefined({
      id: crypto.randomUUID(),
      lotNumber: input.lotNumber || undefined,
      expirationDate,
      stock: units,
      bagCount: input.qty,
      itemsPerBag: input.perUnit,
      looseItems: 0,
      status: 'sealed' as const,
      receivedAt: new Date(),
      supplier: input.supplier || undefined,
      notes: input.notes || undefined,
    });
    await updateDoc(itemRef, {
      batches: arrayUnion(newBatch),
      updatedAt: serverTimestamp(),
    });
  } else {
    const payload: Record<string, unknown> = {
      unopenedBoxes: increment(input.qty),
      updatedAt: serverTimestamp(),
    };
    if (!item.itemsPerBox && input.perUnit > 1) payload.itemsPerBox = input.perUnit;
    // Keep expiry/lot traceable even though the count lives on unopenedBoxes.
    if (input.lotNumber || expirationDate) {
      payload.batches = arrayUnion(removeUndefined({
        id: crypto.randomUUID(),
        lotNumber: input.lotNumber || undefined,
        expirationDate,
        stock: 0,
        status: 'sealed' as const,
        receivedAt: new Date(),
        supplier: input.supplier || undefined,
        notes: `Shipment of ${input.qty} box(es) — counted in unopenedBoxes`,
      }));
    }
    await updateDoc(itemRef, payload);
  }

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'intake',
    quantity: units,
    boxCount: input.qty,
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    supplier: input.supplier || null,
    lotNumber: input.lotNumber || null,
    notes: `${input.qty} box(es)${input.perUnit > 1 ? ` × ${input.perUnit} units each` : ''} received`,
    details: removeUndefined({
      bagTracked,
      expirationDate: input.expirationMonth || undefined,
      note: input.notes || undefined,
    }),
  }));

  await recordAuditEvent({
    eventType: 'shipment_received',
    source: 'supply_audit',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    after: removeUndefined({
      boxes: input.qty,
      unitsPerBox: input.perUnit,
      lotNumber: input.lotNumber || undefined,
      expirationDate: input.expirationMonth || undefined,
      supplier: input.supplier || undefined,
    }),
  });
}

// ─── Report missing / damaged / expired ───────────────────────────────────────

export type ItemIssueType = 'missing' | 'damaged' | 'expired';

export interface ItemIssueInput {
  issueType: ItemIssueType;
  /** How many units/boxes are affected (optional) */
  quantity?: number;
  notes?: string;
}

const ISSUE_LABEL: Record<ItemIssueType, string> = {
  missing: 'Missing',
  damaged: 'Damaged',
  expired: 'Expired',
};

/**
 * Report a problem found during an audit walk-through. Creates an issue report
 * for triage, stamps the item's audit condition, and writes to the ledger.
 */
export async function reportItemIssue(
  item: InventoryItem,
  input: ItemIssueInput,
  actor: AuditActor
): Promise<void> {
  const label = ISSUE_LABEL[input.issueType];
  const qtyPart = input.quantity ? ` (${input.quantity} affected)` : '';

  await createReport({
    reporter: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    type: 'bug',
    priority: input.issueType === 'missing' ? 'high' : 'medium',
    title: `${label}: ${item.name}${qtyPart}`,
    description:
      `${label} reported during supply audit at ${displayLocation(item) || 'unknown location'}.` +
      (input.notes ? `\n\n${input.notes}` : ''),
    pagePath: '/audit',
    component: 'supply_audit',
    target: { collection: 'inventory', docId: item.id },
  });

  if (input.issueType === 'damaged' || input.issueType === 'expired') {
    await updateDoc(doc(db, 'inventory', item.id), {
      auditCondition: input.issueType === 'damaged' ? 'Damaged' : 'Expired',
      auditNotes: input.notes ?? null,
      updatedAt: serverTimestamp(),
    });
  }

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'issue_reported',
    quantity: input.quantity,
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `${label} reported${input.notes ? ` — ${input.notes}` : ''}`,
    details: removeUndefined({ issueType: input.issueType, quantity: input.quantity }),
  }));

  await recordAuditEvent({
    eventType: 'item_issue_reported',
    source: 'supply_audit',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    details: removeUndefined({
      issueType: input.issueType,
      quantity: input.quantity,
      notes: input.notes || undefined,
    }),
  });
}

// ─── Record a fix / refill / change-out ───────────────────────────────────────

export type ItemFixType = 'refilled' | 'replaced' | 'fixed';

export interface ItemFixInput {
  fixType: ItemFixType;
  quantity?: number;
  notes?: string;
}

const FIX_LABEL: Record<ItemFixType, string> = {
  refilled: 'Refilled',
  replaced: 'Changed out',
  fixed: 'Fixed',
};

/**
 * Record that something was refilled, changed out, or fixed on the spot.
 * Clears a Damaged/Expired audit condition and writes to the ledger so
 * remediation work is trackable.
 */
export async function recordItemFix(
  item: InventoryItem,
  input: ItemFixInput,
  actor: AuditActor
): Promise<void> {
  const label = FIX_LABEL[input.fixType];

  await updateDoc(doc(db, 'inventory', item.id), {
    auditCondition: 'Good',
    auditNotes: input.notes ?? null,
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'item_remediated',
    quantity: input.quantity,
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `${label}${input.quantity ? ` × ${input.quantity}` : ''}${input.notes ? ` — ${input.notes}` : ''}`,
    details: removeUndefined({ fixType: input.fixType, quantity: input.quantity }),
  }));

  await recordAuditEvent({
    eventType: 'item_remediated',
    source: 'supply_audit',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    after: { auditCondition: 'Good' },
    details: removeUndefined({
      fixType: input.fixType,
      quantity: input.quantity,
      notes: input.notes || undefined,
    }),
  });
}
