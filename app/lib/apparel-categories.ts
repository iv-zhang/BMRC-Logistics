/**
 * Write helpers for admin-managed `apparel_categories` docs (Uniform Exchange
 * garment categories — replaces the old hardcoded `ApparelGarmentType`
 * union). Categories are never hard-deleted: "delete" is archive
 * (`active: false`), never a real removal, so a garment's `categoryId`
 * always keeps resolving.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { removeUndefined } from '@/app/lib/audit';
import type { ApparelActor } from '@/app/lib/apparel';
import type { ApparelCategory, ApparelItemStatus } from '@/app/types';

const ACTIVE_GARMENT_STATUSES: ApparelItemStatus[] = ['available', 'claimed', 'on_loan'];

function categoryRef(categoryId: string) {
  return doc(db, 'apparel_categories', categoryId);
}

/**
 * Create a new category. Plain `addDoc` (via a pre-fetched next id below) —
 * nothing to race against. `sortOrder` is the current max across all
 * existing categories plus 1, so a fresh category always sorts last.
 */
export async function createApparelCategory(
  input: { name: string },
  actor: ApparelActor,
): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error('Category name is required.');

  const existing = await getDocs(collection(db, 'apparel_categories'));
  const sortOrder = Math.max(
    ...existing.docs.map((d) => (d.data() as ApparelCategory).sortOrder),
    -1,
  ) + 1;

  const ref = await addDoc(collection(db, 'apparel_categories'), removeUndefined({
    name,
    active: true,
    sortOrder,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  return ref.id;
}

/** Archive a category (the only "delete"). Never blocked by garment status. */
export async function archiveApparelCategory(categoryId: string, actor: ApparelActor): Promise<void> {
  const ref = categoryRef(categoryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Category not found');
  const category = snap.data() as ApparelCategory;

  if (category.active === false) throw new Error('This category is already archived.');

  await updateDoc(ref, removeUndefined({
    active: false,
    archivedAt: serverTimestamp(),
    archivedBy: actor.uid,
    updatedAt: serverTimestamp(),
  }));
}

/** Bring an archived category back to active. */
export async function reactivateApparelCategory(categoryId: string, actor: ApparelActor): Promise<void> {
  void actor;
  const ref = categoryRef(categoryId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Category not found');
  const category = snap.data() as ApparelCategory;

  if (category.active === true) throw new Error('This category is not archived.');

  await updateDoc(ref, {
    active: true,
    archivedAt: null,
    archivedBy: null,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Swap the `sortOrder` of two categories. A true transaction — two admins
 * reordering at once must not lose an update.
 */
export async function swapApparelCategorySortOrder(categoryIdA: string, categoryIdB: string): Promise<void> {
  const refA = categoryRef(categoryIdA);
  const refB = categoryRef(categoryIdB);

  await runTransaction(db, async (tx) => {
    const [snapA, snapB] = await Promise.all([tx.get(refA), tx.get(refB)]);
    if (!snapA.exists() || !snapB.exists()) throw new Error('Category not found');

    const sortOrderA = (snapA.data() as ApparelCategory).sortOrder;
    const sortOrderB = (snapB.data() as ApparelCategory).sortOrder;

    tx.update(refA, { sortOrder: sortOrderB, updatedAt: serverTimestamp() });
    tx.update(refB, { sortOrder: sortOrderA, updatedAt: serverTimestamp() });
  });
}

/**
 * Seed the seven default categories the first time the collection is empty.
 * Best-effort and safe to call speculatively from a non-admin client — never
 * throws, since Firestore permission errors are expected there once rules
 * are eventually tightened.
 */
export async function seedDefaultApparelCategoriesIfEmpty(actor: ApparelActor): Promise<void> {
  try {
    const existing = await getDocs(collection(db, 'apparel_categories'));
    if (!existing.empty) return;

    const defaultNames = ['Shirt', 'Polo', 'Pants', 'Jacket', 'Hat', 'Boots', 'Other'];
    const batch = writeBatch(db);
    defaultNames.forEach((name, sortOrder) => {
      const ref = doc(collection(db, 'apparel_categories'));
      batch.set(ref, removeUndefined({
        name,
        sortOrder,
        active: true,
        createdBy: actor.uid,
        createdByName: actor.name,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));
    });
    await batch.commit();
  } catch (e) {
    console.warn('apparel-categories: seed failed', e);
  }
}

/** How many currently-active garments a category holds — used to warn an admin before archiving. */
export async function countActiveApparelGarmentsInCategory(categoryId: string): Promise<number> {
  const snap = await getDocs(query(
    collection(db, 'apparel_items'),
    where('categoryId', '==', categoryId),
    where('status', 'in', ACTIVE_GARMENT_STATUSES),
  ));
  return snap.size;
}

/**
 * Subscribe to all categories (active and archived) — callers sort/filter
 * client-side by `sortOrder`/`active`.
 */
export function subscribeApparelCategories(callback: (categories: ApparelCategory[]) => void): () => void {
  return onSnapshot(
    collection(db, 'apparel_categories'),
    (snap) => {
      callback(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ApparelCategory) })));
    },
    (err) => {
      console.error('apparel-categories subscription error:', err);
      callback([]);
    },
  );
}
