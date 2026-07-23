/**
 * INV-13 — `consumeReserveUnits` (the reserve-pool draw primitive behind
 * `refillShelf`, `app/lib/stock-pools.ts`) is FEFO for bag-tracked items,
 * draws loose units before breaking a bag/box, and clamps instead of
 * over-drawing when the reserve pool has less than requested.
 *
 * This is the core transfer logic for the front-shelf/back-reserve two-pool
 * model and was previously untested. Pure function — no Firestore writes —
 * so fixtures are constructed directly rather than pulled from the seed.
 */
import { defineInvariant } from '../harness';
import { consumeReserveUnits } from '@/app/lib/stock-pools';
import type { InventoryItem } from '@/app/types';

function bagItem(batches: Array<Record<string, unknown>>): InventoryItem {
  return { id: 'fixture', name: 'Fixture', batches } as unknown as InventoryItem;
}

function boxItem(fields: Record<string, unknown>): InventoryItem {
  return { id: 'fixture', name: 'Fixture', batches: [], ...fields } as unknown as InventoryItem;
}

defineInvariant('INV-13', 'consumeReserveUnits: FEFO, loose-before-bag, box-breaking, clamping', async (t) => {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 86400000);
  const later = new Date(now.getTime() + 120 * 86400000);

  // ── FEFO across bag-tracked batches ─────────────────────────────────────
  {
    const item = bagItem([
      { id: 'lotLater', expirationDate: later, bagCount: 10, itemsPerBag: 1, looseItems: 0 },
      { id: 'lotSoon', expirationDate: soon, bagCount: 6, itemsPerBag: 1, looseItems: 0 },
    ]);
    const { patch, consumed } = consumeReserveUnits(item, 10);
    t.ok(consumed === 10, 'FEFO: consumes the full request when reserve covers it', `consumed ${consumed}`);
    const batches = (patch as { batches: Array<{ id: string; bagCount: number; looseItems: number }> }).batches;
    const soonLot = batches.find(b => b.id === 'lotSoon')!;
    const laterLot = batches.find(b => b.id === 'lotLater')!;
    t.ok(soonLot.bagCount === 0, 'earliest-expiring lot is drawn down first (fully exhausted)', `lotSoon bagCount ${soonLot.bagCount}`);
    t.ok(laterLot.bagCount === 6, 'later-expiring lot only covers the remainder (10 requested − 6 from soon lot = 4 drawn, 10−4=6 left)', `lotLater bagCount ${laterLot.bagCount}`);
  }

  // ── Loose units consumed before breaking a bag ──────────────────────────
  {
    const item = bagItem([
      { id: 'lot1', expirationDate: later, bagCount: 2, itemsPerBag: 10, looseItems: 3 },
    ]);
    const { patch, consumed } = consumeReserveUnits(item, 5);
    t.ok(consumed === 5, 'loose-before-bag: full request satisfied', `consumed ${consumed}`);
    const lot = (patch as { batches: Array<{ looseItems: number; bagCount: number }> }).batches[0];
    // 3 loose used first, remaining 2 comes from breaking ONE bag of 10 —
    // the other 8 units of that broken bag stay loose, not discarded.
    t.equal(lot.bagCount, 1, 'exactly one bag was broken to cover the remainder');
    t.equal(lot.looseItems, 8, 'leftover units from the broken bag land back in looseItems (3 loose consumed, 8 remain from the broken bag)');
  }

  // ── Box-breaking (box/loose tracked item) ───────────────────────────────
  {
    const item = boxItem({ unopenedBoxes: 3, itemsPerBox: 200, looseUnits: 0 });
    const { patch, consumed } = consumeReserveUnits(item, 250);
    t.ok(consumed === 250, 'box-breaking: full request satisfied across two broken boxes', `consumed ${consumed}`);
    const p = patch as { unopenedBoxes: number; looseUnits: number };
    t.equal(p.unopenedBoxes, 1, 'two boxes broken (3 → 1 unopened) to cover 250 units');
    t.equal(p.looseUnits, 150, 'leftover from the two broken boxes (400 − 250) lands in looseUnits');
  }

  // ── Clamping: requesting more than reserve has ──────────────────────────
  {
    const item = boxItem({ unopenedBoxes: 0, itemsPerBox: 200, looseUnits: 3 });
    const { patch, consumed } = consumeReserveUnits(item, 5);
    t.ok(consumed === 3, 'clamped to what reserve actually has (3), not the 5 requested', `consumed ${consumed}`);
    const p = patch as { unopenedBoxes: number; looseUnits: number };
    t.equal(p.looseUnits, 0, 'looseUnits drawn to 0, never negative');
    t.equal(p.unopenedBoxes, 0, 'unopenedBoxes untouched (none available to break)');
  }

  // ── Expired/quarantined batches are skipped entirely ────────────────────
  {
    const expired = new Date(now.getTime() - 10 * 86400000);
    const item = bagItem([
      { id: 'expiredLot', expirationDate: expired, bagCount: 5, itemsPerBag: 1, looseItems: 0 },
      { id: 'quarantinedLot', expirationDate: later, status: 'quarantined', bagCount: 5, itemsPerBag: 1, looseItems: 0 },
      { id: 'goodLot', expirationDate: later, bagCount: 5, itemsPerBag: 1, looseItems: 0 },
    ]);
    const { patch, consumed } = consumeReserveUnits(item, 5);
    t.ok(consumed === 5, 'draws only from the available (non-expired, non-quarantined) lot', `consumed ${consumed}`);
    const batches = (patch as { batches: Array<{ id: string; bagCount: number }> }).batches;
    t.equal(batches.find(b => b.id === 'expiredLot')!.bagCount, 5, 'expired lot is left untouched');
    t.equal(batches.find(b => b.id === 'quarantinedLot')!.bagCount, 5, 'quarantined lot is left untouched');
    t.equal(batches.find(b => b.id === 'goodLot')!.bagCount, 0, 'the only available lot is the one actually drawn from');
  }
});
