'use client';

import { collection, doc, getDoc, setDoc, serverTimestamp, query, where, getDocs } from 'firebase/firestore';
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
