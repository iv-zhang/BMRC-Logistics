/**
 * Supplies-on-hand valuation and equipment register (`app/lib/valuation.ts`).
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/valuation.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 * Fixtures use fake item names only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  valueItem,
  valueSuppliesOnHand,
  buildEquipmentRegister,
  latestUnitCost,
  lotUnits,
} from '../valuation';
import { computeBagStock } from '../item-status';
import type { InventoryBatch, InventoryItem } from '@/app/types';

const now = new Date(2026, 8, 30, 12);
const audited = new Date(2026, 8, 1); // after the 2026-06-01 baseline -> confirmed
const isAsset = (i: InventoryItem) => i.isAsset === true;
const opts = { isAsset, now };

const lot = (id: string, bags: number, perBag: number, loose: number, pricePerUnit?: number, receivedAt?: Date): InventoryBatch =>
  ({
    id,
    stock: bags * perBag + loose,
    bagCount: bags,
    itemsPerBag: perBag,
    looseItems: loose,
    receivedAt,
    purchase: pricePerUnit === undefined ? undefined : { pricePerUnit },
  }) as InventoryBatch;

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Item ${id}`,
    category: 'Other',
    unopenedBoxes: 0,
    reorderThreshold: 5,
    location: 'HQ',
    tracksExpiration: false,
    lastAuditDate: audited,
    createdAt: audited,
    updatedAt: audited,
    ...extra,
  }) as unknown as InventoryItem;

describe('bag-tracked reserve: each lot at its own cost', () => {
  const it1 = item('gauze', {
    batches: [lot('a', 3, 10, 0, 0.5, new Date(2026, 0, 5)), lot('b', 1, 10, 5, 0.62, new Date(2026, 5, 5))],
  });
  it('sums lot units x lot price, in integer cents', () => {
    const v = valueItem(it1, now);
    assert.equal(v.reserveUnits, 45);
    assert.equal(v.reserveCents, 30 * 50 + 15 * 62); // 1500 + 930
    assert.equal(v.totalCents, 2430);
    assert.equal(v.method, 'lots');
    assert.equal(v.estimated, false);
    assert.equal(v.unpricedUnits, 0);
    assert.ok(Number.isInteger(v.totalCents));
  });
  it('per-lot units agree with computeBagStock.totalItems', () => {
    const sum = (it1.batches ?? []).reduce((s, b) => s + lotUnits(b), 0);
    assert.equal(sum, computeBagStock(it1, now).totalItems);
  });
  it('rounds a fractional unit cost once per lot total, not per unit', () => {
    const w = valueItem(item('y', { batches: [lot('a', 1, 7, 0, 0.0833)] }), now);
    assert.equal(w.reserveCents, Math.round(7 * 8.33)); // 58
  });
  it('an unpriced lot is not valued at $0: its units are reported unpriced', () => {
    const v = valueItem(item('z', { batches: [lot('a', 2, 10, 0, 1), lot('b', 1, 10, 0)] }), now);
    assert.equal(v.reserveCents, 2000);
    assert.equal(v.unpricedUnits, 10);
  });
  it('values expired lots too (still physically on hand)', () => {
    const expired = { ...lot('a', 1, 10, 0, 1), expirationDate: new Date(2026, 0, 1) } as InventoryBatch;
    assert.equal(valueItem(item('e', { batches: [expired] }), now).reserveCents, 1000);
  });
});

describe('shelf pool', () => {
  it('is valued at the latest lot cost and flagged estimated', () => {
    const v = valueItem(
      item('s', {
        shelfQuantity: 20,
        batches: [lot('old', 1, 10, 0, 0.4, new Date(2026, 0, 1)), lot('new', 1, 10, 0, 0.5, new Date(2026, 6, 1))],
      }),
      now,
    );
    assert.equal(v.shelfCents, 1000); // 20 x 50c: latest = the July lot
    assert.equal(v.reserveCents, 10 * 40 + 10 * 50);
    assert.equal(v.totalCents, 1900);
    assert.equal(v.estimated, true);
  });
  it('falls back to itemValue, and is null (not 0) with no cost at all', () => {
    assert.equal(valueItem(item('a', { shelfQuantity: 10, itemValue: 0.25 }), now).shelfCents, 250);
    const none = valueItem(item('b', { shelfQuantity: 10 }), now);
    assert.equal(none.shelfCents, null);
    assert.equal(none.totalCents, null);
    assert.equal(none.unpricedUnits, 10);
  });
  it('latestUnitCost ties break to the later lot; ignores unpriced and zero prices', () => {
    const c = latestUnitCost({ batches: [lot('a', 1, 1, 0, 0.1), lot('b', 1, 1, 0, 0.2), lot('c', 1, 1, 0, 0)] } as never);
    assert.deepEqual(c, { unitCents: 20, source: 'lot' });
    assert.equal(latestUnitCost({ batches: [lot('a', 1, 1, 0)] } as never), null);
  });
});

describe('box-tracked reserve (D-11/D-12 gap): estimated at latest cost', () => {
  const tomb = (id: string, price: number, at: Date) =>
    ({ id, stock: 0, receivedAt: at, purchase: { pricePerUnit: price } }) as unknown as InventoryBatch;
  it('values pooled on-hand units at the latest priced lot, flagged estimated', () => {
    const v = valueItem(
      item('box', {
        unopenedBoxes: 4,
        itemsPerBox: 10,
        looseUnits: 3,
        batches: [tomb('t1', 1, new Date(2026, 0, 1)), tomb('t2', 2, new Date(2026, 6, 1))],
      }),
      now,
    );
    assert.equal(v.reserveUnits, 43);
    assert.equal(v.reserveCents, 43 * 200);
    assert.equal(v.method, 'latest_lot_estimate');
    assert.equal(v.estimated, true);
  });
  it('no price anywhere: null and counted as no cost', () => {
    const r = valueSuppliesOnHand([item('box', { unopenedBoxes: 4, itemsPerBox: 10 })], opts);
    assert.equal(r.valuedCents, 0);
    assert.equal(r.itemsNoCost, 1);
    assert.equal(r.items[0].totalCents, null);
  });
});

describe('valueSuppliesOnHand', () => {
  const priced = item('p', { batches: [lot('a', 1, 10, 0, 1)] }); // 1000c
  const unpriced = item('u', { batches: [lot('a', 1, 10, 0)] });
  it('reports valued cents and the count of items with no cost', () => {
    const r = valueSuppliesOnHand([priced, unpriced], opts);
    assert.equal(r.valuedCents, 1000);
    assert.equal(r.itemsValued, 1);
    assert.equal(r.itemsNoCost, 1);
    assert.equal(r.itemsConsidered, 2);
  });
  it('confirmed items only; assets, components and retired records are excluded', () => {
    const unverified = item('v', { lastAuditDate: new Date(2026, 4, 31), batches: [lot('a', 1, 10, 0, 1)] });
    const retired = item('r', { existence: 'retired', batches: [lot('a', 1, 10, 0, 1)] });
    const asset = item('as', { isAsset: true, batches: [lot('a', 1, 10, 0, 1)] });
    const comp = item('c', { componentType: 'pads', parentAssetId: 'x', batches: [lot('a', 1, 10, 0, 1)] });
    const r = valueSuppliesOnHand([priced, unverified, retired, asset, comp], opts);
    assert.equal(r.valuedCents, 1000);
    assert.equal(r.itemsExcluded, 4);
  });
  it('an item with nothing on hand is neither valued nor "no cost"', () => {
    const r = valueSuppliesOnHand([item('empty', { batches: [lot('a', 0, 10, 0)] })], opts);
    assert.equal(r.itemsConsidered, 0);
    assert.equal(r.itemsNoCost, 0);
  });
  it('totals are integers and the estimated share is tracked', () => {
    const withShelf = item('sh', { shelfQuantity: 3, batches: [lot('a', 1, 10, 0, 0.333)] });
    const r = valueSuppliesOnHand([withShelf, priced], opts);
    assert.ok(Number.isInteger(r.valuedCents));
    assert.equal(r.estimatedCents, Math.round(3 * 33.3));
    assert.equal(r.items.find((x) => x.itemId === 'sh')?.estimated, true);
  });
  it('flags a partially costed item (lower bound)', () => {
    const r = valueSuppliesOnHand([item('part', { batches: [lot('a', 1, 10, 0, 1), lot('b', 1, 10, 0)] })], opts);
    assert.equal(r.itemsPartial, 1);
    assert.equal(r.valuedCents, 1000);
  });
});

describe('buildEquipmentRegister', () => {
  const asset = (id: string, extra: Record<string, unknown> = {}) =>
    item(id, { isAsset: true, name: `Unit ${id}`, assetCategory: 'AED', ...extra });
  const reg = (items: InventoryItem[]) =>
    buildEquipmentRegister(items, { isAsset, assetValueThresholdDollars: 500 });

  it('workbook shape: Item, Category, Owner, Qty (+ cost and capitalized)', () => {
    const [row] = reg([asset('a', { owner: 'BMRC', acquisitionCostCents: 120000, assets: [{ serial: '1' }, { serial: '2' }, { serial: '3' }] })]);
    assert.equal(row.item, 'Unit a');
    assert.equal(row.category, 'AED');
    assert.equal(row.owner, 'BMRC');
    assert.equal(row.qty, 3);
    assert.equal(row.unitCostCents, 120000);
    assert.equal(row.totalCostCents, 360000);
    assert.equal(row.capitalized, true);
  });
  it('capitalized needs BMRC ownership AND cost >= threshold (boundary inclusive)', () => {
    const rows = reg([
      asset('at', { owner: 'BMRC', acquisitionCostCents: 50000 }),
      asset('under', { owner: 'BMRC', acquisitionCostCents: 49999 }),
      asset('oem', { owner: 'OEM', acquisitionCostCents: 900000 }),
      asset('ucpd', { owner: 'ucpd', acquisitionCostCents: 100 }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.itemId, r.capitalized]));
    assert.deepEqual(by, { at: true, under: false, oem: false, ucpd: false });
  });
  it('unknown owner or unknown cost is null, never assumed', () => {
    const rows = reg([asset('noowner', { acquisitionCostCents: 90000 }), asset('nocost', { owner: 'BMRC' })]);
    const by = Object.fromEntries(rows.map((r) => [r.itemId, r]));
    assert.equal(by.noowner.owner, null);
    assert.equal(by.noowner.capitalized, null);
    assert.equal(by.nocost.capitalized, null);
    assert.equal(by.nocost.unitCostCents, null);
    assert.equal(by.nocost.totalCostCents, null);
  });
  it('falls back to legacy assetValue dollars for cost', () => {
    const [row] = reg([asset('legacy', { owner: 'BMRC', assetValue: 1299.99 })]);
    assert.equal(row.unitCostCents, 129999);
    assert.equal(row.costSource, 'assetValue');
    assert.equal(row.capitalized, true);
  });
  it('excludes components, retired records, lost/retired lifecycle, and non-assets; keeps damaged', () => {
    const rows = reg([
      asset('keep'),
      asset('dmg', { lifecycle: 'damaged' }),
      asset('lost', { lifecycle: 'lost' }),
      asset('ret', { lifecycle: 'retired' }),
      asset('gone', { existence: 'retired' }),
      asset('batt', { componentType: 'battery', parentAssetId: 'keep' }),
      item('supply'),
    ]);
    assert.deepEqual(rows.map((r) => r.itemId).sort(), ['dmg', 'keep']);
    assert.equal(rows.find((r) => r.itemId === 'dmg')?.lifecycle, 'damaged');
  });
  it('instances that are lost/retired do not count toward qty; all gone drops the row', () => {
    const rows = reg([
      asset('some', { assets: [{ serial: '1' }, { serial: '2', lifecycle: 'lost' }] }),
      asset('none', { assets: [{ serial: '1', lifecycle: 'retired' }] }),
    ]);
    assert.deepEqual(rows.map((r) => [r.itemId, r.qty]), [['some', 1]]);
  });
  it('sorted by category then item', () => {
    const rows = reg([
      asset('b', { name: 'Zeta', assetCategory: 'Manikin' }),
      asset('a', { name: 'Beta', assetCategory: 'AED' }),
      asset('c', { name: 'Alpha', assetCategory: 'AED' }),
    ]);
    assert.deepEqual(rows.map((r) => r.item), ['Alpha', 'Beta', 'Zeta']);
  });
});
