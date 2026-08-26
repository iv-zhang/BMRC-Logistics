'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Spinner } from '@heroui/react';
import { Plus, Search, Settings, Shirt } from 'lucide-react';
import { collection, onSnapshot, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  getDisplayStatus, isHoldActive,
  joinApparelWaitlist, leaveApparelWaitlist, markApparelLoaned, markApparelPaid,
  markApparelPickedUp, markApparelReturned, reactivateApparelListing,
  releaseApparelClaim, sweepExpiredApparelHold, withdrawApparelListing,
  type ApparelActor,
} from '@/app/lib/apparel';
import { seedDefaultApparelCategoriesIfEmpty, subscribeApparelCategories } from '@/app/lib/apparel-categories';
import ApparelItemCard from '@/app/components/apparel/apparel-item-card';
import ApparelClaimModal from '@/app/components/apparel/apparel-claim-modal';
import ApparelListingForm from '@/app/components/apparel/apparel-listing-form';
import ApparelCategoryManager from '@/app/components/apparel/apparel-category-manager';
import type { ApparelCategory, ApparelDisposition, ApparelItem } from '@/app/types';

// ── Hydration helpers (Timestamp → Date), same pattern as app/restock/page.tsx ──
function toDateVal(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  const anyV = v as { toDate?: () => Date };
  if (typeof anyV.toDate === 'function') return anyV.toDate();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? undefined : d;
}

function hydrateApparelItem(id: string, raw: Record<string, unknown>): ApparelItem {
  const rawWaitlist = raw.waitlist;
  const waitlist = Array.isArray(rawWaitlist)
    ? rawWaitlist.map((w) => {
        const entry = w as Record<string, unknown>;
        return {
          userId: entry.userId as string,
          userName: entry.userName as string | undefined,
          joinedAt: toDateVal(entry.joinedAt) ?? new Date(0),
        };
      })
    : undefined;
  return {
    ...raw,
    id,
    waitlist,
    claimedAt: toDateVal(raw.claimedAt),
    claimExpiresAt: toDateVal(raw.claimExpiresAt),
    loanedAt: toDateVal(raw.loanedAt),
    loanDueAt: toDateVal(raw.loanDueAt),
    paidAt: toDateVal(raw.paidAt),
    pickedUpAt: toDateVal(raw.pickedUpAt),
    withdrawnAt: toDateVal(raw.withdrawnAt),
    createdAt: toDateVal(raw.createdAt) ?? new Date(),
    updatedAt: toDateVal(raw.updatedAt) ?? new Date(),
  } as unknown as ApparelItem;
}

const DISPOSITION_LABEL: Record<ApparelDisposition, string> = {
  free: 'Free', for_sale: 'For Sale', loaner: 'Loaner',
};

// ── Mark Loaned due-date modal (local — keeps this feature to 4 files) ──────

function defaultLoanDueDate(): string {
  const in14 = new Date();
  in14.setDate(in14.getDate() + 14);
  return in14.toISOString().slice(0, 10);
}

/** Keyed by `item?.id` from the caller so React remounts (and re-runs this
 * lazy initializer) whenever a different item opens the modal, instead of
 * syncing state from a prop via an effect. */
function LoanDueDateModal({
  item, onClose, onConfirm,
}: {
  item: ApparelItem | null;
  onClose: () => void;
  onConfirm: (item: ApparelItem, dueDate: Date) => void;
}) {
  const [dateStr, setDateStr] = useState(defaultLoanDueDate);

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-content1 border border-divider rounded-large p-5 w-full max-w-sm flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-base font-semibold text-foreground">Mark as loaned</p>
          <p className="text-xs text-foreground-500 mt-0.5">{item.sizeLabel} — set a return due date</p>
        </div>
        <Input
          type="date"
          label="Due date"
          value={dateStr}
          onValueChange={setDateStr}
          autoFocus
        />
        <div className="flex items-center justify-end gap-3">
          <Button variant="bordered" onPress={onClose}>Cancel</Button>
          <Button
            color="primary"
            isDisabled={!dateStr}
            onPress={() => {
              const due = new Date(`${dateStr}T00:00:00`);
              if (!isNaN(due.getTime())) onConfirm(item, due);
            }}
          >
            Confirm loan
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ApparelPage() {
  const { loading: authLoading, role, userData, user, effectiveUid } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [items, setItems] = useState<ApparelItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [categories, setCategories] = useState<ApparelCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [opLoading, setOpLoading] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [selectedDispositions, setSelectedDispositions] = useState<Set<ApparelDisposition>>(new Set());
  const [sizeQuery, setSizeQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [sortMode, setSortMode] = useState<'grouped' | 'newest'>('grouped');

  const [claimTarget, setClaimTarget] = useState<ApparelItem | null>(null);
  const [formState, setFormState] = useState<{ open: boolean; item: ApparelItem | null }>({ open: false, item: null });
  const [loanTarget, setLoanTarget] = useState<ApparelItem | null>(null);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);

  const sweptRef = useRef<Set<string>>(new Set());
  const seedAttemptedRef = useRef(false);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'apparel_items'),
      (snap) => {
        const now = new Date();
        const list = snap.docs.map((d) => hydrateApparelItem(d.id, d.data()));
        setItems(list);
        setItemsLoading(false);
        for (const item of list) {
          if (item.id && item.status === 'claimed' && !isHoldActive(item, now) && !sweptRef.current.has(item.id)) {
            sweptRef.current.add(item.id);
            sweepExpiredApparelHold(item.id).catch(() => {});
          }
        }
      },
      (e) => { console.error('[apparel] items listener', e); setItemsLoading(false); },
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = subscribeApparelCategories((cats) => {
      setCategories(cats);
      setCategoriesLoading(false);
      if (!seedAttemptedRef.current && cats.length === 0 && isAdmin) {
        seedAttemptedRef.current = true;
        seedDefaultApparelCategoriesIfEmpty({
          uid: effectiveUid ?? '',
          name: userData?.fullName ?? 'Unknown',
          email: user?.email ?? null,
        }).catch(() => {});
      }
    });
    return () => unsub();
  }, [isAdmin, effectiveUid, userData?.fullName, user?.email]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const loading = authLoading || itemsLoading || categoriesLoading;
  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.id!, c])), [categories]);
  const activeCategoriesSorted = useMemo(
    () => categories.filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  );
  const actor: ApparelActor = { uid: effectiveUid ?? '', name: userData?.fullName ?? 'Unknown', email: user?.email ?? null };
  const member = { id: effectiveUid ?? '', fullName: userData?.fullName };

  async function runAction(fn: () => Promise<void>, successMsg?: string) {
    setOpLoading(true);
    try {
      await fn();
      if (successMsg) setToast({ ok: true, msg: successMsg });
    } catch (e) {
      setToast({ ok: false, msg: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setOpLoading(false);
    }
  }

  const handleRelease = (item: ApparelItem) => {
    if (!item.id) return;
    const categoryName = categoriesById.get(item.categoryId)?.name ?? 'item';
    if (!window.confirm(`Release your claim on this ${categoryName}?`)) return;
    runAction(() => releaseApparelClaim(item.id!, actor), 'Claim released');
  };
  const handleJoinWaitlist = (item: ApparelItem) => {
    if (!item.id) return;
    runAction(() => joinApparelWaitlist(item.id!, member), 'Joined waitlist');
  };
  const handleLeaveWaitlist = (item: ApparelItem) => {
    if (!item.id) return;
    runAction(() => leaveApparelWaitlist(item.id!, member), 'Left waitlist');
  };
  const handleWithdraw = (item: ApparelItem) => {
    if (!item.id) return;
    const input = window.prompt('Reason for withdrawing this listing (optional):');
    if (input === null) return;
    const reason = input.trim() || undefined;
    runAction(() => withdrawApparelListing(item.id!, actor, reason), 'Listing withdrawn');
  };
  const handleReactivate = (item: ApparelItem) => {
    if (!item.id) return;
    if (!window.confirm('Reactivate this listing and make it available again?')) return;
    runAction(() => reactivateApparelListing(item.id!, actor), 'Listing reactivated');
  };
  const handleMarkPickedUp = (item: ApparelItem) => {
    if (!item.id) return;
    runAction(() => markApparelPickedUp(item.id!, actor), 'Marked picked up');
  };
  const handleMarkReturned = (item: ApparelItem) => {
    if (!item.id) return;
    if (!window.confirm('Mark this loaner as returned?')) return;
    runAction(() => markApparelReturned(item.id!, actor), 'Marked returned');
  };
  const handleMarkPaid = (item: ApparelItem) => {
    if (!item.id) return;
    runAction(() => markApparelPaid(item.id!, actor), 'Marked paid');
  };
  const handleConfirmLoan = (item: ApparelItem, dueDate: Date) => {
    if (!item.id) return;
    setLoanTarget(null);
    runAction(() => markApparelLoaned(item.id!, actor, dueDate), 'Marked loaned');
  };

  const toggleCategoryId = (categoryId: string) => {
    setSelectedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      return next;
    });
  };
  const toggleDisposition = (d: ApparelDisposition) => {
    setSelectedDispositions((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const now = new Date();
    return items.filter((item) => {
      const displayStatus = getDisplayStatus(item, now);
      if (!showHistory && (displayStatus === 'withdrawn' || displayStatus === 'picked_up')) return false;
      if (selectedCategoryIds.size > 0 && !selectedCategoryIds.has(item.categoryId)) return false;
      if (selectedDispositions.size > 0 && !selectedDispositions.has(item.disposition)) return false;
      if (sizeQuery.trim() && !item.sizeLabel.toLowerCase().includes(sizeQuery.trim().toLowerCase())) return false;
      return true;
    });
  }, [items, showHistory, selectedCategoryIds, selectedDispositions, sizeQuery]);

  const groups = useMemo(() => {
    if (sortMode !== 'grouped') return [];
    return activeCategoriesSorted
      .map((category) => ({
        category,
        items: filtered
          .filter((i) => i.categoryId === category.id)
          .sort((a, b) => a.sizeLabel.localeCompare(b.sizeLabel)),
      }))
      .filter((g) => g.items.length > 0);
  }, [filtered, sortMode, activeCategoriesSorted]);

  const newestList = useMemo(() => {
    if (sortMode !== 'newest') return [];
    return [...filtered].sort((a, b) => {
      const at = (a.createdAt instanceof Date ? a.createdAt : new Date(0)).getTime();
      const bt = (b.createdAt instanceof Date ? b.createdAt : new Date(0)).getTime();
      return bt - at;
    });
  }, [filtered, sortMode]);

  const availableCount = useMemo(
    () => items.filter((i) => getDisplayStatus(i) === 'available').length,
    [items],
  );

  const activeFilterCount = selectedCategoryIds.size + selectedDispositions.size + (sizeQuery.trim() ? 1 : 0) + (showHistory ? 1 : 0);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5 flex items-center gap-2">
              <Shirt className="text-primary" size={22} /> Uniform Exchange
            </h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span><span className="font-semibold text-foreground tabular-nums">{filtered.length}</span> shown</span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span><span className="font-semibold text-success tabular-nums">{availableCount}</span> available</span>
            </div>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="bordered"
                startContent={<Settings size={15} />}
                onPress={() => setCategoryManagerOpen(true)}
              >
                Manage Categories
              </Button>
              <Button
                color="primary"
                startContent={<Plus size={15} />}
                isDisabled={activeCategoriesSorted.length === 0}
                title={activeCategoriesSorted.length === 0 ? 'Create a category first (Manage Categories)' : undefined}
                onPress={() => setFormState({ open: true, item: null })}
              >
                Add Listing
              </Button>
            </div>
          )}
        </div>

        {/* Filter bar */}
        <div className="bg-content1 border border-divider rounded-large p-4 mb-6 flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Input
              placeholder="Search size…"
              startContent={<Search size={16} className="text-foreground-400" />}
              value={sizeQuery}
              onValueChange={setSizeQuery}
              isClearable
              className="max-w-xs"
            />
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setShowHistory((v) => !v)}
                className={`text-sm font-semibold px-3 py-1.5 rounded-large border transition-colors duration-150 ${
                  showHistory
                    ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content2'
                }`}
              >
                Show history
              </button>
              <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
                {([
                  { mode: 'grouped' as const, label: 'Grouped' },
                  { mode: 'newest' as const, label: 'Newest first' },
                ]).map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => setSortMode(mode)}
                    className={`px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                      sortMode === mode ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {activeCategoriesSorted.map((category) => (
              <button
                key={category.id}
                onClick={() => toggleCategoryId(category.id!)}
                className={`text-sm font-medium px-3 py-1.5 rounded-large border transition-colors duration-150 ${
                  selectedCategoryIds.has(category.id!)
                    ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content2'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {(['free', 'for_sale', 'loaner'] as ApparelDisposition[]).map((d) => (
              <button
                key={d}
                onClick={() => toggleDisposition(d)}
                className={`text-sm font-medium px-3 py-1.5 rounded-large border transition-colors duration-150 ${
                  selectedDispositions.has(d)
                    ? 'bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content2'
                }`}
              >
                {DISPOSITION_LABEL[d]}
              </button>
            ))}
            {activeFilterCount > 0 && (
              <button
                onClick={() => { setSelectedCategoryIds(new Set()); setSelectedDispositions(new Set()); setSizeQuery(''); setShowHistory(false); }}
                className="text-sm font-semibold text-primary px-3 py-1.5"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex justify-center py-12"><Spinner size="lg" color="primary" /></div>
        ) : filtered.length === 0 ? (
          <div className="bg-content1 border border-divider rounded-large p-8 text-center">
            <p className="text-sm text-foreground-500">No items match your filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortMode === 'grouped'
              ? groups.map((group) => (
                  <React.Fragment key={group.category.id}>
                    <div className="col-span-full text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mt-2 first:mt-0">
                      {group.category.name} ({group.items.length})
                    </div>
                    {group.items.map((item) => (
                      <ApparelItemCard
                        key={item.id}
                        item={item}
                        category={categoriesById.get(item.categoryId)}
                        currentUserId={effectiveUid}
                        isAdmin={isAdmin}
                        isBusy={opLoading}
                        onClaim={setClaimTarget}
                        onRelease={handleRelease}
                        onJoinWaitlist={handleJoinWaitlist}
                        onLeaveWaitlist={handleLeaveWaitlist}
                        onEdit={(i) => setFormState({ open: true, item: i })}
                        onWithdraw={handleWithdraw}
                        onReactivate={handleReactivate}
                        onMarkPickedUp={handleMarkPickedUp}
                        onMarkLoaned={setLoanTarget}
                        onMarkReturned={handleMarkReturned}
                        onMarkPaid={handleMarkPaid}
                      />
                    ))}
                  </React.Fragment>
                ))
              : newestList.map((item) => (
                  <ApparelItemCard
                    key={item.id}
                    item={item}
                    category={categoriesById.get(item.categoryId)}
                    currentUserId={effectiveUid}
                    isAdmin={isAdmin}
                    isBusy={opLoading}
                    onClaim={setClaimTarget}
                    onRelease={handleRelease}
                    onJoinWaitlist={handleJoinWaitlist}
                    onLeaveWaitlist={handleLeaveWaitlist}
                    onEdit={(i) => setFormState({ open: true, item: i })}
                    onWithdraw={handleWithdraw}
                    onReactivate={handleReactivate}
                    onMarkPickedUp={handleMarkPickedUp}
                    onMarkLoaned={setLoanTarget}
                    onMarkReturned={handleMarkReturned}
                    onMarkPaid={handleMarkPaid}
                  />
                ))}
          </div>
        )}
      </main>

      <ApparelClaimModal
        isOpen={claimTarget != null}
        onClose={() => setClaimTarget(null)}
        item={claimTarget}
        category={claimTarget ? categoriesById.get(claimTarget.categoryId) : undefined}
        member={member}
      />

      <ApparelListingForm
        isOpen={formState.open}
        onClose={() => setFormState({ open: false, item: null })}
        item={formState.item}
        categories={activeCategoriesSorted}
        actor={actor}
        onSaved={() => setToast({ ok: true, msg: formState.item ? 'Listing updated' : 'Listing created' })}
      />

      <ApparelCategoryManager
        isOpen={categoryManagerOpen}
        onClose={() => setCategoryManagerOpen(false)}
        categories={categories}
        actor={actor}
      />

      <LoanDueDateModal
        key={loanTarget?.id ?? 'none'}
        item={loanTarget}
        onClose={() => setLoanTarget(null)}
        onConfirm={handleConfirmLoan}
      />

      {opLoading && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}

      {toast && (
        <div className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
