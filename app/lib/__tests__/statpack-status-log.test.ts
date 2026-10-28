/**
 * Integration test (Firestore emulator): manual statpack status changes must
 * leave a `statpack_logs` row so they show in the pack Activity log (issue #20).
 * Run:  npm run test:statpack-status-log
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs, query, setDoc, terminate, where, Timestamp } from 'firebase/firestore';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('../../../scripts/emulator/guard');
const { db } = await import('../../../firebase');
const { updateStatpackDetails, overrideStatpackReady, saveStatpackContents } = await import('../statpacks');

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

describe('statpack status changes are logged', () => {
  after(async () => { await terminate(db); });

  it('updateStatpackDetails with a status change writes pack + status_change log', async () => {
    const { id } = await seed('Ready');
    await updateStatpackDetails(id, { status: 'In Use', currentLocation: 'Bay 1' }, actor, { status: 'Ready', name: 'Primary ALS Statpack' });
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
    await updateStatpackDetails(id, { name: 'Renamed', status: 'Ready' }, actor, { status: 'Ready', name: 'Primary ALS Statpack' });
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
    await saveStatpackContents({ ...pack, id, status: 'Not Ready' } as unknown as Pack, actor, 'Ready');
    const logs = await logsFor(id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'status_change');
    assert.deepEqual(logs[0].statusChange, { from: 'Ready', to: 'Not Ready' });
    // The log time must be a real Timestamp (a rebuilt serverTimestamp sentinel
    // stored as a plain map made the row undated and sorted it to the bottom).
    assert.ok(logs[0].timestamp instanceof Timestamp, 'log timestamp is a Timestamp');
  });

  it('saveStatpackContents keeps Timestamps (contents expirations, updatedAt) intact', async () => {
    const exp = Timestamp.fromDate(new Date(2027, 5, 1));
    const { id, pack } = await seed('Ready', { contents: [{ itemId: 'gauze', name: 'Gauze', requiredQuantity: 2, expirationDate: exp }] });
    await saveStatpackContents({ ...pack, id } as unknown as Pack, actor, 'Ready');
    const saved = (await getDoc(doc(db, 'statpacks', id))).data() as Record<string, unknown>;
    const item = (saved.contents as Array<Record<string, unknown>>)[0];
    assert.ok(item.expirationDate instanceof Timestamp, 'contents[].expirationDate stays a Timestamp');
    assert.equal((item.expirationDate as Timestamp).toMillis(), exp.toMillis());
    assert.ok(saved.updatedAt instanceof Timestamp, 'updatedAt is a Timestamp');
    assert.ok(saved.contentsUpdatedAt instanceof Timestamp, 'contentsUpdatedAt is a Timestamp');
  });

  it('saveStatpackContents without a status change omits statusChange', async () => {
    const { id, pack } = await seed('Ready');
    await saveStatpackContents({ ...pack, id } as unknown as Pack, actor, 'Ready');
    const logs = await logsFor(id);
    assert.equal(logs[0].statusChange, undefined);
  });
});
