import { collection, doc, getDoc, writeBatch, serverTimestamp, addDoc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, Statpack, StatpackItem, Container, BoxLog, StatpackLog } from '@/app/types';
import { recordAuditEvent } from '@/app/lib/audit';

/**
 * Compute total asset value of a statpack from its contents.
 * Returns the sum of (itemValue * currentQuantity) for all items in the statpack.
 */
export function computeStatpackAssetValue(statpack: Statpack): number {
  if (!statpack.contents || statpack.contents.length === 0) return 0;
  return statpack.contents.reduce((total, item) => {
    const itemValue = item.itemValue ?? item.itemDetails?.assetValue ?? 0;
    const qty = item.currentQuantity ?? item.requiredQuantity ?? 1;
    return total + (itemValue * qty);
  }, 0);
}

export async function createInventoryItem(partial: Partial<InventoryItem>) {
  const now = serverTimestamp();
  const payload: any = {
    ...partial,
    createdAt: now,
    updatedAt: now,
  };
  return await addDoc(collection(db, 'inventory'), payload);
}

export async function fetchStatpackById(id: string): Promise<Statpack | null> {
  try {
    const ref = doc(db, 'statpacks', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    return { id: snap.id, ...data } as Statpack;
  } catch (e) {
    console.warn('fetchStatpackById failed', e);
    return null;
  }
}

/**
 * Batch-create inventory items based on selected statpack contents.
 * Useful for quick-adding discovered items inside a statpack during HQ walkthroughs.
 * Note: This creates new inventory docs. It will not link variant/batch details; callers may update later.
 */
export async function batchAddInventoryFromStatpack(params: {
  statpack: Statpack;
  selected: StatpackItem[];
  defaults?: Partial<InventoryItem>;
}) {
  const { statpack, selected, defaults } = params;
  const now = serverTimestamp();
  const batch = writeBatch(db);

  for (const it of selected) {
    const name = it.itemDetails?.name || (it as any).itemName || 'New Item';
    const category = it.itemDetails?.category || 'Other';
    const unit = it.itemDetails?.unit || 'count';

    const docRef = doc(collection(db, 'inventory'));
    const payload: any = {
      name,
      category,
      unit: 'box',
      location: defaults?.location || 'HQ',
      room: defaults?.room || 'Back Room',
      shelf: defaults?.shelf || '',
      unopenedBoxes: 0,
      itemsPerBox: null,
      reorderThreshold: defaults?.reorderThreshold ?? 5,
      
      description: defaults?.description ?? '',
      hasVariants: false,
      variants: [],
      batches: [],
      isOxygen: false,
      oxygenPsi: undefined,
      maxOxygenPsi: undefined,
      assignedToId: statpack.id,
      createdAt: now,
      updatedAt: now,
    };
    batch.set(docRef, payload);
  }

  await batch.commit();
}

/**
 * Fetch container by ID (used for sealed box lookups)
 */
export async function fetchContainerById(id: string): Promise<Container | null> {
  try {
    const ref = doc(db, 'containers', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() } as Container;
  } catch (e) {
    console.warn('fetchContainerById failed', e);
    return null;
  }
}

/**
 * Seal a container as a box (mark isSealed=true, record sealer)
 */
export async function sealContainerAsBox(params: {
  containerId: string;
  sealNumber: string;
  sealedBy: string;
  sealedByName?: string;
  boxContents: { itemId: string; batchId: string; quantity: number; serialNumber?: string }[];
}) {
  const { containerId, sealNumber, sealedBy, sealedByName, boxContents } = params;
  const containerRef = doc(db, 'containers', containerId);
  
  await updateDoc(containerRef, {
    isBox: true,
    isSealed: true,
    sealNumber,
    sealedAt: serverTimestamp(),
    sealedBy,
    sealedByName: sealedByName || 'Unknown',
    boxContents,
    updatedAt: serverTimestamp(),
  });

  // Log the seal action
  await addDoc(collection(db, 'box_logs'), {
    boxId: containerId,
    action: 'sealed',
    userId: sealedBy,
    userName: sealedByName || 'Unknown',
    timestamp: serverTimestamp(),
    sealNumber,
  } as BoxLog);
}

/**
 * Verify or break seal on a box during inventory check
 */
export async function checkBoxSeal(params: {
  containerId: string;
  userId: string;
  userName?: string;
  sealIntact: boolean; // true = seal ok, false = broken/tampered
  itemsCounted?: Record<string, number>;
  notes?: string;
}) {
  const { containerId, userId, userName, sealIntact, itemsCounted, notes } = params;
  const containerRef = doc(db, 'containers', containerId);

  // If seal is broken, mark as unsealed
  if (!sealIntact) {
    await updateDoc(containerRef, {
      isSealed: false,
      updatedAt: serverTimestamp(),
    });
  }

  // Always log the check
  await addDoc(collection(db, 'box_logs'), {
    boxId: containerId,
    action: sealIntact ? 'inventory_check' : 'break_seal',
    userId,
    userName: userName || 'Unknown',
    timestamp: serverTimestamp(),
    sealIntact,
    itemsCounted: itemsCounted || {},
    notes,
  } as BoxLog);
}

/**
 * Log a statpack check-off with detailed per-item entries
 */
export async function logStatpackCheckOff(params: {
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'maintenance';
  userId: string;
  userName: string;
  checkEntries: {
    itemId: string;
    itemName?: string;
    batchId?: string;
    compartmentId?: string;
    requiredQuantity: number;
    countedQuantity: number;
    ok: boolean;
    serialNumber?: string;
    notes?: string;
  }[];
  sealChecks?: Record<string, { sealed: boolean; sealNumber?: string }>;
  oxygenReadings?: Record<string, string>;
  notes?: string;
}) {
  const {
    statpackId,
    statpackName,
    action,
    userId,
    userName,
    checkEntries,
    sealChecks,
    oxygenReadings,
    notes,
  } = params;

  // Build base log object
  const logData: Partial<StatpackLog> = {
    statpackId,
    statpackName,
    action,
    userId,
    userName,
    timestamp: serverTimestamp(),
  };

  // Clean and attach check entries (remove undefined fields)
  logData.checkEntries = (checkEntries || []).map(ce => {
    const entry: any = {
      itemId: ce.itemId,
      itemName: ce.itemName,
      batchId: ce.batchId,
      compartmentId: ce.compartmentId,
      requiredQuantity: ce.requiredQuantity,
      countedQuantity: ce.countedQuantity,
      ok: ce.ok,
      serialNumber: ce.serialNumber,
      notes: ce.notes,
      checkedAt: new Date(),
      checkedBy: userId,
    };
    Object.keys(entry).forEach(k => { if (entry[k] === undefined) delete entry[k]; });
    return entry as any;
  });

  // Attach notes only if provided
  if (notes !== undefined && notes !== null) {
    (logData as any).notes = notes;
  }

  // Attach issues only if there are values (sanitize nested objects)
  const issues: any = {};
  if (sealChecks && Object.keys(sealChecks).length > 0) {
    const sanitizedSeal: Record<string, any> = {};
    Object.entries(sealChecks).forEach(([cid, val]) => {
      if (!val) return;
      const obj: any = { sealed: Boolean((val as any).sealed) };
      if ((val as any).sealNumber !== undefined && (val as any).sealNumber !== null) obj.sealNumber = (val as any).sealNumber;
      sanitizedSeal[cid] = obj;
    });
    if (Object.keys(sanitizedSeal).length > 0) issues.sealChecks = sanitizedSeal;
  }
  if (oxygenReadings && Object.keys(oxygenReadings).length > 0) {
    const sanitizedOxy: Record<string, string> = {};
    Object.entries(oxygenReadings).forEach(([k, v]) => {
      if (v !== undefined && v !== null) sanitizedOxy[k] = v as string;
    });
    if (Object.keys(sanitizedOxy).length > 0) issues.oxygenReadings = sanitizedOxy;
  }
  if (Object.keys(issues).length > 0) {
    (logData as any).issues = issues;
  }

  return await addDoc(collection(db, 'statpack_logs'), logData);
}

/**
 * Log restock needed alert for an item (for par-level tracking)
 */
export async function logRestockNeeded(params: {
  itemId: string;
  itemName: string;
  currentQuantity: number;
  parLevel: number;
  location?: string;
  userId: string;
  userName: string;
}) {
  const { itemId, itemName, currentQuantity, parLevel, location, userId, userName } = params;

  return await addDoc(collection(db, 'inventory_alerts'), {
    itemId,
    itemName,
    alertType: 'restock_needed',
    currentQuantity,
    parLevel,
    location: location || 'Unknown',
    userId,
    userName,
    timestamp: serverTimestamp(),
    resolved: false,
  });
}

/**
 * Record an asset check-in (e.g., radio, AED) with status update
 */
export async function logAssetCheckIn(params: {
  itemId: string;
  itemName: string;
  serialNumber: string;
  newStatus: 'Ready' | 'Not Ready' | 'Maintenance';
  userId: string;
  userName: string;
  notes?: string;
}) {
  const { itemId, itemName, serialNumber, newStatus, userId, userName, notes } = params;

  // Log the check-in
  await addDoc(collection(db, 'inventory_logs'), {
    itemId,
    itemName,
    action: 'asset_checkin',
    serialNumber,
    newStatus,
    userId,
    userName,
    timestamp: serverTimestamp(),
    notes,
  });

  // Update asset instance status in inventory doc (if found)
  try {
    const itemRef = doc(db, 'inventory', itemId);
    const snap = await getDoc(itemRef);
    if (snap.exists()) {
      const item = snap.data() as InventoryItem;
      if (item.assets && Array.isArray(item.assets)) {
        const updated = item.assets.map(a =>
          a.serial === serialNumber ? { ...a, status: newStatus, lastChecked: new Date() } : a
        );
        await updateDoc(itemRef, { assets: updated, updatedAt: serverTimestamp() });
      }
    }
  } catch (e) {
    console.warn('Failed to update asset status', e);
  }
}

/**
 * Determine if an item should be treated as an asset based on value threshold and category.
 * Centralizes asset classification logic.
 */
export function determineIsAsset(item: Partial<InventoryItem> | { category?: string; assetValue?: number; isAsset?: boolean }): boolean {
  // Explicit flag takes precedence
  if (item.isAsset !== undefined) return item.isAsset;
  
  // Check category-based rules (ASSET_CATEGORIES)
  const category = (item as any).category;
  if (category && ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'].includes(category)) {
    return true;
  }
  
  // Check value threshold (ASSET_VALUE_THRESHOLD = 500)
  const value = (item as any).assetValue ?? 0;
  if (value >= 500) return true;
  
  return false;
}

/**
 * Create an open batch record for an inventory item.
 * Used when a sealed box is opened and units move to "forward staging" or front area.
 * 
 * @param itemId - Firestore doc ID of the inventory item
 * @param quantity - Number of units to add to the open batch
 * @param opts - Optional metadata: batchId (reuse existing), openDate, expirationDate, lotNumber, notes, userId/userName for audit
 * @returns The created or updated batch ID
 */
export async function createOpenBatch(
  itemId: string,
  quantity: number,
  opts?: {
    batchId?: string; // If provided, add to existing batch instead of creating new one
    openDate?: Date;
    expirationDate?: Date;
    lotNumber?: string;
    notes?: string;
    userId?: string;
    userName?: string;
  }
): Promise<string> {
  const itemRef = doc(db, 'inventory', itemId);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Inventory item ${itemId} not found`);
  
  const item = snap.data() as InventoryItem;
  const batches = item.batches || [];
  
  let targetBatch = opts?.batchId ? batches.find(b => b.id === opts.batchId) : null;
  let batchId = opts?.batchId || `open-${crypto.randomUUID()}`;
  
  if (targetBatch) {
    // Update existing batch
    const updatedBatches = batches.map(b =>
      b.id === batchId ? { ...b, stock: b.stock + quantity } : b
    );
    await updateDoc(itemRef, {
      batches: updatedBatches,
      updatedAt: serverTimestamp(),
    });
  } else {
    // Create new open batch
    const newBatch: any = {
      id: batchId,
      stock: quantity,
      lotNumber: opts?.lotNumber || 'OPEN',
      notes: opts?.notes || 'Open batch created from sealed box',
    };
    if (opts?.openDate) newBatch.openDate = opts.openDate;
    if (opts?.expirationDate) newBatch.expirationDate = opts.expirationDate;
    
    await updateDoc(itemRef, {
      batches: [...batches, newBatch],
      updatedAt: serverTimestamp(),
    });
  }
  
  // Audit log
  await addDoc(collection(db, 'inventory_logs'), {
    itemId,
    itemName: item.name,
    action: 'create_open_batch',
    batchId,
    quantity,
    userId: opts?.userId || 'system',
    userName: opts?.userName || 'System',
    timestamp: serverTimestamp(),
    notes: opts?.notes,
  });
  
  return batchId;
}

/**
 * Consume (open) one or more sealed boxes and move units to an open batch.
 * This is the manual workflow for moving disposables from back (sealed) to front (open).
 * 
 * Atomically:
 * 1. Decrements unopenedBoxes
 * 2. Creates or updates an open batch with the opened units
 * 3. Writes audit logs
 * 
 * @param itemId - Firestore doc ID of the inventory item
 * @param boxCount - Number of boxes to open (defaults to 1)
 * @param opts - Optional: targetBatchId (add to existing batch), openDate, expirationDate, userId/userName for audit
 * @returns The batch ID where opened units were added
 */
export async function consumeBox(
  itemId: string,
  boxCount: number = 1,
  opts?: {
    targetBatchId?: string; // If provided, add opened units to this batch
    openDate?: Date;
    expirationDate?: Date;
    userId?: string;
    userName?: string;
    notes?: string;
  }
): Promise<string> {
  const itemRef = doc(db, 'inventory', itemId);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Inventory item ${itemId} not found`);
  
  const item = snap.data() as InventoryItem;
  const currentUnopened = item.unopenedBoxes || 0;
  
  if (currentUnopened < boxCount) {
    throw new Error(`Insufficient unopened boxes. Current: ${currentUnopened}, requested: ${boxCount}`);
  }
  
  const itemsPerBox = item.itemsPerBox || 1;
  const unitsToAdd = boxCount * itemsPerBox;
  const batches = item.batches || [];
  
  // Find or create target batch
  let targetBatch = opts?.targetBatchId ? batches.find(b => b.id === opts.targetBatchId) : null;
  const batchId = opts?.targetBatchId || `open-${crypto.randomUUID()}`;
  
  let updatedBatches;
  if (targetBatch) {
    // Add to existing batch
    updatedBatches = batches.map(b =>
      b.id === batchId ? { ...b, stock: b.stock + unitsToAdd } : b
    );
  } else {
    // Create new open batch
    const newBatch: any = {
      id: batchId,
      stock: unitsToAdd,
      lotNumber: 'OPEN',
      openDate: opts?.openDate || new Date(),
      notes: opts?.notes || `Opened ${boxCount} box(es) from sealed inventory`,
    };
    if (opts?.expirationDate) newBatch.expirationDate = opts.expirationDate;
    updatedBatches = [...batches, newBatch];
  }
  
  // Atomic update: decrement unopenedBoxes and update batches
  await updateDoc(itemRef, {
    unopenedBoxes: currentUnopened - boxCount,
    batches: updatedBatches,
    updatedAt: serverTimestamp(),
  });
  
  // Audit logs
  await addDoc(collection(db, 'inventory_logs'), {
    itemId,
    itemName: item.name,
    action: 'consume_box',
    boxCount,
    unitsAdded: unitsToAdd,
    batchId,
    beforeUnopenedBoxes: currentUnopened,
    afterUnopenedBoxes: currentUnopened - boxCount,
    userId: opts?.userId || 'system',
    userName: opts?.userName || 'System',
    timestamp: serverTimestamp(),
    notes: opts?.notes,
  });
  
  return batchId;
}

/**
 * Check out an asset (e.g., radio, AED) to a member.
 * Updates the asset status, records checkout timestamp and user, and logs the event.
 */
export async function checkoutAsset(params: {
  assetId: string; // inventory item ID
  user: { id: string; fullName?: string };
  location?: string; // Where the user reported they will be using/keeping it
  note?: string; // Optional reason or context
}): Promise<void> {
  const { assetId, user, location, note } = params;
  const itemRef = doc(db, 'inventory', assetId);
  
  // Get current asset
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Asset ${assetId} not found`);
  
  const item = snap.data() as InventoryItem;
  
  // Update asset to checked out status
  await updateDoc(itemRef, {
    assetStatus: 'Checked Out',
    checkedOutAt: serverTimestamp(),
    checkedOutBy: user.id,
    currentLocation: location,
    updatedAt: serverTimestamp(),
  });
  
  // Log the checkout event
  await addDoc(collection(db, 'inventory_logs'), {
    itemId: assetId,
    itemName: item.name,
    action: 'asset_checkout',
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    location: location || item.currentLocation,
    notes: note,
  });
  
  // Record audit event for cross-system tracking
  await recordAuditEvent({
    eventType: 'asset_checkout',
    source: 'inventory',
    sourceId: assetId,
    actor: {
      userId: user.id,
      userName: user.fullName,
    },
    targets: [{ collection: 'inventory', docId: assetId }],
    after: {
      assetStatus: 'Checked Out',
      checkedOutBy: user.id,
      currentLocation: location,
    },
    details: {
      reason: note,
    },
  });
}

/**
 * Check in an asset (e.g., radio, AED) back to inventory.
 * Updates the asset status, records checkin timestamp and user, and logs the event.
 */
export async function checkinAsset(params: {
  assetId: string; // inventory item ID
  user: { id: string; fullName?: string };
  location?: string; // Where the user is returning it to
  note?: string; // Optional reason or context (e.g., "returned in good condition")
}): Promise<void> {
  const { assetId, user, location, note } = params;
  const itemRef = doc(db, 'inventory', assetId);
  
  // Get current asset
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Asset ${assetId} not found`);
  
  const item = snap.data() as InventoryItem;
  
  // Update asset to available/ready status
  await updateDoc(itemRef, {
    assetStatus: 'Ready',
    lastCheckedInAt: serverTimestamp(),
    lastCheckedInBy: user.id,
    lastKnownReturnLocation: location,
    currentLocation: location,
    updatedAt: serverTimestamp(),
  });
  
  // Log the checkin event
  await addDoc(collection(db, 'inventory_logs'), {
    itemId: assetId,
    itemName: item.name,
    action: 'asset_checkin',
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    location: location || item.currentLocation,
    notes: note,
  });
  
  // Record audit event for cross-system tracking
  await recordAuditEvent({
    eventType: 'asset_checkin',
    source: 'inventory',
    sourceId: assetId,
    actor: {
      userId: user.id,
      userName: user.fullName,
    },
    targets: [{ collection: 'inventory', docId: assetId }],
    after: {
      assetStatus: 'Ready',
      lastCheckedInBy: user.id,
      currentLocation: location,
    },
    details: {
      reason: note,
    },
  });
}


