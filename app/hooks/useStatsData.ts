'use client';

/**
 * Loads every collection the /stats dashboards read, in one shot.
 *
 * Deliberately `getDocs`, not `onSnapshot` (carried over from the previous
 * stats page): these are full-collection scans for analytics, and holding a
 * live listener on all of them would stream a large amount of data for numbers
 * nobody watches change second-to-second. The page has an explicit Refresh.
 *
 * Per-collection failure tolerance is the other load-bearing behavior. Reads
 * are role-gated by firestore.rules, so a medops user hitting the Staffing
 * dashboard will legitimately be DENIED on `inventory` and `purchases`. One
 * denied collection must degrade that collection's tiles to an honest empty
 * state — it must never blank the whole page or surface a raw permission error.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  EMPTY_STATS_DATA,
  type StatsData,
  type RestockReportDoc,
  type RestockActionDoc,
  type AuditEventDoc,
} from '@/app/lib/stats/shared';
import { toStatpackLogWithId, toStatpackSummary } from '@/app/lib/statpack-stats';
import type {
  Purchase,
  BuyListItem,
  InventoryItem,
  MedicationLog,
  Event as BmrcEvent,
  ShiftRequest,
  User,
  VehicleLog,
} from '@/app/types';

/** Firestore collection backing each key of `StatsData`. */
const COLLECTIONS: Record<keyof StatsData, string> = {
  purchases: 'purchases',
  buyList: 'buyList', // camelCase — NOT buy_list
  inventory: 'inventory',
  statpackLogs: 'statpack_logs',
  statpacks: 'statpacks',
  restockReports: 'restock_reports',
  restockActions: 'restock_actions',
  auditEvents: 'auditEvents', // camelCase ledger
  medicationLogs: 'medication_logs',
  events: 'events',
  shiftRequests: 'shift_requests',
  users: 'users',
  vehicleLogs: 'vehicle_logs',
};

export interface UseStatsDataResult {
  data: StatsData;
  loading: boolean;
  /** Keys whose read failed (denied or offline) — their tiles show "unavailable". */
  unavailable: (keyof StatsData)[];
  refresh: () => void;
  lastLoadedAt: Date | null;
}

/**
 * @param keys Which datasets to load. Pass only what the visible dashboards
 *   need so we don't issue reads that rules will deny anyway.
 * @param enabled Skip loading entirely (e.g. while auth is resolving).
 */
export function useStatsData(keys: (keyof StatsData)[], enabled = true): UseStatsDataResult {
  /**
   * One state object keyed by the dataset signature it was loaded for, so
   * `loading` can be DERIVED (`loaded.sig !== keySig`) rather than set at the
   * top of the effect. That keeps the effect free of synchronous setState and
   * has a better side effect: an explicit Refresh doesn't change the
   * signature, so it repaints in place instead of blanking the dashboard back
   * to a spinner.
   */
  const [loaded, setLoaded] = useState<{
    sig: string;
    data: StatsData;
    failed: (keyof StatsData)[];
    at: Date;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Stable identity so a caller passing an inline array doesn't loop forever.
  const keyList = useMemo(() => [...new Set(keys)].sort(), [keys]);
  const keySig = keyList.join(',');

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const wanted = keySig ? (keySig.split(',') as (keyof StatsData)[]) : [];
    if (!wanted.length) return;

    const load = async () => {
      const next: StatsData = { ...EMPTY_STATS_DATA };
      const failed: (keyof StatsData)[] = [];

      await Promise.all(
        wanted.map(async (key) => {
          try {
            const snap = await getDocs(collection(db, COLLECTIONS[key]));
            assignCollection(next, key, snap.docs);
          } catch (e) {
            // Expected for role-gated collections; log once, don't surface raw.
            console.warn(`[stats] could not load "${COLLECTIONS[key]}"`, e);
            failed.push(key);
          }
        })
      );

      if (cancelled) return;
      setLoaded({ sig: keySig, data: next, failed, at: new Date() });
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [keySig, enabled, refreshKey]);

  const isCurrent = loaded?.sig === keySig;
  return {
    data: isCurrent ? loaded.data : EMPTY_STATS_DATA,
    loading: enabled && keySig !== '' && !isCurrent,
    unavailable: isCurrent ? loaded.failed : [],
    refresh,
    lastLoadedAt: isCurrent ? loaded.at : null,
  };
}

type DocLike = { id: string; data: () => Record<string, unknown> };

/**
 * Widen raw Firestore docs into the typed bundle.
 *
 * These are unchecked casts by design: this app has years of documents written
 * before the current interfaces existed, so runtime shapes drift from the
 * types. The stats lib functions are all written to tolerate missing fields
 * (via `toDate()` and null-returning aggregates) rather than trusting the cast.
 */
function assignCollection(target: StatsData, key: keyof StatsData, docs: DocLike[]): void {
  switch (key) {
    case 'statpackLogs':
      target.statpackLogs = docs.map((d) => toStatpackLogWithId(d.id, d.data()));
      return;
    case 'statpacks':
      target.statpacks = docs.map((d) => toStatpackSummary(d.id, d.data()));
      return;
    case 'purchases':
      target.purchases = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as Purchase);
      return;
    case 'buyList':
      target.buyList = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as BuyListItem);
      return;
    case 'inventory':
      target.inventory = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as InventoryItem);
      return;
    case 'restockReports':
      target.restockReports = docs.map((d) => ({ id: d.id, ...d.data() }) as RestockReportDoc);
      return;
    case 'restockActions':
      target.restockActions = docs.map((d) => ({ id: d.id, ...d.data() }) as RestockActionDoc);
      return;
    case 'auditEvents':
      target.auditEvents = docs.map((d) => ({ id: d.id, ...d.data() }) as AuditEventDoc);
      return;
    case 'medicationLogs':
      target.medicationLogs = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as MedicationLog);
      return;
    case 'events':
      target.events = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as BmrcEvent);
      return;
    case 'shiftRequests':
      target.shiftRequests = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as ShiftRequest);
      return;
    case 'users':
      target.users = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as User);
      return;
    case 'vehicleLogs':
      target.vehicleLogs = docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as VehicleLog);
      return;
  }
}
