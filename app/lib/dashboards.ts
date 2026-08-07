'use client';

/**
 * Dashboard-layout persistence for /stats.
 *
 * A `dashboards` Firestore collection holds `DashboardSpec` docs in two
 * flavors, keyed by doc id:
 *   - `published__<key>` — the org-wide default for that dashboard. No
 *     `ownerUid`; `published: true`. Admin/QM write it via `/settings`-style
 *     "publish" actions.
 *   - `<uid>__<key>` — a member's personal override of that dashboard's
 *     layout. `ownerUid` set to that member.
 *
 * Resolution order (what a viewer actually sees) is personal → published →
 * the hardcoded `DEFAULT_LAYOUTS` fallback, so the page always has something
 * to render even before anything has ever been saved to Firestore.
 *
 * Modeled directly on `app/lib/org-config-store.ts` (the house pattern for
 * Firestore-backed runtime config: onSnapshot subscriptions, merge writes,
 * actor attribution, and defaults that work with no doc present). See that
 * file for the pattern this one is deliberately mirroring.
 */

import {
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { deepRemoveUndefined } from '@/app/lib/audit';
import {
  DASHBOARD_META,
  GRID_COLUMNS,
  type DashboardKey,
  type DashboardSpec,
  type TileLayout,
} from '@/app/components/stats/tile-types';

const DASHBOARDS_COLLECTION = 'dashboards';

// ---------------------------------------------------------------------------
// Default layouts
// ---------------------------------------------------------------------------

/**
 * Starting grids for each dashboard, shown whenever no published or personal
 * doc exists yet.
 *
 * Tile ids are the canonical registry ids (`<dashboard>.<name>`) — they must
 * match `TILE_REGISTRY` in `app/components/stats/tile-registry.tsx` exactly.
 * Keep them stable: renaming one orphans every saved layout that references
 * the old id (the tile silently stops rendering — the registry, not this
 * file, decides what an unresolved id means).
 *
 * `consumption` is a superset of BOTH tabs of today's `/stats` page, so the
 * migration loses nothing: the statpack-usage KPIs, Most-Used Items and usage
 * trend land as `consumption.kpis`/`topItems`/`overTime`, and the whole
 * restock tab (its KPIs, Currently Missing, Top Boxes, Top Reported Items,
 * Reports Over Time) lands as the `consumption.restock*` tiles. Restock lives
 * on the Usage dashboard rather than Purchasing because a restock report is a
 * consumption signal — Purchasing is about money and vendors.
 *
 * `calls` ships with an EMPTY layout on purpose. There is no call data in this
 * system yet (see app/lib/calls/nemsis-map.ts); the page renders a "connect an
 * ESO export" state rather than tiles that would all be blank.
 */
export const DEFAULT_LAYOUTS: Record<DashboardKey, TileLayout[]> = {
  procurement: [
    { tileId: 'procurement.kpis', x: 0, y: 0, w: 12, h: 2 },
    { tileId: 'procurement.spendOverTime', x: 0, y: 2, w: 12, h: 6 },
    { tileId: 'procurement.spendByVendor', x: 0, y: 8, w: 6, h: 6 },
    { tileId: 'procurement.spendByCategory', x: 6, y: 8, w: 6, h: 6 },
    { tileId: 'procurement.buyListLatency', x: 0, y: 14, w: 6, h: 6 },
    { tileId: 'procurement.openOrdersAging', x: 6, y: 14, w: 6, h: 7 },
    { tileId: 'procurement.orderFillRate', x: 0, y: 21, w: 6, h: 7 },
    { tileId: 'procurement.unitPriceTrend', x: 6, y: 21, w: 6, h: 6 },
  ],
  consumption: [
    { tileId: 'consumption.kpis', x: 0, y: 0, w: 12, h: 2 },
    // Days of cover leads: it is the only tile that says "you are about to run
    // out of X", which is the question the whole dashboard exists to answer.
    { tileId: 'consumption.daysOfCover', x: 0, y: 2, w: 12, h: 7 },
    { tileId: 'consumption.overTime', x: 0, y: 9, w: 6, h: 6 },
    { tileId: 'consumption.topItems', x: 6, y: 9, w: 6, h: 6 },
    { tileId: 'consumption.usagePerDeployment', x: 0, y: 15, w: 6, h: 6 },
    { tileId: 'consumption.expiryWaste', x: 6, y: 15, w: 6, h: 6 },
    // ── everything below is the old Restock tab, preserved verbatim ──
    { tileId: 'consumption.restockKpis', x: 0, y: 21, w: 12, h: 2 },
    { tileId: 'consumption.currentlyMissing', x: 0, y: 23, w: 12, h: 5 },
    { tileId: 'consumption.topRestockBoxes', x: 0, y: 28, w: 4, h: 6 },
    { tileId: 'consumption.topReportedItems', x: 4, y: 28, w: 4, h: 6 },
    { tileId: 'consumption.reportsOverTime', x: 8, y: 28, w: 4, h: 6 },
    { tileId: 'consumption.restockLatency', x: 0, y: 34, w: 6, h: 6 },
    { tileId: 'consumption.medicationActivity', x: 6, y: 34, w: 6, h: 6 },
  ],
  staffing: [
    { tileId: 'staffing.kpis', x: 0, y: 0, w: 12, h: 2 },
    // Cert runway leads: an expiring cert blocks shift signup outright (D-14),
    // so it is the staffing failure with the longest lead time to fix.
    { tileId: 'staffing.certExpiryRunway', x: 0, y: 2, w: 6, h: 6 },
    { tileId: 'staffing.fillRateOverTime', x: 6, y: 2, w: 6, h: 6 },
    { tileId: 'staffing.attendanceFunnel', x: 0, y: 8, w: 4, h: 6 },
    { tileId: 'staffing.unfilledSlots', x: 4, y: 8, w: 4, h: 6 },
    { tileId: 'staffing.latenessHistogram', x: 8, y: 8, w: 4, h: 6 },
    { tileId: 'staffing.hoursByMember', x: 0, y: 14, w: 6, h: 7 },
    { tileId: 'staffing.latenessByMember', x: 6, y: 14, w: 6, h: 6 },
    { tileId: 'staffing.requestSupplyDemand', x: 0, y: 21, w: 6, h: 7 },
    { tileId: 'staffing.participationByCohort', x: 6, y: 21, w: 6, h: 6 },
  ],
  calls: [],
};

// ---------------------------------------------------------------------------
// Layout sanitization
// ---------------------------------------------------------------------------

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate + sanitize a saved tile layout: drops entries with a missing/
 * duplicate `tileId` or negative/NaN/non-finite coordinates, clamps `x + w`
 * to `GRID_COLUMNS` (dropping tiles that start entirely off-grid), and
 * coerces coordinates to integers. Returns `null` when nothing usable
 * survives, so callers can fall back to `DEFAULT_LAYOUTS` — a corrupt saved
 * layout must degrade gracefully, never crash the page.
 *
 * This does not detect two tiles occupying the same cells (that's a grid
 * renderer's collision concern at drag/drop time, not a storage-layer one) —
 * it only guards against structurally corrupt data.
 */
export function layoutIsValid(tiles: unknown): TileLayout[] | null {
  if (!Array.isArray(tiles) || tiles.length === 0) return null;

  const seenIds = new Set<string>();
  const out: TileLayout[] = [];

  for (const raw of tiles) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Partial<TileLayout>;

    if (typeof t.tileId !== 'string' || t.tileId.length === 0) continue;
    if (seenIds.has(t.tileId)) continue; // drop duplicate tile ids

    if (!isFiniteNonNegative(t.x) || !isFiniteNonNegative(t.y)) continue;
    if (!isFiniteNonNegative(t.w) || !isFiniteNonNegative(t.h)) continue;
    if (t.w <= 0 || t.h <= 0) continue;

    const x = Math.round(t.x);
    const y = Math.round(t.y);
    let w = Math.round(t.w);
    const h = Math.round(t.h);

    if (x >= GRID_COLUMNS) continue; // starts entirely off-grid — unrecoverable
    if (x + w > GRID_COLUMNS) w = GRID_COLUMNS - x; // clamp to fit

    seenIds.add(t.tileId);
    out.push({ tileId: t.tileId, x, y, w, h });
  }

  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Doc refs / conversion
// ---------------------------------------------------------------------------

function publishedDocId(key: DashboardKey): string {
  return `published__${key}`;
}

function personalDocId(key: DashboardKey, uid: string): string {
  return `${uid}__${key}`;
}

function publishedDocRef(key: DashboardKey) {
  return doc(db, DASHBOARDS_COLLECTION, publishedDocId(key));
}

function personalDocRef(key: DashboardKey, uid: string) {
  return doc(db, DASHBOARDS_COLLECTION, personalDocId(key, uid));
}

function defaultSpec(key: DashboardKey): DashboardSpec {
  return {
    id: `default__${key}`,
    key,
    name: DASHBOARD_META[key]?.label ?? key,
    tiles: DEFAULT_LAYOUTS[key],
  };
}

/** Build a usable `DashboardSpec` from a possibly-corrupt Firestore doc. */
function toDashboardSpec(
  docId: string,
  key: DashboardKey,
  data: Record<string, unknown> | undefined,
): DashboardSpec {
  const raw = (data ?? {}) as Partial<DashboardSpec>;
  const tiles = layoutIsValid(raw.tiles) ?? DEFAULT_LAYOUTS[key];
  return {
    id: docId,
    key,
    name: typeof raw.name === 'string' && raw.name ? raw.name : DASHBOARD_META[key]?.label ?? key,
    tiles,
    ownerUid: typeof raw.ownerUid === 'string' ? raw.ownerUid : undefined,
    published: raw.published === true,
    updatedAt: raw.updatedAt,
    updatedBy: raw.updatedBy,
  };
}

// ---------------------------------------------------------------------------
// Subscribe (read)
// ---------------------------------------------------------------------------

/**
 * Subscribe to a dashboard's effective layout for `uid`: personal override if
 * one exists, else the org-published default, else `DEFAULT_LAYOUTS`. Fires
 * `cb` on every relevant change and returns an unsubscribe fn.
 *
 * Always resolves to *something renderable* — a missing doc, an empty
 * collection, or an offline client all fall through to `DEFAULT_LAYOUTS`
 * rather than leaving the caller without a layout.
 *
 * Pass `uid: null` (e.g. logged-out / role not yet resolved) to subscribe to
 * the published/default layout only.
 */
export function subscribeDashboard(
  key: DashboardKey,
  uid: string | null | undefined,
  cb: (spec: DashboardSpec) => void,
): () => void {
  if (typeof window === 'undefined') {
    cb(defaultSpec(key));
    return () => {};
  }

  // undefined = not yet resolved by Firestore; null = resolved, doc absent.
  let personal: DashboardSpec | null | undefined = uid ? undefined : null;
  let published: DashboardSpec | null | undefined;

  const emit = () => {
    if (personal === undefined || published === undefined) return; // still loading
    cb(personal ?? published ?? defaultSpec(key));
  };

  const unsubs: Array<() => void> = [];

  unsubs.push(
    onSnapshot(
      publishedDocRef(key),
      (snap) => {
        published = snap.exists() ? toDashboardSpec(snap.id, key, snap.data()) : null;
        emit();
      },
      (err) => {
        console.warn('subscribeDashboard: published snapshot error', err);
        published = null;
        emit();
      },
    ),
  );

  if (uid) {
    unsubs.push(
      onSnapshot(
        personalDocRef(key, uid),
        (snap) => {
          personal = snap.exists() ? toDashboardSpec(snap.id, key, snap.data()) : null;
          emit();
        },
        (err) => {
          console.warn('subscribeDashboard: personal snapshot error', err);
          personal = null;
          emit();
        },
      ),
    );
  }

  return () => unsubs.forEach((unsub) => unsub());
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

/** Merge-write `uid`'s personal override of `key`'s layout, actor-stamped. */
export async function saveDashboardLayout(
  key: DashboardKey,
  uid: string,
  tiles: TileLayout[],
  actor: { uid: string; name: string },
): Promise<void> {
  const sanitized = layoutIsValid(tiles) ?? DEFAULT_LAYOUTS[key];
  const payload = deepRemoveUndefined({
    id: personalDocId(key, uid),
    key,
    name: DASHBOARD_META[key]?.label ?? key,
    tiles: sanitized,
    ownerUid: uid,
    published: false,
    updatedAt: serverTimestamp(),
    updatedBy: actor,
  });
  await setDoc(personalDocRef(key, uid), payload, { merge: true });
}

/**
 * Merge-write the org-published default layout for `key`, actor-stamped.
 * Admin/QM only — enforced by `firestore.rules`, not this function; callers
 * should still gate the UI so non-admins never reach this call.
 */
export async function publishDashboardLayout(
  key: DashboardKey,
  tiles: TileLayout[],
  actor: { uid: string; name: string },
): Promise<void> {
  const sanitized = layoutIsValid(tiles) ?? DEFAULT_LAYOUTS[key];
  const payload = deepRemoveUndefined({
    id: publishedDocId(key),
    key,
    name: DASHBOARD_META[key]?.label ?? key,
    tiles: sanitized,
    published: true,
    updatedAt: serverTimestamp(),
    updatedBy: actor,
  });
  await setDoc(publishedDocRef(key), payload, { merge: true });
}

/**
 * Delete `uid`'s personal override of `key`, so the published/default layout
 * shows again. No-op (resolves) if no personal doc exists.
 */
export async function resetDashboardLayout(key: DashboardKey, uid: string): Promise<void> {
  await deleteDoc(personalDocRef(key, uid));
}
