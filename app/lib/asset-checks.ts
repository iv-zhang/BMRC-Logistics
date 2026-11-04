import { collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '@/firebase';
import { addAuditEventToBatch, removeUndefined } from '@/app/lib/audit';
import type { InventoryItem } from '@/app/types';

export interface ControlTestActor {
  uid: string;
  name: string;
  email?: string | null;
}

/**
 * Record a glucometer (or other reagent-device) control test. Dotted field paths
 * keep `controlTest.intervalDays` intact. `lastTestedAt` / `lastTestedBy` are
 * written loosely (not yet on the InventoryItem type).
 */
export async function recordControlTest(
  item: Pick<InventoryItem, 'id' | 'name'>,
  result: 'pass' | 'fail',
  actor: ControlTestActor,
  notes?: string
): Promise<void> {
  const batch = writeBatch(db);
  const trimmed = notes?.trim() || undefined;

  const update: Record<string, unknown> = {
    'controlTest.lastResult': result,
    'controlTest.lastTestedAt': serverTimestamp(),
    'controlTest.lastTestedBy': actor.name,
    updatedAt: serverTimestamp(),
  };
  if (result === 'pass') update['controlTest.lastPassedAt'] = serverTimestamp();
  batch.update(doc(db, 'inventory', item.id), update);

  batch.set(doc(collection(db, 'inventory_logs')), removeUndefined({
    itemId: item.id,
    itemName: item.name,
    action: 'control_test',
    userId: actor.uid,
    userName: actor.name,
    timestamp: serverTimestamp(),
    notes: `Control test ${result}${trimmed ? ` — ${trimmed}` : ''}`,
    details: removeUndefined({ result, notes: trimmed }),
  }));

  addAuditEventToBatch(batch, {
    eventType: 'control_test_recorded',
    source: 'supply_audit',
    sourceId: item.id,
    actor: { userId: actor.uid, userName: actor.name, userEmail: actor.email ?? null },
    targets: [{ collection: 'inventory', docId: item.id }],
    after: { controlTestResult: result },
    details: removeUndefined({ result, notes: trimmed }),
  } as Parameters<typeof addAuditEventToBatch>[1]);

  await batch.commit();
}
