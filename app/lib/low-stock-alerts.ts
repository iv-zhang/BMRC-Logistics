/**
 * Proactive low-stock flagging (issue #38).
 *
 * When a stock-reducing write (audit count, shelf refill, quick adjust) moves an
 * item INTO low or out, file one open `team_tasks` card for it and notify
 * admin/QM — so shortages reach logistics without a member having to report them.
 *
 * Same best-effort shape as `statpack-restock-flag.ts`: called AFTER the write
 * has committed, never throws, never blocks the write. Status is the reserve-pool
 * status from `getItemStatus` (the front shelf is deliberately not part of it).
 * Recipients are admin/quartermaster ONLY — medops must not get logistics
 * alerts (decisions.md D-13).
 */
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { getItemStatus, computeBagStock } from '@/app/lib/item-status';
import { broadcastNotification } from '@/app/lib/notifications';
import { getAdminRecipientIds, OPEN_TEAM_TASK_STATUSES } from '@/app/lib/statpack-restock-flag';

export type LowStockLevel = 'low' | 'out';

export interface LowStockActor {
  uid: string;
  name: string;
}

function toJsDateValue(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v;
  const o = v as { toDate?: unknown; seconds?: unknown };
  if (typeof o.toDate === 'function') return (o.toDate as () => Date).call(v);
  if (typeof o.seconds === 'number') return new Date(o.seconds * 1000);
  return undefined;
}

/**
 * Pure. Shallow copy of `item` whose batch `expirationDate` / `openDate` are JS
 * `Date`s. Items read straight from `snapshot.data()` carry Firestore
 * `Timestamp`s, and `getItemStatus` compares `b.expirationDate < now` — a
 * Timestamp coerces to a seconds string, which compares LESS than a Date, so every
 * dated batch would read as expired. Accepts Date, Timestamp (anything with
 * `toDate()`), legacy `{seconds, nanoseconds}`, and null/undefined.
 */
export function withJsBatchDates<T extends Partial<InventoryItem>>(item: T): T {
  if (!Array.isArray(item.batches)) return item;
  return {
    ...item,
    batches: item.batches.map((b) => {
      const copy = { ...b } as Record<string, unknown>;
      copy.expirationDate = toJsDateValue(b.expirationDate);
      if ('openDate' in b) copy.openDate = toJsDateValue((b as { openDate?: unknown }).openDate);
      return copy as unknown as typeof b;
    }),
  };
}

const RANK: Record<string, number> = { ok: 0, expiring: 0, low: 1, out: 2 };

/**
 * Pure. Returns the new status when an item moved INTO low/out from a better
 * status (ok/expiring -> low/out, low -> out); otherwise null. Expired is a
 * different axis and never alerts here (an expired item's stock is judged on
 * availability by getItemStatus, which already folds it into 'out').
 */
export function stockStatusWorsened(
  before: InventoryItem,
  after: InventoryItem,
): LowStockLevel | null {
  const b = getItemStatus(withJsBatchDates(before));
  const a = getItemStatus(withJsBatchDates(after));
  if (a !== 'low' && a !== 'out') return null;
  if (b === 'expired') return null;
  return (RANK[a] ?? 0) > (RANK[b] ?? 0) ? a : null;
}

/**
 * Best-effort: ensure ONE open card for this item and, only when the card is
 * newly created, notify admin/QM. NEVER throws.
 */
export async function flagLowStock(
  item: Pick<InventoryItem, 'id' | 'name'> & Partial<InventoryItem>,
  status: LowStockLevel,
  actor: LowStockActor,
): Promise<void> {
  try {
    const available = computeBagStock(withJsBatchDates(item) as InventoryItem).availableItems;
    const par = item.reorderThreshold ?? 0;
    const label = status === 'out' ? 'OUT of stock' : 'Low stock';
    const detail = status === 'out'
      ? `${item.name} is out of stock.`
      : `${item.name} is low: ${available} on hand (reorder at ${par}).`;

    let created = false;
    const tasksRef = collection(db, 'team_tasks');
    const existing = await getDocs(
      query(
        tasksRef,
        where('linkedInventoryItemId', '==', item.id),
        where('status', 'in', OPEN_TEAM_TASK_STATUSES),
      ),
    );
    if (existing.empty) {
      await addDoc(tasksRef, {
        title: `Reorder ${item.name}`,
        definitionOfDone: 'Stock back above the reorder threshold (ordered or restocked).',
        // Unassigned on purpose, same as the statpack restock card.
        owners: [],
        status: 'backlog',
        subtasks: [{ id: item.id, text: detail, done: false }],
        updates: [],
        dueDate: null,
        linkedInventoryItemId: item.id,
        createdBy: actor.uid,
        createdByName: actor.name,
        createdAt: serverTimestamp(),
      });
      created = true;
    }

    if (!created) return;
    const recipientIds = await getAdminRecipientIds();
    await broadcastNotification(
      recipientIds,
      {
        type: 'broadcast',
        title: `${label}: ${item.name}`,
        body: detail,
        link: '/restock',
      },
      actor,
    );
  } catch (e) {
    console.warn('flagLowStock failed:', e);
  }
}

/** Convenience: flag only if `after` is a worsening of `before`. Never throws. */
export async function maybeFlagLowStock(
  before: InventoryItem,
  after: InventoryItem,
  actor: LowStockActor,
): Promise<void> {
  try {
    const nb = withJsBatchDates(before);
    const na = withJsBatchDates(after);
    const status = stockStatusWorsened(nb, na);
    if (status) await flagLowStock(na, status, actor);
  } catch (e) {
    console.warn('maybeFlagLowStock failed:', e);
  }
}
