'use client';

import { collection, doc, getDoc, setDoc, serverTimestamp, query, where, getDocs, writeBatch, runTransaction } from 'firebase/firestore';
import { db } from '@/firebase';
import type { Statpack, StatpackShortageSnapshot } from '@/app/types';
import { computeStatpackAssetValue } from '@/app/lib/inventory';
import { getPackShortages } from '@/app/lib/statpack-shortages';
import { recordAuditEvent, deepRemoveUndefined } from '@/app/lib/audit';
import { coerceTimestamp } from '@/app/lib/timestamps';

/**
 * Duplicate a statpack: create a copy with new ID, sanitized timestamps, and " (copy)" suffix
 * Useful for admins who want to create multiple statpacks with similar contents
 * 
 * @param statpackId - The ID of the statpack to duplicate
 * @returns The ID of the newly created statpack
 */
export async function duplicateStatpack(statpackId: string): Promise<string> {
  try {
    // Fetch the original statpack
    const originalRef = doc(db, 'statpacks', statpackId);
    const originalSnap = await getDoc(originalRef);
    
    if (!originalSnap.exists()) {
      throw new Error('Statpack not found');
    }
    
    const original = originalSnap.data() as Statpack;
    
    // Find a unique name by appending " (copy)" or " (copy N)"
    let copyName = `${original.name} (copy)`;
    let copyNumber = 1;
    
    // Check if a statpack with this name already exists
    while (true) {
      const existingQuery = query(
        collection(db, 'statpacks'),
        where('name', '==', copyName)
      );
      const existingSnap = await getDocs(existingQuery);
      
      if (existingSnap.empty) break;
      
      copyNumber++;
      copyName = `${original.name} (copy ${copyNumber})`;
    }
    
    // Create new statpack document with sanitized data
    const newRef = doc(collection(db, 'statpacks'));
    const now = serverTimestamp();
    
    // Clone contents (deep copy to avoid reference issues)
    const contents = (original.contents || []).map(item => ({
      ...item,
      // Preserve all item details but reset current quantities to required
      currentQuantity: item.requiredQuantity,
    }));
    
    // Clone compartments
    const compartments = (original.compartments || []).map(comp => ({
      ...comp,
      // Reset seal information for the copy
      isSealed: false,
      sealNumber: undefined,
    }));
    
    // Build the new statpack object
    const duplicate = {
      name: copyName,
      type: original.type,
      status: 'Pending Initial Check', // New pack needs initial verification
      compartments,
      contents,
      isCheckedOut: false,
      assignedToUserId: undefined,
      assignedToUserName: undefined,
      checkedOutAt: undefined,
      lastCheckedBy: undefined,
      lastCheckedAt: undefined,
      currentEvent: undefined,
      createdAt: now,
      updatedAt: now,
      // Recalculate asset value from contents
      assetValue: computeStatpackAssetValue({ contents } as Statpack),
      currentLocation: original.currentLocation || '',
      assetSerial: undefined, // New pack needs new serial assignment
      maintenance_logs: [], // Start fresh with no maintenance history
    };
    
    // Remove undefined values before writing to Firestore
    const sanitized = deepRemoveUndefined(duplicate);
    
    await setDoc(newRef, sanitized);
    
    return newRef.id;
  } catch (error) {
    console.error('Failed to duplicate statpack:', error);
    throw error;
  }
}

/** The only fields a contents editor may persist from its draft. */
export function buildStatpackEditorPatch(draft: Statpack, seed: Statpack): Record<string, unknown> {
  // Normalize nested inventory convenience dates too: old JSON-cloned drafts
  // can carry map dates in itemDetails, batches, and asset verification data.
  const normalize = (value: unknown, key = ''): unknown => {
    if (value === null || value === undefined) return value;
    if (value instanceof Date || /(?:At|Date|Expiration)$/.test(key) ||
        ['assetLastChecked', 'timestamp', 'date', 'at', 'expiresOn'].includes(key)) {
      const timestamp = coerceTimestamp(value);
      if (timestamp) return timestamp;
      if (value !== '') throw new Error('An item date could not be read. Reopen the editor.');
      return undefined;
    }
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (typeof value === 'object') {
      // Timestamp instances and serialized Timestamp maps can occur anywhere.
      const timestamp = coerceTimestamp(value);
      if (timestamp) return timestamp;
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
    }
    return value;
  };
  return deepRemoveUndefined({
    name: draft.name,
    currentLocation: draft.currentLocation,
    contents: normalize(draft.contents),
    exchangeBagAssignments: draft.exchangeBagAssignments,
    assetValue: draft.assetValue,
    ...(draft.status !== seed.status ? { status: draft.status } : {}),
    contentsUpdatedAt: serverTimestamp(),
  });
}

/**
 * Save a contents-editor draft with its immutable opening snapshot. Ownership
 * and safety observations are never copied from the draft into the document.
 */
export async function saveStatpackContents(
  draft: Statpack,
  actor: { uid?: string; name?: string },
  seed: Statpack,
): Promise<void> {
  if (!draft.id) throw new Error('Cannot save statpack contents without an id');
  await updateStatpackDetails(draft.id, buildStatpackEditorPatch(draft, seed), actor, seed, undefined, seed);
}

/**
 * Atomically update details and their activity log against the live pack.
 * Contents writes must include the editor's opening snapshot for concurrency
 * checks. Non-editor maintenance/details callers do not need an editor seed.
 */
export async function updateStatpackDetails(
  packId: string,
  patch: Record<string, unknown>,
  actor: { uid?: string; name?: string },
  _previous: { status?: string; name?: string },
  note?: string,
  editorSeed?: Statpack,
): Promise<void> {
  if (!packId) throw new Error('Cannot update statpack details without an id');
  if ('contents' in patch && !editorSeed) {
    throw new Error('Reopen the editor before saving contents.');
  }
  const packRef = doc(db, 'statpacks', packId);
  const logRef = doc(collection(db, 'statpack_logs'));
  const payload = deepRemoveUndefined({ ...patch, updatedAt: serverTimestamp() });
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(packRef);
    if (!snapshot.exists()) throw new Error('Statpack not found');
    const live = snapshot.data();
    const nextStatus = typeof patch.status === 'string' ? patch.status : undefined;
    if (live.isCheckedOut && nextStatus !== undefined && nextStatus !== 'In Use') {
      throw new Error('Check this pack in first.');
    }
    if ('contents' in patch) {
      if (!Array.isArray(patch.contents)) throw new Error('Pack contents must be a list.');
      if (patch.contents.length < (Array.isArray(live.contents) ? live.contents.length : 0)) {
        throw new Error("Items can't be removed. Set par to 0 instead.");
      }
    }
    if (editorSeed) {
      const dateVersion = (value: unknown) => {
        const timestamp = coerceTimestamp(value);
        return timestamp ? `${timestamp.seconds}:${timestamp.nanoseconds}` : JSON.stringify(value ?? null);
      };
      if (live.isCheckedOut !== editorSeed.isCheckedOut || live.status !== editorSeed.status ||
          dateVersion(live.lastCheckedAt) !== dateVersion(editorSeed.lastCheckedAt) ||
          dateVersion(live.lastAuditAt) !== dateVersion(editorSeed.lastAuditAt)) {
        throw new Error('This pack changed since you opened it. Reopen the editor.');
      }
    }
    const statusChanged = nextStatus !== undefined && nextStatus !== live.status;
    const logPayload = deepRemoveUndefined({
      statpackId: packId,
      statpackName: (typeof patch.name === 'string' && patch.name) || live.name || '',
      action: statusChanged ? 'status_change' : 'content_edit',
      statusChange: statusChanged ? { from: live.status, to: nextStatus } : undefined,
      userId: actor.uid || 'unknown',
      userName: actor.name || 'Unknown',
      timestamp: serverTimestamp(),
      notes: note?.trim() || undefined,
    });
    transaction.update(packRef, payload);
    transaction.set(logRef, logPayload);
  });
}

/**
 * Admin manual "mark Ready" override for a pack that derived `Restock Needed`
 * (e.g. an item counted at 0, which partial shortages no longer trigger) when
 * the crew is about to roll and the missing item isn't critical. Stamps who
 * overrode it, when, and a snapshot of what was short at the time so the
 * decision is auditable after the fact.
 *
 * One-shot by design: the very next `logStatpackCheckOff` (checkout, checkin,
 * or audit) clears `readyOverride` back to null regardless of what status
 * that check-off derives, so a stale override can never mask a NEW problem.
 *
 * Refuses on:
 *  - a checked-out pack (nothing to mark ready — it's in use),
 *  - `Expired Items`/`CRITICAL - EXPIRED ITEMS` status (expired/recalled
 *    stock must be physically replaced, never overridden away),
 *  - a pack that's already `Ready` (nothing to override).
 */
export async function overrideStatpackReady(
  pack: Statpack,
  actor: { uid: string; name: string },
  note?: string,
): Promise<void> {
  if (!pack.id) throw new Error('Cannot override readiness on a statpack without an id');
  if (pack.isCheckedOut) {
    throw new Error('Cannot mark a checked-out statpack Ready — check it in first');
  }
  if (pack.status.includes('Expired')) {
    throw new Error('Expired or recalled items must be physically replaced — this pack cannot be overridden to Ready');
  }
  if (pack.status === 'Ready') {
    throw new Error('This statpack is already Ready');
  }

  const { out, low } = getPackShortages(pack);
  const shortages: StatpackShortageSnapshot[] = [...out, ...low].map((s) => ({
    itemId: s.itemId,
    name: s.name,
    currentQuantity: s.currentQuantity,
    requiredQuantity: s.requiredQuantity,
  }));

  const readyOverride: Record<string, unknown> = {
    byUid: actor.uid,
    byName: actor.name,
    at: serverTimestamp(),
    previousStatus: pack.status,
    shortages,
  };
  if (note && note.trim()) readyOverride.note = note.trim();

  const payload = deepRemoveUndefined({
    status: 'Ready' as const,
    readyOverride,
    updatedAt: serverTimestamp(),
  });

  const overrideNote = note?.trim();
  const logPayload = deepRemoveUndefined({
    statpackId: pack.id,
    statpackName: pack.name,
    action: 'status_change',
    statusChange: { from: pack.status, to: 'Ready' },
    userId: actor.uid || 'unknown',
    userName: actor.name || 'Unknown',
    timestamp: serverTimestamp(),
    notes: overrideNote ? `Manual Ready override: ${overrideNote}` : 'Manual Ready override',
  }) as Record<string, unknown>;

  const batch = writeBatch(db);
  batch.update(doc(db, 'statpacks', pack.id), payload as Record<string, unknown>);
  batch.set(doc(collection(db, 'statpack_logs')), logPayload);
  await batch.commit();

  // Best-effort ledger entry — an audit-log failure must never block the
  // override itself.
  try {
    await recordAuditEvent({
      eventType: 'statpack_ready_override',
      source: 'statpacks',
      sourceId: pack.id,
      actor: { userId: actor.uid, userName: actor.name },
      targets: [{ collection: 'statpacks', docId: pack.id }],
      before: { status: pack.status },
      after: { status: 'Ready' },
      details: { note: note?.trim() || undefined, shortages },
    });
  } catch (e) {
    console.warn('overrideStatpackReady: audit ledger write failed (non-fatal)', e);
  }
}

