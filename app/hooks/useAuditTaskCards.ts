'use client';

import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  isAuditedThisMonth,
  isStatpackAuditCurrent,
  currentAuditCycleLabel,
} from '@/app/lib/item-status';
import type { InventoryItem, Statpack, TeamTaskStatus } from '@/app/types';

/**
 * A read-only, live-derived board card representing a recurring audit obligation.
 * It is never persisted to `team_tasks` — its status/counts are recomputed every
 * render from real inventory/statpack data, so it always reflects reality.
 */
export interface AuditTaskCard {
  id: '__audit_supply__' | '__audit_statpack__';
  title: string;
  subtitle: string;
  status: TeamTaskStatus;
  remaining: number; // items/packs still due this cycle
  total: number;
  href: string;
}

/** Firestore Timestamp → Date, mirroring the audit page's tolerant converter. */
function toDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  if (typeof val === 'object' && typeof (val as { toDate?: () => Date }).toDate === 'function')
    return (val as { toDate: () => Date }).toDate();
  return undefined;
}

/** remaining===0 → done; some done → in_progress; none done → this_cycle. */
function deriveStatus(total: number, remaining: number): TeamTaskStatus {
  if (total === 0 || remaining === 0) return 'done';
  if (remaining < total) return 'in_progress';
  return 'this_cycle';
}

/**
 * Subscribes to `inventory` and `statpacks` and derives the two recurring
 * committee audit cards (monthly supply audit, biweekly statpack audit).
 * Reuses the same audit-cadence helpers as `/audit` so the counts stay in sync.
 */
export function useAuditTaskCards(): { cards: AuditTaskCard[]; loading: boolean } {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [invLoaded, setInvLoaded] = useState(false);
  const [packLoaded, setPackLoaded] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setInventory(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<InventoryItem, 'id'>) })));
        setInvLoaded(true);
      },
      (e) => { console.error('[useAuditTaskCards] inventory listener error', e); setInvLoaded(true); }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setStatpacks(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Statpack, 'id'>) })));
        setPackLoaded(true);
      },
      (e) => { console.error('[useAuditTaskCards] statpacks listener error', e); setPackLoaded(true); }
    );
    return () => unsub();
  }, []);

  const cards = useMemo<AuditTaskCard[]>(() => {
    const now = new Date();

    // Monthly supply audit — matches the `stale_audit` rule in reconciliation.ts.
    const invTotal = inventory.length;
    const invRemaining = inventory.filter(
      (i) => !isAuditedThisMonth(toDate(i.lastAuditDate), now)
    ).length;

    // Biweekly statpack audit — matches the audit page's `statpacksDue`.
    const packTotal = statpacks.length;
    const packRemaining = statpacks.filter(
      (p) => !isStatpackAuditCurrent(toDate(p.lastAuditAt), now)
    ).length;

    return [
      {
        id: '__audit_supply__',
        title: `Monthly supply audit — ${currentAuditCycleLabel(now)}`,
        subtitle: `${invTotal - invRemaining} of ${invTotal} items audited`,
        status: deriveStatus(invTotal, invRemaining),
        remaining: invRemaining,
        total: invTotal,
        href: '/audit',
      },
      {
        id: '__audit_statpack__',
        title: 'Biweekly statpack audit',
        subtitle: `${packTotal - packRemaining} of ${packTotal} packs current`,
        status: deriveStatus(packTotal, packRemaining),
        remaining: packRemaining,
        total: packTotal,
        href: '/audit?tab=statpacks',
      },
    ];
  }, [inventory, statpacks]);

  return { cards, loading: !invLoaded || !packLoaded };
}
