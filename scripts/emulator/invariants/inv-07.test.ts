/**
 * INV-7 — Marking a lot recalled quarantines it in EVERY location at once and
 * flips any Statpack containing it to not-service-ready.
 *
 * Seed: epi-lot-A is held in inventory (HQ reserve) and referenced by MRC1 and
 * MRC2. `recallLot` (app/lib/recall.ts) is the single cascade action: it
 * quarantines the batch AND flips every pack that carries the lot.
 * Real reads: getItemStatus / computeBagStock; pack.status.
 */
import { defineInvariant, getInventory, getPack, IDS } from '../harness';
import { computeBagStock, getItemStatus } from '@/app/lib/item-status';
import { recallLot } from '@/app/lib/recall';

defineInvariant('INV-7', 'Recall quarantines a lot everywhere + flips packs', async (t) => {
  const res = await recallLot({
    itemId: IDS.epi,
    batchId: IDS.epiLotA,
    actor: { uid: 'admin-1', name: 'Quinn', email: 'qm@bmrc.test' },
  });
  t.ok(res.quarantined && res.packsFlipped.length === 2,
    'a single recall action cascades across the packs holding the lot',
    `quarantined=${res.quarantined}, packsFlipped=${JSON.stringify(res.packsFlipped)}`);

  const after = await getInventory(IDS.epi);
  const avail = computeBagStock(after).availableItems;
  t.ok(avail === 6, 'quarantined lot A (10 units) is excluded from available quantity',
    `available is ${avail}; quarantined stock still counted (expected 6 — only lot B)`);
  t.ok(getItemStatus(after) !== 'ok', 'a quarantined lot makes item status non-ok',
    `getItemStatus returned '${getItemStatus(after)}' (must not be 'ok')`);

  // Cascade to the two packs that carry lot A.
  for (const packId of [IDS.packMRC1, IDS.packMRC2]) {
    const pack = await getPack(packId);
    t.ok(pack.status !== 'Ready',
      `${packId} flipped to not-service-ready after the recall`,
      `${packId}.status is still '${pack.status}' — recall did not cascade`);
  }
});
