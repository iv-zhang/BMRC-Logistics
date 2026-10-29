/**
 * Integration test (Firestore emulator): manual statpack status changes must
 * leave a `statpack_logs` row so they show in the pack Activity log (issue #20).
 * Run:  npm run test:statpack-status-log
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs, query, setDoc, terminate, where, Timestamp } from 'firebase/firestore';
import type { Statpack } from '../../types';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('../../../scripts/emulator/guard');
const { db } = await import('../../../firebase');
const { updateStatpackDetails, overrideStatpackReady, saveStatpackContents, buildStatpackEditorPatch } = await import('../statpacks');
const { coerceDate, coerceTimestamp } = await import('../timestamps');
const { logStatpackCheckOff } = await import('../inventory');
const { getPackShortages } = await import('../statpack-shortages');

type Pack = Parameters<typeof overrideStatpackReady>[0];
const run = `${Date.now()}`;
let seq = 0;
const actor = { uid: 'admin-1', name: 'Test Admin' };

async function seed(status: string, extra: Record<string, unknown> = {}) {
  const id = `status-log-${run}-${++seq}`;
  const pack = { name: 'Primary ALS Statpack', type: 'Primary', status, isCheckedOut: false, contents: [], ...extra };
  await setDoc(doc(db, 'statpacks', id), pack);
  return { id, pack };
}

async function logsFor(id: string) {
  const snap = await getDocs(query(collection(db, 'statpack_logs'), where('statpackId', '==', id)));
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

function editorSeed(id: string, pack: Record<string, unknown>): Statpack {
  return { ...pack, id } as unknown as Statpack;
}

after(async () => { await terminate(db); });

describe('statpack status changes are logged', () => {

  it('audit preserves checked-out custody and logs the derived status', async () => {
    const checkedOutAt = Timestamp.fromDate(new Date('2026-10-27T18:00:00.000Z'));
    const { id } = await seed('In Use', {
      isCheckedOut: true,
      assignedToUserId: 'member-1',
      assignedToUserName: 'Member One',
      checkedOutAt,
      currentEventId: 'event-1',
      currentEvent: 'Training Night',
      readyOverride: { by: 'admin-1', note: 'one pass' },
    });

    await logStatpackCheckOff({
      statpackId: id,
      statpackName: 'Primary ALS Statpack',
      action: 'audit',
      userId: actor.uid,
      userName: actor.name,
      userRole: 'admin',
      checkEntries: [],
    });

    const saved = (await getDoc(doc(db, 'statpacks', id))).data()!;
    assert.equal(saved.status, 'In Use');
    assert.equal(saved.isCheckedOut, true);
    assert.equal(saved.assignedToUserId, 'member-1');
    assert.equal(saved.assignedToUserName, 'Member One');
    assert.equal((saved.checkedOutAt as Timestamp).toMillis(), checkedOutAt.toMillis());
    assert.equal(saved.currentEventId, 'event-1');
    assert.equal(saved.currentEvent, 'Training Night');
    assert.equal(saved.readyOverride, null);
    assert.ok(saved.lastAuditAt instanceof Timestamp);
    assert.equal(saved.lastAuditBy, actor.name);

    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'audit');
    assert.equal(logs[0].derivedStatus, 'Ready');
  });

  it('audit preserves checked-out status while logging a non-ready derived result', async () => {
    const { id } = await seed('In Use', {
      isCheckedOut: true,
      assignedToUserId: 'member-1',
      contents: [{ itemId: 'empty-gauze', requiredQuantity: 1, currentQuantity: 0 }],
    });
    await logStatpackCheckOff({
      statpackId: id,
      statpackName: 'Primary ALS Statpack',
      action: 'audit',
      userId: actor.uid,
      userName: actor.name,
      userRole: 'admin',
      checkEntries: [],
    });
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.status, 'In Use');
    assert.equal((await logsFor(id))[0].derivedStatus, 'Restock Needed');
  });

  it('updateStatpackDetails with a status change writes pack + status_change log', async () => {
    const { id } = await seed('Ready');
    const openingSeed = editorSeed(id, { status: 'Ready', name: 'Primary ALS Statpack', contents: [], isCheckedOut: false });
    await updateStatpackDetails(id, { status: 'In Use', currentLocation: 'Bay 1' }, actor, openingSeed);
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.status, 'In Use');
    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'status_change');
    assert.deepEqual(logs[0].statusChange, { from: 'Ready', to: 'In Use' });
    assert.equal(logs[0].userId, 'admin-1');
    assert.equal(logs[0].userName, 'Test Admin');
  });

  it('updateStatpackDetails without a status change logs content_edit and no statusChange', async () => {
    const { id } = await seed('Ready');
    const openingSeed = editorSeed(id, { status: 'Ready', name: 'Primary ALS Statpack', contents: [], isCheckedOut: false });
    await updateStatpackDetails(id, { name: 'Renamed', status: 'Ready' }, actor, openingSeed);
    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'content_edit');
    assert.equal(logs[0].statusChange, undefined);
    assert.equal(logs[0].statpackName, 'Renamed');
  });

  it('overrideStatpackReady writes a status_change log row', async () => {
    const { id, pack } = await seed('Restock Needed');
    await overrideStatpackReady({ ...pack, id } as unknown as Pack, actor, 'crew rolling');
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.status, 'Ready');
    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'status_change');
    assert.deepEqual(logs[0].statusChange, { from: 'Restock Needed', to: 'Ready' });
    assert.match(String(logs[0].notes), /Manual Ready override/);
  });

  it('saveStatpackContents records statusChange when previousStatus differs', async () => {
    const { id, pack } = await seed('Ready');
    const openingSeed = editorSeed(id, pack as unknown as Record<string, unknown>);
    await saveStatpackContents({ ...pack, id, status: 'In Maintenance' } as unknown as Pack, actor, openingSeed);
    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'status_change');
    assert.deepEqual(logs[0].statusChange, { from: 'Ready', to: 'In Maintenance' });
    // The log time must be a real Timestamp (a rebuilt serverTimestamp sentinel
    // stored as a plain map made the row undated and sorted it to the bottom).
    assert.ok(logs[0].timestamp instanceof Timestamp, 'log timestamp is a Timestamp');
  });

  it('saveStatpackContents keeps Timestamps (contents expirations, updatedAt) intact', async () => {
    const exp = Timestamp.fromDate(new Date(2027, 5, 1));
    const { id, pack } = await seed('Ready', { contents: [{ itemId: 'gauze', name: 'Gauze', requiredQuantity: 2, expirationDate: exp }] });
    const openingSeed = editorSeed(id, pack as unknown as Record<string, unknown>);
    await saveStatpackContents({ ...pack, id } as unknown as Pack, actor, openingSeed);
    const saved = (await getDoc(doc(db, 'statpacks', id))).data() as Record<string, unknown>;
    const item = (saved.contents as Array<Record<string, unknown>>)[0];
    assert.ok(item.expirationDate instanceof Timestamp, 'contents[].expirationDate stays a Timestamp');
    assert.equal((item.expirationDate as Timestamp).toMillis(), exp.toMillis());
    assert.ok(saved.updatedAt instanceof Timestamp, 'updatedAt is a Timestamp');
    assert.ok(saved.contentsUpdatedAt instanceof Timestamp, 'contentsUpdatedAt is a Timestamp');
  });

  it('saveStatpackContents without a status change omits statusChange', async () => {
    const { id, pack } = await seed('Ready');
    const openingSeed = editorSeed(id, pack as unknown as Record<string, unknown>);
    await saveStatpackContents({ ...pack, id } as unknown as Pack, actor, openingSeed);
    const logs = await logsFor(id);
    assert.equal(logs[0].statusChange, undefined);
  });
});

describe('statpack editor immutable seed and whitelist', () => {
  it('patch whitelist omits ownership fields and unchanged status', () => {
    const openingSeed = editorSeed('x', { name: 'Test pack', currentLocation: 'Bay 1', assetValue: 10, exchangeBagAssignments: [], status: 'Ready', contents: [], isCheckedOut: false });
    const draft = editorSeed('x', { ...openingSeed, status: 'Ready', isCheckedOut: true, assignedToUserId: 'attacker', assignedToUserName: 'Wrong', checkedOutAt: new Date(), checkedInAt: new Date(), lastCheckedAt: new Date(), lastCheckedBy: 'wrong', lastAuditAt: new Date(), lastAuditBy: 'wrong', currentEventId: 'wrong', readyOverride: { at: new Date() }, sharpsContainer: 'wrong', createdAt: new Date(), updatedAt: new Date(), maintenance_logs: [{ note: 'wrong' }] });
    const patch = buildStatpackEditorPatch(draft, openingSeed);
    for (const key of ['isCheckedOut','assignedToUserId','assignedToUserName','checkedOutAt','checkedInAt','lastCheckedAt','lastCheckedBy','lastAuditAt','lastAuditBy','currentEvent','currentEventId','readyOverride','sharpsContainer','createdAt','updatedAt','maintenance_logs']) assert.equal(key in patch, false, key);
    assert.deepEqual(Object.keys(patch).sort(), ['assetValue','contents','contentsUpdatedAt','currentLocation','name','exchangeBagAssignments'].sort());
    assert.equal('status' in patch, false);
  });

  it('rehydrates JSON cloned expiration date with exact Timestamp nanoseconds', () => {
    const openingSeed = editorSeed('x', { status: 'Ready', contents: [], isCheckedOut: false });
    const dateValue = new Date('2027-01-02T03:04:05.123Z');
    const clonedContents = JSON.parse(JSON.stringify([{ itemId: 'x', expirationDate: new Timestamp(1800000000, 123456789),
      effectiveExpiration: dateValue, itemDetails: { assetLastChecked: dateValue, maintenance_logs: [{ timestamp: dateValue }] } }]));
    const patch = buildStatpackEditorPatch(editorSeed('x', { status: 'Ready', contents: clonedContents, isCheckedOut: false }), openingSeed);
    const date = (patch.contents as Array<Record<string, unknown>>)[0].expirationDate as Timestamp;
    assert.ok(date instanceof Timestamp);
    assert.equal(date.seconds, 1800000000);
    assert.equal(date.nanoseconds, 123456789);
    const item = (patch.contents as Array<Record<string, unknown>>)[0];
    const details = item.itemDetails as { assetLastChecked: Timestamp; maintenance_logs: Array<{ timestamp: Timestamp }> };
    for (const normalized of [item.effectiveExpiration, details.assetLastChecked, details.maintenance_logs[0].timestamp]) {
      assert.ok(normalized instanceof Timestamp);
      assert.equal(normalized.toMillis(), dateValue.getTime());
    }
  });

  it('coercer covers supported timestamp representations and ignores sentinel maps', () => {
    const expected = new Date('2027-01-02T03:04:05.123Z');
    const ts = Timestamp.fromDate(expected);
    for (const value of [ts, expected, expected.toISOString(), { seconds: ts.seconds, nanoseconds: ts.nanoseconds }, { type: 'timestamp', seconds: ts.seconds, nanoseconds: ts.nanoseconds }]) assert.equal(coerceDate(value)?.getTime(), expected.getTime());
    assert.equal(coerceTimestamp({ _methodName: 'serverTimestamp' }), undefined);
  });

  it('live checked-out pack rejects Ready and non-ready safety statuses even with stale caller', async () => {
    for (const status of ['Ready', 'In Maintenance', 'Pending Initial Check']) {
      const { id } = await seed('In Use', { isCheckedOut: true, contents: [], assignedToUserId: 'u' });
      const seedSnap = editorSeed(id, { status: 'In Use', isCheckedOut: true, contents: [] });
      await assert.rejects(updateStatpackDetails(id, { status }, actor, seedSnap), /Check this pack in first/);
      assert.equal((await logsFor(id)).length, 0);
    }
  });

  it('uses live status for status-change decision and rejects removal atomically', async () => {
    const { id } = await seed('Ready', { contents: [{ itemId: 'g', requiredQuantity: 1, currentQuantity: 1 }] });
    const seedSnap = editorSeed(id, { status: 'Ready', isCheckedOut: false, contents: [{ itemId: 'g', requiredQuantity: 1, currentQuantity: 1 }] });
    await updateStatpackDetails(id, { name: 'Renamed' }, actor, { status: 'Old', name: 'old' });
    assert.equal((await logsFor(id))[0].action, 'content_edit');
    await assert.rejects(updateStatpackDetails(id, { contents: [] }, actor, seedSnap, undefined, seedSnap), /Items can't be removed/);
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.contents instanceof Array, true);
    assert.equal((await logsFor(id)).length, 1);
  });

  it('logs status change from live status when caller previous status is stale', async () => {
    const { id } = await seed('Ready');
    await setDoc(doc(db, 'statpacks', id), { status: 'In Use' }, { merge: true });
    await updateStatpackDetails(id, { status: 'Ready' }, actor, { status: 'Ready', name: 'stale' });
    const logs = await logsFor(id);
    assert.equal(logs[0].action, 'status_change');
    assert.deepEqual(logs[0].statusChange, { from: 'In Use', to: 'Ready' });
  });

  it('accepts par 0 and preserves the item; zero-count par-0 check-in is Ready without shortages', async () => {
    const contents = [{ itemId: 'gauze', name: 'Gauze', requiredQuantity: 1, currentQuantity: 0, pocket: 'main', isConsumable: true }];
    const { id } = await seed('In Use', { isCheckedOut: true, assignedToUserId: 'admin-1', contents });
    const savedSeed = editorSeed(id, { status: 'In Use', isCheckedOut: true, lastCheckedAt: undefined, lastAuditAt: undefined, contents });
    await saveStatpackContents(editorSeed(id, { ...savedSeed, contents: [{ ...contents[0], requiredQuantity: 0, currentQuantity: 0 }] }), actor, savedSeed);
    const saved = (await getDoc(doc(db, 'statpacks', id))).data()!;
    assert.equal((saved.contents as Array<{ requiredQuantity: number }>)[0].requiredQuantity, 0);
    assert.equal(getPackShortages({ id, ...saved } as unknown as Statpack).out.length, 0);
    await logStatpackCheckOff({ statpackId: id, statpackName: 'Primary ALS Statpack', action: 'checkin', userId: 'admin-1', userName: 'Test Admin', userRole: 'admin', checkEntries: [{ itemId: 'gauze', itemName: 'Gauze', requiredQuantity: 0, countedQuantity: 0, ok: true }] });
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.status, 'Ready');
  });

  it('rejects each D3 observation or ownership mismatch but permits equivalent serialized dates', async () => {
    const observed = Timestamp.fromMillis(1800000000000);
    for (const field of ['lastCheckedAt', 'lastAuditAt', 'status', 'isCheckedOut'] as const) {
      const { id } = await seed('Ready', { isCheckedOut: false, lastCheckedAt: observed, lastAuditAt: observed, contents: [] });
      const seedSnap = editorSeed(id, { status: 'Ready', isCheckedOut: false, lastCheckedAt: observed, lastAuditAt: observed, contents: [] });
      // Firestore observations can differ within one millisecond too.
      const mutation = field === 'lastCheckedAt' || field === 'lastAuditAt' ? new Timestamp(observed.seconds, observed.nanoseconds + 1000) : field === 'status' ? 'In Use' : true;
      await setDoc(doc(db, 'statpacks', id), { [field]: mutation }, { merge: true });
      await assert.rejects(saveStatpackContents(editorSeed(id, { ...seedSnap, contents: [] }), actor, seedSnap), /changed since you opened/);
      assert.equal((await logsFor(id)).length, 0);
    }
    const { id } = await seed('Ready', { isCheckedOut: false, lastCheckedAt: observed, lastAuditAt: observed, contents: [] });
    const seedSnap = editorSeed(id, { status: 'Ready', isCheckedOut: false, lastCheckedAt: observed, lastAuditAt: observed, contents: [] });
    await setDoc(doc(db, 'statpacks', id), { lastCheckedAt: { seconds: observed.seconds, nanoseconds: observed.nanoseconds } as never }, { merge: true });
    await saveStatpackContents(editorSeed(id, { ...seedSnap, contents: [] }), actor, seedSnap);
  });

  it('requires an opening seed for contents writes', async () => {
    const { id } = await seed('Ready');
    await assert.rejects(updateStatpackDetails(id, { contents: [] }, actor, { status: 'Ready', name: 'Primary ALS Statpack' }), /Reopen the editor/);
    assert.equal((await logsFor(id)).length, 0);
  });

  it('fast check-in detects an expired item stored as a legacy timestamp map', async () => {
    const expired = Timestamp.fromMillis(Date.now() - 86400000);
    const { id } = await seed('In Use', { isCheckedOut: true, assignedToUserId: actor.uid,
      contents: [{ itemId: 'expired-gauze', requiredQuantity: 1, currentQuantity: 1,
        expirationDate: { seconds: expired.seconds, nanoseconds: expired.nanoseconds } }] });
    await logStatpackCheckOff({ statpackId: id, statpackName: 'Primary ALS Statpack',
      action: 'checkin', userId: actor.uid, userName: actor.name, userRole: 'admin', checkEntries: [] });
    assert.equal((await getDoc(doc(db, 'statpacks', id))).data()?.status, 'Expired Items');
  });
});
