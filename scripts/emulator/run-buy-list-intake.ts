import './guard';

import assert from 'node:assert/strict';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  terminate,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { BuyListItem, InventoryItem } from '@/app/types';
import { db } from '@/firebase';
import { addShipment, DuplicateShipmentError } from '@/app/lib/audit-actions';
import {
  BuyListDeliveryConflictError,
  postBuyListDelivery,
  postPendingIntake,
} from '@/app/lib/buy-list';

const testRunId = `buylist-intake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const purpose = 'Batch 3 buy-list intake writer regression';
const actor = { uid: testRunId, name: '[TEST] Buy List Intake' };

const cleanupManifest: { inventory: string[]; inventory_logs: string[]; auditEvents: string[]; buyList: string[] } = {
  inventory: [], inventory_logs: [], auditEvents: [], buyList: [],
};

function makeItem(suffix: string, extra: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: `${testRunId}-${suffix}`,
    name: `[TEST] ${purpose} ${suffix}`,
    category: 'Supplies',
    location: 'Test fixture',
    unopenedBoxes: 0,
    itemsPerBox: 10,
    reorderThreshold: 0,
    tracksExpiration: false,
    totalStockQuantity: 0,
    ...extra,
  } as unknown as InventoryItem;
}

async function createItem(item: InventoryItem): Promise<void> {
  cleanupManifest.inventory.push(item.id);
  await setDoc(doc(db, 'inventory', item.id), { ...item, isTest: true, testRunId, purpose });
}

async function createEntry(suffix: string, quantity: number, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `${testRunId}-entry-${suffix}`;
  cleanupManifest.buyList.push(id);
  await setDoc(doc(db, 'buyList', id), {
    itemName: `[TEST] ${purpose} ${suffix}`,
    quantity,
    unit: 'boxes',
    priority: 'medium',
    status: 'pending',
    addedBy: actor.uid,
    addedByName: actor.name,
    addedAt: new Date(),
    isTest: true,
    testRunId,
    purpose,
    ...extra,
  });
  return id;
}

async function readEntry(id: string): Promise<BuyListItem> {
  const snap = await getDoc(doc(db, 'buyList', id));
  assert.ok(snap.exists(), `entry ${id} should exist`);
  return { ...(snap.data() as BuyListItem), id };
}

async function boxes(id: string): Promise<number> {
  const snap = await getDoc(doc(db, 'inventory', id));
  assert.ok(snap.exists());
  return (snap.data().unopenedBoxes as number) ?? 0;
}

async function intakeLogs(itemId: string) {
  const snap = await getDocs(query(
    collection(db, 'inventory_logs'),
    where('itemId', '==', itemId),
    where('action', '==', 'intake'),
  ));
  for (const d of snap.docs) cleanupManifest.inventory_logs.push(d.id);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
}

const ARGS = { perUnit: 10 };

async function run(): Promise<void> {
  // 1. Keyed addShipment twice.
  const plain = makeItem('plain');
  await createItem(plain);
  const key = `${testRunId}-key-1`;
  await addShipment(plain, { qty: 2, perUnit: 10, idempotencyKey: key }, actor);
  await assert.rejects(
    addShipment(plain, { qty: 2, perUnit: 10, idempotencyKey: key }, actor),
    (e) => e instanceof DuplicateShipmentError,
  );
  assert.equal(await boxes(plain.id), 2);
  const logs1 = await intakeLogs(plain.id);
  assert.equal(logs1.length, 1);
  assert.equal((logs1[0].details as Record<string, unknown>).idempotencyKey, key);

  // 2. Partial delivery + retry with the stale entry.
  const item2 = makeItem('case2');
  await createItem(item2);
  const id2 = await createEntry('case2', 5);
  const stale2 = await readEntry(id2);
  await postBuyListDelivery(stale2, { quantity: 2, final: false, post: true, item: item2, ...ARGS }, actor);
  assert.equal(await boxes(item2.id), 2);
  const after2 = await readEntry(id2);
  assert.equal(after2.receivedQuantity, 2);
  assert.equal(after2.intakeStatus, 'partial');
  assert.equal(after2.status, 'ordered');
  assert.equal(after2.deliveries?.length, 1);
  await postBuyListDelivery(stale2, { quantity: 2, final: false, post: true, item: item2, ...ARGS }, actor);
  assert.equal(await boxes(item2.id), 2, 'retry must not post stock twice');
  assert.equal((await readEntry(id2)).deliveries?.length, 1, 'retry must not add a second delivery');

  // 3. Partial failure: stock written under the next key, entry not yet updated.
  const nextKey = `buylist_${id2}_2`;
  await addShipment(item2, { qty: 3, perUnit: 10, idempotencyKey: nextKey }, actor);
  assert.equal(await boxes(item2.id), 5);
  await postBuyListDelivery(after2, { quantity: 3, final: true, post: true, item: item2, ...ARGS }, actor);
  assert.equal(await boxes(item2.id), 5, 'stock for the key must be written only once');
  const done2 = await readEntry(id2);
  assert.equal(done2.deliveries?.length, 2);
  assert.equal(done2.receivedQuantity, 5);
  assert.equal(done2.status, 'received');
  assert.equal(done2.intakeStatus, 'posted');
  assert.equal((await intakeLogs(item2.id)).length, 2);

  // 4. Two identical partial deliveries on a fresh entry.
  const item4 = makeItem('case4');
  await createItem(item4);
  const id4 = await createEntry('case4', 10);
  await postBuyListDelivery(await readEntry(id4), { quantity: 2, final: false, post: true, item: item4, ...ARGS }, actor);
  await postBuyListDelivery(await readEntry(id4), { quantity: 2, final: false, post: true, item: item4, ...ARGS }, actor);
  assert.equal(await boxes(item4.id), 4);
  const e4 = await readEntry(id4);
  assert.equal(e4.deliveries?.length, 2);
  assert.notEqual(e4.deliveries![0].idempotencyKey, e4.deliveries![1].idempotencyKey);
  assert.equal((await intakeLogs(item4.id)).length, 2);

  // 5. Intake later, then post pending (twice with a stale entry).
  const item5 = makeItem('case5');
  await createItem(item5);
  const id5 = await createEntry('case5', 4);
  await postBuyListDelivery(await readEntry(id5), { quantity: 4, final: true, post: false, item: item5, ...ARGS }, actor);
  assert.equal(await boxes(item5.id), 0, 'intake later must not change stock');
  const later = await readEntry(id5);
  assert.equal(later.intakeStatus, 'needed');
  assert.equal(later.linkedInventoryId, item5.id);
  assert.equal(later.deliveries![0].posted, false);
  await postPendingIntake(later, later.deliveries![0].seq, { item: item5, ...ARGS }, actor);
  assert.equal(await boxes(item5.id), 4);
  const posted5 = await readEntry(id5);
  assert.equal(posted5.deliveries![0].posted, true);
  assert.equal(posted5.intakeStatus, 'posted');
  await postPendingIntake(later, later.deliveries![0].seq, { item: item5, ...ARGS }, actor);
  assert.equal(await boxes(item5.id), 4, 'stale second post must not write stock again');
  assert.equal((await intakeLogs(item5.id)).length, 1);

  // 6. Conflict with another actor's delivery under the next key.
  const item6 = makeItem('case6');
  await createItem(item6);
  const id6 = await createEntry('case6', 5);
  const stale6 = await readEntry(id6);
  await updateDoc(doc(db, 'buyList', id6), {
    deliveries: [{
      seq: 1, quantity: 2, units: 20, idempotencyKey: `buylist_${id6}_1`,
      posted: true, at: new Date(), by: 'someone-else',
    }],
  });
  await assert.rejects(
    postBuyListDelivery(stale6, { quantity: 2, final: false, post: true, item: item6, ...ARGS }, actor),
    (e) => e instanceof BuyListDeliveryConflictError,
  );
  assert.equal(await boxes(item6.id), 0);

  // 7. Dated item without an expiration rejects before writing anything.
  const dated = makeItem('dated', { tracksExpiration: true });
  await createItem(dated);
  const id7 = await createEntry('dated', 3);
  await assert.rejects(
    postBuyListDelivery(await readEntry(id7), { quantity: 3, final: true, post: true, item: dated, ...ARGS }, actor),
    /Expiration/,
  );
  assert.equal(await boxes(dated.id), 0);
  assert.equal(((await readEntry(id7)).deliveries ?? []).length, 0);
  assert.equal((await intakeLogs(dated.id)).length, 0);
}

let failed = false;
try {
  await run();
  console.log('buy-list intake writer: ok');
} catch (error) {
  failed = true;
  console.error(`buy-list intake writer failed (${testRunId}):`, error);
} finally {
  const unique = <T,>(xs: T[]) => [...new Set(xs)];
  try {
    for (const itemId of unique(cleanupManifest.inventory)) {
      const logs = await getDocs(query(collection(db, 'inventory_logs'), where('itemId', '==', itemId)));
      cleanupManifest.inventory_logs.push(...logs.docs.map((d) => d.id));
      const events = await getDocs(query(collection(db, 'auditEvents'), where('sourceId', '==', itemId)));
      cleanupManifest.auditEvents.push(...events.docs.map((d) => d.id));
    }
  } catch (error) {
    failed = true;
    console.error('Could not discover all evidence for cleanup:', error);
  }
  for (const [name, ids] of [
    ['inventory_logs', cleanupManifest.inventory_logs],
    ['auditEvents', cleanupManifest.auditEvents],
    ['buyList', cleanupManifest.buyList],
    ['inventory', cleanupManifest.inventory],
  ] as const) {
    for (const id of unique(ids)) {
      try {
        await deleteDoc(doc(db, name, id));
      } catch (error) {
        failed = true;
        console.error(`Cleanup failed for ${name}/${id}:`, error);
      }
    }
  }
  if (failed) console.error('Cleanup manifest:', JSON.stringify(cleanupManifest, null, 2));
  try {
    await terminate(db);
  } catch (error) {
    failed = true;
    console.error('Failed to terminate Firestore client:', error);
  }
}

process.exit(failed ? 1 : 0);
