'use client';

/**
 * Reconciliation / Exceptions surface.
 *
 * Standing report of data problems the dashboard hides behind "false green":
 * orphaned (no-location) items, dated SKUs with no expiration on file, expired
 * stock physically present, stale (not-verified-this-month) items, and overdue
 * statpack audits. Answers Tier-2 HR-3 / HR-7 / HR-10 — every skippable member
 * step gets caught here instead of vanishing. Admin / quartermaster only.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Chip, Spinner, Button } from '@heroui/react';
import {
  AlertTriangle,
  MapPinOff,
  CalendarX,
  PackageX,
  Clock,
  Backpack,
  ShieldAlert,
  CheckCircle2,
  ArrowLeft,
} from 'lucide-react';
import { collection, onSnapshot, orderBy, query, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem, InventoryBatch, Statpack } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  buildExceptions,
  type ReconciliationException,
  type ExceptionSeverity,
} from '@/app/lib/reconciliation';

// ── Firestore date hydration ─────────────────────────────────────────────────
function hydrateDate(val: unknown): Date | undefined {
  if (!val) return undefined;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return isNaN(val.getTime()) ? undefined : val;
  if (typeof val === 'object' && typeof (val as { toDate?: () => Date }).toDate === 'function') {
    try { return (val as { toDate: () => Date }).toDate(); } catch { return undefined; }
  }
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Hydrate only the date fields the reconciliation engine reads. */
function hydrateItem(id: string, raw: Record<string, unknown>): InventoryItem {
  const batches = Array.isArray(raw.batches)
    ? (raw.batches as Record<string, unknown>[]).map((b) => ({
        ...(b as unknown as InventoryBatch),
        expirationDate: hydrateDate(b.expirationDate),
      }))
    : [];
  return {
    ...(raw as unknown as InventoryItem),
    id,
    batches,
    expirationDate: hydrateDate(raw.expirationDate),
    lastAuditDate: hydrateDate(raw.lastAuditDate),
  };
}

// ── Severity + kind presentation ─────────────────────────────────────────────
// Static class strings — Tailwind can't generate interpolated class names.
const SEVERITY_META: Record<
  ExceptionSeverity,
  { label: string; color: 'danger' | 'warning' | 'primary'; iconTint: string; badgeTint: string }
> = {
  high: {
    label: 'High',
    color: 'danger',
    iconTint: 'text-danger',
    badgeTint: 'bg-danger-50 dark:bg-danger-900/20 text-danger',
  },
  medium: {
    label: 'Medium',
    color: 'warning',
    iconTint: 'text-warning',
    badgeTint: 'bg-warning-50 dark:bg-warning-900/20 text-warning',
  },
  low: {
    label: 'Low',
    color: 'primary',
    iconTint: 'text-primary',
    badgeTint: 'bg-primary-50 dark:bg-primary-900/20 text-primary',
  },
};

const KIND_META: Record<string, { label: string; icon: React.ReactNode }> = {
  orphaned_location: { label: 'No location', icon: <MapPinOff size={16} /> },
  missing_expiration: { label: 'Missing expiration', icon: <CalendarX size={16} /> },
  expired_present: { label: 'Expired present', icon: <PackageX size={16} /> },
  stale_audit: { label: 'Stale audit', icon: <Clock size={16} /> },
  overdue_statpack: { label: 'Overdue pack', icon: <Backpack size={16} /> },
};

const SEVERITY_ORDER: ExceptionSeverity[] = ['high', 'medium', 'low'];

export default function ReconciliationPage() {
  const router = useRouter();
  const { loading: authLoading, user, role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [invLoaded, setInvLoaded] = useState(false);
  const [packsLoaded, setPacksLoaded] = useState(false);

  // ── Live inventory ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user || !isAdmin) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      setInventory(snap.docs.map((d) => hydrateItem(d.id, d.data())));
      setInvLoaded(true);
    });
    return () => unsub();
  }, [user, isAdmin]);

  // ── Live statpacks ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user || !isAdmin) return;
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      setStatpacks(
        snap.docs.map((d) => ({
          ...(d.data() as Omit<Statpack, 'id'>),
          id: d.id,
          lastAuditAt: hydrateDate((d.data() as Record<string, unknown>).lastAuditAt),
        })) as Statpack[],
      );
      setPacksLoaded(true);
    });
    return () => unsub();
  }, [user, isAdmin]);

  const exceptions = useMemo(
    () => buildExceptions(inventory, statpacks),
    [inventory, statpacks],
  );

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    for (const e of exceptions) c[e.severity] += 1;
    return c;
  }, [exceptions]);

  const grouped = useMemo(() => {
    const g: Record<ExceptionSeverity, ReconciliationException[]> = { high: [], medium: [], low: [] };
    for (const e of exceptions) g[e.severity].push(e);
    return g;
  }, [exceptions]);

  const loading = authLoading || (isAdmin && (!invLoaded || !packsLoaded));

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  // ── Access notice ──────────────────────────────────────────────────────────────
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <div className="bg-content1 border border-divider rounded-large p-8 flex flex-col items-center text-center gap-3 max-w-md mx-auto mt-16">
            <div className="w-12 h-12 rounded-large bg-danger-50 dark:bg-danger-900/20 text-danger flex items-center justify-center">
              <ShieldAlert size={24} />
            </div>
            <h1 className="text-2xl font-semibold text-foreground">Admins only</h1>
            <p className="text-sm text-foreground-500">
              The exceptions report is available to admins and quartermasters.
            </p>
            <Button color="primary" variant="flat" onPress={() => router.push('/dashboard')} startContent={<ArrowLeft size={15} />}>
              Back to dashboard
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const total = exceptions.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Exceptions</h1>
            <p className="text-sm text-foreground-500 max-w-2xl">
              Data problems the dashboard hides behind &ldquo;false green&rdquo; — orphaned items, missing
              expirations, expired stock, and stale or overdue audits. Live, across all inventory and packs.
            </p>
            <div className="flex items-center gap-2 flex-wrap mt-3">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{total}</span>
                <span className="text-xs text-foreground-400">total</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{counts.high}</span>
                <span className="text-xs text-danger/80 font-medium">high</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{counts.medium}</span>
                <span className="text-xs text-warning/80 font-medium">medium</span>
              </div>
              {counts.low > 0 && (
                <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-primary flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-primary">{counts.low}</span>
                  <span className="text-xs text-foreground-400 font-medium">low</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Empty state */}
        {total === 0 ? (
          <div className="bg-content1 border border-divider rounded-large p-10 flex flex-col items-center text-center gap-3">
            <div className="w-12 h-12 rounded-large bg-success-50 dark:bg-success-900/20 text-success flex items-center justify-center">
              <CheckCircle2 size={24} />
            </div>
            <p className="text-base font-semibold text-foreground">No exceptions — data looks clean.</p>
            <p className="text-sm text-foreground-500">Every item has a location, an expiration on file, and a current audit.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {SEVERITY_ORDER.filter((s) => grouped[s].length > 0).map((sev) => {
              const meta = SEVERITY_META[sev];
              const rows = grouped[sev];
              return (
                <section key={sev}>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle size={15} className={meta.iconTint} />
                    <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                      {meta.label} severity
                    </h2>
                    <span className="font-mono text-xs font-semibold tabular-nums text-foreground-400">
                      {rows.length}
                    </span>
                  </div>
                  <div className="bg-content1 border border-divider rounded-large divide-y divide-divider overflow-hidden">
                    {rows.map((ex, i) => {
                      const kind = KIND_META[ex.kind] ?? { label: ex.kind, icon: <AlertTriangle size={16} /> };
                      return (
                        <div
                          key={`${ex.kind}-${ex.itemId ?? i}`}
                          className="flex items-start gap-3 px-4 py-3.5 hover:bg-content2 transition-colors duration-150"
                        >
                          <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center flex-none ${meta.badgeTint}`}>
                            {kind.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-foreground truncate">{ex.itemName}</span>
                              <Chip size="sm" variant="flat" color={meta.color}>{kind.label}</Chip>
                            </div>
                            <p className="text-[13px] text-foreground-500 mt-0.5">{ex.detail}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
