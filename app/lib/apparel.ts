/**
 * Write helpers for the Uniform Exchange feature (`apparel_items` /
 * `apparel_claims` collections). Members browse/claim/release/waitlist
 * surplus garments; admins list and withdraw them. This module is
 * deliberately fully isolated from the inventory/audit system — it never
 * imports from `inventory.ts` or `audit-actions.ts` and never writes to
 * `inventory_logs` or `auditEvents`. `apparel_claims` is the only ledger
 * this feature writes to, and every write goes through `removeUndefined`
 * before being handed to Firestore.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { removeUndefined } from '@/app/lib/audit';
import { createNotification } from '@/app/lib/notifications';
import type {
  ApparelCategory,
  ApparelClaimAction,
  ApparelCondition,
  ApparelDisposition,
  ApparelItem,
  ApparelItemStatus,
  ApparelWaitlistEntry,
} from '@/app/types';

export interface ApparelActor {
  uid: string;
  name: string;
  email?: string | null;
}

/** Two weeks, in milliseconds. Exact ms arithmetic — no calendar-month drift. */
export const HOLD_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Pure helpers (no I/O) ──────────────────────────────────────────────────

/**
 * Whether a claim hold is still live. `claimExpiresAt` is the ONLY field this
 * (or any) expiry logic may read — `claimedAt` is audit/display only. Always
 * written as a plain client `Date`, but this guards defensively: if it's ever
 * something else (e.g. an unconverted Firestore Timestamp), fail OPEN toward
 * "not active" rather than throwing.
 */
export function isHoldActive(item: ApparelItem, now: Date): boolean {
  if (item.status !== 'claimed') return false;
  const expires = item.claimExpiresAt;
  if (!expires || typeof (expires as Date).getTime !== 'function') return false;
  return (expires as Date).getTime() > now.getTime();
}

/** Whether an active loan has passed its due date. */
export function isLoanOverdue(item: ApparelItem, now: Date): boolean {
  if (item.status !== 'on_loan') return false;
  const due = item.loanDueAt;
  if (!due || typeof (due as Date).getTime !== 'function') return false;
  return (due as Date).getTime() < now.getTime();
}

/**
 * The status UI should render. A `claimed` doc whose hold has lapsed reads as
 * `available` here even before the lazy sweep runs — so a stale DB doc never
 * displays as an active hold. UI code must always render off this, never off
 * raw `item.status`.
 */
export function getDisplayStatus(item: ApparelItem, now: Date = new Date()): ApparelItemStatus {
  if (item.status === 'claimed' && !isHoldActive(item, now)) return 'available';
  return item.status;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function itemRef(itemId: string) {
  return doc(db, 'apparel_items', itemId);
}

function newClaimLogRef() {
  return doc(collection(db, 'apparel_claims'));
}

/** Best-effort notify — never allowed to fail the caller's primary action. */
async function notifyBestEffort(
  userId: string,
  input: { type: 'apparel_available' | 'apparel_withdrawn'; title: string; body?: string; link?: string },
): Promise<void> {
  try {
    await createNotification(userId, input);
  } catch (e) {
    console.warn('apparel: notification failed', e);
  }
}

async function notifyWaitlistHead(waitlist: ApparelWaitlistEntry[] | undefined, categoryName: string): Promise<void> {
  const head = waitlist?.[0];
  if (!head) return;
  await notifyBestEffort(head.userId, {
    type: 'apparel_available',
    title: 'A garment you were waitlisted for is available',
    body: `A ${categoryName} you waitlisted for is now available in the Uniform Exchange.`,
    link: '/apparel',
  });
}

// ─── Write helpers ──────────────────────────────────────────────────────────

export interface CreateApparelListingInput {
  categoryId: string;
  sizeLabel: string;
  condition: ApparelCondition;
  disposition: ApparelDisposition;
  price?: number;
  description?: string;
}

/** Create a new listing. Plain `addDoc` — nothing to race against, no log entry. */
export async function createApparelListing(
  input: CreateApparelListingInput,
  actor: ApparelActor,
): Promise<string> {
  const ref = await addDoc(collection(db, 'apparel_items'), removeUndefined({
    categoryId: input.categoryId,
    sizeLabel: input.sizeLabel,
    condition: input.condition,
    disposition: input.disposition,
    price: input.price,
    description: input.description,
    status: 'available' as ApparelItemStatus,
    listedBy: actor.uid,
    listedByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  return ref.id;
}

export interface UpdateApparelListingPatch {
  categoryId?: string;
  sizeLabel?: string;
  condition?: ApparelCondition;
  disposition?: ApparelDisposition;
  price?: number;
  description?: string;
}

/**
 * Edit a listing's descriptive fields. Guarded by a simple pre-check (not a
 * transaction — low-stakes race, same as editing any other doc's descriptive
 * fields elsewhere in this app) that the listing is still `available`, since
 * editing details out from under an active hold is confusing. No log entry.
 */
export async function updateApparelListing(
  itemId: string,
  patch: UpdateApparelListingPatch,
  actor: ApparelActor,
): Promise<void> {
  void actor;
  const ref = itemRef(itemId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Listing not found');
  const item = snap.data() as ApparelItem;
  if (item.status !== 'available') {
    throw new Error('Only an available listing can be edited.');
  }
  await updateDoc(ref, removeUndefined({ ...patch, updatedAt: serverTimestamp() }));
}

/**
 * Claim an available (or self-healing lapsed) listing on behalf of `member`.
 * Enforces the one-active-claim-per-garment-type rule via a pre-transaction
 * query (Firestore transactions can't run queries), then does the log + item
 * update atomically inside one transaction.
 */
export async function claimApparelItem(
  itemId: string,
  member: { id: string; fullName?: string },
): Promise<void> {
  const now = new Date();
  const ref = itemRef(itemId);

  // Need the target item's categoryId for the duplicate-claim query.
  const preSnap = await getDoc(ref);
  if (!preSnap.exists()) throw new Error('Listing not found');
  const preItem = preSnap.data() as ApparelItem;
  const categoryId = preItem.categoryId;

  const existingClaims = await getDocs(query(
    collection(db, 'apparel_items'),
    where('claimedBy', '==', member.id),
    where('categoryId', '==', categoryId),
    where('status', '==', 'claimed'),
  ));
  const activeExisting = existingClaims.docs.some((d) => {
    const candidate = { id: d.id, ...(d.data() as ApparelItem) } as ApparelItem;
    return isHoldActive(candidate, now);
  });
  if (activeExisting) {
    throw new Error('You already have a claim in this category. Release it before claiming another.');
  }

  const claimLogRef = newClaimLogRef();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    if (item.status === 'withdrawn') throw new Error('This listing has been withdrawn.');
    if (item.status === 'on_loan') throw new Error('This item is currently on loan.');
    if (item.status === 'picked_up') throw new Error('This item has already been picked up.');
    if (item.status === 'claimed') {
      if (isHoldActive(item, now)) {
        throw new Error('This item is already claimed by someone else.');
      }
      // Lapsed hold nobody released yet — self-heal: log the expiry for the
      // OLD holder before overwriting with the new claim.
      const expiredLogRef = doc(collection(db, 'apparel_claims'));
      tx.set(expiredLogRef, removeUndefined({
        itemId,
        categoryId: item.categoryId,
        categoryName,
        sizeLabel: item.sizeLabel,
        action: 'expired' as ApparelClaimAction,
        userId: item.claimedBy as string,
        pairId: item.activeClaimId,
        timestamp: serverTimestamp(),
        clientTimestamp: now,
      }));
    }

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'claimed' as ApparelClaimAction,
      userId: member.id,
      userName: member.fullName,
      timestamp: serverTimestamp(),
      clientTimestamp: now,
      pairId: claimLogRef.id,
    }));

    tx.update(ref, removeUndefined({
      status: 'claimed' as ApparelItemStatus,
      claimedBy: member.id,
      claimedByName: member.fullName ?? null,
      claimedAt: serverTimestamp(),
      claimExpiresAt: new Date(now.getTime() + HOLD_DURATION_MS),
      activeClaimId: claimLogRef.id,
      updatedAt: serverTimestamp(),
    }));
  });
}

/**
 * Release an active claim. The claimant releases their own hold; an admin may
 * force-release with `opts.allowAdminOverride`.
 */
export async function releaseApparelClaim(
  itemId: string,
  actor: ApparelActor,
  opts?: { allowAdminOverride?: boolean },
): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  const { claimedBy, categoryName, waitlist } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'claimed') throw new Error('This item is not currently claimed.');
    if (item.claimedBy !== actor.uid && !opts?.allowAdminOverride) {
      throw new Error('Only the person holding this claim can release it.');
    }

    const holderId = item.claimedBy as string;
    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'released' as ApparelClaimAction,
      userId: holderId,
      actorId: actor.uid !== holderId ? actor.uid : undefined,
      actorName: actor.uid !== holderId ? actor.name : undefined,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
      pairId: item.activeClaimId,
    }));

    tx.update(ref, {
      status: 'available' as ApparelItemStatus,
      claimedBy: null,
      claimedByName: null,
      claimedAt: null,
      claimExpiresAt: null,
      activeClaimId: null,
      updatedAt: serverTimestamp(),
    });

    return { claimedBy: holderId, categoryName, waitlist: item.waitlist };
  });

  void claimedBy;
  if (waitlist?.length) {
    await notifyWaitlistHead(waitlist, categoryName);
  }
}

/**
 * Page-load lazy sweep: self-heals a lapsed hold nobody has claimed yet. This
 * is opportunistic, not an assertion of caller intent — returns quietly if
 * there is nothing to sweep.
 */
export async function sweepExpiredApparelHold(itemId: string): Promise<void> {
  const now = new Date();
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const item = snap.data() as ApparelItem;

    if (!(item.status === 'claimed' && !isHoldActive(item, now))) return null;

    const holderId = item.claimedBy as string;
    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'expired' as ApparelClaimAction,
      userId: holderId,
      pairId: item.activeClaimId,
      timestamp: serverTimestamp(),
      clientTimestamp: now,
    }));

    tx.update(ref, {
      status: 'available' as ApparelItemStatus,
      claimedBy: null,
      claimedByName: null,
      claimedAt: null,
      claimExpiresAt: null,
      activeClaimId: null,
      updatedAt: serverTimestamp(),
    });

    return { categoryName, waitlist: item.waitlist };
  });

  if (result?.waitlist?.length) {
    await notifyWaitlistHead(result.waitlist, result.categoryName);
  }
}

/**
 * Withdraw a listing (soft delete — nothing is ever hard-deleted). Force-clears
 * ALL hold and loan fields regardless of current status, and notifies both the
 * dispossessed claimant and every waitlist entry.
 */
export async function withdrawApparelListing(
  itemId: string,
  actor: ApparelActor,
  reason?: string,
): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  const { previousClaimedBy, previousWaitlist, categoryName } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status === 'withdrawn') throw new Error('This listing is already withdrawn.');

    const previousClaimedBy = item.claimedBy;
    const previousClaimedByName = item.claimedByName;
    const previousWaitlist = item.waitlist ?? [];
    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'withdrawn' as ApparelClaimAction,
      userId: previousClaimedBy ?? actor.uid,
      actorId: (previousClaimedBy ?? actor.uid) !== actor.uid ? actor.uid : undefined,
      actorName: (previousClaimedBy ?? actor.uid) !== actor.uid ? actor.name : undefined,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
      details: { reason },
    }));

    tx.update(ref, removeUndefined({
      status: 'withdrawn' as ApparelItemStatus,
      withdrawnAt: serverTimestamp(),
      withdrawnBy: actor.uid,
      withdrawnReason: reason ?? null,
      claimedBy: null,
      claimedByName: null,
      claimedAt: null,
      claimExpiresAt: null,
      activeClaimId: null,
      loanedAt: null,
      loanDueAt: null,
      waitlist: [],
      updatedAt: serverTimestamp(),
    }));

    return { previousClaimedBy, previousClaimedByName, previousWaitlist, categoryName };
  });

  if (previousClaimedBy) {
    await notifyBestEffort(previousClaimedBy, {
      type: 'apparel_withdrawn',
      title: 'A garment you held has been withdrawn',
      body: `The ${categoryName} you held has been withdrawn from the Uniform Exchange.`,
      link: '/apparel',
    });
  }
  for (const entry of previousWaitlist) {
    await notifyBestEffort(entry.userId, {
      type: 'apparel_withdrawn',
      title: 'A garment you were waitlisted for has been withdrawn',
      body: `The ${categoryName} you waitlisted for has been withdrawn from the Uniform Exchange.`,
      link: '/apparel',
    });
  }
}

/** Bring a withdrawn listing back to `available`. */
export async function reactivateApparelListing(itemId: string, actor: ApparelActor): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'withdrawn') throw new Error('Only a withdrawn listing can be reactivated.');

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'reactivated' as ApparelClaimAction,
      userId: actor.uid,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
    }));

    tx.update(ref, {
      status: 'available' as ApparelItemStatus,
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawnReason: null,
      updatedAt: serverTimestamp(),
    });
  });
}

/**
 * Mark a claimed item picked up. Does NOT block on `!isPaid` for a for-sale
 * item — that is a soft/informational flag only; the caller (UI) is
 * responsible for warning the admin, not this function. Keeps `claimedBy`/
 * `claimedByName` on the doc as the historical record.
 */
export async function markApparelPickedUp(itemId: string, actor: ApparelActor): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'claimed') throw new Error('This item is not currently claimed.');
    if (item.disposition === 'loaner') {
      throw new Error('Loaner items are picked up via markApparelLoaned, not markApparelPickedUp.');
    }

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'picked_up' as ApparelClaimAction,
      userId: item.claimedBy as string,
      actorId: actor.uid,
      actorName: actor.name,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
      details: {
        disposition: item.disposition,
        price: item.price ?? null,
        isPaid: item.isPaid ?? false,
      },
    }));

    tx.update(ref, removeUndefined({
      status: 'picked_up' as ApparelItemStatus,
      pickedUpAt: serverTimestamp(),
      pickedUpBy: actor.uid,
      pickedUpByName: actor.name,
      updatedAt: serverTimestamp(),
    }));
  });
}

/** Mark a claimed loaner item as loaned out, with a due date. */
export async function markApparelLoaned(itemId: string, actor: ApparelActor, loanDueAt: Date): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'claimed') throw new Error('This item is not currently claimed.');
    if (item.disposition !== 'loaner') throw new Error('Only loaner items can be marked loaned.');

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'loaned' as ApparelClaimAction,
      userId: item.claimedBy as string,
      actorId: actor.uid,
      actorName: actor.name,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
      details: { loanDueAt },
    }));

    tx.update(ref, removeUndefined({
      status: 'on_loan' as ApparelItemStatus,
      loanedAt: serverTimestamp(),
      loanDueAt,
      pickedUpBy: actor.uid,
      pickedUpByName: actor.name,
      updatedAt: serverTimestamp(),
    }));
  });
}

/** Return a loaned item to `available`, clearing loan and hold fields. */
export async function markApparelReturned(itemId: string, actor: ApparelActor): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  const { categoryName, waitlist } = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'on_loan') throw new Error('This item is not currently on loan.');

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'returned' as ApparelClaimAction,
      userId: item.claimedBy as string,
      actorId: actor.uid,
      actorName: actor.name,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
    }));

    tx.update(ref, {
      status: 'available' as ApparelItemStatus,
      loanedAt: null,
      loanDueAt: null,
      claimedBy: null,
      claimedByName: null,
      claimedAt: null,
      claimExpiresAt: null,
      activeClaimId: null,
      updatedAt: serverTimestamp(),
    });

    return { categoryName, waitlist: item.waitlist };
  });

  if (waitlist?.length) {
    await notifyWaitlistHead(waitlist, categoryName);
  }
}

/**
 * Mark a for-sale item paid. Not a transaction — no state-machine precondition
 * to race, mirrors `recordItemFix`'s simple sequential-write style.
 */
export async function markApparelPaid(itemId: string, actor: ApparelActor): Promise<void> {
  const ref = itemRef(itemId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Listing not found');
  const item = snap.data() as ApparelItem;

  if (item.disposition !== 'for_sale') throw new Error('Only for-sale items can be marked paid.');

  const holderId = item.claimedBy ?? item.pickedUpBy;
  const categorySnap = await getDoc(doc(db, 'apparel_categories', item.categoryId));
  const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

  await updateDoc(ref, removeUndefined({
    isPaid: true,
    paidAt: serverTimestamp(),
    paidBy: actor.uid,
    updatedAt: serverTimestamp(),
  }));

  await addDoc(collection(db, 'apparel_claims'), removeUndefined({
    itemId,
    categoryId: item.categoryId,
    categoryName,
    sizeLabel: item.sizeLabel,
    action: 'paid' as ApparelClaimAction,
    userId: holderId,
    actorId: actor.uid,
    actorName: actor.name,
    timestamp: serverTimestamp(),
    clientTimestamp: new Date(),
    details: { price: item.price ?? null },
  }));
}

/** Join the waitlist for an item currently held (claimed or on loan). */
export async function joinApparelWaitlist(
  itemId: string,
  member: { id: string; fullName?: string },
): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();
  const now = new Date();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    if (item.status !== 'claimed' && item.status !== 'on_loan') {
      throw new Error('This item is not available to waitlist — it is not currently held.');
    }
    const existing = item.waitlist ?? [];
    if (existing.some((w) => w.userId === member.id)) {
      throw new Error('You are already on this waitlist.');
    }

    const newEntry: ApparelWaitlistEntry = {
      userId: member.id,
      userName: member.fullName ?? undefined,
      joinedAt: now,
    };

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'waitlist_joined' as ApparelClaimAction,
      userId: member.id,
      timestamp: serverTimestamp(),
      clientTimestamp: now,
    }));

    tx.update(ref, {
      waitlist: [...existing, removeUndefined(newEntry as unknown as Record<string, unknown>)],
      updatedAt: serverTimestamp(),
    });
  });
}

/** Leave a waitlist. */
export async function leaveApparelWaitlist(itemId: string, member: { id: string }): Promise<void> {
  const ref = itemRef(itemId);
  const claimLogRef = newClaimLogRef();

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Listing not found');
    const item = snap.data() as ApparelItem;

    const existing = item.waitlist ?? [];
    const filtered = existing.filter((w) => w.userId !== member.id);
    if (filtered.length === existing.length) {
      throw new Error('You are not on this waitlist.');
    }

    const categorySnap = await tx.get(doc(db, 'apparel_categories', item.categoryId));
    const categoryName = categorySnap.exists() ? (categorySnap.data() as ApparelCategory).name : 'Unknown category';

    tx.set(claimLogRef, removeUndefined({
      itemId,
      categoryId: item.categoryId,
      categoryName,
      sizeLabel: item.sizeLabel,
      action: 'waitlist_left' as ApparelClaimAction,
      userId: member.id,
      timestamp: serverTimestamp(),
      clientTimestamp: new Date(),
    }));

    tx.update(ref, {
      waitlist: filtered,
      updatedAt: serverTimestamp(),
    });
  });
}
