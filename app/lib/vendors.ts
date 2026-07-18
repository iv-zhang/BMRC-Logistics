/**
 * Vendor list for Log Purchase.
 *
 * A lightweight `vendors` Firestore collection (docs: `{ name, createdAt }`)
 * backing the vendor Autocomplete in `purchase-modal.tsx`. Mirrors the seed /
 * subscribe pattern in `org-config-store.ts`, scaled down — there is no
 * runtime-config merge here, just a plain ordered list.
 */

import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';

export interface Vendor {
  id: string;
  name: string;
}

const VENDORS_COLLECTION = 'vendors';
const SEED_VENDOR_NAMES = ['Bound Tree Medical', 'Amazon'];

function vendorsCollection() {
  return collection(db, VENDORS_COLLECTION);
}

/** Subscribe to the vendor list, ordered by name. Returns an unsubscribe fn. */
export function subscribeVendors(cb: (vendors: Vendor[]) => void): () => void {
  const q = query(vendorsCollection(), orderBy('name'));
  return onSnapshot(
    q,
    (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, name: (d.data().name as string) || '' })));
    },
    (err) => {
      console.warn('subscribeVendors: snapshot error', err);
      cb([]);
    },
  );
}

/**
 * Add a new vendor if it doesn't already exist (case-insensitive dedupe).
 * No-op if a matching vendor is already present.
 */
export async function addVendor(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  const snap = await getDocs(vendorsCollection());
  const exists = snap.docs.some(
    (d) => ((d.data().name as string) || '').trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (exists) return;

  await addDoc(vendorsCollection(), {
    name: trimmed,
    createdAt: serverTimestamp(),
  });
}

/**
 * Seed the vendors collection with defaults ("Bound Tree Medical", "Amazon")
 * if it is currently empty. Idempotent; safe to call on every modal open.
 */
export async function seedVendorsIfMissing(): Promise<void> {
  try {
    const snap = await getDocs(vendorsCollection());
    if (!snap.empty) return;
    await Promise.all(
      SEED_VENDOR_NAMES.map((name) =>
        addDoc(vendorsCollection(), { name, createdAt: serverTimestamp() }),
      ),
    );
  } catch (e) {
    console.warn('seedVendorsIfMissing: skipped', e);
  }
}
