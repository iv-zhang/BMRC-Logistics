/**
 * INV-2 — Sum of a SKU's lot quantities equals its reported total on-hand.
 * Real path: app/lib/item-status.ts → computeBagStock.
 * Expectation: holds for bag-tracked (epi); BREAKS for box-tracked (gauze),
 * whose lots are stock:0 tombstones (see MODEL.md B-5).
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { computeBagStock } from '@/app/lib/item-status';

defineInvariant('INV-2', 'Lot-sum equals total on-hand', async (t) => {
  // Bag-tracked epi: batch stock should equal computed total.
  const epi = await getInventory(IDS.epi);
  const epiLotSum = epi.batches.reduce((s: number, b: any) => s + (b.stock ?? 0), 0);
  const epiTotal = computeBagStock(epi).totalItems;
  t.equal(epiTotal, epiLotSum, `epi: computeBagStock total (${epiTotal}) == Σ lot stock (${epiLotSum})`);

  // Box-tracked gauze: on-hand lives on unopenedBoxes; lots carry no quantity.
  const gauze = await getInventory(IDS.gauze);
  const gauzeLotSum = (gauze.batches ?? []).reduce((s: number, b: any) => s + (b.stock ?? 0), 0);
  const gauzeTotal = computeBagStock(gauze).totalItems;
  t.equal(gauzeTotal, gauzeLotSum,
    `gauze: computeBagStock total (${gauzeTotal}) == Σ lot stock (${gauzeLotSum})`);
});
