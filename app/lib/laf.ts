/**
 * LAF (Letter of Authorization / Formulary) gate for controlled and
 * authorized items.
 *
 * Controlled or otherwise authorization-gated meds (epi, narcan, …) may not be
 * received or dispensed unless a current LAF is on file. `laf_records` is the
 * authorization ledger: one doc per authorized item, `onFile: true` while the
 * authorization stands, with an optional `expiresAt`. This helper is the single
 * enforcement point — call it before any receive/dispense of a gated item.
 */

import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/firebase';

/** A LAF is valid if `expiresAt` is absent or still in the future. */
function toMillis(v: unknown): number | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.getTime();
  if (typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().getTime();
  }
  return undefined;
}

/**
 * Throw unless a current LAF is on file for `itemId`. A record counts when
 * `onFile === true` and (if it carries an `expiresAt`) it has not expired.
 */
export async function assertLafOnFile(itemId: string): Promise<void> {
  const snap = await getDocs(
    query(collection(db, 'laf_records'), where('itemId', '==', itemId)),
  );

  const now = Date.now();
  const hasCurrent = snap.docs.some((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.onFile !== true) return false;
    const expMs = toMillis(data.expiresAt);
    if (expMs !== undefined && expMs < now) return false; // lapsed authorization
    return true;
  });

  if (!hasCurrent) {
    throw new Error('No LAF on file for this controlled/authorized item');
  }
}
