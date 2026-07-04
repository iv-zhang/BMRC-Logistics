/**
 * Lot recall / quarantine.
 *
 * A recall is a single action that must cascade everywhere the lot lives
 * (INV-7 / HR-9): it quarantines the batch on the inventory doc AND flips every
 * Statpack that carries that lot to a not-service-ready status, atomically as far
 * as practical (batched writes), and leaves an audit trail.
 *
 * Firestore cannot array-query a nested field (`contents[].batchId`), so we fetch
 * statpacks and filter in JS. Statpack counts are small (dozens), so this is fine
 * at BMRC scale.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  writeBatch,
  serverTimestamp,
  addDoc,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryBatch, InventoryItem, Statpack } from '@/app/types';
import { recordAuditEvent, removeUndefined } from '@/app/lib/audit';

export interface RecallActor {
  uid: string;
  name: string;
  email?: string;
}

/** Max writes per Firestore WriteBatch is 500; stay well under it. */
const BATCH_CHUNK = 400;

/**
 * Recall a specific lot of an inventory item.
 *
 * (a) sets that batch's `status` to `'quarantined'` on the inventory doc so it is
 *     immediately excluded from available stock (see computeBagStock/getItemStatus);
 * (b) finds every statpack whose `contents[].batchId === batchId` and sets its
 *     `status` to a not-ready value (`'Expired Items'`), stamping `updatedAt`;
 * (c) writes an `inventory_logs` row and an `auditEvents` entry.
 *
 * @returns which packs were flipped.
 */
export async function recallLot(params: {
  itemId: string;
  batchId: string;
  actor: RecallActor;
}): Promise<{ quarantined: boolean; packsFlipped: string[] }> {
  const { itemId, batchId, actor } = params;

  const itemRef = doc(db, 'inventory', itemId);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Inventory item ${itemId} not found`);

  const item = snap.data() as InventoryItem;
  const batches = (item.batches || []) as InventoryBatch[];
  const target = batches.find(b => b.id === batchId);
  if (!target) throw new Error(`Batch ${batchId} not found on inventory item ${itemId}`);

  const updatedBatches = batches.map(b =>
    b.id === batchId ? { ...b, status: 'quarantined' as const } : b,
  );

  // Find affected statpacks (nested-field filter must happen client-side).
  const packSnap = await getDocs(collection(db, 'statpacks'));
  const affected = packSnap.docs.filter(d => {
    const contents = ((d.data() as Statpack).contents || []) as Statpack['contents'];
    return Array.isArray(contents) && contents.some(c => c.batchId === batchId);
  });

  // Commit the inventory quarantine + pack flips in chunked batches (resilient at
  // any scale, even if a lot somehow lives in hundreds of packs).
  const packsFlipped: string[] = [];
  let batch = writeBatch(db);
  let n = 0;
  const flush = async () => { await batch.commit(); batch = writeBatch(db); n = 0; };

  batch.update(itemRef, { batches: updatedBatches, updatedAt: serverTimestamp() });
  n++;
  for (const p of affected) {
    batch.update(p.ref, { status: 'Expired Items', updatedAt: serverTimestamp() });
    packsFlipped.push(p.id);
    if (++n >= BATCH_CHUNK) await flush();
  }
  await batch.commit();

  // Immutable log rows (best-effort trail; do not roll back the recall on failure).
  try {
    await addDoc(collection(db, 'inventory_logs'), removeUndefined({
      itemId,
      itemName: item.name,
      action: 'recall_quarantine',
      batchId,
      lotNumber: target.lotNumber,
      newStatus: 'quarantined',
      userId: actor.uid,
      userName: actor.name,
      timestamp: serverTimestamp(),
      notes: `Lot ${target.lotNumber ?? batchId} recalled/quarantined; ${packsFlipped.length} pack(s) flipped to Expired Items`,
    } as Record<string, unknown>));
  } catch (e) {
    console.warn('recallLot: failed to write inventory_logs row', e);
  }

  try {
    await recordAuditEvent({
      eventType: 'lot_recalled',
      source: 'recall',
      sourceId: itemId,
      actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email },
      targets: [
        { collection: 'inventory', docId: itemId },
        ...packsFlipped.map(id => ({ collection: 'statpacks', docId: id })),
      ],
      details: removeUndefined({
        batchId,
        lotNumber: target.lotNumber,
        packsFlipped,
      } as Record<string, unknown>),
    });
  } catch (e) {
    console.warn('recallLot: failed to write auditEvents entry', e);
  }

  return { quarantined: true, packsFlipped };
}
