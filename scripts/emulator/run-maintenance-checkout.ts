/** Targeted transaction regression for statpack maintenance checkout policy. */
import './guard';
import assert from 'node:assert/strict';
import { db } from '@/firebase';
import { logStatpackCheckOff } from '@/app/lib/inventory';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, terminate, updateDoc } from 'firebase/firestore';

const testRunId = `maintenance-policy-${Date.now()}`;
const maintenanceId = `__test_maintenance_${testRunId}`;
const checkinId = `__test_maintenance_checkin_${testRunId}`;

const params = (statpackId: string, action: 'checkout' | 'checkin' | 'audit', userRole: string, userId = 'maintenance-policy-user') => ({
  statpackId,
  statpackName: `[TEST] Maintenance Policy ${testRunId}`,
  action,
  userId,
  userName: '[TEST] Maintenance Policy Runner',
  userRole,
  checkEntries: [],
});

async function readPack(id: string): Promise<Record<string, unknown>> {
  const snapshot = await getDoc(doc(db, 'statpacks', id));
  assert.ok(snapshot.exists(), `expected fixture statpack ${id} to exist`);
  return snapshot.data();
}

async function logsFor(id: string): Promise<Array<Record<string, unknown>>> {
  const snapshot = await getDocs(collection(db, 'statpack_logs'));
  return snapshot.docs.filter((entry) => entry.data().statpackId === id).map((entry) => entry.data());
}

async function main() {
  try {
    await setDoc(doc(db, 'statpacks', maintenanceId), {
      isTest: true,
      testRunId,
      purpose: 'Verify maintenance checkout denial, no admin bypass, and available audit/check-in',
      name: `[TEST] Maintenance Policy ${testRunId}`,
      type: 'Primary',
      status: 'Ready',
      isCheckedOut: false,
      currentLocation: 'MRC1',
      contents: [],
    });

    // Simulate stale client state: client sees Ready, then the pack enters
    // maintenance before logStatpackCheckOff starts its authoritative transaction.
    assert.equal((await readPack(maintenanceId)).status, 'Ready', 'client initially loads an eligible pack');
    await updateDoc(doc(db, 'statpacks', maintenanceId), { status: 'In Maintenance' });
    const maintenanceState = await readPack(maintenanceId);

    await assert.rejects(
      logStatpackCheckOff(params(maintenanceId, 'checkout', 'member')),
      /In Maintenance/i,
      'member checkout must reject specifically because the pack is in maintenance',
    );
    assert.equal((await readPack(maintenanceId)).status, 'In Maintenance', 'rejected member checkout preserves maintenance status');
    assert.equal((await readPack(maintenanceId)).isCheckedOut, false, 'rejected member checkout leaves pack unchecked out');
    assert.deepEqual(await readPack(maintenanceId), maintenanceState, 'member rejection leaves every pack field unchanged');

    await assert.rejects(
      logStatpackCheckOff(params(maintenanceId, 'checkout', 'admin', 'maintenance-policy-admin')),
      /In Maintenance/i,
      'admin checkout must reject specifically because the pack is in maintenance',
    );
    assert.equal((await readPack(maintenanceId)).status, 'In Maintenance', 'rejected admin checkout preserves maintenance status');
    assert.equal((await readPack(maintenanceId)).isCheckedOut, false, 'rejected admin checkout leaves pack unchecked out');
    assert.deepEqual(await readPack(maintenanceId), maintenanceState, 'admin rejection leaves every pack field unchanged');
    assert.equal((await logsFor(maintenanceId)).length, 0, 'rejected checkouts create no statpack logs');

    await logStatpackCheckOff(params(maintenanceId, 'audit', 'admin', 'maintenance-policy-admin'));
    assert.equal((await logsFor(maintenanceId)).filter((entry) => entry.action === 'audit').length, 1,
      'audit remains available for a maintenance pack');

    await setDoc(doc(db, 'statpacks', checkinId), {
      isTest: true,
      testRunId,
      purpose: 'Verify check-in remains available for a maintenance pack',
      name: `[TEST] Maintenance Check-in ${testRunId}`,
      type: 'Primary',
      status: 'In Maintenance',
      isCheckedOut: true,
      assignedToUserId: 'maintenance-policy-user',
      currentLocation: 'MRC1',
      contents: [],
    });
    await logStatpackCheckOff(params(checkinId, 'checkin', 'member'));
    assert.equal((await logsFor(checkinId)).filter((entry) => entry.action === 'checkin').length, 1,
      'check-in remains available for a checked-out maintenance pack');

    console.log('Maintenance checkout policy passed: stale, member, admin, audit, check-in, and persistence checks.');
  } finally {
    // Remove only this run's fixture packs and logs, leaving the seeded dataset intact.
    const snapshot = await getDocs(collection(db, 'statpack_logs'));
    const ownedLogs = snapshot.docs.filter((entry) =>
      entry.data().statpackId === maintenanceId || entry.data().statpackId === checkinId,
    );
    await Promise.all([
      ...ownedLogs.map((entry) => deleteDoc(entry.ref)),
      deleteDoc(doc(db, 'statpacks', maintenanceId)),
      deleteDoc(doc(db, 'statpacks', checkinId)),
    ]);
    await terminate(db);
  }
}

main().then(
  () => {},
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
