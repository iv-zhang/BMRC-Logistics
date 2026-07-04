import { collection, doc, getDoc, getDocs, writeBatch, serverTimestamp, addDoc, updateDoc, runTransaction, query, where, orderBy, limit, documentId } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, InventoryBatch, Statpack, StatpackItem, StatpackPocket, Container, BoxLog, StatpackLog, PurchaseInfo, ValidationWarning, AssetInstance, AssetCheckResult, StatpackAuditResult, AssetVerificationRules } from '@/app/types';
import { recordAuditEvent, removeUndefined, deepRemoveUndefined } from '@/app/lib/audit';
import { createReport } from '@/app/lib/reports';
import { getAssetCategoriesRuntime, getThresholds } from '@/app/lib/org-config-store';

/**
 * Fetch an inventory item by ID and return enriched itemDetails + suggested verification rules.
 * Used when attaching assets to statpacks to ensure full metadata is available.
 */
export async function fetchAndEnrichItemDetails(itemId: string): Promise<{
  itemDetails: Partial<InventoryItem>;
  suggestedVerificationRules?: AssetVerificationRules;
} | null> {
  try {
    const itemRef = doc(db, 'inventory', itemId);
    const snap = await getDoc(itemRef);
    if (!snap.exists()) return null;
    
    const data = snap.data() as InventoryItem;
    const itemDetails: Partial<InventoryItem> = {
      id: snap.id,
      name: data.name,
      category: data.category,
      isAsset: data.isAsset,
      assetCategory: data.assetCategory,
      assetSerial: data.assetSerial,
      expirationDate: data.expirationDate,
      batteryExpiration: data.batteryExpiration,
      padExpiration: data.padExpiration,
      isOxygen: data.isOxygen,
      oxygenPsi: data.oxygenPsi,
      maxOxygenPsi: data.maxOxygenPsi,
      assetValue: data.assetValue,
      requiresExpirationCheck: data.requiresExpirationCheck,
      verificationPolicy: data.verificationPolicy,
    };
    
    // Auto-suggest verification rules based on asset type
    const suggestedVerificationRules: AssetVerificationRules = {};
    
    // Meds require expiration check
    if (data.category === 'Meds' || data.requiresExpirationCheck || data.expirationDate) {
      suggestedVerificationRules.requireExpirationConfirmation = true;
    }
    
    // Oxygen tanks require PSI check
    if (data.isOxygen || data.assetCategory === 'Oxygen Tank') {
      suggestedVerificationRules.requireO2PsiMin = data.maxOxygenPsi ? Math.floor(data.maxOxygenPsi * 0.9) : getThresholds().o2PsiMin; // 90% of max or org default
    }
    
    // AEDs and serialized assets require serial verification
    if (data.assetCategory === 'AED' || data.isAsset || data.assetSerial || (data.assets && data.assets.length > 0)) {
      suggestedVerificationRules.requireSerial = true;
    }
    
    // Return enriched data
    return {
      itemDetails,
      suggestedVerificationRules: Object.keys(suggestedVerificationRules).length > 0 ? suggestedVerificationRules : undefined,
    };
  } catch (e) {
    console.error('fetchAndEnrichItemDetails failed:', e);
    return null;
  }
}

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
const generateStatpackPairId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `pair_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const resolveStatpackPairId = async (params: {
  statpackId: string;
  action: 'checkout' | 'checkin' | 'maintenance' | 'audit';
  pairId?: string;
}) => {
  const { statpackId, action, pairId } = params;

  if (pairId) return pairId;
  if (action === 'maintenance' || action === 'audit') return undefined;
  if (action === 'checkout') return generateStatpackPairId();

  try {
    const q = query(
      collection(db, 'statpack_logs'),
      where('statpackId', '==', statpackId),
      where('action', '==', 'checkout'),
      orderBy('timestamp', 'desc'),
      limit(1)
    );
    const snap = await getDocs(q);
    const latest = snap.docs[0]?.data() as Partial<StatpackLog> | undefined;
    if (latest?.pairId) return latest.pairId;
  } catch (e) {
    console.warn('resolveStatpackPairId: failed to lookup latest checkout', e);
  }

  return generateStatpackPairId();
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Coerce a Date | Firestore Timestamp | ISO-string | ms into epoch ms (or undefined). */
function toMillisLoose(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.getTime();
  const anyV = v as { toMillis?: () => number; toDate?: () => Date };
  if (typeof anyV.toMillis === 'function') return anyV.toMillis();
  if (typeof anyV.toDate === 'function') return anyV.toDate().getTime();
  const t = new Date(v as string | number).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Best-effort, bounded pre-assessment of the life-safety hazards a check-off must
 * fail-closed on but that live on the *inventory* docs, not the member's entries:
 *   • a lot referenced by the pack has been recalled (`batch.status==='quarantined'`)
 *   • an AED in the pack has expired pads/battery or an overdue periodic check
 *   • a glucometer (reagent asset) has no in-interval passing control test
 * Reads are done once up front (not inside the check-off transaction) so the
 * transaction stays light; a recall landing between this read and commit is
 * acceptable — the next check-off/audit catches it.
 */
async function assessPackHazards(statpackId: string): Promise<{
  quarantinedBatchIds: Set<string>;
  assetCurrencyLapsed: boolean;
}> {
  const quarantinedBatchIds = new Set<string>();
  let assetCurrencyLapsed = false;
  try {
    const sp = await getDoc(doc(db, 'statpacks', statpackId));
    if (!sp.exists()) return { quarantinedBatchIds, assetCurrencyLapsed };
    const contents = ((sp.data() as Statpack)?.contents ?? []) as StatpackItem[];
    const itemIds = Array.from(new Set(contents.map(c => c?.itemId).filter(Boolean)));
    const th = getThresholds();
    const nowMs = Date.now();
    await Promise.all(itemIds.map(async (iid) => {
      const invSnap = await getDoc(doc(db, 'inventory', iid as string));
      if (!invSnap.exists()) return;
      const inv = invSnap.data() as InventoryItem;
      for (const b of (inv.batches ?? [])) {
        if (b?.status === 'quarantined' && b?.id) quarantinedBatchIds.add(b.id);
      }
      if (inv.isAsset) {
        // AED: expired pads/battery, or an overdue periodic check → not current.
        if (inv.assetCategory === 'AED') {
          const pad = toMillisLoose(inv.padExpiration);
          const bat = toMillisLoose(inv.batteryExpiration);
          if ((pad !== undefined && pad < nowMs) || (bat !== undefined && bat < nowMs)) assetCurrencyLapsed = true;
          const checked = toMillisLoose(inv.assetLastChecked);
          if (checked !== undefined && (nowMs - checked) / DAY_MS > th.aedCheckIntervalDays) assetCurrencyLapsed = true;
        }
        // Glucometer / reagent asset: control test must be current AND passing.
        const ct = inv.controlTest;
        if (ct) {
          const last = toMillisLoose(ct.lastPassedAt);
          const interval = typeof ct.intervalDays === 'number' ? ct.intervalDays : th.glucometerControlTestIntervalDays;
          if (last === undefined || (nowMs - last) / DAY_MS > interval) assetCurrencyLapsed = true;
          if (ct.lastResult && ct.lastResult !== 'pass') assetCurrencyLapsed = true;
        }
      }
    }));
  } catch (e) {
    console.warn('logStatpackCheckOff: hazard pre-assessment failed', e);
  }
  return { quarantinedBatchIds, assetCurrencyLapsed };
}

export async function logStatpackCheckOff(params: {
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'maintenance' | 'audit';
  userId: string;
  userName: string;
  userRole?: string;
  pairId?: string;
  quickCheckin?: boolean; // When true, indicates a quick checkin (member reported no items used)
  checkEntries: {
    itemId: string;
    itemName?: string;
    batchId?: string;
    compartmentId?: string;
    pocket?: StatpackPocket;
    requiredQuantity: number;
    countedQuantity: number;
    ok: boolean;
    serialNumber?: string;
    expirationDate?: Date;
    notes?: string;
    // Per-asset condition tracking (added for assignment feature)
    assetCondition?: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
    assetCheckResult?: {
      batteryStatus?: 'Good' | 'Low' | 'Unknown';
      batteryPct?: number;
      padsSealed?: boolean;
      oxygenPsi?: number;
      notes?: string;
    };
    // Restock tracking during check-in
    restockStatus?: 'restocked' | 'shelf_empty' | 'not_needed';
    restockNotes?: string;
    // A freshly confirmed/entered expiration to persist onto the pack content
    // (clears expired state for that item).
    newExpirationDate?: Date;
    // Oxygen tank readings (also mirrored on assetCheckResult.oxygenPsi)
    oxygenPsi?: number;
    regulatorOk?: boolean;
    // Member acknowledged an expired/short item and chose to proceed
    acknowledged?: boolean;
    acknowledgeReason?: string;
    // Member reported a problem with this item -> spawns a tracked issue report
    issue?: { type: 'missing' | 'broken' | 'expired'; quantity?: number; notes?: string };
  }[];
  sealChecks?: Record<string, { sealed: boolean; sealNumber?: string }>;
  oxygenReadings?: Record<string, string>;
  // Pack-level sharps container safety check
  sharpsCheck?: { status: 'ok' | 'full' | 'na'; notes?: string };
  notes?: string;
}) {
  const {
    statpackId,
    statpackName,
    action,
    userId,
    userName,
    userRole,
    pairId,
    quickCheckin,
    checkEntries,
    sealChecks,
    oxygenReadings,
    sharpsCheck,
    notes,
  } = params;

  const resolvedPairId = await resolveStatpackPairId({ statpackId, action, pairId });

  // Always validate statpack assignments for checkout/checkin to ensure assets are properly assigned
  const validationWarnings = await validateStatpackAssignments({
    statpackId,
    checkEntries,
  });

  // Build base log object
  const logData: Partial<StatpackLog> & { quickCheckin?: boolean; summary?: Record<string, number> } = {
    statpackId,
    statpackName,
    action,
    pairId: resolvedPairId,
    userId,
    userName,
    timestamp: serverTimestamp(),
  };

  // Mark quick checkins for admin audit visibility
  if (quickCheckin) {
    logData.quickCheckin = true;
  }

  // Clean and attach check entries (remove undefined fields)
  logData.checkEntries = (checkEntries || []).map(ce => {
    const entry: any = {
      itemId: ce.itemId,
      itemName: ce.itemName,
      batchId: ce.batchId,
      compartmentId: ce.compartmentId,
      pocket: ce.pocket,
      requiredQuantity: ce.requiredQuantity,
      countedQuantity: ce.countedQuantity,
      ok: ce.ok,
      serialNumber: ce.serialNumber,
      expirationDate: ce.expirationDate,
      notes: ce.notes,
      // `checkedAt` will be set to the client `now` value after sanitization.
      checkedBy: userId,
      // Include per-asset condition fields
      assetCondition: ce.assetCondition,
      assetCheckResult: ce.assetCheckResult,
      // Restock tracking
      restockStatus: ce.restockStatus,
      restockNotes: ce.restockNotes,
      // Newly persisted verification details (source-of-truth paper trail)
      newExpirationDate: ce.newExpirationDate,
      oxygenPsi: ce.oxygenPsi,
      regulatorOk: ce.regulatorOk,
      acknowledged: ce.acknowledged,
      acknowledgeReason: ce.acknowledgeReason,
      issue: ce.issue,
    };
    Object.keys(entry).forEach(k => { if (entry[k] === undefined) delete entry[k]; });
    return entry as any;
  });

  // Attach pack-level sharps container check to the log
  if (sharpsCheck && sharpsCheck.status) {
    (logData as any).sharpsCheck = removeUndefined({
      status: sharpsCheck.status,
      notes: sharpsCheck.notes,
    });
  }

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

  // Compute summary statistics for admin audit review
  const totalItems = (checkEntries || []).length;
  const verifiedCount = (checkEntries || []).filter(e => e.ok).length;
  const mismatchCount = (checkEntries || []).filter(e => !e.ok).length;
  const expiredCount = (checkEntries || []).filter(e => {
    const exp = e.newExpirationDate ?? e.expirationDate;
    if (!exp) return false;
    return new Date(exp).getTime() < Date.now();
  }).length;
  const restockedCount = (checkEntries || []).filter(e => e.restockStatus === 'restocked').length;
  const reportedCount = (checkEntries || []).filter(e => e.issue && e.issue.type).length;
  logData.summary = { totalItems, verifiedCount, mismatchCount, expiredCount, restockedCount, reportedCount };

  const sanitizedLog = deepRemoveUndefined(logData as any);
  // Use both serverTimestamp (canonical) and a client-side Date for immediate reads.
  // serverTimestamp() is resolved server-side, but the client Date ensures the log
  // reflects the actual time of the action (retroactive-safe).
  const now = new Date();
  sanitizedLog.timestamp = serverTimestamp();
  sanitizedLog.clientTimestamp = now; // Fallback for immediate display before server resolves
  // Also re-assign checkedAt in each checkEntry
  if (Array.isArray(sanitizedLog.checkEntries)) {
    for (const entry of sanitizedLog.checkEntries) {
      entry.checkedAt = now;
    }
  }
  // Pre-assess recall + asset-currency hazards from the backing inventory docs so
  // readiness can fail-closed on them (bounded reads, outside the transaction).
  const hazard = await assessPackHazards(statpackId);

  // Write the log and update the statpack inside a transaction to avoid races.
  const statpackRef = doc(db, 'statpacks', statpackId);
  const newLogRef = doc(collection(db, 'statpack_logs'));

  try {
    await runTransaction(db, async (tx) => {
      const sp = await tx.get(statpackRef);
      if (!sp.exists()) throw new Error('Statpack not found');
      const spData = sp.data() as any;

      const isAdmin = userRole === 'admin' || userRole === 'quartermaster';

      // Prevent checking out a statpack that is already checked out
      if (action === 'checkout' && spData?.isCheckedOut) {
        throw new Error('Statpack is already checked out');
      }

      // Enforce same-user checkin: only the user who checked out (or admin) can check in
      if (action === 'checkin' && !isAdmin) {
        if (spData?.assignedToUserId && spData.assignedToUserId !== userId) {
          throw new Error('Only the user who checked out this statpack can check it in');
        }
      }

      // Build statpack update payload
      const statpackUpdate: Record<string, any> = {
        lastCheckedBy: userName,
        lastCheckedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      // ── Persist pack contents (currentQuantity is source of truth) ──────────
      // Clone existing contents (keep raw Firestore Timestamps intact — do NOT
      // deep-clean, that would corrupt Timestamp objects into plain maps).
      const contents: any[] = Array.isArray(spData?.contents)
        ? spData.contents.map((c: any) => ({ ...c }))
        : [];
      const usedIdx = new Set<number>();
      // Match a check entry to a pack content, disambiguating repeated itemIds
      // across pockets: compartmentId first, then pocket, then itemId alone.
      const matchIndex = (e: any): number => {
        if (e.compartmentId) {
          const i = contents.findIndex((c, idx) => !usedIdx.has(idx) && c.itemId === e.itemId && c.compartmentId && c.compartmentId === e.compartmentId);
          if (i >= 0) return i;
        }
        if (e.pocket) {
          const i = contents.findIndex((c, idx) => !usedIdx.has(idx) && c.itemId === e.itemId && c.pocket && c.pocket === e.pocket);
          if (i >= 0) return i;
        }
        return contents.findIndex((c, idx) => !usedIdx.has(idx) && c.itemId === e.itemId);
      };

      // Accumulate status signals while we walk the entries.
      let anyExpired = false;
      let anyShortConsumable = false;
      // Fail-closed: a required consumable submitted WITHOUT a numeric count is an
      // unknown, and unknown must resolve to not-ready (never optimistic 'Ready').
      let anyUnknown = false;
      const nowMs = Date.now();

      for (const e of (checkEntries || [])) {
        const idx = matchIndex(e);
        const content = idx >= 0 ? contents[idx] : undefined;
        if (idx >= 0) usedIdx.add(idx);

        // Assets are status-tracked, not counted. Identify them by serial on the
        // entry OR by asset linkage on the matched content.
        const isAssetEntry = Boolean(e.serialNumber) || Boolean(content?.assetInstanceId) || Boolean(content?.serialNumber);

        if (content && !isAssetEntry && typeof e.countedQuantity === 'number') {
          content.currentQuantity = e.countedQuantity;
        }
        // Persist a freshly entered expiration onto the content (clears expired).
        if (content && e.newExpirationDate) {
          content.expirationDate = e.newExpirationDate;
          if (content.effectiveExpiration !== undefined) content.effectiveExpiration = e.newExpirationDate;
        }

        // Status signals
        const effExp = e.newExpirationDate ?? e.expirationDate;
        const expiredByDate = effExp ? new Date(effExp).getTime() < nowMs : false;
        const expiredByIssue = Boolean(e.issue && (e.issue.type === 'broken' || e.issue.type === 'expired'));
        if (expiredByDate || expiredByIssue) anyExpired = true;

        if (!isAssetEntry && typeof e.requiredQuantity === 'number' && e.requiredQuantity > 0) {
          if (typeof e.countedQuantity !== 'number' || !Number.isFinite(e.countedQuantity)) {
            // Required consumable with no usable count → unknown → fail-closed.
            anyUnknown = true;
          } else if (e.countedQuantity < e.requiredQuantity && e.restockStatus !== 'restocked') {
            anyShortConsumable = true;
          }
        }
      }

      // Recall + stored-expiry hazards read from the pack's own persisted contents
      // (not just what the member re-entered this pass): a lot already recalled, or
      // a stored expiration already in the past, must flip the pack to not-ready.
      let anyQuarantined = false;
      let anyStoredExpired = false;
      for (const c of contents) {
        if (c?.batchId && hazard.quarantinedBatchIds.has(c.batchId)) anyQuarantined = true;
        const storedExp = toMillisLoose(c?.expirationDate);
        if (storedExp !== undefined && storedExp < nowMs) anyStoredExpired = true;
      }

      // Write updated contents back whenever the pack has contents to persist.
      if (Array.isArray(spData?.contents)) {
        statpackUpdate.contents = contents;
      }

      // Persist the pack-level sharps container check.
      if (sharpsCheck && sharpsCheck.status) {
        statpackUpdate.sharpsContainer = removeUndefined({
          status: sharpsCheck.status,
          lastCheckedAt: now,
          lastCheckedBy: userName,
        });
      }

      // Derive the resulting pack status for check-in / audit. Conservative:
      // expired/recalled lots (entered OR already stored) block first; short,
      // unknown (uncounted), stale life-safety assets, or a full sharps box all
      // keep the pack out of 'Ready'.
      const deriveStatus = (): Statpack['status'] => {
        if (anyExpired || anyStoredExpired || anyQuarantined) return 'Expired Items';
        if (anyShortConsumable
          || anyUnknown
          || hazard.assetCurrencyLapsed
          || sharpsCheck?.status === 'full') return 'Restock Needed';
        return 'Ready';
      };

      if (action === 'checkout') {
        statpackUpdate.isCheckedOut = true;
        statpackUpdate.status = 'In Use';
        statpackUpdate.checkedOutAt = serverTimestamp();
        statpackUpdate.assignedToUserId = userId;
        statpackUpdate.assignedToUserName = userName;
      } else if (action === 'checkin') {
        statpackUpdate.isCheckedOut = false;
        statpackUpdate.status = deriveStatus();
        statpackUpdate.checkedOutAt = null;
        statpackUpdate.assignedToUserId = null;
        statpackUpdate.assignedToUserName = null;
      } else if (action === 'audit') {
        // Audits verify the pack in place — never take ownership of it.
        statpackUpdate.status = deriveStatus();
        statpackUpdate.lastAuditAt = serverTimestamp();
        statpackUpdate.lastAuditBy = userName;
      }

      // Use transaction to write the new log and update the statpack document.
      const txLog = { ...sanitizedLog } as any;
      // Ensure serverTimestamp sentinel fields remain present for server resolution
      txLog.timestamp = serverTimestamp();
      txLog.clientTimestamp = now;

      tx.set(newLogRef, txLog);
      tx.update(statpackRef, statpackUpdate);
    });
  } catch (e: any) {
    console.warn('logStatpackCheckOff: Transaction failed', e);
    throw e;
  }

  await logValidationWarningsToCollections({
    warnings: validationWarnings,
    statpackId,
    statpackName,
    userId,
    userName,
  });

  // Create tracked issue reports for any item the member flagged during the
  // check-off. Done AFTER the transaction commits so a report write can never
  // roll back the check-off; failures are logged, not thrown.
  const ISSUE_LABEL: Record<'missing' | 'broken' | 'expired', string> = {
    missing: 'Missing',
    broken: 'Broken',
    expired: 'Expired',
  };
  for (const ce of (checkEntries || [])) {
    if (!ce.issue || !ce.issue.type) continue;
    const label = ISSUE_LABEL[ce.issue.type] ?? 'Issue';
    const itemLabel = ce.itemName || ce.itemId;
    const qtyPart = ce.issue.quantity ? ` (${ce.issue.quantity} affected)` : '';
    try {
      await createReport({
        reporter: { userId, userName },
        type: 'bug',
        priority: (ce.issue.type === 'missing' || ce.issue.type === 'broken') ? 'high' : 'medium',
        title: `${label}: ${itemLabel} (in ${statpackName})`,
        description:
          `${label} reported during statpack ${action} of "${statpackName}"${qtyPart}.` +
          (ce.issue.notes ? `\n\n${ce.issue.notes}` : ''),
        pagePath: '/statpacks/check-off',
        component: 'statpack_checkoff',
        target: { collection: 'statpacks', docId: statpackId },
      });
    } catch (err) {
      console.warn('logStatpackCheckOff: failed to create issue report for', ce.itemId, err);
    }
  }

  return { logRef: newLogRef, validationWarnings };
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

  // Batch the primary lookups with chunked `documentId() in` queries (≤10 per
  // chunk) instead of one getDoc per id (N+1). Behavior is identical: ids that
  // don't resolve to an inventory doc simply fall through to the fallback path.
  for (let i = 0; i < uniqueItemIds.length; i += 10) {
    const chunk = uniqueItemIds.slice(i, i + 10);
    try {
      const snap = await getDocs(query(collection(db, 'inventory'), where(documentId(), 'in', chunk)));
      snap.forEach(d => itemMap.set(d.id, d.data() as InventoryItem));
    } catch (e) {
      console.warn('validateStatpackAssignments: failed to batch-load inventory items', chunk, e);
    }
  }

  for (const entry of checkEntries || []) {
    let item = itemMap.get(entry.itemId);
    const serial = entry.serialNumber?.trim();

    if (!item) {
      // Attempt fallback lookups: try by itemName, then by serial fields on inventory.
      let foundItem: InventoryItem | undefined;
      try {
        if (entry.itemName) {
          const q = query(collection(db, 'inventory'), where('name', '==', entry.itemName));
          const snap = await getDocs(q);
          if (!snap.empty) {
            const d = snap.docs[0];
            foundItem = { ...(d.data() as InventoryItem), id: d.id } as InventoryItem;
            itemMap.set(entry.itemId, foundItem);
          }
        }

        // If still not found, and we have a serial, try matching common serial/barcode/qr fields
        if (!foundItem && serial) {
          // Try assetSerial
          let snap = await getDocs(query(collection(db, 'inventory'), where('assetSerial', '==', serial)));
          if (!snap.empty) {
            const d = snap.docs[0];
            foundItem = { ...(d.data() as InventoryItem), id: d.id } as InventoryItem;
            itemMap.set(entry.itemId, foundItem);
          }
          // Try barcode field
          if (!foundItem) {
            snap = await getDocs(query(collection(db, 'inventory'), where('barcode', '==', serial)));
            if (!snap.empty) {
              const d = snap.docs[0];
              foundItem = { ...(d.data() as InventoryItem), id: d.id } as InventoryItem;
              itemMap.set(entry.itemId, foundItem);
            }
          }
          // Try qr field
          if (!foundItem) {
            snap = await getDocs(query(collection(db, 'inventory'), where('qr', '==', serial)));
            if (!snap.empty) {
              const d = snap.docs[0];
              foundItem = { ...(d.data() as InventoryItem), id: d.id } as InventoryItem;
              itemMap.set(entry.itemId, foundItem);
            }
          }
        }
      } catch (e) {
        console.warn('validateStatpackAssignments: fallback lookup failed', e);
      }

      if (!foundItem) {
        // Only warn about missing inventory items for serialized/asset entries.
        // Non-asset items (disposables, consumables) may not have matching inventory docs
        // until a full inventory audit is performed — skip these to avoid noise.
        if (serial) {
          warnings.push({
            warningType: 'missing_asset',
            severity: 'warning',
            itemId: entry.itemId,
            itemName: entry.itemName,
            serialNumber: serial,
            message: `Inventory item not found for ${entry.itemName || entry.itemId}.`,
          });
        }
        continue;
      }

        // If we found a fallback item, update local item variable
        if (foundItem) {
          item = foundItem;
        }
      }

      if (!item) continue;

      const isAsset = determineIsAsset(item);
    if (isAsset && !serial) {
      warnings.push({
        warningType: 'missing_asset',
        severity: 'critical', // Asset missing serial is critical
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        message: `Asset item missing serial number during check-off.`,
      });
      continue;
    }

    if (!serial) continue;

    const { matched, instance } = resolveAssetInstance(item, serial);
    if (!matched) {
      const isAssetItem = determineIsAsset(item);
      warnings.push({
        warningType: 'missing_asset',
        severity: isAssetItem ? 'critical' : 'info',
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
        severity: 'critical', // Asset in wrong statpack is critical
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        currentAssignedTo: assignedToId,
        message: `Asset is assigned to a different statpack (${assignedToId}).`,
      });
    } else if (!assignedToId) {
      warnings.push({
        warningType: 'unassigned_asset',
        severity: 'warning', // Unassigned asset is warning level (can still proceed)
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
        severity: 'critical', // Not Ready asset is critical
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
        severity: 'critical', // Expired asset component is critical
        itemId: entry.itemId,
        itemName: entry.itemName || item.name,
        serialNumber: serial,
        message: 'Asset has an expired component or service window.',
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// BATCH CHECKOUT / CHECKIN (Issue 3)
// ---------------------------------------------------------------------------

/**
 * Batch checkout multiple assets in a single Firestore transaction.
 * Designed for scenarios like checking out 10 radios for training.
 *
 * @param assets - Array of { itemId, instanceSerial? } to check out
 * @param context - Checkout context (who, why, where)
 * @param userId - ID of the user performing the operation
 * @param userName - Name of the user
 */
export async function batchCheckoutAssets(
  assets: Array<{ itemId: string; instanceSerial?: string }>,
  context: { purpose: string; assignee: string; location: string; notes: string },
  userId: string,
  userName: string,
): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  // Firestore batches support max 500 operations; chunk if needed
  const CHUNK_SIZE = 100; // leave room for audit events per asset
  for (let i = 0; i < assets.length; i += CHUNK_SIZE) {
    const chunk = assets.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const { itemId, instanceSerial } of chunk) {
      try {
        const itemRef = doc(db, 'inventory', itemId);

        if (instanceSerial) {
          // Update specific instance within the item
          const itemSnap = await getDoc(itemRef);
          if (!itemSnap.exists()) {
            errors.push(`Item ${itemId} not found`);
            continue;
          }
          const data = itemSnap.data() as InventoryItem;
          const instances = data.assets || [];
          const idx = instances.findIndex(inst => inst.serial === instanceSerial);
          if (idx === -1) {
            errors.push(`Instance ${instanceSerial} not found in ${data.name}`);
            continue;
          }
          instances[idx] = {
            ...instances[idx],
            status: 'Checked Out',
            checkedOutAt: new Date(),
            checkedOutBy: userId,
            currentLocation: context.location || undefined,
          };
          batch.update(itemRef, {
            assets: instances,
            assetStatus: 'Checked Out',
            checkedOutAt: serverTimestamp(),
            checkedOutBy: userId,
            updatedAt: serverTimestamp(),
          });
        } else {
          // Simple asset (no instances array)
          batch.update(itemRef, {
            assetStatus: 'Checked Out',
            checkedOutAt: serverTimestamp(),
            checkedOutBy: userId,
            currentLocation: context.location || undefined,
            updatedAt: serverTimestamp(),
          });
        }

        // Audit event
        const logRef = doc(collection(db, 'inventory_logs'));
        batch.set(logRef, removeUndefined({
          itemId,
          action: 'batch_asset_checkout',
          serialNumber: instanceSerial || undefined,
          userId,
          userName,
          timestamp: serverTimestamp(),
          location: context.location || undefined,
          notes: `Batch checkout: ${context.purpose}. ${context.notes}`.trim(),
          details: {
            purpose: context.purpose,
            assignee: context.assignee,
            batchSize: assets.length,
          },
        }));

        successCount++;
      } catch (err) {
        errors.push(`Failed to checkout ${itemId}: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }

    await batch.commit();
  }

  // Global audit event
  await recordAuditEvent({
    eventType: 'batch_checkout',
    actor: { userId },
    details: `Batch checkout of ${successCount} assets for ${context.purpose} by ${context.assignee}`,
  });

  return { successCount, errors };
}

/**
 * Batch checkin multiple assets in a single Firestore transaction.
 */
export async function batchCheckinAssets(
  assets: Array<{ itemId: string; instanceSerial?: string; condition?: string; notes?: string }>,
  context: { assignee: string; location: string; notes: string },
  userId: string,
  userName: string,
): Promise<{ successCount: number; errors: string[] }> {
  const errors: string[] = [];
  let successCount = 0;

  const CHUNK_SIZE = 100;
  for (let i = 0; i < assets.length; i += CHUNK_SIZE) {
    const chunk = assets.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const { itemId, instanceSerial, condition, notes } of chunk) {
      try {
        const itemRef = doc(db, 'inventory', itemId);

        const newStatus = (condition === 'Needs Maintenance' || condition === 'Major Issue')
          ? 'Not Ready' : 'Ready';

        if (instanceSerial) {
          const itemSnap = await getDoc(itemRef);
          if (!itemSnap.exists()) { errors.push(`Item ${itemId} not found`); continue; }
          const data = itemSnap.data() as InventoryItem;
          const instances = data.assets || [];
          const idx = instances.findIndex(inst => inst.serial === instanceSerial);
          if (idx === -1) { errors.push(`Instance ${instanceSerial} not found in ${data.name}`); continue; }
          instances[idx] = {
            ...instances[idx],
            status: newStatus as AssetInstance['status'],
            lastCheckedInAt: new Date(),
            lastCheckedInBy: userId,
            currentLocation: context.location || undefined,
          };
          batch.update(itemRef, {
            assets: instances,
            assetStatus: newStatus,
            lastCheckedInAt: serverTimestamp(),
            lastCheckedInBy: userId,
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.update(itemRef, {
            assetStatus: newStatus,
            lastCheckedInAt: serverTimestamp(),
            lastCheckedInBy: userId,
            lastKnownReturnLocation: context.location || undefined,
            updatedAt: serverTimestamp(),
          });
        }

        // Audit log
        const logRef = doc(collection(db, 'inventory_logs'));
        batch.set(logRef, removeUndefined({
          itemId,
          action: 'batch_asset_checkin',
          serialNumber: instanceSerial || undefined,
          userId,
          userName,
          timestamp: serverTimestamp(),
          location: context.location || undefined,
          notes: notes || context.notes || undefined,
          newStatus,
          details: { condition, assignee: context.assignee },
        }));

        successCount++;
      } catch (err) {
        errors.push(`Failed to checkin ${itemId}: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }

    await batch.commit();
  }

  await recordAuditEvent({
    eventType: 'batch_checkin',
    actor: { userId },
    details: `Batch checkin of ${successCount} assets by ${context.assignee}`,
  });

  return { successCount, errors };
}

// ---------------------------------------------------------------------------
// ENHANCED ASSET-STATPACK ASSIGNMENT (Issue 2)
// ---------------------------------------------------------------------------

/**
 * Assign an asset to a statpack with full pocket/compartment tracking.
 * Updates BOTH the asset document and the statpack item reference
 * to maintain bidirectional visibility.
 */
export async function assignAssetToStatpack(
  assetId: string,
  statpackId: string,
  pocket: StatpackPocket,
  userId: string,
  userName: string,
  options?: {
    compartmentLabel?: string;
    positionIndex?: number;
    instanceSerial?: string;
  },
): Promise<void> {
  await runTransaction(db, async (transaction) => {
    const assetRef = doc(db, 'inventory', assetId);
    const statpackRef = doc(db, 'statpacks', statpackId);

    const [assetSnap, statpackSnap] = await Promise.all([
      transaction.get(assetRef),
      transaction.get(statpackRef),
    ]);

    if (!assetSnap.exists()) throw new Error('Asset not found');
    if (!statpackSnap.exists()) throw new Error('Statpack not found');

    const assetData = assetSnap.data() as InventoryItem;
    const statpackData = statpackSnap.data() as Statpack;

    // Check for existing assignment to a different statpack
    if (assetData.statpackAssignment?.statpackId &&
        assetData.statpackAssignment.statpackId !== statpackId) {
      throw new Error(
        `Asset is already assigned to statpack "${assetData.statpackAssignment.statpackName}". ` +
        `Remove it from that statpack first.`
      );
    }

    // Update asset with statpack assignment
    transaction.update(assetRef, {
      assignedToId: statpackId,
      statpackAssignment: {
        statpackId,
        statpackName: statpackData.name,
        pocket,
        compartmentLabel: options?.compartmentLabel || null,
        positionIndex: options?.positionIndex ?? null,
        assignedAt: serverTimestamp(),
        assignedBy: userId,
      },
      updatedAt: serverTimestamp(),
    });

    // Update statpack content item with asset reference if matching item exists
    const contents = [...(statpackData.contents || [])];
    const matchingItemIdx = contents.findIndex(c =>
      c.itemId === assetId && c.pocket === pocket
    );
    if (matchingItemIdx >= 0) {
      contents[matchingItemIdx] = {
        ...contents[matchingItemIdx],
        assetInstanceId: options?.instanceSerial || assetId,
        serialNumber: options?.instanceSerial || assetData.assetSerial || undefined,
      };
      transaction.update(statpackRef, { contents, updatedAt: serverTimestamp() });
    }
  });

  // Audit event
  await recordAuditEvent({
    eventType: 'asset_assigned_to_statpack',
    source: 'inventory',
    sourceId: assetId,
    actor: { userId, userName },
    targets: [
      { collection: 'inventory', docId: assetId },
      { collection: 'statpacks', docId: statpackId },
    ],
    details: { statpackId, pocket, compartmentLabel: options?.compartmentLabel, positionIndex: options?.positionIndex },
  });
}

/**
 * Remove an asset from its current statpack assignment.
 */
export async function unassignAssetFromStatpack(
  assetId: string,
  userId: string,
  userName: string,
): Promise<void> {
  const assetRef = doc(db, 'inventory', assetId);
  const assetSnap = await getDoc(assetRef);
  if (!assetSnap.exists()) throw new Error('Asset not found');

  const assetData = assetSnap.data() as InventoryItem;
  const prevStatpack = assetData.statpackAssignment?.statpackName || assetData.assignedToId || 'unknown';

  await updateDoc(assetRef, {
    assignedToId: null,
    statpackAssignment: null,
    updatedAt: serverTimestamp(),
  });

  await recordAuditEvent({
    eventType: 'asset_unassigned_from_statpack',
    source: 'inventory',
    sourceId: assetId,
    actor: { userId, userName },
    details: { previousStatpack: prevStatpack },
  });
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
  // Explicit flag takes precedence (an explicit `false` keeps disposables out).
  if (item.isAsset !== undefined) return item.isAsset;

  const it = item as Partial<InventoryItem>;

  // Check category-based rules from org-config
  const category = (item as any).category;
  if (category && getAssetCategoriesRuntime().some(c => c.id.toLowerCase() === category.toLowerCase())) {
    return true;
  }

  // Check value threshold from org-config
  const value = (item as any).assetValue ?? 0;
  if (value >= getThresholds().assetValueThreshold) return true;

  // MODEL-2: durable gear (cot, backboard) often has no assetValue but shows
  // clear asset signals. Treat any of these as an asset even without a value.
  // Trainers are still assets for tracking, so no isTrainer exclusion here.
  if (it.assetSerial) return true;
  if (it.assetStatus) return true;
  if (it.assetCategory) return true;
  if (Array.isArray(it.assets) && it.assets.length > 0) return true;
  if (Array.isArray(it.maintenance_logs) && it.maintenance_logs.length > 0) return true;
  if (it.isOxygen) return true;

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
  
  // Audit logs — strip undefined (e.g. a missing `notes`) so Firestore, which
  // rejects `undefined` field values, does not throw on a no-note consume.
  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
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
  }));
  
  return batchId;
}

/**
 * FEFO (first-expiry-first-out) consumption of a batch/lot-tracked SKU.
 *
 * Draws `quantity` units from the item's batches in EARLIEST-expiry-first order,
 * skipping any lot that is expired or quarantined/recalled, and decrementing each
 * drawn lot's `stock` (recomputing `bagCount`/`looseItems` from `itemsPerBag` so a
 * bag-tracked lot stays consistent). REFUSES (throws) if `quantity` exceeds the
 * available (deployable) total — stock is never driven negative. Writes one
 * `inventory_logs` row describing the draw.
 *
 * This is the lot-level consume primitive the model previously lacked (INV-5);
 * `consumeBox` only moves sealed boxes to an open batch and never picks by expiry.
 */
export async function consumeSku(params: {
  itemId: string;
  quantity: number;
  actor: { uid: string; name: string; email?: string };
  note?: string;
}): Promise<{ consumed: number; draws: Array<{ batchId: string; units: number }> }> {
  const { itemId, quantity, actor, note } = params;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`consumeSku: quantity must be a positive number (got ${quantity})`);
  }

  const itemRef = doc(db, 'inventory', itemId);

  const { itemName, draws } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error(`Inventory item ${itemId} not found`);
    const item = snap.data() as InventoryItem;
    const batches = (item.batches || []).map(b => ({ ...b }));
    const nowMs = Date.now();

    const unitsOf = (b: InventoryBatch): number => b.stock ?? 0;
    const eligible = batches
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => {
        if (unitsOf(b) <= 0) return false;
        if (b.status === 'quarantined') return false;
        const exp = toMillisLoose(b.expirationDate);
        if (exp !== undefined && exp < nowMs) return false; // expired
        return true;
      })
      // Earliest expiry first; undated lots drawn last.
      .sort((x, y) => (toMillisLoose(x.b.expirationDate) ?? Infinity) - (toMillisLoose(y.b.expirationDate) ?? Infinity));

    const available = eligible.reduce((sum, { b }) => sum + unitsOf(b), 0);
    if (quantity > available) {
      throw new Error(`consumeSku: insufficient available stock for ${itemId}. Requested ${quantity}, available ${available}`);
    }

    let remaining = quantity;
    const localDraws: Array<{ batchId: string; units: number }> = [];
    for (const { b, idx } of eligible) {
      if (remaining <= 0) break;
      const take = Math.min(unitsOf(b), remaining);
      const newStock = unitsOf(b) - take;
      const updated = batches[idx];
      updated.stock = newStock;
      // Keep bag/loose accounting consistent when the lot is bag-tracked.
      if (updated.itemsPerBag !== undefined && (updated.itemsPerBag ?? 0) > 0) {
        const per = updated.itemsPerBag as number;
        updated.bagCount = Math.floor(newStock / per);
        updated.looseItems = newStock % per;
      }
      if (newStock === 0 && updated.status !== 'quarantined') updated.status = 'depleted';
      remaining -= take;
      localDraws.push({ batchId: b.id, units: take });
    }

    tx.update(itemRef, { batches, updatedAt: serverTimestamp() });
    return { itemName: item.name, draws: localDraws };
  });

  // Immutable change log (best-effort; the consumption already committed).
  try {
    await addDoc(collection(db, 'inventory_logs'), removeUndefined({
      itemId,
      itemName,
      action: 'consume_sku',
      quantity,
      batchId: draws.map(d => d.batchId).join(','),
      userId: actor.uid,
      userName: actor.name,
      timestamp: serverTimestamp(),
      notes: note,
      details: { draws, method: 'FEFO' },
    } as Record<string, unknown>));
  } catch (e) {
    console.warn('consumeSku: failed to write inventory_logs row', e);
  }

  return { consumed: quantity, draws };
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
  expirationDate?: Date; // Optional expiration date confirmed at checkout
}): Promise<void> {
  const { assetId, user, location, note, serial, expirationDate } = params;
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
        ...(expirationDate ? { expirationDate } : {}),
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
    if (expirationDate && !updatedAssets) {
      // Single-instance asset: store top-level next expiration for convenience
      checkoutPayload.assetNextExpiration = expirationDate;
    }
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
    expirationDate: expirationDate ?? null,
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
      expirationDate: expirationDate ?? null,
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

  const maintenanceLogPayload: Record<string, unknown> = deepRemoveUndefined({
    statpackId,
    statpackName: statpack.name,
    action: 'maintenance',
    userId: user.id,
    userName: user.fullName || 'Unknown',
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
  });
  // Assign timestamp after sanitization to preserve the FieldValue sentinel
  maintenanceLogPayload.timestamp = serverTimestamp();
  await addDoc(collection(db, 'statpack_logs'), maintenanceLogPayload);

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
        // serverTimestamp() cannot be used inside arrays/arrayUnion in writes.
        // Use client-side Date for history entries inside arrays and keep
        // `updatedAt`/`timestamp` fields set to serverTimestamp() at the
        // top-level doc for canonical server time.
        assignedAt: new Date(),
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
    await addDoc(collection(db, 'inventory_logs'), deepRemoveUndefined(logEntry) as any);

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

/**
 * Compare expiration dates in month/year format (MM/YYYY or YYYY-MM).
 * Returns true if dates match within the same month and year.
 */
export function compareExpirationMonthYear(
  date1: Date | string | undefined,
  date2: Date | string | undefined
): boolean {
  if (!date1 || !date2) return false;
  
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);
  
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
}

/**
 * Verify an asset against configured verification rules.
 * Returns ValidationWarning[] with permissive defaults (advisory severity).
 * 
 * Checks:
 * - Serial number match (if requireSerial=true)
 * - Expiration date confirmation (if requireExpirationConfirmation=true)
 * - O2 PSI minimum (if requireO2PsiMin is set)
 */
export async function verifyAssetAgainstRules(params: {
  statpackItem: StatpackItem;
  scannedCode?: string; // Barcode/serial/QR scanned by user
  scannedExpiration?: Date | string; // GS1-parsed or user-entered expiration
  scannedO2Psi?: number; // User-entered O2 PSI reading
  inventoryItem?: InventoryItem; // Full item details (optional, will fetch if needed)
}): Promise<ValidationWarning[]> {
  const { statpackItem, scannedCode, scannedExpiration, scannedO2Psi, inventoryItem } = params;
  const warnings: ValidationWarning[] = [];

  // Fetch item details if not provided (we need item to derive rules if statpackItem doesn't carry them)
  let item = inventoryItem;
  if (!item && statpackItem.itemId) {
    try {
      const snap = await getDoc(doc(db, 'inventory', statpackItem.itemId));
      if (snap.exists()) {
        item = { id: snap.id, ...snap.data() } as InventoryItem;
      }
    } catch (e) {
      console.warn('Failed to fetch inventory item for verification', e);
    }
  }

  // Determine applicable rules: prefer statpackItem.verificationRules, fall back to statpack item's linked inventory item's verificationPolicy
  const rules = statpackItem.verificationRules && Object.keys(statpackItem.verificationRules).length > 0
    ? statpackItem.verificationRules
    : (item?.verificationPolicy || statpackItem.itemDetails?.verificationPolicy);

  // No rules = no verification needed (permissive default)
  if (!rules || Object.keys(rules).length === 0) return warnings;

  const severity = (rules as any).advisoryOnly ? 'warning' : 'critical';
  
  // Check 1: Serial number requirement
  if (rules.requireSerial) {
    const expectedSerial = statpackItem.serialNumber || item?.assetSerial;
    if (!scannedCode) {
      warnings.push({
        warningType: 'missing_asset',
        severity,
        itemId: statpackItem.itemId,
        itemName: statpackItem.itemDetails?.name || item?.name,
        serialNumber: expectedSerial,
        message: `Serial scan required but not provided${expectedSerial ? ` (expected: ${expectedSerial})` : ''}`,
      });
    } else if (expectedSerial && scannedCode !== expectedSerial) {
      // Also check asset instances
      const matchFound = item?.assets?.some(a => 
        a.serial === scannedCode || 
        a.barcode === scannedCode || 
        a.qr === scannedCode ||
        a.assetTag === scannedCode
      );
      
      if (!matchFound) {
        warnings.push({
          warningType: 'assigned_mismatch',
          severity,
          itemId: statpackItem.itemId,
          itemName: statpackItem.itemDetails?.name || item?.name,
          serialNumber: scannedCode,
          message: `Scanned serial "${scannedCode}" does not match expected "${expectedSerial}"`,
        });
      }
    }
  }
  
  // Check 2: Expiration date confirmation
  if (rules.requireExpirationConfirmation) {
    const expectedExpiration = statpackItem.expirationDate || item?.expirationDate;
    if (!scannedExpiration) {
      warnings.push({
        warningType: 'asset_expired',
        severity,
        itemId: statpackItem.itemId,
        itemName: statpackItem.itemDetails?.name || item?.name,
        message: 'Expiration confirmation required but not provided',
      });
    } else if (expectedExpiration) {
      const match = compareExpirationMonthYear(expectedExpiration, scannedExpiration);
      if (!match) {
        const exp1 = expectedExpiration instanceof Date ? expectedExpiration.toISOString().slice(0, 7) : String(expectedExpiration).slice(0, 7);
        const exp2 = scannedExpiration instanceof Date ? scannedExpiration.toISOString().slice(0, 7) : String(scannedExpiration).slice(0, 7);
        warnings.push({
          warningType: 'asset_expired',
          severity,
          itemId: statpackItem.itemId,
          itemName: statpackItem.itemDetails?.name || item?.name,
          message: `Expiration mismatch: scanned "${exp2}" vs stored "${exp1}"`,
        });
      }
      
      // Also check if expired
      const expDate = scannedExpiration instanceof Date ? scannedExpiration : new Date(scannedExpiration);
      if (!isNaN(expDate.getTime()) && expDate < new Date()) {
        warnings.push({
          warningType: 'asset_expired',
          severity: 'critical', // Expired is always critical
          itemId: statpackItem.itemId,
          itemName: statpackItem.itemDetails?.name || item?.name,
          message: `Item expired on ${expDate.toLocaleDateString()}`,
        });
      }
    }
  }
  
  // Check 3: O2 PSI minimum
  if (rules.requireO2PsiMin !== undefined && rules.requireO2PsiMin > 0) {
    if (scannedO2Psi === undefined || scannedO2Psi === null) {
      warnings.push({
        warningType: 'asset_status',
        severity,
        itemId: statpackItem.itemId,
        itemName: statpackItem.itemDetails?.name || item?.name,
        message: `O₂ PSI reading required (min: ${rules.requireO2PsiMin})`,
      });
    } else if (scannedO2Psi < rules.requireO2PsiMin) {
      warnings.push({
        warningType: 'asset_status',
        severity,
        itemId: statpackItem.itemId,
        itemName: statpackItem.itemDetails?.name || item?.name,
        message: `O₂ PSI too low: ${scannedO2Psi} (min: ${rules.requireO2PsiMin})`,
      });
    }
  }
  
  return warnings;
}
