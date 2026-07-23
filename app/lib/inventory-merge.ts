/**
 * Inventory duplicate detection, merge, and hard-delete.
 *
 * Follows the triple-write contract documented at `app/lib/audit-actions.ts:1-9`
 * (the domain change itself + an `inventory_logs` row + an `auditEvents` ledger
 * entry) so usage metrics stay derivable from the ledger.
 *
 * ── The dangerous part ──────────────────────────────────────────────────────
 * `computeBagStock()` (`app/lib/item-status.ts`) treats an item's `batches[]`
 * as the stock source of truth the moment ANY batch has `bagCount > 0` or
 * `itemsPerBag > 0`. If a bag-tracked loser's batches were concatenated onto a
 * box-tracked survivor, the survivor would flip into bag-tracked mode and its
 * `unopenedBoxes` contribution would be silently ignored by every stock read
 * in the app. `buildMergePlan` below refuses any merge where the survivor and
 * a loser disagree on tracking mode — same-mode merges only.
 */

import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { DocumentData, DocumentReference, WriteBatch } from 'firebase/firestore';
import { db } from '@/firebase';
import { recordAuditEvent, removeUndefined } from '@/app/lib/audit';
import { computeBagStock } from '@/app/lib/item-status';
import { safeParseDate } from '@/app/utils/inventoryNormalization';
import type { InventoryBatch, InventoryItem } from '@/app/types';

export interface MergeActor {
  uid: string;
  name: string;
  email?: string | null;
}

// ─── Levenshtein distance (shared with app/components/additemmodal.tsx) ──────
// Extracted here so both the add-item duplicate check and the inventory-page
// duplicate banner share one implementation instead of drifting apart.

/** Case/whitespace-insensitive edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const as = a.toLowerCase().trim();
  const bs = b.toLowerCase().trim();
  if (as === bs) return 0;
  const m = as.length, n = bs.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = as[i - 1] === bs[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

export type DuplicateReason = 'sku' | 'barcode' | 'name' | 'fuzzy';

export interface DuplicateGroup {
  /** Stable key for this group (derived from member ids). */
  key: string;
  items: InventoryItem[];
  /** Strongest match reason found among the group's members. */
  reason: DuplicateReason;
}

const REASON_RANK: Record<DuplicateReason, number> = { sku: 3, barcode: 3, name: 2, fuzzy: 1 };

/**
 * Group inventory items that look like duplicates of each other: exact SKU
 * match, exact barcode match, exact normalized-name match, or a near-name
 * match (Levenshtein distance within 25% of the longer name, floor 2).
 * Archived/already-merged items are excluded. Union-find groups transitively
 * — if A~B and B~C, all three land in one group even if A and C alone
 * wouldn't have matched.
 */
export function findDuplicateCandidates(items: InventoryItem[]): DuplicateGroup[] {
  const active = items.filter((i) => !(i as unknown as { isArchived?: boolean }).isArchived);
  const n = active.length;
  if (n < 2) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  const bestReason: DuplicateReason[] = new Array(n).fill('fuzzy');

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function upgrade(i: number, reason: DuplicateReason) {
    if (REASON_RANK[reason] > REASON_RANK[bestReason[i]]) bestReason[i] = reason;
  }
  function union(a: number, b: number, reason: DuplicateReason) {
    upgrade(a, reason);
    upgrade(b, reason);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const normalized = active.map((i) => normalizeName(i.name || ''));
  const skus = active.map((i) => ((i as unknown as { sku?: string }).sku || '').trim().toLowerCase());
  const barcodes = active.map((i) => (i.barcode || '').trim().toLowerCase());

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (skus[i] && skus[j] && skus[i] === skus[j]) { union(i, j, 'sku'); continue; }
      if (barcodes[i] && barcodes[j] && barcodes[i] === barcodes[j]) { union(i, j, 'barcode'); continue; }
      if (normalized[i] && normalized[i] === normalized[j]) { union(i, j, 'name'); continue; }
      if (normalized[i].length >= 2 && normalized[j].length >= 2) {
        const dist = levenshtein(normalized[i], normalized[j]);
        const threshold = Math.max(2, Math.floor(Math.max(normalized[i].length, normalized[j].length) * 0.25));
        if (dist <= threshold) union(i, j, 'fuzzy');
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const result: DuplicateGroup[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let reason: DuplicateReason = 'fuzzy';
    for (const i of idxs) if (REASON_RANK[bestReason[i]] > REASON_RANK[reason]) reason = bestReason[i];
    const groupItems = idxs.map((i) => active[i]);
    result.push({ key: groupItems.map((it) => it.id).sort().join(':'), items: groupItems, reason });
  }
  // Strongest matches first.
  result.sort((a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason]);
  return result;
}

// ─── Shared write-batch chunker (Firestore's 500-op-per-batch limit) ─────────

const MAX_BATCH_OPS = 500;

class BatchChunker {
  private batches: WriteBatch[] = [writeBatch(db)];
  private opsInCurrent = 0;

  private current(): WriteBatch {
    if (this.opsInCurrent >= MAX_BATCH_OPS) {
      this.batches.push(writeBatch(db));
      this.opsInCurrent = 0;
    }
    this.opsInCurrent++;
    return this.batches[this.batches.length - 1];
  }

  set(ref: DocumentReference, data: DocumentData) {
    this.current().set(ref, data);
  }
  update(ref: DocumentReference, data: DocumentData) {
    this.current().update(ref, data);
  }
  delete(ref: DocumentReference) {
    this.current().delete(ref);
  }
  async commit() {
    for (const b of this.batches) await b.commit();
  }
}

// ─── Forward-looking reference scan ──────────────────────────────────────────
// The reference set this workstream repoints on merge / refuses to delete
// through: statpacks.contents[].itemId, exchange_bags.lines[].itemId,
// containers.boxContents[].itemId, buyList.linkedInventoryId,
// tasks.linkedInventoryId, purchases.lines[].linkedInventoryId/.createdInventoryId,
// and the dotted map key restock_categories.itemRestocks.{itemId}.
//
// Deliberately NOT scanned/touched (historical, must stay pointed at the
// loser so audit history stays truthful): inventory_logs, auditEvents,
// box_logs, medication_logs, purchase_history, restock_shelf_events,
// laf_records.

interface ArrayRefMatch {
  id: string;
  data: Record<string, unknown>;
}
interface ScalarRefMatch {
  id: string;
  data: Record<string, unknown>;
}
interface MapKeyRefMatch {
  id: string;
  data: Record<string, unknown>;
  matchedKeys: string[];
}

async function scanArrayCollection(
  collectionName: string,
  arrayField: string,
  idFields: string[],
  targetIds: Set<string>,
): Promise<ArrayRefMatch[]> {
  const snap = await getDocs(collection(db, collectionName));
  const matches: ArrayRefMatch[] = [];
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const arr = data[arrayField];
    if (!Array.isArray(arr)) continue;
    const hit = arr.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      return idFields.some((f) => {
        const v = (entry as Record<string, unknown>)[f];
        return typeof v === 'string' && targetIds.has(v);
      });
    });
    if (hit) matches.push({ id: d.id, data });
  }
  return matches;
}

/** Chunked `where(field, 'in', …)` — Firestore caps `in` arrays at 10 values. */
async function scanScalarCollection(
  collectionName: string,
  field: string,
  targetIds: string[],
): Promise<ScalarRefMatch[]> {
  const results: ScalarRefMatch[] = [];
  for (let i = 0; i < targetIds.length; i += 10) {
    const chunk = targetIds.slice(i, i + 10);
    const snap = await getDocs(query(collection(db, collectionName), where(field, 'in', chunk)));
    for (const d of snap.docs) results.push({ id: d.id, data: d.data() as Record<string, unknown> });
  }
  return results;
}

async function scanMapKeyCollection(
  collectionName: string,
  mapField: string,
  targetIds: Set<string>,
): Promise<MapKeyRefMatch[]> {
  const snap = await getDocs(collection(db, collectionName));
  const results: MapKeyRefMatch[] = [];
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const map = data[mapField] as Record<string, unknown> | undefined;
    if (!map) continue;
    const matchedKeys = Object.keys(map).filter((k) => targetIds.has(k));
    if (matchedKeys.length > 0) results.push({ id: d.id, data, matchedKeys });
  }
  return results;
}

function repointArrayField(
  data: Record<string, unknown>,
  arrayField: string,
  idFields: string[],
  targetIds: Set<string>,
  survivorId: string,
): unknown[] {
  const arr = (data[arrayField] as unknown[]) || [];
  return arr.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const clone = { ...(entry as Record<string, unknown>) };
    for (const f of idFields) {
      const v = clone[f];
      if (typeof v === 'string' && targetIds.has(v)) clone[f] = survivorId;
    }
    return clone;
  });
}

export interface ForwardRefScan {
  statpacks: ArrayRefMatch[];
  exchangeBags: ArrayRefMatch[];
  containers: ArrayRefMatch[];
  purchases: ArrayRefMatch[];
  buyList: ScalarRefMatch[];
  tasks: ScalarRefMatch[];
  restockCategories: MapKeyRefMatch[];
}

async function scanForwardRefs(targetIds: string[]): Promise<ForwardRefScan> {
  const idSet = new Set(targetIds);
  const [statpacks, exchangeBags, containers, purchases, buyList, tasks, restockCategories] = await Promise.all([
    scanArrayCollection('statpacks', 'contents', ['itemId'], idSet),
    scanArrayCollection('exchange_bags', 'lines', ['itemId'], idSet),
    scanArrayCollection('containers', 'boxContents', ['itemId'], idSet),
    scanArrayCollection('purchases', 'lines', ['linkedInventoryId', 'createdInventoryId'], idSet),
    scanScalarCollection('buyList', 'linkedInventoryId', targetIds),
    scanScalarCollection('tasks', 'linkedInventoryId', targetIds),
    scanMapKeyCollection('restock_categories', 'itemRestocks', idSet),
  ]);
  return { statpacks, exchangeBags, containers, purchases, buyList, tasks, restockCategories };
}

export function forwardRefCounts(scan: ForwardRefScan): Record<string, number> {
  return {
    statpacks: scan.statpacks.length,
    exchangeBags: scan.exchangeBags.length,
    containers: scan.containers.length,
    purchases: scan.purchases.length,
    buyList: scan.buyList.length,
    tasks: scan.tasks.length,
    restockCategories: scan.restockCategories.length,
  };
}

function totalForwardRefs(scan: ForwardRefScan): number {
  return Object.values(forwardRefCounts(scan)).reduce((s, n) => s + n, 0);
}

// ─── Merge plan ───────────────────────────────────────────────────────────────

function hydrateItemForMerge(id: string, data: Record<string, unknown>): InventoryItem & Record<string, unknown> {
  const rawBatches = Array.isArray(data.batches) ? (data.batches as Record<string, unknown>[]) : [];
  const batches: InventoryBatch[] = rawBatches.map((b) => ({
    ...b,
    expirationDate: safeParseDate(b.expirationDate as Parameters<typeof safeParseDate>[0]),
  })) as InventoryBatch[];
  return { ...data, id, batches } as InventoryItem & Record<string, unknown>;
}

function trackingMode(item: InventoryItem): 'bag' | 'box' {
  return computeBagStock(item).hasBagTracking ? 'bag' : 'box';
}

/** Physical on-hand total (see item-status.ts) — used for the merge preview only. */
function physicalStock(item: InventoryItem): number {
  return computeBagStock(item).totalItems;
}

interface MergePlan {
  survivorId: string;
  survivor: InventoryItem & Record<string, unknown>;
  loserIds: string[];
  losers: (InventoryItem & Record<string, unknown>)[];
  mode: 'bag' | 'box';
  mergedPatch: Record<string, unknown>;
  scan: ForwardRefScan;
  stockBefore: { id: string; name: string; total: number }[];
  stockAfterSurvivor: number;
}

/**
 * Reads the survivor + losers fresh from Firestore, enforces the tracking-mode
 * guard, computes the summed-stock patch, and scans forward-looking
 * collections for references to the losers. Does NOT write anything — used
 * by both the read-only preview and the real merge so they can never drift.
 */
async function buildMergePlan(survivorId: string, loserIds: string[]): Promise<MergePlan> {
  if (!survivorId) throw new Error('A survivor item must be selected');
  const uniqueLoserIds = Array.from(new Set(loserIds.filter((id) => id && id !== survivorId)));
  if (uniqueLoserIds.length === 0) throw new Error('Select at least one duplicate item to merge');

  const survivorSnap = await getDoc(doc(db, 'inventory', survivorId));
  if (!survivorSnap.exists()) throw new Error(`Survivor item ${survivorId} not found`);
  const survivor = hydrateItemForMerge(survivorSnap.id, survivorSnap.data());
  if (survivor.isArchived) {
    throw new Error(`"${survivor.name}" is already archived/merged — pick a live item as the survivor`);
  }

  const losers: (InventoryItem & Record<string, unknown>)[] = [];
  for (const id of uniqueLoserIds) {
    const snap = await getDoc(doc(db, 'inventory', id));
    if (!snap.exists()) throw new Error(`Item ${id} not found`);
    const loser = hydrateItemForMerge(snap.id, snap.data());
    if (loser.isArchived) {
      throw new Error(`"${loser.name}" is already archived — it may already be merged into another item`);
    }
    losers.push(loser);
  }

  // ── THE dangerous guard: refuse a mixed-mode merge before any write. ──────
  const survivorMode = trackingMode(survivor);
  const modeLabel = (m: 'bag' | 'box') => (m === 'bag' ? 'bag/lot-tracked' : 'box-tracked');
  for (const loser of losers) {
    const loserMode = trackingMode(loser);
    if (loserMode !== survivorMode) {
      throw new Error(
        `Cannot merge "${loser.name}" (${modeLabel(loserMode)}) into "${survivor.name}" (${modeLabel(survivorMode)}) — ` +
        `mixed-mode merges are refused. Concatenating batches into a box-tracked item (or vice versa) would silently ` +
        `zero out its stock the next time it's read. Only items with the same tracking mode can be merged.`,
      );
    }
  }

  // ── Second guard: box-tracked items must agree on units-per-box. ──────────
  // Box-tracked stock is pooled onto `unopenedBoxes` and only converted to
  // units at read time, via the ITEM-level `itemsPerBox` (see computeBagStock
  // in item-status.ts). So summing boxes across items whose boxes hold
  // different unit counts silently rescales the loser's stock to the
  // survivor's box size — 3 boxes of 50 merged into an item with
  // itemsPerBox 100 would read back as 300 units instead of 150.
  // Per-lot box quantity is a deliberate open design gap (CLAUDE.md), so we
  // refuse rather than invent a conversion the rest of the app can't see.
  if (survivorMode === 'box') {
    const survivorPerBox = survivor.itemsPerBox ?? 0;
    for (const loser of losers) {
      const loserPerBox = loser.itemsPerBox ?? 0;
      if (survivorPerBox > 0 && loserPerBox > 0 && survivorPerBox !== loserPerBox) {
        throw new Error(
          `Cannot merge "${loser.name}" (${loserPerBox} per box) into "${survivor.name}" ` +
          `(${survivorPerBox} per box) — box-tracked stock is pooled as a box count and only ` +
          `converted to units by the survivor's units-per-box, so merging would misstate on-hand ` +
          `stock. Make the units-per-box match on both items first, or convert one to loose units.`,
        );
      }
    }
  }

  // ── Sum stock within the mode ──────────────────────────────────────────────
  const mergedPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (survivorMode === 'bag') {
    mergedPatch.batches = [...(survivor.batches || []), ...losers.flatMap((l) => l.batches || [])];
  } else {
    mergedPatch.unopenedBoxes =
      (survivor.unopenedBoxes ?? 0) + losers.reduce((s, l) => s + (l.unopenedBoxes ?? 0), 0);
    mergedPatch.looseUnits =
      (survivor.looseUnits ?? 0) + losers.reduce((s, l) => s + (l.looseUnits ?? 0), 0);
    mergedPatch.totalStockQuantity =
      (survivor.totalStockQuantity ?? 0) + losers.reduce((s, l) => s + (l.totalStockQuantity ?? 0), 0);
  }
  mergedPatch.shelfQuantity =
    (survivor.shelfQuantity ?? 0) + losers.reduce((s, l) => s + (l.shelfQuantity ?? 0), 0);
  const incomingOrders = [...(survivor.incomingOrders || []), ...losers.flatMap((l) => l.incomingOrders || [])];
  if (incomingOrders.length > 0) mergedPatch.incomingOrders = incomingOrders;

  const scan = await scanForwardRefs(uniqueLoserIds);

  const stockBefore = [survivor, ...losers].map((it) => ({ id: it.id, name: it.name, total: physicalStock(it) }));
  const stockAfterSurvivor = stockBefore.reduce((s, x) => s + x.total, 0);

  return {
    survivorId,
    survivor,
    loserIds: uniqueLoserIds,
    losers,
    mode: survivorMode,
    mergedPatch,
    scan,
    stockBefore,
    stockAfterSurvivor,
  };
}

export interface MergePreview {
  survivorId: string;
  survivorName: string;
  loserIds: string[];
  loserNames: string[];
  mode: 'bag-tracked' | 'box-tracked';
  stockBefore: { id: string; name: string; total: number }[];
  stockAfterSurvivor: number;
  repointedCounts: Record<string, number>;
  repointedTotal: number;
}

/** Read-only preview for the merge confirmation modal — no writes. */
export async function previewInventoryMerge(survivorId: string, loserIds: string[]): Promise<MergePreview> {
  const plan = await buildMergePlan(survivorId, loserIds);
  return {
    survivorId: plan.survivorId,
    survivorName: plan.survivor.name,
    loserIds: plan.loserIds,
    loserNames: plan.losers.map((l) => l.name),
    mode: plan.mode === 'bag' ? 'bag-tracked' : 'box-tracked',
    stockBefore: plan.stockBefore,
    stockAfterSurvivor: plan.stockAfterSurvivor,
    repointedCounts: forwardRefCounts(plan.scan),
    repointedTotal: totalForwardRefs(plan.scan),
  };
}

export interface MergeResult {
  survivorId: string;
  mergedLoserIds: string[];
  repointedCounts: Record<string, number>;
}

/**
 * Merge `loserIds` into `survivorId`: sums stock within the shared tracking
 * mode, repoints forward-looking references, archives (never deletes) the
 * losers, and writes the triple-write contract for the merge action itself.
 * Refuses (throws, no writes) on a mixed-mode merge — see `buildMergePlan`.
 */
export async function mergeInventoryItems(params: {
  survivorId: string;
  loserIds: string[];
  actor: MergeActor;
}): Promise<MergeResult> {
  const { survivorId, loserIds, actor } = params;
  const plan = await buildMergePlan(survivorId, loserIds);
  const chunker = new BatchChunker();

  // 1. Survivor — summed stock.
  chunker.update(doc(db, 'inventory', plan.survivorId), removeUndefined(plan.mergedPatch));

  // 2. Losers — archived, never deleted.
  for (const loser of plan.losers) {
    chunker.update(doc(db, 'inventory', loser.id), {
      isArchived: true,
      mergedIntoId: plan.survivorId,
      mergedAt: serverTimestamp(),
      mergedBy: { uid: actor.uid, name: actor.name },
      updatedAt: serverTimestamp(),
    });
  }

  // 3. Repoint forward-looking refs only (historical logs/ledger are untouched).
  const targetSet = new Set(plan.loserIds);
  for (const m of plan.scan.statpacks) {
    chunker.update(doc(db, 'statpacks', m.id), {
      contents: repointArrayField(m.data, 'contents', ['itemId'], targetSet, plan.survivorId),
      updatedAt: serverTimestamp(),
    });
  }
  for (const m of plan.scan.exchangeBags) {
    chunker.update(doc(db, 'exchange_bags', m.id), {
      lines: repointArrayField(m.data, 'lines', ['itemId'], targetSet, plan.survivorId),
      updatedAt: serverTimestamp(),
    });
  }
  for (const m of plan.scan.containers) {
    chunker.update(doc(db, 'containers', m.id), {
      boxContents: repointArrayField(m.data, 'boxContents', ['itemId'], targetSet, plan.survivorId),
      updatedAt: serverTimestamp(),
    });
  }
  for (const m of plan.scan.purchases) {
    chunker.update(doc(db, 'purchases', m.id), {
      lines: repointArrayField(m.data, 'lines', ['linkedInventoryId', 'createdInventoryId'], targetSet, plan.survivorId),
      updatedAt: serverTimestamp(),
    });
  }
  for (const m of plan.scan.buyList) {
    chunker.update(doc(db, 'buyList', m.id), { linkedInventoryId: plan.survivorId });
  }
  for (const m of plan.scan.tasks) {
    chunker.update(doc(db, 'tasks', m.id), { linkedInventoryId: plan.survivorId });
  }
  for (const m of plan.scan.restockCategories) {
    const map = (m.data.itemRestocks as Record<string, unknown>) || {};
    const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    for (const key of m.matchedKeys) {
      patch[`itemRestocks.${plan.survivorId}`] = map[key];
      patch[`itemRestocks.${key}`] = deleteField();
    }
    chunker.update(doc(db, 'restock_categories', m.id), patch);
  }

  const repointedCounts = forwardRefCounts(plan.scan);

  // 4. The merge action itself — inventory_logs row + auditEvents ledger entry.
  chunker.set(doc(collection(db, 'inventory_logs')), removeUndefined({
    itemId: plan.survivorId,
    itemName: plan.survivor.name,
    action: 'merged_duplicates',
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `Merged ${plan.losers.length} duplicate item(s) — ${plan.losers.map((l) => l.name).join(', ')} — into this item`,
    details: { loserIds: plan.loserIds, loserNames: plan.losers.map((l) => l.name), repointedCounts },
  }));

  chunker.set(doc(collection(db, 'auditEvents')), removeUndefined({
    eventType: 'inventory_items_merged',
    source: 'inventory_merge',
    sourceId: plan.survivorId,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [
      { collection: 'inventory', docId: plan.survivorId },
      ...plan.losers.map((l) => ({ collection: 'inventory', docId: l.id })),
    ],
    before: { stock: plan.stockBefore },
    after: { survivorStock: plan.stockAfterSurvivor },
    details: { repointedCounts },
    timestamp: serverTimestamp(),
  }));

  await chunker.commit();

  return { survivorId: plan.survivorId, mergedLoserIds: plan.loserIds, repointedCounts };
}

// ─── Hard delete ──────────────────────────────────────────────────────────────

export interface DeleteRefusedError extends Error {
  refCounts: Record<string, number>;
}

/**
 * Preflight-scans the same forward-looking reference set used by merge; if
 * any live reference exists, throws listing exactly which collections/docs
 * reference it and suggests merging instead. On success: `deleteDoc` +
 * an `auditEvents` tombstone entry (no `inventory_logs` row — the item no
 * longer exists to attach one to).
 */
export async function deleteInventoryItem(params: { itemId: string; actor: MergeActor }): Promise<void> {
  const { itemId, actor } = params;
  const itemSnap = await getDoc(doc(db, 'inventory', itemId));
  if (!itemSnap.exists()) throw new Error(`Item ${itemId} not found`);
  const itemData = itemSnap.data() as Record<string, unknown>;
  const itemName = (itemData.name as string) || itemId;

  const scan = await scanForwardRefs([itemId]);
  if (totalForwardRefs(scan) > 0) {
    const parts: string[] = [];
    if (scan.statpacks.length) parts.push(`statpacks (${scan.statpacks.map((m) => m.id).join(', ')})`);
    if (scan.exchangeBags.length) parts.push(`exchange_bags (${scan.exchangeBags.map((m) => m.id).join(', ')})`);
    if (scan.containers.length) parts.push(`containers (${scan.containers.map((m) => m.id).join(', ')})`);
    if (scan.purchases.length) parts.push(`purchases (${scan.purchases.map((m) => m.id).join(', ')})`);
    if (scan.buyList.length) parts.push(`buyList (${scan.buyList.map((m) => m.id).join(', ')})`);
    if (scan.tasks.length) parts.push(`tasks (${scan.tasks.map((m) => m.id).join(', ')})`);
    if (scan.restockCategories.length) parts.push(`restock_categories (${scan.restockCategories.map((m) => m.id).join(', ')})`);
    const err = new Error(
      `Cannot delete "${itemName}" — it is still referenced by ${parts.join('; ')}. ` +
      `Merge it into another item instead of deleting.`,
    ) as DeleteRefusedError;
    err.refCounts = forwardRefCounts(scan);
    throw err;
  }

  await deleteDoc(doc(db, 'inventory', itemId));

  await recordAuditEvent(removeUndefined({
    eventType: 'inventory_item_deleted',
    source: 'inventory_merge',
    sourceId: itemId,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: itemId }],
    before: removeUndefined({ name: itemName, category: itemData.category as string | undefined }),
    details: { tombstone: true },
  }));
}

/** Read-only reference check for the delete confirmation modal — no writes. */
export async function checkInventoryItemReferences(itemId: string): Promise<{
  refCounts: Record<string, number>;
  total: number;
}> {
  const scan = await scanForwardRefs([itemId]);
  const refCounts = forwardRefCounts(scan);
  return { refCounts, total: totalForwardRefs(scan) };
}

// ─── Edit logging ─────────────────────────────────────────────────────────────

/**
 * Update an inventory item and write the accompanying `inventory_logs` row
 * (in addition to the `auditEvents` entry the caller already writes) so edits
 * show up in the item's activity history, not just the ledger.
 */
export async function updateInventoryItemWithLog(params: {
  itemId: string;
  itemName?: string;
  data: Record<string, unknown>;
  actor: MergeActor;
}): Promise<void> {
  const { itemId, itemName, data, actor } = params;
  const chunker = new BatchChunker();
  chunker.update(doc(db, 'inventory', itemId), data);
  chunker.set(doc(collection(db, 'inventory_logs')), removeUndefined({
    itemId,
    itemName,
    action: 'item_updated',
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: 'Item details updated',
  }));
  await chunker.commit();
}
