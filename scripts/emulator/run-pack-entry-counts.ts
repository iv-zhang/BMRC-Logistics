/** Real-writer regressions for repeated contents; disposable demo data only. */
import './guard';
import assert from 'node:assert/strict';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, terminate } from 'firebase/firestore';
import { db } from '@/firebase';
import { logStatpackCheckOff } from '@/app/lib/inventory';

const testRunId = `pack-entry-${Date.now()}`;
const packId = `[TEST]-${testRunId}`;
const manifest: Record<string, string[]> = { statpacks: [packId], statpack_logs: [] };
const content = (pocket: 'main' | 'front_aux', currentQuantity: number) => ({
  itemId: 'test-opa', itemName: '[TEST] OPA 80 mm', pocket,
  compartmentId: 'mesh', requiredQuantity: 3, currentQuantity,
});
const params = {
  statpackId: packId, statpackName: `[TEST] ${testRunId}`, action: 'audit' as const,
  userId: `[TEST]-${testRunId}`, userName: '[TEST] Pack Identity', userRole: 'admin',
};
try {
  await setDoc(doc(db, 'statpacks', packId), {
    name: params.statpackName, type: 'Primary', status: 'Restock Needed', isCheckedOut: false,
    isTest: true, testRunId, purpose: 'Repeated pocket count and restock isolation',
    contents: [content('main', 0), content('front_aux', 3)],
  });
  await logStatpackCheckOff({ ...params, checkEntries: [{
    ...content('front_aux', 3), countedQuantity: 2, ok: true, restockStatus: 'restocked',
  }] });
  let pack = (await getDoc(doc(db, 'statpacks', packId))).data()!;
  assert.deepEqual(pack.contents.map((entry: { currentQuantity: number }) => entry.currentQuantity), [0, 2],
    'a reused compartment ID cannot send a count to another pocket');
  assert.equal(pack.status, 'Restock Needed', 'restocking one occurrence cannot hide another empty pocket');
  await logStatpackCheckOff({ ...params, checkEntries: [{
    ...content('main', 0), countedQuantity: 1, ok: true,
  }] });
  pack = (await getDoc(doc(db, 'statpacks', packId))).data()!;
  assert.deepEqual(pack.contents.map((entry: { currentQuantity: number }) => entry.currentQuantity), [1, 2]);
  const logs = (await getDocs(collection(db, 'statpack_logs'))).docs.filter(snap => snap.data().statpackId === packId);
  manifest.statpack_logs = logs.map(snap => snap.id);
  assert.equal(logs.length, 2);
  assert.ok(logs.some(snap => snap.data().checkEntries[0].pocket === 'front_aux'));
  await assert.rejects(logStatpackCheckOff({ ...params, checkEntries: [{
    ...content('front_aux', 3), compartmentId: 'removed-compartment', countedQuantity: 99, ok: true,
  }] }), /contents changed|location no longer matches/);
  assert.deepEqual((await getDoc(doc(db, 'statpacks', packId))).data()!.contents, pack.contents,
    'an unmatched physical entry fails without changing the pack');
  const afterRejected = (await getDocs(collection(db, 'statpack_logs'))).docs.filter(snap => snap.data().statpackId === packId);
  assert.equal(afterRejected.length, 2, 'a rejected location writes no successful log');
  console.log('Pack entry writer checks passed: pocket/compartment isolation and untouched zero shortage.');
} finally {
  const logs = (await getDocs(collection(db, 'statpack_logs'))).docs.filter(snap => snap.data().statpackId === packId);
  manifest.statpack_logs = logs.map(snap => snap.id);
  console.log('Pack entry cleanup manifest:', JSON.stringify(manifest));
  await Promise.all([...logs.map(snap => deleteDoc(snap.ref)), deleteDoc(doc(db, 'statpacks', packId))]);
  await terminate(db);
}
