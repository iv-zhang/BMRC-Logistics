import { collection, doc, getDoc, getDocs, writeBatch, serverTimestamp, addDoc, updateDoc, runTransaction, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, Statpack, StatpackItem, Container, BoxLog, StatpackLog, PurchaseInfo, ValidationWarning, AssetInstance, AssetCheckResult, StatpackAuditResult } from '@/app/types';
import { recordAuditEvent, removeUndefined, deepRemoveUndefined } from '@/app/lib/audit';

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
  purchase?: PurchaseInfo;
}) {
  const { containerId, sealNumber, sealedBy, sealedByName, boxContents, purchase } = params;
  const containerRef = doc(db, 'containers', containerId);
  
  const updatePayload: any = {
    isBox: true,
    isSealed: true,
    sealNumber,
    sealedAt: serverTimestamp(),
    sealedBy,
    sealedByName: sealedByName || 'Unknown',
    boxContents,
    updatedAt: serverTimestamp(),
  };
  if (purchase) updatePayload.purchase = purchase;
  
  await updateDoc(containerRef, updatePayload);

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

  const validationWarnings = (action === 'checkout' || action === 'checkin')
    ? []
    : await validateStatpackAssignments({
        statpackId,
        checkEntries,
      });

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

  if (validationWarnings.length > 0) {
    logData.validationWarnings = validationWarnings;
  }

  const sanitizedLog = deepRemoveUndefined(logData as any);
  const logRef = await addDoc(collection(db, 'statpack_logs'), sanitizedLog as any);

  await logValidationWarningsToCollections({
    warnings: validationWarnings,
    statpackId,
    statpackName,
    userId,
    userName,
  });

  return { logRef, validationWarnings };
}

function resolveAssetInstance(item: InventoryItem, serial?: string): { matched: boolean; instance?: AssetInstance } {
  if (!serial) return { matched: false };

  if (item.assetSerial && item.assetSerial === serial) {
    return { matched: true };
  }

  const instance = (item.assets || []).find(a =>
    a.serial === serial || a.id === serial || a.assetTag === serial || a.barcode === serial || a.qr === serial
  );
  if (instance) return { matched: true, instance };

  const inBatch = (item.batches || []).some(b => Array.isArray(b.serialNumbers) && b.serialNumbers.includes(serial));
  if (inBatch) return { matched: true };

  return { matched: false };
}

export type AssetScanMatch = {
  asset: InventoryItem;
  instance?: AssetInstance;
  serial?: string;
  matchedOn: 'assetSerial' | 'assetBarcode' | 'assetQr' | 'instanceSerial' | 'instanceBarcode' | 'instanceQr' | 'instanceId' | 'instanceTag' | 'batchSerial';
};

export function findAssetByCode(assets: InventoryItem[], code: string): AssetScanMatch[] {
  const normalized = code.trim();
  if (!normalized) return [];

  const matches: AssetScanMatch[] = [];
  const matchesValue = (value?: string) => Boolean(value && (value === normalized || normalized.includes(value)));

  for (const asset of assets) {
    if (matchesValue(asset.assetSerial)) {
      matches.push({ asset, serial: asset.assetSerial, matchedOn: 'assetSerial' });
    }
    if (matchesValue(asset.barcode)) {
      matches.push({ asset, serial: asset.assetSerial, matchedOn: 'assetBarcode' });
    }
    if (matchesValue(asset.qr)) {
      matches.push({ asset, serial: asset.assetSerial, matchedOn: 'assetQr' });
    }

    const instances = asset.assets || [];
    for (const instance of instances) {
      if (matchesValue(instance.serial)) {
        matches.push({ asset, instance, serial: instance.serial, matchedOn: 'instanceSerial' });
      } else if (matchesValue(instance.barcode)) {
        matches.push({ asset, instance, serial: instance.serial, matchedOn: 'instanceBarcode' });
      } else if (matchesValue(instance.qr)) {
        matches.push({ asset, instance, serial: instance.serial, matchedOn: 'instanceQr' });
      } else if (matchesValue(instance.id)) {
        matches.push({ asset, instance, serial: instance.serial, matchedOn: 'instanceId' });
      } else if (matchesValue(instance.assetTag)) {
        matches.push({ asset, instance, serial: instance.serial, matchedOn: 'instanceTag' });
      }
    }

    const batchSerials = (asset.batches || [])
      .flatMap((b) => Array.isArray(b.serialNumbers) ? b.serialNumbers : [])
      .filter(Boolean);
    if (batchSerials.some((serial) => matchesValue(serial))) {
      matches.push({ asset, serial: normalized, matchedOn: 'batchSerial' });
    }
  }

  return matches;
}

function isExpired(date?: Date | null): boolean {
  if (!date) return false;
  const now = Date.now();
  return new Date(date).getTime() < now;
}

export async function validateStatpackAssignments(params: {
  statpackId: string;
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
}): Promise<ValidationWarning[]> {
  const { statpackId, checkEntries } = params;
  const warnings: ValidationWarning[] = [];

  const uniqueItemIds = Array.from(new Set((checkEntries || []).map(e => e.itemId).filter(Boolean)));
  const itemMap = new Map<string, InventoryItem>();

  for (const itemId of uniqueItemIds) {
    try {
      const ref = doc(db, 'inventory', itemId);
      const snap = await getDoc(ref);
      if (snap.exists()) itemMap.set(itemId, snap.data() as InventoryItem);
    } catch (e) {
      console.warn('validateStatpackAssignments: failed to load inventory item', itemId, e);
    }
  }

  for (const entry of checkEntries || []) {
    const item = itemMap.get(entry.itemId);
    const serial = entry.serialNumber?.trim();

    if (!item) {
      warnings.push({
        warningType: 'missing_asset',
        itemId: entry.itemId,
        itemName: entry.itemName,
        serialNumber: serial,
        message: `Inventory item not found for ${entry.itemName || entry.itemId}.`,
      });
      continue;
    }

    const isAsset = determineIsAsset(item);
    if (isAsset && !serial) {
      warnings.push({
        warningType: 'missing_asset',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        message: `Asset item missing serial number during check-off.`,
      });
      continue;
    }

    if (!serial) continue;

    const { matched, instance } = resolveAssetInstance(item, serial);
    if (!matched) {
      warnings.push({
        warningType: 'missing_asset',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        message: `Serial ${serial} not found on inventory record.`,
      });
      continue;
    }

    const assignedToId = instance?.assignedToId ?? item.assignedToId ?? null;
    if (assignedToId && assignedToId !== statpackId) {
      warnings.push({
        warningType: 'assigned_mismatch',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        currentAssignedTo: assignedToId,
        message: `Asset is assigned to a different statpack (${assignedToId}).`,
      });
    } else if (!assignedToId) {
      warnings.push({
        warningType: 'unassigned_asset',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        message: 'Asset is not assigned to any statpack.',
      });
    }

    const status = instance?.status ?? item.assetStatus;
    if (status && ['Not Ready', 'Maintenance', 'Unknown'].includes(status)) {
      warnings.push({
        warningType: 'asset_status',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        message: `Asset status is ${status}.`,
      });
    }

    const expirationCandidates = [
      item.assetNextExpiration,
      instance?.nextExpiration,
      instance?.padExpiration,
      instance?.batteryExpiration,
    ].filter(Boolean) as Date[];

    if (expirationCandidates.some(d => isExpired(d))) {
      warnings.push({
        warningType: 'asset_expired',
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        message: 'Asset has an expired component or service window.',
      });
    }
  }

  return warnings;
}

export async function logValidationWarningsToCollections(params: {
  warnings: ValidationWarning[];
  statpackId: string;
  statpackName: string;
  userId: string;
  userName: string;
}) {
  const { warnings, statpackId, statpackName, userId, userName } = params;
  if (!warnings || warnings.length === 0) return;

  await Promise.all(
    warnings.map(async (w) => {
      const logPayload = removeUndefined({
        itemId: w.itemId,
        itemName: w.itemName,
        action: 'statpack_validation_warning',
        serialNumber: w.serialNumber,
        warningType: w.warningType,
        relatedStatpackId: statpackId,
        relatedStatpackName: statpackName,
        currentAssignedTo: w.currentAssignedTo,
        message: w.message,
        userId,
        userName,
        timestamp: serverTimestamp(),
      });

      await addDoc(collection(db, 'inventory_logs'), logPayload);

      await recordAuditEvent({
        eventType: 'statpack_validation_warning',
        source: 'statpack_logs',
        sourceId: statpackId,
        actor: {
          userId,
          userName,
        },
        targets: w.itemId ? [{ collection: 'inventory', docId: w.itemId }] : undefined,
        details: logPayload,
      });
    })
  );
}

export async function updateAssetAssignment(params: {
  itemId: string;
  newAssignedToId?: string | null;
  user?: { id: string; fullName?: string | null };
  note?: string;
}) {
  const { itemId, newAssignedToId, user, note } = params;
  const itemRef = doc(db, 'inventory', itemId);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Asset ${itemId} not found`);

  const item = snap.data() as InventoryItem;
  const action = newAssignedToId ? 'asset_assign' : 'asset_unassign';

  await updateDoc(itemRef, {
    assignedToId: newAssignedToId ?? null,
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId,
    itemName: item.name,
    action,
    relatedStatpackId: newAssignedToId ?? null,
    previousAssignedToId: item.assignedToId ?? null,
    userId: user?.id ?? 'system',
    userName: user?.fullName ?? 'System',
    timestamp: serverTimestamp(),
    notes: note,
  }));

  await recordAuditEvent({
    eventType: action,
    source: 'inventory',
    sourceId: itemId,
    actor: {
      userId: user?.id ?? null,
      userName: user?.fullName ?? null,
    },
    targets: [{ collection: 'inventory', docId: itemId }],
    after: { assignedToId: newAssignedToId ?? null },
    details: { previousAssignedToId: item.assignedToId ?? null, note },
  });
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
 * @param opts - Optional metadata: batchId (reuse existing), openDate, expirationDate, lotNumber, notes, userId/userName for audit, purchase info
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
    purchase?: PurchaseInfo;
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
    if (opts?.purchase) newBatch.purchase = opts.purchase;
    
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
 * @param opts - Optional: targetBatchId (add to existing batch), openDate, expirationDate, userId/userName for audit, purchase info
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
    purchase?: PurchaseInfo;
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
    if (opts?.purchase) newBatch.purchase = opts.purchase;
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
  serial?: string; // Optional asset instance serial/tag
}): Promise<void> {
  const { assetId, user, location, note, serial } = params;
  const itemRef = doc(db, 'inventory', assetId);

  const { itemName, resolvedSerial, resolvedLocation, nextStatus } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error(`Asset ${assetId} not found`);
    const item = snap.data() as InventoryItem;

    const normalizedSerial = serial?.trim();
    const hasInstances = Array.isArray(item.assets) && item.assets.length > 0;
    if (hasInstances && !normalizedSerial) {
      throw new Error('This asset requires a serial/instance selection.');
    }

    let updatedAssets = hasInstances ? [...(item.assets || [])] : undefined;
    let resolvedInstance: AssetInstance | undefined;

    if (normalizedSerial && hasInstances) {
      const idx = updatedAssets!.findIndex(a =>
        a.serial === normalizedSerial || a.id === normalizedSerial || a.assetTag === normalizedSerial || a.barcode === normalizedSerial || a.qr === normalizedSerial
      );
      if (idx === -1) {
        throw new Error(`Serial ${normalizedSerial} not found on this asset.`);
      }
      resolvedInstance = updatedAssets![idx];
      const currentStatus = resolvedInstance.status ?? item.assetStatus;
      if (currentStatus === 'Checked Out') {
        throw new Error('Asset instance is already checked out.');
      }
      updatedAssets![idx] = {
        ...resolvedInstance,
        status: 'Checked Out',
        checkedOutAt: serverTimestamp(),
        checkedOutBy: user.id,
        currentLocation: location ?? resolvedInstance.currentLocation ?? item.currentLocation,
        updatedAt: new Date(),
      } as AssetInstance;
    } else if (!normalizedSerial) {
      if (item.assetStatus === 'Checked Out') {
        throw new Error('Asset is already checked out.');
      }
    }

    const anyCheckedOut = updatedAssets ? updatedAssets.some(a => a.status === 'Checked Out') : false;
    const allCheckedOut = updatedAssets ? updatedAssets.every(a => a.status === 'Checked Out') : false;

    const nextStatus: InventoryItem['assetStatus'] = updatedAssets
      ? (allCheckedOut ? 'Checked Out' : anyCheckedOut ? 'In Use' : 'Ready')
      : 'Checked Out';

    const checkoutPayload: any = {
      assetStatus: nextStatus,
      checkedOutAt: serverTimestamp(),
      checkedOutBy: user.id,
      updatedAt: serverTimestamp(),
    };
    if (location !== undefined) {
      checkoutPayload.currentLocation = location;
    }
    if (updatedAssets) {
      checkoutPayload.assets = updatedAssets;
    }

    tx.update(itemRef, checkoutPayload);

    return {
      itemName: item.name,
      resolvedSerial: normalizedSerial ?? item.assetSerial,
      resolvedLocation: location ?? item.currentLocation,
      nextStatus,
    };
  });

  const checkoutLog: any = {
    itemId: assetId,
    itemName,
    action: 'asset_checkout',
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    location: resolvedLocation,
    serialNumber: resolvedSerial,
    notes: note,
  };
  await addDoc(collection(db, 'inventory_logs'), removeUndefined(checkoutLog));

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
      assetStatus: nextStatus,
      checkedOutBy: user.id,
      currentLocation: resolvedLocation,
    },
    details: {
      reason: note,
      serialNumber: resolvedSerial,
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
  serial?: string; // Optional asset instance serial/tag
}): Promise<void> {
  const { assetId, user, location, note, serial } = params;
  const itemRef = doc(db, 'inventory', assetId);

  const { itemName, resolvedSerial, resolvedLocation, nextStatus } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error(`Asset ${assetId} not found`);
    const item = snap.data() as InventoryItem;

    const normalizedSerial = serial?.trim();
    const hasInstances = Array.isArray(item.assets) && item.assets.length > 0;
    if (hasInstances && !normalizedSerial) {
      throw new Error('This asset requires a serial/instance selection.');
    }

    let updatedAssets = hasInstances ? [...(item.assets || [])] : undefined;
    let resolvedInstance: AssetInstance | undefined;

    if (normalizedSerial && hasInstances) {
      const idx = updatedAssets!.findIndex(a =>
        a.serial === normalizedSerial || a.id === normalizedSerial || a.assetTag === normalizedSerial || a.barcode === normalizedSerial || a.qr === normalizedSerial
      );
      if (idx === -1) {
        throw new Error(`Serial ${normalizedSerial} not found on this asset.`);
      }
      resolvedInstance = updatedAssets![idx];
      const currentStatus = resolvedInstance.status ?? item.assetStatus;
      if (currentStatus !== 'Checked Out') {
        throw new Error('Asset instance is not currently checked out.');
      }
      updatedAssets![idx] = {
        ...resolvedInstance,
        status: 'Ready',
        lastCheckedInAt: serverTimestamp(),
        lastCheckedInBy: user.id,
        currentLocation: location ?? resolvedInstance.currentLocation ?? item.currentLocation,
        updatedAt: new Date(),
      } as AssetInstance;
    } else if (!normalizedSerial) {
      if (item.assetStatus !== 'Checked Out' && item.assetStatus !== 'In Use') {
        throw new Error('Asset is not currently checked out.');
      }
    }

    const anyCheckedOut = updatedAssets ? updatedAssets.some(a => a.status === 'Checked Out') : false;
    const allCheckedOut = updatedAssets ? updatedAssets.every(a => a.status === 'Checked Out') : false;

    const nextStatus: InventoryItem['assetStatus'] = updatedAssets
      ? (allCheckedOut ? 'Checked Out' : anyCheckedOut ? 'In Use' : 'Ready')
      : 'Ready';

    const checkinPayload: any = {
      assetStatus: nextStatus,
      lastCheckedInAt: serverTimestamp(),
      lastCheckedInBy: user.id,
      updatedAt: serverTimestamp(),
    };
    if (location !== undefined) {
      checkinPayload.lastKnownReturnLocation = location;
      checkinPayload.currentLocation = location;
    }
    if (updatedAssets) {
      checkinPayload.assets = updatedAssets;
    }

    tx.update(itemRef, checkinPayload);

    return {
      itemName: item.name,
      resolvedSerial: normalizedSerial ?? item.assetSerial,
      resolvedLocation: location ?? item.currentLocation,
      nextStatus,
    };
  });

  const checkinLog: any = {
    itemId: assetId,
    itemName,
    action: 'asset_checkin',
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    location: resolvedLocation,
    serialNumber: resolvedSerial,
    notes: note,
  };
  await addDoc(collection(db, 'inventory_logs'), removeUndefined(checkinLog));

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
      assetStatus: nextStatus,
      lastCheckedInBy: user.id,
      currentLocation: resolvedLocation,
    },
    details: {
      reason: note,
      serialNumber: resolvedSerial,
    },
  });
}

export async function performAssetManualCheck(params: {
  itemId: string;
  measuredBatteryPct?: number;
  measuredO2Psi?: number;
  condition: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
  notes?: string;
  dueNextDate?: Date;
  user: { id: string; fullName?: string | null };
}): Promise<AssetCheckResult> {
  const { itemId, measuredBatteryPct, measuredO2Psi, condition, notes, dueNextDate, user } = params;
  const itemRef = doc(db, 'inventory', itemId);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error(`Asset ${itemId} not found`);

  const item = snap.data() as InventoryItem;
  const now = new Date();

  const expirationWarnings: ValidationWarning[] = [];
  if (item.assetNextExpiration && isExpired(item.assetNextExpiration)) {
    expirationWarnings.push({
      warningType: 'asset_expired',
      itemId,
      itemName: item.name,
      message: 'Asset has an expired component.',
    });
  }

  const actionRequired = condition !== 'Good' || expirationWarnings.length > 0;

  const result: AssetCheckResult = {
    itemId,
    itemName: item.name,
    serialNumber: item.assetSerial,
    measuredBatteryPct,
    measuredO2Psi,
    condition,
    expirationWarnings,
    checkedAt: now,
    checkedBy: user.id,
    checkedByName: user.fullName || 'Unknown',
    notes,
    dueNextDate,
    actionRequired,
  };

  const updatePayload: any = {
    updatedAt: serverTimestamp(),
  };
  if (measuredBatteryPct !== undefined) {
    updatePayload.batteryStatus = measuredBatteryPct > 50 ? 'Good' : measuredBatteryPct > 20 ? 'Low' : 'Unknown';
  }
  if (measuredO2Psi !== undefined) {
    updatePayload.oxygenPsi = measuredO2Psi;
  }

  if (!item.maintenance_logs) item.maintenance_logs = [];
  item.maintenance_logs.push({
    timestamp: now,
    serviceType: 'inspection',
    reason: `Manual audit check: ${condition}`,
    technician: user.fullName || user.id,
    notes: notes || `Battery: ${measuredBatteryPct ?? 'N/A'}%, O2: ${measuredO2Psi ?? 'N/A'} PSI`,
    status: actionRequired ? 'pending' : 'completed',
    completedAt: actionRequired ? undefined : now,
  });

  updatePayload.maintenance_logs = item.maintenance_logs;
  await updateDoc(itemRef, updatePayload);

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId,
    itemName: item.name,
    action: 'asset_manual_check',
    serialNumber: item.assetSerial,
    measuredBatteryPct,
    measuredO2Psi,
    condition,
    expirationWarningCount: expirationWarnings.length,
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    notes,
    dueNextDate,
  }));

  await recordAuditEvent({
    eventType: 'asset_manual_check',
    source: 'inventory',
    sourceId: itemId,
    actor: {
      userId: user.id,
      userName: user.fullName,
    },
    targets: [{ collection: 'inventory', docId: itemId }],
    details: {
      measuredBatteryPct,
      measuredO2Psi,
      condition,
      actionRequired,
      notes,
    },
  });

  return result;
}

export async function performStatpackManualAudit(params: {
  statpackId: string;
  contentChecks: Array<{
    itemId: string;
    requiredQuantity: number;
    foundQuantity: number;
    inCorrectPocket: boolean;
    conditionOk: boolean;
    expirationOk: boolean;
    notes?: string;
  }>;
  overallNotes?: string;
  user: { id: string; fullName?: string | null };
}): Promise<StatpackAuditResult> {
  const { statpackId, contentChecks, overallNotes, user } = params;
  const packRef = doc(db, 'statpacks', statpackId);
  const snap = await getDoc(packRef);
  if (!snap.exists()) throw new Error(`Statpack ${statpackId} not found`);

  const statpack = snap.data() as Statpack;
  const now = new Date();

  const checks = await Promise.all(
    contentChecks.map(async (check) => {
      const itemRef = doc(db, 'inventory', check.itemId);
      const itemSnap = await getDoc(itemRef);
      const item = itemSnap.exists() ? (itemSnap.data() as InventoryItem) : null;

      return {
        itemId: check.itemId,
        itemName: item?.name || 'Unknown',
        serialNumber: item?.assetSerial,
        requiredQuantity: check.requiredQuantity,
        foundQuantity: check.foundQuantity,
        inCorrectPocket: check.inCorrectPocket,
        conditionOk: check.conditionOk,
        expirationOk: check.expirationOk,
        notes: check.notes,
      };
    })
  );

  const validationWarnings = await validateStatpackAssignments({
    statpackId,
    checkEntries: contentChecks.map(c => ({
      itemId: c.itemId,
      requiredQuantity: c.requiredQuantity,
      countedQuantity: c.foundQuantity,
      ok: c.foundQuantity >= c.requiredQuantity && c.conditionOk && c.expirationOk,
    })) as any[],
  });

  const issueFound = checks.some(
    (c) => c.foundQuantity < c.requiredQuantity || !c.inCorrectPocket || !c.conditionOk || !c.expirationOk
  );
  const actionRequired = issueFound || validationWarnings.length > 0;

  const result: StatpackAuditResult = {
    statpackId,
    statpackName: statpack.name,
    contentChecks: checks,
    validationWarnings,
    condition: actionRequired ? 'Issues Found' : 'Ready',
    checkedAt: now,
    checkedBy: user.id,
    checkedByName: user.fullName || 'Unknown',
    overallNotes,
    actionRequired,
  };

  if (!statpack.maintenance_logs) statpack.maintenance_logs = [];
  statpack.maintenance_logs.push({
    timestamp: now,
    serviceType: 'inspection',
    reason: `Manual audit: ${actionRequired ? 'Issues found' : 'Ready'}`,
    technician: user.fullName || user.id,
    notes: overallNotes,
    status: actionRequired ? 'pending' : 'completed',
    completedAt: actionRequired ? undefined : now,
  });

  await updateDoc(packRef, {
    maintenance_logs: statpack.maintenance_logs,
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'statpack_logs'), deepRemoveUndefined({
    statpackId,
    statpackName: statpack.name,
    action: 'maintenance',
    userId: user.id,
    userName: user.fullName || 'Unknown',
    timestamp: serverTimestamp(),
    checkEntries: checks.map((c) => ({
      itemId: c.itemId,
      itemName: c.itemName,
      requiredQuantity: c.requiredQuantity,
      countedQuantity: c.foundQuantity,
      ok: c.foundQuantity >= c.requiredQuantity && c.inCorrectPocket && c.conditionOk && c.expirationOk,
      notes: c.notes,
    })),
    validationWarnings,
    notes: overallNotes,
  }));

  await logValidationWarningsToCollections({
    warnings: validationWarnings,
    statpackId,
    statpackName: statpack.name,
    userId: user.id,
    userName: user.fullName || 'Unknown',
  });

  await recordAuditEvent({
    eventType: 'statpack_manual_audit',
    source: 'statpack_logs',
    sourceId: statpackId,
    actor: {
      userId: user.id,
      userName: user.fullName,
    },
    targets: [{ collection: 'statpacks', docId: statpackId }],
    details: {
      issuesFound: actionRequired,
      checkCount: checks.length,
      warningCount: validationWarnings.length,
    },
  });

  return result;
}

/**
 * Assign an external barcode tag to an asset or asset instance.
 * Supports both "Block" and "Warn & allow override" duplicate policies.
 * Records assignment in barcodeHistory and creates inventory log entry.
 * 
 * @param params.itemId - Firestore doc ID of the inventory item
 * @param params.barcode - The external barcode value from the purchased tag
 * @param params.user - User performing the assignment
 * @param params.serial - Optional: asset instance serial (required for items with multiple instances)
 * @param params.options.allowDuplicate - When true, allows assignment even if barcode is already used
 * @returns Object with success status, message, and optional duplicate info
 */
export async function assignBarcode(params: {
  itemId: string;
  barcode: string;
  user: { id: string; fullName?: string };
  serial?: string;
  options?: {
    allowDuplicate?: boolean;
  };
}): Promise<{
  success: boolean;
  message: string;
  isDuplicate?: boolean;
  duplicateItem?: { id: string; name: string; serial?: string };
  action?: 'assign' | 'reassign';
}> {
  const { itemId, barcode, user, serial, options } = params;
  const normalizedBarcode = barcode.trim();
  
  if (!normalizedBarcode) {
    return { success: false, message: 'Barcode cannot be empty' };
  }

  const itemRef = doc(db, 'inventory', itemId);

  try {
    // Step 1: Check for duplicates across all inventory items
    const duplicateCheck = await runTransaction(db, async (tx) => {
      // Query for items with this assignedBarcode at top level
      const inventorySnap = await getDocs(
        query(collection(db, 'inventory'), where('assignedBarcode', '==', normalizedBarcode))
      );
      
      for (const docSnap of inventorySnap.docs) {
        if (docSnap.id !== itemId) {
          const data = docSnap.data() as InventoryItem;
          return {
            isDuplicate: true,
            duplicateItem: { id: docSnap.id, name: data.name },
          };
        }
      }

      // Also check instance-level barcodes by scanning all inventory items with assets
      const allInventorySnap = await getDocs(collection(db, 'inventory'));
      for (const docSnap of allInventorySnap.docs) {
        const data = docSnap.data() as InventoryItem;
        if (Array.isArray(data.assets)) {
          for (const instance of data.assets) {
            if (instance.assignedBarcode === normalizedBarcode) {
              // Skip if it's the same item and serial we're updating
              if (docSnap.id === itemId && serial && instance.serial === serial) {
                continue;
              }
              return {
                isDuplicate: true,
                duplicateItem: {
                  id: docSnap.id,
                  name: data.name,
                  serial: instance.serial,
                },
              };
            }
          }
        }
      }

      return { isDuplicate: false };
    });

    // Step 2: If duplicate found and not allowed, return warning
    if (duplicateCheck.isDuplicate && !options?.allowDuplicate) {
      return {
        success: false,
        message: `Barcode already assigned to ${duplicateCheck.duplicateItem?.name}${
          duplicateCheck.duplicateItem?.serial ? ` (Serial: ${duplicateCheck.duplicateItem.serial})` : ''
        }`,
        isDuplicate: true,
        duplicateItem: duplicateCheck.duplicateItem,
      };
    }

    // Step 3: Perform assignment in transaction
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists()) {
        throw new Error(`Asset ${itemId} not found`);
      }
      
      const item = snap.data() as InventoryItem;
      const normalizedSerial = serial?.trim();
      const hasInstances = Array.isArray(item.assets) && item.assets.length > 0;

      if (hasInstances && !normalizedSerial) {
        throw new Error('This asset has multiple instances; please specify a serial number.');
      }

      let action: 'assign' | 'reassign' = 'assign';
      let previousBarcode: string | undefined;
      const historyEntry = {
        value: normalizedBarcode,
        assignedAt: serverTimestamp(),
        assignedBy: { id: user.id, name: user.fullName },
      };

      // Handle instance-level assignment
      if (normalizedSerial && hasInstances) {
        const updatedAssets = [...(item.assets || [])];
        const idx = updatedAssets.findIndex(a =>
          a.serial === normalizedSerial ||
          a.id === normalizedSerial ||
          a.assetTag === normalizedSerial ||
          a.barcode === normalizedSerial ||
          a.qr === normalizedSerial
        );
        
        if (idx === -1) {
          throw new Error(`Serial ${normalizedSerial} not found on this asset.`);
        }

        const instance = updatedAssets[idx];
        previousBarcode = instance.assignedBarcode ?? undefined;
        if (previousBarcode) action = 'reassign';

        // Update instance with new barcode and history
        updatedAssets[idx] = {
          ...instance,
          assignedBarcode: normalizedBarcode,
          barcodeHistory: [
            ...(instance.barcodeHistory || []),
            historyEntry,
          ],
          updatedAt: new Date(),
        } as AssetInstance;

        tx.update(itemRef, {
          assets: updatedAssets,
          updatedAt: serverTimestamp(),
        });

        return {
          action,
          itemName: item.name,
          resolvedSerial: normalizedSerial,
          previousBarcode,
        };
      } else {
        // Top-level assignment (no instances or single asset)
        previousBarcode = item.assignedBarcode ?? undefined;
        if (previousBarcode) action = 'reassign';

        tx.update(itemRef, {
          assignedBarcode: normalizedBarcode,
          barcodeHistory: [
            ...(item.barcodeHistory || []),
            historyEntry,
          ],
          updatedAt: serverTimestamp(),
        });

        return {
          action,
          itemName: item.name,
          resolvedSerial: item.assetSerial,
          previousBarcode,
        };
      }
    });

    // Step 4: Create inventory log
    const logEntry: any = {
      itemId,
      itemName: result.itemName,
      action: result.action === 'reassign' ? 'barcode_reassign' : 'barcode_assign',
      serialNumber: result.resolvedSerial,
      userId: user.id,
      userName: user.fullName || 'Unknown',
      timestamp: serverTimestamp(),
      details: {
        newBarcode: normalizedBarcode,
        previousBarcode: result.previousBarcode,
      },
      notes: result.action === 'reassign'
        ? `Reassigned barcode from ${result.previousBarcode} to ${normalizedBarcode}`
        : `Assigned barcode ${normalizedBarcode}`,
    };
    await addDoc(collection(db, 'inventory_logs'), removeUndefined(logEntry));

    // Step 5: Create audit event
    await recordAuditEvent({
      eventType: result.action === 'reassign' ? 'barcode_reassign' : 'barcode_assign',
      source: 'inventory',
      sourceId: itemId,
      actor: {
        userId: user.id,
        userName: user.fullName,
      },
      targets: [{ collection: 'inventory', docId: itemId }],
      details: {
        barcode: normalizedBarcode,
        serial: result.resolvedSerial,
        previousBarcode: result.previousBarcode,
      },
    });

    return {
      success: true,
      message: result.action === 'reassign'
        ? `Barcode reassigned successfully${duplicateCheck.isDuplicate ? ' (duplicate allowed)' : ''}`
        : `Barcode assigned successfully${duplicateCheck.isDuplicate ? ' (duplicate allowed)' : ''}`,
      action: result.action,
      isDuplicate: duplicateCheck.isDuplicate,
    };
  } catch (error: any) {
    console.error('assignBarcode failed:', error);
    return {
      success: false,
      message: error.message || 'Failed to assign barcode',
    };
  }
}
