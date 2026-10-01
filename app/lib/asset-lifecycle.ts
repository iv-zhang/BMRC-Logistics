/**
 * Asset lifecycle (active / loaned_out / lost / damaged / retired).
 *
 * A SEPARATE axis from readiness: `assetStatus` (Ready / Not Ready) says whether
 * the gear can go out today; lifecycle says whether we still have it. Nothing
 * here touches readiness, and readiness logic never reads lifecycle.
 *
 * Split in two on purpose:
 *   - PURE (no Firestore): `getLifecycle`, `validateLifecycleChange`,
 *     `appendLifecycleHistory`, `planLifecycleChange`. Unit-tested directly.
 *   - WRITE: `changeAssetLifecycle` runs the plan inside a transaction on the
 *     fresh doc, then writes the usual triple: the inventory change +
 *     an `inventory_logs` row + an `auditEvents` ledger entry
 *     (same shape as `retireInventoryItem` in audit-actions.ts).
 *
 * A legacy doc with no `lifecycle` is `active`. `retired` is terminal (nothing
 * leaves it); `lost` / `damaged` can return to another state (found, repaired).
 * Retiring an asset here does NOT set `existence: 'retired'` (that is the
 * supply-audit "record does not exist" marker), they are different facts.
 */

import {
  addDoc,
  collection,
  deleteField,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { deepRemoveUndefined, recordAuditEvent, removeUndefined } from '@/app/lib/audit';
import type { AuditActor } from '@/app/lib/audit-actions';
import type {
  AssetInstance,
  AssetLifecycle,
  AssetLifecycleEntry,
  AssetRegisterFields,
  InventoryItem,
} from '@/app/types';

export const ASSET_LIFECYCLES: readonly AssetLifecycle[] = [
  'active',
  'loaned_out',
  'lost',
  'damaged',
  'retired',
];

/** States that mean the asset is gone from the books (feeds shrinkage and leaves the equipment register). */
export const LOSS_LIFECYCLES: readonly AssetLifecycle[] = ['lost', 'damaged', 'retired'];

export function isAssetLifecycle(v: unknown): v is AssetLifecycle {
  return typeof v === 'string' && (ASSET_LIFECYCLES as readonly string[]).includes(v);
}

/** Effective lifecycle: undefined (legacy) or a corrupt value reads as `active`. */
export function getLifecycle(x: Pick<AssetRegisterFields, 'lifecycle'> | undefined | null): AssetLifecycle {
  return x && isAssetLifecycle(x.lifecycle) ? x.lifecycle : 'active';
}

export type LifecycleValidation = { ok: true } | { ok: false; reason: string };

/**
 * Is `current -> to` allowed? `assignedTo` is the holder that will be on the
 * record after the change (a loan must say who has it).
 */
export function validateLifecycleChange(
  current: AssetLifecycle,
  to: AssetLifecycle,
  assignedTo?: string | null,
): LifecycleValidation {
  if (!isAssetLifecycle(to)) return { ok: false, reason: `Unknown lifecycle state: ${String(to)}` };
  if (current === to) return { ok: false, reason: `Asset is already ${to}` };
  if (current === 'retired') return { ok: false, reason: 'A retired asset cannot change state' };
  if (to === 'loaned_out' && !(assignedTo && assignedTo.trim())) {
    return { ok: false, reason: 'A loaned-out asset needs a holder (assignedTo)' };
  }
  return { ok: true };
}

/** New history array with `entry` appended; never mutates the input. */
export function appendLifecycleHistory(
  history: AssetLifecycleEntry[] | undefined,
  entry: AssetLifecycleEntry,
): AssetLifecycleEntry[] {
  return [...(history ?? []), entry];
}

export interface LifecycleChangeOptions {
  note?: string;
  /** Holder for `loaned_out`. Ignored (and cleared) for every other target state. */
  assignedTo?: string;
}

export type LifecyclePlan =
  | {
      ok: true;
      entry: AssetLifecycleEntry;
      /** Fields to write on the target. `assignedTo: null` means "remove the field". */
      patch: {
        lifecycle: AssetLifecycle;
        lifecycleHistory: AssetLifecycleEntry[];
        assignedTo: string | null;
      };
    }
  | { ok: false; reason: string };

/** Pure: validate a transition and compute the entry + patch. No I/O. */
export function planLifecycleChange(
  target: Pick<AssetRegisterFields, 'lifecycle' | 'lifecycleHistory' | 'assignedTo'>,
  to: AssetLifecycle,
  actor: { uid: string; name?: string },
  opts: LifecycleChangeOptions = {},
  now: Date = new Date(),
): LifecyclePlan {
  const from = getLifecycle(target);
  const holder = to === 'loaned_out' ? (opts.assignedTo ?? target.assignedTo)?.trim() || undefined : undefined;
  const check = validateLifecycleChange(from, to, holder);
  if (!check.ok) return check;

  const note = opts.note?.trim() || undefined;
  const entry: AssetLifecycleEntry = removeUndefined({
    from,
    to,
    at: now,
    by: removeUndefined({ uid: actor.uid, name: actor.name }),
    note,
  }) as AssetLifecycleEntry;

  return {
    ok: true,
    entry,
    patch: {
      lifecycle: to,
      lifecycleHistory: appendLifecycleHistory(target.lifecycleHistory, entry),
      assignedTo: holder ?? null,
    },
  };
}

export interface ChangeAssetLifecycleOptions extends LifecycleChangeOptions {
  /** Change one serialized instance inside `item.assets[]` instead of the whole doc. */
  instanceSerial?: string;
}

/**
 * Move an asset (or one of its serialized instances) to a new lifecycle state.
 * Re-reads the doc in a transaction so validation and the history append see
 * the current state, then logs to `inventory_logs` + `auditEvents`. Throws an
 * Error with a readable message when the change is not allowed.
 */
export async function changeAssetLifecycle(
  item: Pick<InventoryItem, 'id' | 'name'>,
  to: AssetLifecycle,
  actor: AuditActor,
  opts: ChangeAssetLifecycleOptions = {},
): Promise<{ from: AssetLifecycle; to: AssetLifecycle }> {
  const ref = doc(db, 'inventory', item.id);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Asset not found');
    const data = snap.data() as InventoryItem;

    if (opts.instanceSerial) {
      const instances = (data.assets ?? []) as AssetInstance[];
      const idx = instances.findIndex((a) => a.serial === opts.instanceSerial);
      if (idx < 0) throw new Error(`No asset instance with serial ${opts.instanceSerial}`);
      const plan = planLifecycleChange(instances[idx], to, actor, opts);
      if (!plan.ok) throw new Error(plan.reason);
      const updated = instances.map((a, i) =>
        i === idx
          ? { ...a, lifecycle: plan.patch.lifecycle, lifecycleHistory: plan.patch.lifecycleHistory, assignedTo: plan.patch.assignedTo ?? undefined }
          : a,
      );
      tx.update(ref, { assets: deepRemoveUndefined(updated), updatedAt: serverTimestamp() });
      return { plan, from: plan.entry.from };
    }

    const plan = planLifecycleChange(data, to, actor, opts);
    if (!plan.ok) throw new Error(plan.reason);
    tx.update(ref, {
      lifecycle: plan.patch.lifecycle,
      lifecycleHistory: deepRemoveUndefined(plan.patch.lifecycleHistory),
      assignedTo: plan.patch.assignedTo ?? deleteField(),
      updatedAt: serverTimestamp(),
    });
    return { plan, from: plan.entry.from };
  });

  const { plan, from } = result;
  const note = plan.entry.note;
  const where = opts.instanceSerial ? ` (serial ${opts.instanceSerial})` : '';

  await addDoc(collection(db, 'inventory_logs'), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'asset_lifecycle_changed',
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `Lifecycle ${from} -> ${to}${where}${note ? `: ${note}` : ''}`,
    details: removeUndefined({
      from,
      to,
      serial: opts.instanceSerial,
      assignedTo: plan.patch.assignedTo ?? undefined,
      note,
    }),
  }));

  await recordAuditEvent({
    eventType: 'asset_lifecycle_changed',
    source: 'asset_register',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    before: { lifecycle: from },
    after: { lifecycle: to },
    details: removeUndefined({
      serial: opts.instanceSerial,
      assignedTo: plan.patch.assignedTo ?? undefined,
      note,
    }),
  });

  return { from, to };
}
