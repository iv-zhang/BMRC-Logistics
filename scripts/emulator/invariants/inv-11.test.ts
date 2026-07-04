/**
 * INV-11 — Epi and narcan cannot be received or dispensed without a LAF on
 * file; every receipt/dispense writes an immutable log entry.
 *
 * The app has no LAF gate (BLOCKER B-3). We remove the LAF record and attempt
 * to receive epi via the real addShipment path. Expected: receipt should be
 * refused (FAIL — it is not), but an immutable inventory_logs entry IS written
 * (PASS — the logging half exists).
 */
import { defineInvariant, getInventory, db, IDS } from '../harness';
import { doc, deleteDoc, getDocs, query, collection, where } from 'firebase/firestore';
import { addShipment } from '@/app/lib/audit-actions';

defineInvariant('INV-11', 'Controlled receipt is LAF-gated and logged', async (t) => {
  // Immutable-log half: an AUTHORIZED receipt (LAF on file) writes an intake
  // log entry. Do this while the LAF still stands.
  const epiWithLaf = await getInventory(IDS.epi);
  await addShipment(epiWithLaf, { qty: 1, perUnit: 1, lotNumber: 'BT-EPI-AUTH', expirationMonth: '2028-06', supplier: 'Bound Tree' },
    { uid: 'fto-1', name: 'Frankie FTO' });
  t.note('authorized receipt logged while LAF on file');

  // Remove the epi LAF record — there is now no authorization on file.
  await deleteDoc(doc(db, 'laf_records', IDS.lafEpi));
  t.note('deleted LAF-2026-EPI-001 — epi now has no LAF on file');

  const epi = await getInventory(IDS.epi);
  await t.rejects(
    addShipment(epi, { qty: 2, perUnit: 1, lotNumber: 'BT-EPI-NOLAF', expirationMonth: '2028-06', supplier: 'Bound Tree' },
      { uid: 'fto-1', name: 'Frankie FTO' }),
    'receiving epi with NO LAF on file is refused',
  );

  // The immutable-log half: an intake log row must exist for the receipt.
  const logs = await getDocs(query(
    collection(db, 'inventory_logs'),
    where('itemId', '==', IDS.epi),
    where('action', '==', 'intake'),
  ));
  t.ok(logs.size >= 1, 'every receipt writes an immutable inventory_logs entry', `found ${logs.size} intake logs`);
});
