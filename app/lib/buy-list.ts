/**
 * Buy list helpers.
 *
 * `addToBuyList` is the single de-duplicating entry point for adding an item to
 * the `buyList` collection. Before creating a new doc it looks for an existing
 * OPEN entry (status 'pending' or 'ordered') that matches on `linkedInventoryId`
 * when one is provided, otherwise on a normalized (trim + lowercase) item name.
 * A match short-circuits the write so the same SKU can't land on the list twice
 * (which would cause double orders). See INV-9.
 */
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
  runTransaction,
  getDoc,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { removeUndefined } from '@/app/lib/audit';
import { addShipment, DuplicateShipmentError } from '@/app/lib/audit-actions';
import type { BuyListDelivery, BuyListItem, InventoryItem } from '@/app/types';

const OPEN_STATUSES = ['pending', 'ordered'] as const;

export interface BuyListEntry {
  itemName: string;
  linkedInventoryId?: string;
  quantity?: number | null;
  unit?: string | null;
  category?: string | null;
  priority: string;
  notes?: string | null;
}

export interface BuyListActor {
  uid: string;
  name?: string;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Add an item to the buy list, de-duplicating against existing OPEN entries.
 * Returns `{ created: false, id }` (no new doc) when a matching open entry
 * already exists, else `{ created: true, id }` for the freshly created doc.
 */
export async function addToBuyList(
  entry: BuyListEntry,
  actor: BuyListActor,
): Promise<{ created: boolean; id: string }> {
  const buyList = collection(db, 'buyList');

  // Look for an existing OPEN entry to avoid a duplicate order.
  let existingId: string | null = null;
  if (entry.linkedInventoryId) {
    const snap = await getDocs(query(
      buyList,
      where('linkedInventoryId', '==', entry.linkedInventoryId),
      where('status', 'in', OPEN_STATUSES as unknown as string[]),
    ));
    if (!snap.empty) existingId = snap.docs[0].id;
  } else {
    const wanted = normalizeName(entry.itemName);
    const snap = await getDocs(query(
      buyList,
      where('status', 'in', OPEN_STATUSES as unknown as string[]),
    ));
    const match = snap.docs.find(
      (d) => normalizeName(String((d.data() as { itemName?: string }).itemName ?? '')) === wanted,
    );
    if (match) existingId = match.id;
  }

  if (existingId) {
    // Already on the list; optionally bump quantity so the newer, larger need wins.
    if (entry.quantity != null) {
      await updateDoc(doc(db, 'buyList', existingId), { quantity: entry.quantity });
    }
    return { created: false, id: existingId };
  }

  const ref = await addDoc(buyList, {
    itemName: entry.itemName.trim(),
    quantity: entry.quantity ?? null,
    unit: entry.unit ?? null,
    category: entry.category ?? null,
    priority: entry.priority,
    notes: entry.notes ?? null,
    ...(entry.linkedInventoryId ? { linkedInventoryId: entry.linkedInventoryId } : {}),
    status: 'pending',
    addedBy: actor.uid || 'unknown',
    addedByName: actor.name || 'Unknown',
    addedAt: serverTimestamp(),
  });
  return { created: true, id: ref.id };
}

// ─── Delivery → intake ────────────────────────────────────────────────────────

export interface BuyListDeliveryPlan {
  seq: number;
  idempotencyKey: string;
  receivedQuantity: number;
  intakeStatus: 'needed' | 'partial' | 'posted';
  status: BuyListItem['status'];
}

function intakeStatusFor(
  anyUnposted: boolean,
  status: BuyListItem['status'],
): 'needed' | 'partial' | 'posted' {
  if (anyUnposted) return 'needed';
  return status !== 'received' ? 'partial' : 'posted';
}

/**
 * Pure planner for one delivery against a buy-list entry. Deterministic from
 * the entry's current state, so a retry computes the same seq / idempotency key.
 */
export function planBuyListDelivery(
  entry: BuyListItem,
  input: { quantity: number; final: boolean; post: boolean },
): BuyListDeliveryPlan {
  const { quantity } = input;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Quantity received must be a positive whole number');
  }
  const seq = (entry.deliveries?.length ?? 0) + 1;
  const receivedQuantity = (entry.receivedQuantity ?? 0) + quantity;
  const complete =
    input.final || (entry.quantity != null && receivedQuantity >= entry.quantity);
  const status: BuyListItem['status'] = complete
    ? 'received'
    : entry.status === 'pending'
      ? 'ordered'
      : entry.status;
  const anyUnposted = !input.post || (entry.deliveries ?? []).some((d) => !d.posted);
  return {
    seq,
    idempotencyKey: `buylist_${entry.id}_${seq}`,
    receivedQuantity,
    intakeStatus: intakeStatusFor(anyUnposted, status),
    status,
  };
}

export interface BuyListDeliveryArgs {
  quantity: number;
  final: boolean;
  /** Post stock now (requires `item`). False = "delivered — intake later". */
  post: boolean;
  item?: InventoryItem;
  /** Units per package */
  perUnit?: number;
  lotNumber?: string;
  expirationMonth?: string;
  supplier?: string;
  notes?: string;
}

function stockInput(
  quantity: number,
  args: BuyListDeliveryArgs,
  idempotencyKey: string,
) {
  return {
    qty: quantity,
    perUnit: args.perUnit ?? 1,
    lotNumber: args.lotNumber,
    expirationMonth: args.expirationMonth,
    supplier: args.supplier,
    notes: args.notes,
    idempotencyKey,
  };
}

/**
 * Thrown when another delivery claimed the same sequence slot on this entry
 * (two people receiving the same order at once). Nothing of ours was posted;
 * the caller should reload the entry and submit again.
 */
export class BuyListDeliveryConflictError extends Error {
  constructor() {
    super('Another delivery for this order was just recorded. Yours was not added. Close this, reopen the entry, and submit again.');
    this.name = 'BuyListDeliveryConflictError';
  }
}

/** True when an already-recorded delivery is this actor's own earlier attempt (a retry). */
function isOwnAttempt(d: BuyListDelivery, actor: BuyListActor, quantity: number): boolean {
  return d.by === (actor.uid || 'unknown') && d.quantity === quantity;
}

/**
 * Post stock; a duplicate for OUR key means a previous attempt already wrote it.
 * A duplicate written by someone else under the same key is a conflict, not success.
 */
async function postStockIdempotent(
  item: InventoryItem,
  input: ReturnType<typeof stockInput>,
  actor: BuyListActor,
  /** False for posting an earlier delivery: anyone's write under that key means it is already in stock. */
  strictOwner = true,
): Promise<void> {
  try {
    await addShipment(item, input, { uid: actor.uid, name: actor.name ?? 'Unknown' });
  } catch (err) {
    if (!(err instanceof DuplicateShipmentError)) throw err;
    if (!strictOwner) return;
    const log = await getDoc(doc(db, 'inventory_logs', `intake_${input.idempotencyKey.replace(/\//g, '_')}`));
    const loggedBy = log.exists() ? (log.data() as { userId?: string }).userId : undefined;
    if (loggedBy && loggedBy !== actor.uid) throw new BuyListDeliveryConflictError();
  }
}

/**
 * Record a delivery against a buy-list entry, optionally posting stock in the
 * same pass. Retry-safe: stock is keyed by `buylist_<id>_<seq>` (atomic with its
 * log in addShipment) and the buy-list write skips an already-appended key.
 */
export async function postBuyListDelivery(
  entry: BuyListItem,
  args: BuyListDeliveryArgs,
  actor: BuyListActor,
): Promise<BuyListDeliveryPlan> {
  if (!entry.id) throw new Error('Buy list entry has no id');
  const posting = args.post && !!args.item;
  const plan = planBuyListDelivery(entry, {
    quantity: args.quantity,
    final: args.final,
    post: posting,
  });
  if (args.post && !args.item) throw new Error('Pick an inventory item to add stock');
  if (posting && !(args.perUnit && args.perUnit > 0)) {
    throw new Error('Units per package must be greater than zero');
  }

  const ref = doc(db, 'buyList', entry.id);
  // Re-read before touching stock: a delivery already recorded under this key is
  // either our own earlier attempt (done) or someone else's (conflict).
  const current = await getDoc(ref);
  if (!current.exists()) throw new Error('Buy list entry no longer exists');
  const prior = ((current.data() as BuyListItem).deliveries ?? []).find(
    (d) => d.idempotencyKey === plan.idempotencyKey,
  );
  if (prior) {
    if (isOwnAttempt(prior, actor, args.quantity)) return plan;
    throw new BuyListDeliveryConflictError();
  }

  if (posting && args.item) {
    await postStockIdempotent(
      args.item,
      stockInput(args.quantity, args, plan.idempotencyKey),
      actor,
    );
  }

  const delivery: BuyListDelivery = removeUndefined({
    seq: plan.seq,
    quantity: args.quantity,
    units: args.perUnit && args.perUnit > 0 ? args.quantity * args.perUnit : 0,
    inventoryItemId: args.item?.id,
    idempotencyKey: plan.idempotencyKey,
    posted: posting,
    at: new Date(),
    by: actor.uid || 'unknown',
    byName: actor.name,
  });

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Buy list entry no longer exists');
    const fresh = { ...(snap.data() as BuyListItem), id: entry.id };
    const existing = (fresh.deliveries ?? []).find((d) => d.idempotencyKey === plan.idempotencyKey);
    if (existing) {
      if (isOwnAttempt(existing, actor, args.quantity)) return; // recorded by an earlier attempt
      throw new BuyListDeliveryConflictError();
    }
    // Totals come from the fresh doc, never the (possibly stale) entry the form opened with.
    const freshPlan = planBuyListDelivery(fresh, {
      quantity: args.quantity,
      final: args.final,
      post: posting,
    });
    const update: Record<string, unknown> = {
      receivedQuantity: freshPlan.receivedQuantity,
      intakeStatus: freshPlan.intakeStatus,
      status: freshPlan.status,
      deliveries: [...(fresh.deliveries ?? []), delivery],
    };
    if (args.item?.id && args.item.id !== fresh.linkedInventoryId) {
      update.linkedInventoryId = args.item.id;
    }
    if (fresh.status === 'pending' && freshPlan.status !== 'pending') {
      update.orderedAt = serverTimestamp();
    }
    if (freshPlan.status === 'received') {
      update.receivedAt = serverTimestamp();
      update.completedBy = actor.uid || 'unknown';
      update.completedByName = actor.name || 'Unknown';
    }
    tx.update(ref, update);
  });
  return plan;
}

/**
 * Post the stock for an earlier delivery recorded with `posted: false`
 * ("delivered — intake later"), flipping that delivery to posted.
 */
export async function postPendingIntake(
  entry: BuyListItem,
  seq: number,
  args: Omit<BuyListDeliveryArgs, 'quantity' | 'final' | 'post'> & { item: InventoryItem },
  actor: BuyListActor,
): Promise<void> {
  if (!entry.id) throw new Error('Buy list entry has no id');
  const target = (entry.deliveries ?? []).find((d) => d.seq === seq);
  if (!target) throw new Error('Delivery not found on this entry');
  if (!(args.perUnit && args.perUnit > 0)) {
    throw new Error('Units per package must be greater than zero');
  }
  if (!target.posted) {
    await postStockIdempotent(
      args.item,
      stockInput(target.quantity, { ...args, quantity: target.quantity, final: false, post: true }, target.idempotencyKey),
      actor,
      false,
    );
  }

  const ref = doc(db, 'buyList', entry.id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Buy list entry no longer exists');
    const fresh = snap.data() as BuyListItem;
    const deliveries = fresh.deliveries ?? [];
    const cur = deliveries.find((d) => d.idempotencyKey === target.idempotencyKey);
    if (!cur || cur.posted) return;
    const next = deliveries.map((d) =>
      d.idempotencyKey === target.idempotencyKey
        ? removeUndefined({
            ...d,
            posted: true,
            units: d.quantity * (args.perUnit as number),
            inventoryItemId: args.item.id,
          })
        : d,
    );
    const update: Record<string, unknown> = {
      deliveries: next,
      intakeStatus: intakeStatusFor(next.some((d) => !d.posted), fresh.status),
    };
    if (args.item.id !== fresh.linkedInventoryId) update.linkedInventoryId = args.item.id;
    tx.update(ref, update);
  });
}
