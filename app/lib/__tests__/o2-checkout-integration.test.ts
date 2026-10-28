/**
 * Integration test for the O₂ PSI checkout flow: logStatpackCheckOff must persist
 * the per-entry O₂ PSI reading onto the statpack_logs row.
 *
 * Needs the Firestore emulator (logStatpackCheckOff runs a real transaction), so
 * it is NOT part of `npm run test`. Run:  npm run test:o2
 *
 * Fixtures use fake names only; the demo-* project id is enforced by the guard.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDocs, query, setDoc, terminate, where } from 'firebase/firestore';

// Must be set before the app's Firebase client is imported (it wires the emulator
// at import time). `firebase emulators:exec` sets this already.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('../../../scripts/emulator/guard');
const { db } = await import('../../../firebase');
const { logStatpackCheckOff } = await import('../inventory');

type CheckEntries = Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];

const run = `${Date.now()}`;
let seq = 0;

/** Seed a fresh, available pack holding one content row per entry, then check it out. */
async function checkoutWith(checkEntries: CheckEntries) {
  const statpackId = `o2-test-${run}-${++seq}`;
  await setDoc(doc(db, 'statpacks', statpackId), {
    name: 'Primary ALS Statpack',
    status: 'Ready',
    isCheckedOut: false,
    contents: checkEntries.map((e) => ({
      itemId: e.itemId,
      requiredQuantity: e.requiredQuantity,
      currentQuantity: e.requiredQuantity,
    })),
  });

  await logStatpackCheckOff({
    statpackId,
    statpackName: 'Primary ALS Statpack',
    action: 'checkout',
    userId: 'user-123',
    userName: 'Test User',
    userRole: 'member',
    checkEntries,
  });

  const snap = await getDocs(query(collection(db, 'statpack_logs'), where('statpackId', '==', statpackId)));
  assert.equal(snap.size, 1);
  return snap.docs[0].data() as {
    checkEntries: Array<{ assetCheckResult?: { oxygenPsi?: number; batteryPct?: number }; checkedAt?: unknown }>;
    timestamp?: unknown;
    clientTimestamp?: { toDate?: () => Date } | Date;
  };
}

const tank = (id: string, name: string, assetCheckResult?: NonNullable<CheckEntries[number]['assetCheckResult']>) => ({
  itemId: id,
  itemName: name,
  requiredQuantity: 1,
  countedQuantity: 1,
  ok: true,
  assetCheckResult,
});

after(async () => {
  await terminate(db);
});

describe('O₂ PSI Checkout Integration', () => {
  describe('Checkout with O₂ PSI', () => {
    it('should persist O₂ PSI in checkEntries.assetCheckResult', async () => {
      const log = await checkoutWith([tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', { oxygenPsi: 2000 })]);
      assert.equal(log.checkEntries[0].assetCheckResult?.oxygenPsi, 2000);
    });

    it('should handle multiple O₂ tanks in one checkout', async () => {
      const log = await checkoutWith([
        tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', { oxygenPsi: 2000 }),
        tank('oxygen-tank-002', 'Spare Oxygen Tank', { oxygenPsi: 1950 }),
        tank('aed-001', 'AED'),
      ]);
      assert.equal(log.checkEntries.length, 3);
      assert.equal(log.checkEntries[0].assetCheckResult?.oxygenPsi, 2000);
      assert.equal(log.checkEntries[1].assetCheckResult?.oxygenPsi, 1950);
      assert.equal(log.checkEntries[2].assetCheckResult, undefined);
    });

    it('should preserve O₂ PSI through sanitization (undefined fields stripped)', async () => {
      const log = await checkoutWith([
        tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', { oxygenPsi: 1850, batteryPct: undefined }),
      ]);
      assert.equal(log.checkEntries[0].assetCheckResult?.oxygenPsi, 1850);
      assert.equal(log.checkEntries[0].assetCheckResult?.batteryPct, undefined);
    });
  });

  describe('Edge Cases', () => {
    it('should handle O₂ PSI of 0 (empty tank)', async () => {
      const log = await checkoutWith([tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', { oxygenPsi: 0 })]);
      assert.equal(log.checkEntries[0].assetCheckResult?.oxygenPsi, 0);
    });

    it('should handle checkout without O₂ items', async () => {
      const log = await checkoutWith([tank('aed-001', 'AED')]);
      assert.equal(log.checkEntries[0].assetCheckResult, undefined);
    });

    it('should handle undefined assetCheckResult', async () => {
      const log = await checkoutWith([tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', undefined)]);
      assert.equal(log.checkEntries[0].assetCheckResult, undefined);
    });
  });

  describe('Timestamp Handling', () => {
    it('should set both server and client timestamps', async () => {
      const log = await checkoutWith([tank('oxygen-tank-001', 'Oxygen Tank D-Cylinder', { oxygenPsi: 2000 })]);
      assert.ok(log.timestamp);
      // Firestore returns written Dates as Timestamps.
      assert.ok(log.clientTimestamp && typeof (log.clientTimestamp as { toDate?: unknown }).toDate === 'function');
      assert.ok(log.checkEntries[0].checkedAt);
    });
  });
});
