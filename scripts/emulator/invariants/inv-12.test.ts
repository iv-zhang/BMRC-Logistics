/**
 * INV-12 — Every physical unit maps to exactly one valid location; a scan to an
 * UNKNOWN location code is rejected, not silently created.
 *
 * Real path: app/lib/audit-actions.ts → moveItemLocation. It resolves the
 * destination zone by id; if the zone doc does not exist it silently proceeds
 * and writes the bogus ref rather than rejecting (MODEL.md INV-12). Expected
 * FAIL: the phantom location is accepted.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { moveItemLocation } from '@/app/lib/audit-actions';

const BOGUS_ZONE = 'STA-Z9-99-does-not-exist';

defineInvariant('INV-12', 'Scan to an unknown location code is rejected', async (t) => {
  const gauze = await getInventory(IDS.gauze);

  await t.rejects(
    moveItemLocation(gauze, { storageLocation: { zoneId: BOGUS_ZONE, zoneName: 'STA-Z9-99' } },
      { uid: 'member-1', name: 'Morgan' }),
    'moving an item to a non-existent zone/location code is refused',
  );

  const after = await getInventory(IDS.gauze);
  t.ok(after.storageLocation?.zoneId !== BOGUS_ZONE,
    'the bogus location was NOT persisted onto the item',
    `item.storageLocation.zoneId is now '${after.storageLocation?.zoneId}' — phantom location created`);
});
