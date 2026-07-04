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
} from 'firebase/firestore';
import { db } from '@/firebase';

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
