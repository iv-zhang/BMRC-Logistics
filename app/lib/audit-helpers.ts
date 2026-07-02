/**
 * Consolidated audit helpers for the BMRC Logistics app.
 *
 * This module provides:
 * - Permission checks (who can audit)
 * - Inventory snapshot generation (quick "what do I have?" view)
 * - Box-based counting for disposables (unopenedBoxes is source of truth)
 * - Asset status summaries
 * - Audit session management (start/finish/lock zones)
 * - Restock decision helpers
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  writeBatch,
  serverTimestamp,
  setDoc,
  deleteDoc,
  addDoc,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, User } from '@/app/types';
import { addAuditEventToBatch } from '@/app/lib/audit';
import { determineIsAsset } from '@/app/lib/inventory';
import { computeBagStock, isAuditedThisMonth } from '@/app/lib/item-status';

// ─── Permission helpers ───────────────────────────────────────────────────────

/** Roles that always have audit access */
const AUDIT_ROLES: User['role'][] = ['admin', 'quartermaster', 'inventory_helper'];

/**
 * Check if a user has permission to perform audits.
 * Admins, quartermasters, and inventory_helpers always can.
 * Regular members can audit only if `canAudit` is explicitly true.
 */
export function canUserAudit(user: Pick<User, 'role' | 'canAudit'> | null): boolean {
  if (!user) return false;
  if (AUDIT_ROLES.includes(user.role)) return true;
  return user.canAudit === true;
}

/**
 * Grant or revoke audit permission for a member.
 * Only admins should call this.
 */
export async function setAuditPermission(
  userId: string,
  canAudit: boolean,
  grantedBy: { id: string; name: string }
): Promise<void> {
  const userRef = doc(db, 'users', userId);
  const batch = writeBatch(db);

  batch.update(userRef, {
    canAudit,
    updatedAt: serverTimestamp(),
  });

  addAuditEventToBatch(batch, {
    eventType: canAudit ? 'audit_permission_granted' : 'audit_permission_revoked',
    source: 'admin',
    sourceId: userId,
    actor: {
      userId: grantedBy.id,
      userName: grantedBy.name,
    },
    targets: [{ collection: 'users', docId: userId }],
    after: { canAudit },
  });

  await batch.commit();
}

// ─── Inventory snapshot ───────────────────────────────────────────────────────

export interface AuditSnapshot {
  disposables: DisposableSnapshot[];
  assets: AssetSnapshot[];
  generatedAt: Date;
  totalDisposableTypes: number;
  totalAssetTypes: number;
  lowStockCount: number;
  expiredCount: number;
}

export interface DisposableSnapshot {
  id: string;
  name: string;
  category: string;
  location: string;
  room?: string;
  /** Sealed boxes/bags in the back (item-level or summed from bag-tracked batches) */
  unopenedBoxes: number;
  itemsPerBox: number;
  /** Total on-hand units — same math as the inventory page (bag-tracking aware) */
  totalUnits: number;
  /** Total individual units across all open batches (front area — informational only) */
  openBatchUnits: number;
  reorderThreshold: number;
  isLowStock: boolean;
  isOut: boolean;
  /** Earliest expiration across all batches */
  earliestExpiration?: Date;
  isExpired: boolean;
  /** Verified for the CURRENT monthly audit cycle (lastAuditDate this month) */
  auditVerified: boolean;
  lastAuditDate?: Date;
  auditCondition?: 'Good' | 'Damaged' | 'Expired';
  /** Legacy field for backward compat — prefer totalUnits */
  totalStockQuantity?: number;
}

export interface AssetSnapshot {
  id: string;
  name: string;
  category: string;
  assetSerial?: string;
  assetStatus?: string;
  currentLocation?: string;
  lastChecked?: Date;
  isAsset: true;
  /** Verified for the CURRENT monthly audit cycle (lastAuditDate this month) */
  auditVerified: boolean;
  lastAuditDate?: Date;
  /** For multi-instance assets, count of instances */
  instanceCount: number;
  /** Instances needing attention (maintenance, expired, etc.) */
  issueCount: number;
}

/**
 * Generate a full inventory snapshot for audit purposes.
 * Splits items into disposables (box-based) and assets (lifecycle-based).
 */
export async function generateAuditSnapshot(
  zoneFilter?: string
): Promise<AuditSnapshot> {
  const q = query(collection(db, 'inventory'), orderBy('name'));
  const snap = await getDocs(q);
  const now = new Date();

  const disposables: DisposableSnapshot[] = [];
  const assets: AssetSnapshot[] = [];
  let lowStockCount = 0;
  let expiredCount = 0;

  snap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Omit<InventoryItem, 'id'>;
    const item: InventoryItem = { id: docSnap.id, ...data };

    // Apply zone filter — match legacy room/location fields and the
    // structured storageLocation zone name
    if (zoneFilter) {
      const zf = zoneFilter.toLowerCase();
      const candidates = [
        item.room,
        item.location,
        item.storageLocation?.zoneName,
      ].filter(Boolean).map(s => String(s).toLowerCase());
      if (!candidates.some(c => c === zf || c.includes(zf))) return;
    }

    const isAsset = determineIsAsset(item);

    const lastAuditDate = item.lastAuditDate ? toDate(item.lastAuditDate) : undefined;
    // Monthly audit cycle: an item only counts as verified if it was audited
    // during the current calendar month. The sticky `auditVerified` boolean
    // never resets, so it must not be trusted on its own.
    const verifiedThisCycle = isAuditedThisMonth(lastAuditDate, now);

    if (isAsset) {
      const instances = Array.isArray(item.assets) ? item.assets : [];
      const issueCount = instances.filter(
        (a) => a.status === 'Maintenance' || a.status === 'Not Ready'
      ).length;

      assets.push({
        id: item.id,
        name: item.name,
        category: item.category,
        assetSerial: item.assetSerial,
        assetStatus: item.assetStatus,
        currentLocation: item.currentLocation,
        lastChecked: item.assetLastChecked
          ? toDate(item.assetLastChecked)
          : undefined,
        isAsset: true,
        auditVerified: verifiedThisCycle,
        lastAuditDate,
        instanceCount: instances.length || 1,
        issueCount,
      });
    } else {
      // Disposable — same stock math as the inventory page (bag-tracking aware)
      const bag = computeBagStock(item);
      const unopenedBoxes = bag.hasBagTracking ? bag.totalBags : (item.unopenedBoxes ?? 0);
      const itemsPerBox = item.itemsPerBox ?? 1;
      const openBatchUnits = bag.hasBagTracking
        ? bag.totalLoose
        : (item.batches || []).reduce((sum, b) => sum + (b.stock || 0), 0);
      const reorderThreshold = item.reorderThreshold ?? 0;
      const isOut = bag.totalItems === 0;
      const isLowStock = !isOut && reorderThreshold > 0 && bag.totalItems <= reorderThreshold;

      // Find earliest expiration
      let earliestExp: Date | undefined;
      if (item.expirationDate) {
        earliestExp = toDate(item.expirationDate);
      }
      (item.batches || []).forEach((b) => {
        if (b.expirationDate) {
          const bExp = toDate(b.expirationDate);
          if (bExp && (!earliestExp || bExp < earliestExp)) {
            earliestExp = bExp;
          }
        }
      });

      const isExpired = earliestExp ? earliestExp < now : false;

      if (isLowStock || isOut) lowStockCount++;
      if (isExpired) expiredCount++;

      disposables.push({
        id: item.id,
        name: item.name,
        category: item.category,
        location: item.location,
        room: item.room,
        unopenedBoxes,
        itemsPerBox,
        totalUnits: bag.totalItems,
        openBatchUnits,
        reorderThreshold,
        isLowStock,
        isOut,
        earliestExpiration: earliestExp,
        isExpired,
        auditVerified: verifiedThisCycle,
        lastAuditDate,
        auditCondition: item.auditCondition,
        totalStockQuantity: item.totalStockQuantity,
      });
    }
  });

  return {
    disposables,
    assets,
    generatedAt: now,
    totalDisposableTypes: disposables.length,
    totalAssetTypes: assets.length,
    lowStockCount,
    expiredCount,
  };
}

// ─── Audit session management ─────────────────────────────────────────────────

export interface AuditSession {
  id: string;
  zone: string;
  zoneLabel?: string;
  startedAt: Date;
  startedBy: { id: string; name: string; email: string };
  status: 'in_progress' | 'completed' | 'cancelled';
  completedAt?: Date;
  /** Number of items verified in this session */
  itemsVerified: number;
  /** Number of variances found */
  variancesFound: number;
}

/**
 * Try to acquire a zone lock for auditing. Returns lock status.
 */
export async function acquireZoneLock(
  zone: string,
  user: { uid: string; email?: string | null; displayName?: string | null }
): Promise<{ acquired: boolean; lockedBy?: string; lockedByName?: string }> {
  const lockRef = doc(db, 'audit_locks', zone);
  const snap = await getDoc(lockRef);

  if (snap.exists()) {
    const data = snap.data() as { lockedBy?: string; lockedByName?: string };
    if (data.lockedBy && data.lockedBy !== user.uid) {
      return {
        acquired: false,
        lockedBy: data.lockedBy,
        lockedByName: data.lockedByName,
      };
    }
  }

  await setDoc(lockRef, {
    lockedBy: user.uid,
    lockedByName: user.displayName || user.email || 'Unknown',
    lockedAt: serverTimestamp(),
  });

  return { acquired: true };
}

/**
 * Release a zone lock.
 */
export async function releaseZoneLock(
  zone: string,
  userId: string
): Promise<void> {
  const lockRef = doc(db, 'audit_locks', zone);
  try {
    const snap = await getDoc(lockRef);
    if (snap.exists()) {
      const data = snap.data() as { lockedBy?: string };
      if (data.lockedBy === userId) {
        await deleteDoc(lockRef);
      }
    }
  } catch (e) {
    console.warn('Failed to release zone lock:', e);
  }
}

// ─── Box-based audit submission ───────────────────────────────────────────────

export interface AuditEntry {
  itemId: string;
  /** For disposables: counted number of unopened boxes/bags */
  countedBoxes?: number;
  /** For assets: verified status */
  assetVerified?: boolean;
  assetCondition?: string;
  condition: 'Good' | 'Damaged' | 'Expired';
  notes?: string;
  expirationDate?: string;
  /** Optional: units per sealed box/bag as observed during audit */
  itemsPerBox?: number;
  /** Optional lot/batch identifier observed on sealed box/bag */
  lotNumber?: string;
  /** Optional batch open date or manufacture date (ISO string) */
  batchDate?: string;
  /** Barcode scanned during audit (optional) */
  scannedBarcode?: string;
}

/**
 * Submit a batch of audit entries. Uses box-based counting for disposables.
 * All writes are atomic via WriteBatch.
 */
export async function submitAuditEntries(
  entries: AuditEntry[],
  items: InventoryItem[],
  user: { uid: string; email?: string | null; displayName?: string | null },
  zone: string
): Promise<{ success: boolean; itemsUpdated: number; variances: number }> {
  const batch = writeBatch(db);
  const logsToWrite: Record<string, unknown>[] = [];
  let variances = 0;

  for (const entry of entries) {
    const item = items.find((x) => x.id === entry.itemId);
    if (!item) continue;

    const isAsset = determineIsAsset(item);

    if (isAsset) {
      // Asset audit: verify status and condition
      batch.update(doc(db, 'inventory', entry.itemId), {
        auditVerified: true,
        auditCondition: entry.condition,
        auditNotes: entry.notes ?? null,
        lastAuditDate: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      // Disposable audit
      const countedBoxes = entry.countedBoxes ?? 0;
      const bag = computeBagStock(item);
      const systemBoxes = bag.hasBagTracking ? bag.totalBags : (item.unopenedBoxes ?? 0);

      if (countedBoxes !== systemBoxes) variances++;

      if (bag.hasBagTracking) {
        // Bag-tracked items: batches are the source of truth. Overwriting the
        // item-level box count would silently desync from the batches, so only
        // mark the item verified; variances stay in the audit log for manual
        // batch reconciliation.
        batch.update(doc(db, 'inventory', entry.itemId), {
          auditVerified: true,
          auditCondition: entry.condition,
          auditNotes: entry.notes ?? null,
          lastAuditDate: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(doc(db, 'inventory', entry.itemId), {
          unopenedBoxes: countedBoxes,
          // Also sync totalStockQuantity for legacy compat
          totalStockQuantity: countedBoxes * (entry.itemsPerBox ?? item.itemsPerBox ?? 1),
          // Allow auditors to correct or record observed items-per-box
          itemsPerBox: entry.itemsPerBox ?? item.itemsPerBox ?? 1,
          auditVerified: true,
          auditCondition: entry.condition,
          auditNotes: entry.notes ?? null,
          lastAuditDate: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    addAuditEventToBatch(batch, {
      eventType: isAsset ? 'audit_asset_verified' : 'audit_box_count_verified',
      source: 'supply_audit',
      sourceId: entry.itemId,
      actor: {
        userId: user.uid,
        userEmail: user.email ?? null,
      },
      targets: [{ collection: 'inventory', docId: entry.itemId }],
      before: isAsset
        ? { assetStatus: item.assetStatus }
        : { unopenedBoxes: item.unopenedBoxes ?? 0 },
      after: isAsset
        ? { auditVerified: true, condition: entry.condition }
        : {
            unopenedBoxes: entry.countedBoxes ?? 0,
            condition: entry.condition,
            itemsPerBox: entry.itemsPerBox ?? item.itemsPerBox ?? 1,
            lotNumber: entry.lotNumber ?? null,
            batchDate: entry.batchDate ?? null,
            expirationDate: entry.expirationDate ?? null,
          },
    });

    logsToWrite.push({
      action: isAsset ? 'audit_asset_verified' : 'audit_box_count',
      itemId: entry.itemId,
      itemName: item.name,
      userId: user.uid,
      userName: user.displayName || user.email || 'Unknown',
      timestamp: serverTimestamp(),
      notes: isAsset
        ? `Asset audit: condition ${entry.condition}`
        : `Box audit: counted ${entry.countedBoxes} boxes (system had ${item.unopenedBoxes ?? 0}), condition ${entry.condition}`,
      details: {
        zone,
        isAsset,
        ...(isAsset
          ? {}
          : {
              countedBoxes: entry.countedBoxes,
              systemBoxes: item.unopenedBoxes ?? 0,
              variance: (entry.countedBoxes ?? 0) - (item.unopenedBoxes ?? 0),
              itemsPerBox: entry.itemsPerBox ?? item.itemsPerBox ?? 1,
              lotNumber: entry.lotNumber ?? null,
              batchDate: entry.batchDate ?? null,
              expirationDate: entry.expirationDate ?? null,
            }),
      },
    });
  }

  await batch.commit();

  // Write logs non-transactionally (acceptable for audit trail)
  for (const log of logsToWrite) {
    try {
      await addDoc(collection(db, 'inventory_logs'), log);
    } catch (e) {
      console.warn('Failed to write audit log:', e);
    }
  }

  return {
    success: true,
    itemsUpdated: entries.length,
    variances,
  };
}

// ─── Restock decision helpers ─────────────────────────────────────────────────

export interface RestockDecision {
  itemId: string;
  itemName: string;
  unopenedBoxes: number;
  itemsPerBox: number;
  totalUnits: number;
  reorderThreshold: number;
  deficit: number;
  urgency: 'critical' | 'low' | 'ok';
  recommendation: string;
}

/**
 * Analyze inventory and produce restock recommendations.
 * Uses total on-hand UNITS vs reorderThreshold — the same comparison the
 * inventory page makes — so both surfaces flag the same items.
 */
export function analyzeRestockNeeds(
  items: DisposableSnapshot[]
): RestockDecision[] {
  return items
    .map((item) => {
      const deficit = item.reorderThreshold - item.totalUnits;
      let urgency: RestockDecision['urgency'] = 'ok';
      let recommendation = 'Stock is adequate';

      if (item.isOut) {
        urgency = 'critical';
        recommendation = item.reorderThreshold > 0
          ? `OUT OF STOCK — Need ${item.reorderThreshold} units immediately`
          : 'OUT OF STOCK';
      } else if (item.isLowStock) {
        urgency = 'low';
        recommendation = `Low stock — Order ${Math.max(1, deficit)} more units to reach par level`;
      }

      if (item.isExpired) {
        urgency = 'critical';
        recommendation += ' | EXPIRED items present';
      }

      return {
        itemId: item.id,
        itemName: item.name,
        unopenedBoxes: item.unopenedBoxes,
        itemsPerBox: item.itemsPerBox,
        totalUnits: item.totalUnits,
        reorderThreshold: item.reorderThreshold,
        deficit: Math.max(0, deficit),
        urgency,
        recommendation,
      };
    })
    .filter((d) => d.urgency !== 'ok')
    .sort((a, b) => {
      const order = { critical: 0, low: 1, ok: 2 };
      return order[a.urgency] - order[b.urgency];
    });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val;
  if (val instanceof Timestamp) return val.toDate();
  if (typeof val === 'object' && typeof (val as { toDate?: () => Date }).toDate === 'function')
    return (val as { toDate: () => Date }).toDate();
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/** Audit-specific logging for debugging */
export const auditLog = {
  info: (msg: string, data?: unknown) => {
    console.log(`[AUDIT] ${msg}`, data ?? '');
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(`[AUDIT] ${msg}`, data ?? '');
  },
  error: (msg: string, data?: unknown) => {
    console.error(`[AUDIT] ❌ ${msg}`, data ?? '');
  },
  debug: (msg: string, data?: unknown) => {
    if (typeof window !== 'undefined' && (window as { __BMRC_DEBUG?: boolean }).__BMRC_DEBUG) {
      console.debug(`[AUDIT] 🔍 ${msg}`, data ?? '');
    }
  },
};
