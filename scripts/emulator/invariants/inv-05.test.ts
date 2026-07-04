/**
 * INV-5 — FEFO: consumption draws from the earliest-expiring available lot
 * first, spilling to the next only when it is exhausted.
 *
 * Seed: epi lot B (exp +120d, stock 6) is earlier than lot A (exp +240d,
 * stock 10). Requesting 10 units must leave B=0 then A=6, i.e. draw 6 from B
 * then 4 from A.
 *
 * Real path: app/lib/inventory.ts → consumeSku (the FEFO lot-consume primitive).
 * Also asserts the never-negative refusal: over-drawing must throw, not underflow.
 */
import { defineInvariant, getInventory, IDS } from '../harness';
import { consumeSku } from '@/app/lib/inventory';

defineInvariant('INV-5', 'FEFO draws earliest-expiring lot first', async (t) => {
  const before = await getInventory(IDS.epi);
  const lotB = before.batches.find((b: any) => b.id === IDS.epiLotB);
  const lotA = before.batches.find((b: any) => b.id === IDS.epiLotA);
  t.note(`lot B exp ${lotB.expirationDate} stock ${lotB.stock}; lot A exp ${lotA.expirationDate} stock ${lotA.stock}`);

  await t.resolves(
    consumeSku({ itemId: IDS.epi, quantity: 10, actor: { uid: 'member-1', name: 'Morgan' } }),
    'consumeSku draws 10 units FEFO across lots',
  );

  const after = await getInventory(IDS.epi);
  const bAfter = after.batches.find((b: any) => b.id === IDS.epiLotB);
  const aAfter = after.batches.find((b: any) => b.id === IDS.epiLotA);
  t.ok(bAfter.stock === 0, 'earliest-expiring lot B fully drawn to 0 after requesting 10',
    `lot B stock is ${bAfter.stock} (expected 0 — FEFO must exhaust the earlier lot first)`);
  t.ok(aAfter.stock === 6, 'lot A spilled to 6 (10 − 4) after B exhausted',
    `lot A stock is ${aAfter.stock} (expected 6 — later lot must only cover the remainder)`);

  // Never-negative: only 6 units remain (all in lot A); requesting 7 must be REFUSED.
  await t.rejects(
    consumeSku({ itemId: IDS.epi, quantity: 7, actor: { uid: 'member-1', name: 'Morgan' } }),
    'over-drawing beyond available stock is refused (stock never goes negative)',
  );
});
