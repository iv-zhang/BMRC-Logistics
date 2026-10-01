/**
 * Asset lifecycle (active / loaned_out / lost / damaged / retired).
 *
 * A SEPARATE axis from readiness: `assetStatus` (Ready / Not Ready) says whether
 * the gear can go out today; lifecycle says whether we still have it. Nothing
 * here touches readiness, and readiness logic never reads lifecycle.
 *
 * Split in two on purpose:
 *   - PURE (no Firestore, in `asset-lifecycle-core.ts`, re-exported here):
 *     `getLifecycle`, `validateLifecycleChange`, `appendLifecycleHistory`,
 *     `planLifecycleChange`. Unit-tested directly.
 *   - WRITE: `changeAssetLifecycle` (this file) runs the plan inside a transaction on the
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
import {
  planLifecycleChange,
  type LifecycleChangeOptions,
} from '@/app/lib/asset-lifecycle-core';
import type { AssetInstance, AssetLifecycle, InventoryItem } from '@/app/types';

export * from '@/app/lib/asset-lifecycle-core';

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
