/**
 * Client-side utility to fix broken serverTimestamp() sentinels in statpack_logs.
 *
 * The deepRemoveUndefined() sanitizer was destructuring FieldValue sentinels into
 * plain objects {_methodName: 'serverTimestamp'} before Firestore could resolve them.
 *
 * Two modes:
 *  1. fixBrokenTimestamps() — bulk scan all docs (for the admin fix page).
 *  2. isBrokenTimestamp() + repairDocTimestamp() — inline repair during normal reads
 *     so the UI auto-heals broken docs lazily.
 */

import { collection, getDocs, getDoc, updateDoc, serverTimestamp, type DocumentReference } from 'firebase/firestore';
import { db } from '@/firebase';

// ---------------------------------------------------------------------------
// Detection helper — used by both bulk fix and inline repair
// ---------------------------------------------------------------------------
export function isBrokenTimestamp(ts: unknown): boolean {
  if (!ts || typeof ts !== 'object') return false;
  const obj = ts as Record<string, unknown>;
  // A valid Firestore Timestamp has toDate(); a broken sentinel doesn't
  if (typeof (obj as Record<string, unknown>).toDate === 'function') return false;
  // Broken sentinel: {_methodName: 'serverTimestamp'} or similar shape
  if (obj._methodName === 'serverTimestamp') return true;
  // Valid raw Firestore timestamp-like object with seconds
  if ('seconds' in obj && typeof obj.seconds === 'number') return false;
  // Date objects are fine
  if (ts instanceof Date) return false;
  return false; // Don't aggressively flag other shapes as broken
}

// ---------------------------------------------------------------------------
// Inline repair — fire-and-forget update when a doc is read with broken ts.
// IMPORTANT: Uses clientTimestamp (if stored on the doc) to preserve original
// action time. Falls back to serverTimestamp() only as last resort.
// ---------------------------------------------------------------------------
const _repairing = new Set<string>(); // avoid duplicate concurrent repairs
export function repairDocTimestamp(ref: DocumentReference): void {
  const path = ref.path;
  if (_repairing.has(path)) return;
  _repairing.add(path);

  // Read the doc to check for a clientTimestamp fallback
  getDoc(ref)
    .then((snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      // If the doc has a valid clientTimestamp, use that instead of serverTimestamp()
      // This preserves the original action time rather than overwriting with "now"
      const clientTs = data?.clientTimestamp;
      let repairValue: unknown = serverTimestamp();
      if (clientTs) {
        if (typeof clientTs.toDate === 'function') {
          repairValue = clientTs; // Already a Firestore Timestamp — keep it
        } else if (clientTs instanceof Date) {
          repairValue = clientTs;
        } else if (typeof clientTs === 'string') {
          const parsed = new Date(clientTs);
          if (!isNaN(parsed.getTime())) repairValue = parsed;
        }
      }
      return updateDoc(ref, { timestamp: repairValue });
    })
    .then(() => console.log(`[repairDocTimestamp] Fixed ${path}`))
    .catch((err) => console.warn(`[repairDocTimestamp] Failed ${path}:`, err))
    .finally(() => _repairing.delete(path));
}

// ---------------------------------------------------------------------------
// Bulk repair (for the admin fix page)
// ---------------------------------------------------------------------------
export async function fixBrokenTimestamps(): Promise<{
  total: number;
  fixed: number;
  alreadyOk: number;
  errors: string[];
}> {
  const result = { total: 0, fixed: 0, alreadyOk: 0, errors: [] as string[] };

  try {
    const snap = await getDocs(collection(db, 'statpack_logs'));
    result.total = snap.size;

    console.log(`[fixBrokenTimestamps] Scanning ${snap.size} statpack_logs...`);

    for (const docSnap of snap.docs) {
      const data = docSnap.data();

      if (!isBrokenTimestamp(data.timestamp)) {
        result.alreadyOk++;
        continue;
      }

      try {
        // Prefer clientTimestamp to preserve original action time
        const clientTs = data.clientTimestamp;
        let repairValue: unknown = serverTimestamp();
        if (clientTs) {
          if (typeof clientTs.toDate === 'function') {
            repairValue = clientTs;
          } else if (clientTs instanceof Date) {
            repairValue = clientTs;
          } else if (typeof clientTs === 'string') {
            const parsed = new Date(clientTs);
            if (!isNaN(parsed.getTime())) repairValue = parsed;
          }
        }
        await updateDoc(docSnap.ref, { timestamp: repairValue });
        result.fixed++;
        console.log(
          `[fixBrokenTimestamps] Fixed ${docSnap.id} (${data.action} on ${data.statpackName}) using ${clientTs ? 'clientTimestamp' : 'serverTimestamp'}`
        );
      } catch (err) {
        const msg = `Failed to fix ${docSnap.id}: ${err instanceof Error ? err.message : err}`;
        result.errors.push(msg);
        console.error(`[fixBrokenTimestamps] ${msg}`);
      }
    }

    console.log(
      `[fixBrokenTimestamps] Done. Total: ${result.total}, Fixed: ${result.fixed}, Already OK: ${result.alreadyOk}, Errors: ${result.errors.length}`
    );
  } catch (err) {
    const msg = `Scan failed: ${err instanceof Error ? err.message : err}`;
    result.errors.push(msg);
    console.error(`[fixBrokenTimestamps] ${msg}`);
  }

  return result;
}
