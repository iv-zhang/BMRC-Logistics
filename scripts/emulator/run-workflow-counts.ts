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
  increment,
  where,
} from 'firebase/firestore';
import type { InventoryItem } from '@/app/types';
import { db } from '@/firebase';
import { auditStockFingerprint } from '@/app/lib/audit-count';
import { submitAuditEntries } from '@/app/lib/audit-helpers';
import type { AuditEntry } from '@/app/lib/audit-helpers';

const testRunId = `workflow-counts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const purpose = 'Batch 1a audit count writer regression';
const user = { uid: testRunId, email: `${testRunId}@test.invalid`, displayName: '[TEST] Workflow Counts' };

const cleanupManifest: {
  inventory: string[];
  inventory_logs: string[];
  auditEvents: string[];
} = { inventory: [], inventory_logs: [], auditEvents: [] };

function makeItem(
  suffix: string,
  stock: Partial<InventoryItem> = {},
): InventoryItem {
  const id = `${testRunId}-${suffix}`;
  const item = {
    id,
    name: `[TEST] ${purpose} ${suffix}`,
    category: 'Supplies',
    location: 'Test fixture',
    unopenedBoxes: 0,
    reorderThreshold: 0,
    tracksExpiration: false,
    totalStockQuantity: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...stock,
  } as unknown as InventoryItem;
  return item;
}

async function createFixture(item: InventoryItem): Promise<void> {
  cleanupManifest.inventory.push(item.id);
  await setDoc(doc(db, 'inventory', item.id), {
    ...item,
    isTest: true,
    testRunId,
    purpose,
  });
}

async function readItem(id: string): Promise<Record<string, unknown>> {
  const snap = await getDoc(doc(db, 'inventory', id));
  assert.ok(snap.exists(), `fixture ${id} should exist`);
  return snap.data();
}

async function findRelatedDocs(collectionName: string, field: string, ids: string[]) {
  const docs = [];
  for (let i = 0; i < ids.length; i += 10) {
    const part = ids.slice(i, i + 10);
    const snap = await getDocs(query(collection(db, collectionName), where(field, 'in', part)));
    docs.push(...snap.docs);
  }
  return docs;
}

async function evidenceFor(ids: string[]) {
  const [logs, events] = await Promise.all([
    findRelatedDocs('inventory_logs', 'itemId', ids),
    findRelatedDocs('auditEvents', 'sourceId', ids),
  ]);
  for (const snap of logs) cleanupManifest.inventory_logs.push(snap.id);
  for (const snap of events) cleanupManifest.auditEvents.push(snap.id);
  return {
    logs: logs.map((snap) => ({ id: snap.id, ...snap.data() }) as Record<string, unknown>),
    events: events.map((snap) => ({ id: snap.id, ...snap.data() }) as Record<string, unknown>),
  };
}

async function submit(item: InventoryItem, entry: Omit<AuditEntry, 'itemId'>) {
  return submitAuditEntries(
    [{ expectedStockFingerprint: auditStockFingerprint(item), ...entry, itemId: item.id, notes: `[TEST] ${testRunId}: ${purpose}` }],
    [item],
    user,
    `[TEST] ${testRunId}: ${purpose}`,
  );
}

async function assertRecordedCount(
  item: InventoryItem,
  expected: { boxes: number; loose: number; total: number | null },
): Promise<void> {
  const { logs, events } = await evidenceFor([item.id]);
  assert.equal(logs.length, 1, `${item.name}: exactly one inventory log`);
  assert.equal(events.length, 1, `${item.name}: exactly one audit event`);
  const details = logs[0].details as Record<string, unknown>;
  assert.equal(details.countedBoxes, expected.boxes);
  assert.equal(details.countedLooseUnits, expected.loose);
  assert.equal(details.countedTotalUnits, expected.total);
  const eventDetails = events[0].details as Record<string, unknown>;
  assert.equal(eventDetails.countedBoxes, expected.boxes);
  assert.equal(eventDetails.countedLooseUnits, expected.loose);
  assert.equal(eventDetails.countedTotalUnits, expected.total);
}

async function run(): Promise<void> {
  const looseOpa = makeItem('loose-opa');
  await createFixture(looseOpa);
  const opaResult = await submit(looseOpa, { countedBoxes: 0, countedLooseUnits: 12, reconcileCount: true, condition: 'Good' });
  assert.equal(opaResult.itemsUpdated, 1);
  const opa = await readItem(looseOpa.id);
  assert.equal(opa.looseUnits, 12);
  assert.equal(opa.unopenedBoxes, 0);
  assert.equal(opa.totalStockQuantity, 12);
  assert.equal(opa.auditVerified, true);
  await assertRecordedCount(looseOpa, { boxes: 0, loose: 12, total: 12 });

  const splints = makeItem('splints');
  await createFixture(splints);
  await submit(splints, { countedBoxes: 0, countedLooseUnits: 6, reconcileCount: true, condition: 'Good' });
  const splintData = await readItem(splints.id);
  assert.equal(splintData.looseUnits, 6);
  assert.equal(splintData.totalStockQuantity, 6);
  await assertRecordedCount(splints, { boxes: 0, loose: 6, total: 6 });

  const coldPacks = makeItem('cold-packs-tote');
  await createFixture(coldPacks);
  await submit(coldPacks, { countedBoxes: 0, countedLooseUnits: 60, reconcileCount: true, condition: 'Good' });
  const coldPackData = await readItem(coldPacks.id);
  assert.equal(coldPackData.looseUnits, 60);
  assert.equal(coldPackData.totalStockQuantity, 60);
  await assertRecordedCount(coldPacks, { boxes: 0, loose: 60, total: 60 });

  const zeroStock = makeItem('zero-stock', { unopenedBoxes: 3, itemsPerBox: 10, totalStockQuantity: 30 });
  await createFixture(zeroStock);
  await submit(zeroStock, { countedBoxes: 0, countedLooseUnits: 0, reconcileCount: true, condition: 'Good' });
  const zeroData = await readItem(zeroStock.id);
  assert.equal(zeroData.unopenedBoxes, 0);
  assert.equal(zeroData.looseUnits, 0);
  assert.equal(zeroData.totalStockQuantity, 0);
  await assertRecordedCount(zeroStock, { boxes: 0, loose: 0, total: 0 });

  const singleLot = makeItem('two-bags-plus-seven', {
    batches: [{ id: 'single-lot', lotNumber: 'provenance-A', stock: 27, bagCount: 2, itemsPerBag: 10, looseItems: 7 }],
    totalStockQuantity: 27,
    auditVerified: false,
  });
  await createFixture(singleLot);
  await submit(singleLot, { countedBoxes: 2, countedLooseUnits: 7, condition: 'Good' });
  const singleLotData = await readItem(singleLot.id);
  assert.deepEqual(singleLotData.batches, [{ id: 'single-lot', lotNumber: 'provenance-A', stock: 27, bagCount: 2, itemsPerBag: 10, looseItems: 7 }]);
  assert.equal(singleLotData.totalStockQuantity, 27);
  assert.equal(singleLotData.auditVerified, true);
  assert.ok(singleLotData.lastAuditDate, 'matching package and loose count should stamp the audit');
  await assertRecordedCount(singleLot, { boxes: 2, loose: 7, total: 27 });
  await submit(singleLot, { countedBoxes: 3, countedLooseUnits: 4, reconcileCount: true, condition: 'Good' });
  const correctedLot = await readItem(singleLot.id);
  assert.deepEqual(correctedLot.batches, [{ id: 'single-lot', lotNumber: 'provenance-A', stock: 34, bagCount: 3, itemsPerBag: 10, looseItems: 4 }]);
  assert.equal(correctedLot.totalStockQuantity, 34);
  assert.equal(correctedLot.auditVerified, true);
  assert.equal((await evidenceFor([singleLot.id])).events.length, 2);

  const staleStampMismatch = makeItem('fresh-stamp-mismatch', {
    unopenedBoxes: 3,
    itemsPerBox: 10,
    totalStockQuantity: 30,
    auditVerified: true,
    lastAuditDate: new Date(),
  });
  await createFixture(staleStampMismatch);
  const mismatchResult = await submit(staleStampMismatch, {
    countedBoxes: 2, countedLooseUnits: 0, condition: 'Good',
  });
  const mismatchData = await readItem(staleStampMismatch.id);
  assert.equal(mismatchResult.variances, 1);
  assert.equal(mismatchData.unopenedBoxes, 3);
  assert.equal(mismatchData.totalStockQuantity, 30);
  assert.equal(mismatchData.auditVerified, false);
  assert.equal(mismatchData.lastAuditDate, null);
  await assertRecordedCount(staleStampMismatch, { boxes: 2, loose: 0, total: 20 });
  const observation = mismatchData.auditCountObservation as Record<string, unknown>;
  assert.deepEqual(observation.expected, { boxes: 3, loose: 0, total: 30 });
  assert.deepEqual(observation.observed, { boxes: 2, loose: 0, total: 20 });
  assert.deepEqual(observation.delta, { boxes: -1, loose: 0, total: -10 });
  // Saving the same mismatch twice must never turn it into a verified match.
  await submit(staleStampMismatch, { countedBoxes: 2, countedLooseUnits: 0, condition: 'Good' });
  assert.equal((await readItem(staleStampMismatch.id)).auditVerified, false);
  await submit(staleStampMismatch, { countedBoxes: 2, countedLooseUnits: 0, reconcileCount: true, condition: 'Good' });
  const corrected = await readItem(staleStampMismatch.id);
  assert.equal(corrected.unopenedBoxes, 2);
  assert.equal(corrected.auditVerified, true);
  assert.equal(corrected.auditCountObservation, null);
  const mismatchHistory = await evidenceFor([staleStampMismatch.id]);
  assert.equal(mismatchHistory.events.length, 3);
  assert.ok(mismatchHistory.events.some(event => event.eventType === 'audit_count_reconciled'));

  const ambiguousLots = makeItem('ambiguous-multilot', {
    batches: [
      { id: 'lot-10', stock: 20, bagCount: 2, itemsPerBag: 10, looseItems: 0 },
      { id: 'lot-20', stock: 20, bagCount: 1, itemsPerBag: 20, looseItems: 0 },
    ],
    totalStockQuantity: 40,
    auditVerified: false,
  });
  await createFixture(ambiguousLots);
  const ambiguousResult = await submit(ambiguousLots, {
    countedBoxes: 2, countedLooseUnits: 0, condition: 'Good',
  });
  const ambiguousData = await readItem(ambiguousLots.id);
  assert.equal(ambiguousResult.unresolved, 1);
  assert.deepEqual(ambiguousData.batches, ambiguousLots.batches);
  assert.equal(ambiguousData.totalStockQuantity, 40);
  assert.equal(ambiguousData.auditVerified, false);
  assert.equal(ambiguousData.lastAuditDate, null);
  await assertRecordedCount(ambiguousLots, { boxes: 2, loose: 0, total: null });

  const unknownSize = makeItem('unknown-sealed-size', {
    unopenedBoxes: 0,
    totalStockQuantity: 0,
    auditVerified: false,
  });
  await createFixture(unknownSize);
  const unknownResult = await submit(unknownSize, {
    countedBoxes: 2, countedLooseUnits: 0, condition: 'Good',
  });
  const unknownData = await readItem(unknownSize.id);
  assert.equal(unknownResult.unresolved, 1);
  assert.equal(unknownData.unopenedBoxes, 0, 'unknown package count must not be guessed into canonical stock');
  assert.equal(unknownData.totalStockQuantity, 0);
  assert.equal(unknownData.auditVerified, false);
  assert.equal(unknownData.lastAuditDate, null);
  await assertRecordedCount(unknownSize, { boxes: 2, loose: 0, total: null });

  for (const [label, invalidCount] of [
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ] as const) {
    const validFirst = makeItem(`atomic-${label}-valid-first`, {
      unopenedBoxes: 1, itemsPerBox: 10, totalStockQuantity: 10,
    });
    const invalidSecond = makeItem(`atomic-${label}-invalid-second`, {
      unopenedBoxes: 1, itemsPerBox: 10, totalStockQuantity: 10,
    });
    await Promise.all([createFixture(validFirst), createFixture(invalidSecond)]);
    await assert.rejects(
      submitAuditEntries(
        [
          { itemId: validFirst.id, countedBoxes: 2, countedLooseUnits: 0, condition: 'Good' },
          { itemId: invalidSecond.id, countedBoxes: invalidCount, countedLooseUnits: 0, condition: 'Good' },
        ],
        [validFirst, invalidSecond],
        user,
        `[TEST] ${testRunId}: ${purpose}`,
      ),
      `${label} count should be rejected`,
    );
    for (const item of [validFirst, invalidSecond]) {
      const after = await readItem(item.id);
      assert.equal(after.unopenedBoxes, 1, `${label}: first and invalid item remain unchanged`);
      assert.equal(after.totalStockQuantity, 10, `${label}: total remains unchanged`);
      assert.equal(after.lastAuditDate, undefined);
      assert.equal(after.auditVerified, undefined);
    }
    const evidence = await evidenceFor([validFirst.id, invalidSecond.id]);
    assert.equal(evidence.logs.length, 0, `${label}: rejected batch writes no inventory logs`);
    assert.equal(evidence.events.length, 0, `${label}: rejected batch writes no audit events`);
  }

  // A receipt after opening the drawer must survive a stale absolute correction.
  const staleReceipt = makeItem('receipt-after-count', { unopenedBoxes: 3, itemsPerBox: 10, totalStockQuantity: 30 });
  await createFixture(staleReceipt);
  await updateDoc(doc(db, 'inventory', staleReceipt.id), { unopenedBoxes: increment(2), totalStockQuantity: increment(20) });
  await assert.rejects(submit(staleReceipt, { countedBoxes: 2, countedLooseUnits: 0, reconcileCount: true, condition: 'Good' }), /Stock changed/);
  await assert.rejects(submit(staleReceipt, { countedBoxes: 3, countedLooseUnits: 0, condition: 'Good' }), /Stock changed/);
  assert.equal((await readItem(staleReceipt.id)).unopenedBoxes, 5);
  assert.equal((await evidenceFor([staleReceipt.id])).events.length, 0);

  // Two writers share one stock snapshot. Only one correction may commit; the
  // other transaction must re-read, reject, and leave no phantom history.
  const race = makeItem('concurrent-corrections', { unopenedBoxes: 3, itemsPerBox: 10, totalStockQuantity: 30 });
  await createFixture(race);
  const raced = await Promise.allSettled([2, 4].map(boxes => submit(race, {
    countedBoxes: boxes, countedLooseUnits: 0, reconcileCount: true, condition: 'Good',
  })));
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter(result => result.status === 'rejected').length, 1);
  const winner = await readItem(race.id);
  assert.ok(winner.unopenedBoxes === 2 || winner.unopenedBoxes === 4);
  const raceEvidence = await evidenceFor([race.id]);
  assert.equal(raceEvidence.logs.length, 1);
  assert.equal(raceEvidence.events.length, 1);
  const winnerDetails = raceEvidence.logs[0].details as Record<string, unknown>;
  assert.equal(winnerDetails.countedBoxes, winner.unopenedBoxes);
  assert.equal(winner.auditVerified, true);

  // Explicit corrections still cannot allocate ambiguous lots.
  await submit(ambiguousLots, { countedBoxes: 2, countedLooseUnits: 0, reconcileCount: true, condition: 'Good' });
  assert.deepEqual((await readItem(ambiguousLots.id)).batches, ambiguousLots.batches);
  assert.equal((await readItem(ambiguousLots.id)).auditVerified, false);

  // The test fixtures and their related immutable evidence are all identified
  // by unique fixture IDs; cleanup records exact evidence document IDs below.
  const allIds = cleanupManifest.inventory;
  const evidence = await evidenceFor(allIds);
  // Every successful audit wrote one log/event; failed atomic trials wrote none.
  assert.equal(evidence.logs.length, 13);
  assert.equal(evidence.events.length, 13);
}

let failed = false;
try {
  await run();
  console.log(`\nWorkflow count writer checks passed (${testRunId}).`);
} catch (error) {
  failed = true;
  console.error(`\nWorkflow count writer checks failed (${testRunId}):`, error);
} finally {
  const unique = <T,>(xs: T[]) => [...new Set(xs)];
  try {
    const fixtureIds = unique(cleanupManifest.inventory);
    if (fixtureIds.length > 0) {
      const [logs, events] = await Promise.all([
        findRelatedDocs('inventory_logs', 'itemId', fixtureIds),
        findRelatedDocs('auditEvents', 'sourceId', fixtureIds),
      ]);
      cleanupManifest.inventory_logs.push(...logs.map((snap) => snap.id));
      cleanupManifest.auditEvents.push(...events.map((snap) => snap.id));
    }
  } catch (error) {
    failed = true;
    console.error('Could not discover all audit evidence for cleanup:', error);
  }
  for (const [collectionName, ids] of [
    ['inventory_logs', cleanupManifest.inventory_logs],
    ['auditEvents', cleanupManifest.auditEvents],
    ['inventory', cleanupManifest.inventory],
  ] as const) {
    for (const id of unique(ids)) {
      try {
        await deleteDoc(doc(db, collectionName, id));
      } catch (error) {
        failed = true;
        console.error(`Workflow count cleanup failed for ${collectionName}/${id}:`, error);
      }
    }
  }
  if (failed) {
    console.error('Workflow count cleanup manifest:', JSON.stringify({
      inventory: unique(cleanupManifest.inventory),
      inventory_logs: unique(cleanupManifest.inventory_logs),
      auditEvents: unique(cleanupManifest.auditEvents),
    }, null, 2));
  }
  try {
    await terminate(db);
  } catch (error) {
    failed = true;
    console.error('Failed to terminate Firestore client:', error);
  }
}

process.exit(failed ? 1 : 0);
