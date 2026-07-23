'use client';

import { collection, doc, getDoc, setDoc, serverTimestamp, query, where, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '@/firebase';
import type { Statpack } from '@/app/types';
import { computeStatpackAssetValue } from '@/app/lib/inventory';

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
    const sanitized = removeUndefined(duplicate);
    
    await setDoc(newRef, sanitized);
    
    return newRef.id;
  } catch (error) {
    console.error('Failed to duplicate statpack:', error);
    throw error;
  }
}

/**
 * Persist an edited statpack's contents/config (the StatpackEditorModal save
 * path). Both call sites that used to do a raw `updateDoc(doc(db,'statpacks',id),
 * {...draft})` with no sanitization and no logging should route through here
 * instead:
 *  - strips `undefined` values (Firestore rejects them — the raw updateDoc
 *    call sites did not do this),
 *  - stamps `contentsUpdatedAt` (declared on the type, previously written
 *    nowhere), which drives the "contents changed since last audit" indicator,
 *  - emits a `statpack_logs` row with `action: 'content_edit'` (declared on
 *    `StatpackLog['action']`, previously never emitted) so the edit shows up
 *    in the pack's activity log.
 *
 * `draft` must carry its Firestore id (`draft.id`).
 */
export async function saveStatpackContents(
  draft: Statpack,
  actor: { uid?: string; name?: string },
): Promise<void> {
  if (!draft.id) throw new Error('Cannot save statpack contents without an id');

  const { id, ...rest } = draft;
  const payload = removeUndefined({
    ...rest,
    contentsUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }) as Record<string, unknown>;

  const logPayload = removeUndefined({
    statpackId: id,
    statpackName: draft.name,
    action: 'content_edit',
    userId: actor.uid || 'unknown',
    userName: actor.name || 'Unknown',
    timestamp: serverTimestamp(),
  }) as Record<string, unknown>;

  const batch = writeBatch(db);
  batch.update(doc(db, 'statpacks', id), payload);
  batch.set(doc(collection(db, 'statpack_logs')), logPayload);
  await batch.commit();
}

/**
 * Remove undefined values from an object recursively
 */
function removeUndefined(obj: unknown): unknown {
  if (obj === undefined) return undefined;
  if (obj === null) return null;
  if (obj instanceof Date) return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => removeUndefined(item)).filter(item => item !== undefined);
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    Object.keys(obj as Record<string, unknown>).forEach(key => {
      const value = removeUndefined((obj as Record<string, unknown>)[key]);
      if (value !== undefined) {
        result[key] = value;
      }
    });
    return result;
  }
  return obj;
}
