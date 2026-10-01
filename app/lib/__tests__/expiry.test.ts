/**
 * Expiry buckets, reorder cost this FY, and shrinkage (`app/lib/expiry.ts`).
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/expiry.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 * Fixtures use fake item names only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectExpiryEntries,
  bucketExpiries,
  expiryReport,
  reorderCostExpiringThisFY,
  shrinkage,
} from '../expiry';
import type { InventoryBatch, InventoryItem } from '@/app/types';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 8, 30, 12); // Sep 30 2026 -> FY27
const audited = new Date(2026, 8, 1);
const isAsset = (i: InventoryItem) => i.isAsset === true;
const base = { buckets: [30, 60, 90], isAsset, now };
const inDays = (n: number) => new Date(now.getTime() + n * DAY);

const lot = (id: string, units: number, exp: Date | undefined, pricePerUnit?: number): InventoryBatch =>
  ({
    id,
    stock: units,
    bagCount: 1,
    itemsPerBag: units,
    looseItems: 0,
    expirationDate: exp,
    purchase: pricePerUnit === undefined ? undefined : { pricePerUnit },
  }) as InventoryBatch;

const tomb = (id: string, exp: Date): InventoryBatch => ({ id, stock: 0, expirationDate: exp }) as InventoryBatch;

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: `Item ${id}`,
    category: 'Other',
    unopenedBoxes: 0,
    reorderThreshold: 5,
    location: 'HQ',
    tracksExpiration: true,
    lastAuditDate: audited,
    createdAt: audited,
    updatedAt: audited,
    ...extra,
  }) as unknown as InventoryItem;

const keysOf = (entries: { itemId: string; bucket: string }[]) => Object.fromEntries(entries.map((e) => [e.itemId, e.bucket]));

describe('lot buckets', () => {
  const items = [
    item('past', { batches: [lot('a', 10, inDays(-5))] }),
    item('d10', { batches: [lot('a', 10, inDays(10))] }),
    item('d30', { batches: [lot('a', 10, inDays(30))] }), // exactly on the cutoff -> <=30
    item('d31', { batches: [lot('a', 10, inDays(31))] }),
    item('d60', { batches: [lot('a', 10, inDays(60))] }),
    item('d85', { batches: [lot('a', 10, inDays(85))] }),
    item('d120', { batches: [lot('a', 10, inDays(120))] }),
  ];
  it('puts each lot in the right exclusive band', () => {
    const e = collectExpiryEntries(items, base);
    assert.deepEqual(keysOf(e), {
      past: 'expired', d10: 'd30', d30: 'd30', d31: 'd60', d60: 'd60', d85: 'd90', d120: 'beyond',
    });
  });
  it('bucketExpiries groups by band and labels them', () => {
    const rep = expiryReport(items, base);
    assert.deepEqual(rep.buckets.map((b) => b.key), ['expired', 'd30', 'd60', 'd90']);
    assert.deepEqual(rep.buckets.map((b) => b.entries.length), [1, 2, 2, 1]);
    assert.equal(rep.beyond, 1);
    assert.equal(rep.buckets[1].label, '≤ 30 days');
    assert.equal(rep.buckets[0].maxDays, null);
  });
  it('is sorted soonest first and reports daysLeft', () => {
    const e = collectExpiryEntries(items, base);
    assert.equal(e[0].itemId, 'past');
    assert.equal(e[1].daysLeft, 10);
    assert.ok(e[0].daysLeft <= 0);
  });
  it('honors configured bucket days (and sanitizes them)', () => {
    const e = collectExpiryEntries(items, { ...base, buckets: [45, 14, 14, 0] });
    assert.equal(keysOf(e).d10, 'd14');
    assert.equal(keysOf(e).d30, 'd45');
    assert.equal(keysOf(e).d60, 'beyond');
    assert.deepEqual(bucketExpiries(e, [45, 14]).map((b) => b.key), ['expired', 'd14', 'd45']);
  });
  it('ignores zero-stock tombstone lots (like getItemStatus)', () => {
    const e = collectExpiryEntries(
      [item('t', { batches: [tomb('x', inDays(-100)), tomb('y', inDays(5))] })],
      base,
    );
    assert.equal(e.length, 0);
  });
  it('only the stock-holding lots of a mixed item count', () => {
    const e = collectExpiryEntries(
      [item('m', { batches: [tomb('x', inDays(-100)), lot('y', 4, inDays(5))] })],
      base,
    );
    assert.deepEqual(e.map((x) => [x.lotId, x.units, x.bucket]), [['y', 4, 'd30']]);
  });
  it('an undated lot is skipped; item-level date is a fallback only with units and no stock lot', () => {
    assert.equal(collectExpiryEntries([item('u', { batches: [lot('a', 5, undefined)] })], base).length, 0);
    const fb = collectExpiryEntries([item('f', { unopenedBoxes: 3, itemsPerBox: 2, expirationDate: inDays(20) })], base);
    assert.deepEqual(fb.map((x) => [x.units, x.bucket]), [[6, 'd30']]);
    assert.equal(collectExpiryEntries([item('z', { unopenedBoxes: 0, expirationDate: inDays(20) })], base).length, 0);
  });
  it('confirmed items only by default; retired always dropped', () => {
    const unverified = item('v', { lastAuditDate: new Date(2026, 4, 31), batches: [lot('a', 5, inDays(5))] });
    const retired = item('r', { existence: 'retired', batches: [lot('a', 5, inDays(5))] });
    assert.equal(collectExpiryEntries([unverified, retired], base).length, 0);
    const all = collectExpiryEntries([unverified, retired], { ...base, confirmedOnly: false });
    assert.deepEqual(all.map((x) => x.itemId), ['v']);
  });
  it('carries a replacement unit cost from the latest lot, null when unknown', () => {
    const [priced] = collectExpiryEntries([item('p', { batches: [lot('a', 5, inDays(5), 2)] })], base);
    assert.equal(priced.replacementUnitCents, 200);
    const [unpriced] = collectExpiryEntries([item('q', { batches: [lot('a', 5, inDays(5))] })], base);
    assert.equal(unpriced.replacementUnitCents, null);
  });
});

describe('asset components (pads / batteries)', () => {
  const aed = (id: string, extra: Record<string, unknown> = {}) =>
    item(id, { isAsset: true, assetCategory: 'AED', name: `Unit ${id}`, tracksExpiration: false, ...extra });

  it('reads child component docs', () => {
    const items = [
      aed('p1'),
      item('c1', { isAsset: true, componentType: 'pads', parentAssetId: 'p1', name: 'Pads c1', expirationDate: inDays(50), assetValue: 45 }),
      item('c2', { isAsset: true, componentType: 'battery', parentAssetId: 'p1', name: 'Battery c2', expirationDate: inDays(-3) }),
    ];
    const e = collectExpiryEntries(items, base);
    assert.deepEqual(e.map((x) => [x.itemId, x.kind, x.componentType, x.parentItemId, x.bucket]), [
      ['c2', 'component', 'battery', 'p1', 'expired'],
      ['c1', 'component', 'pads', 'p1', 'd60'],
    ]);
    assert.equal(e[1].replacementUnitCents, 4500);
    assert.equal(e[0].replacementUnitCents, null);
  });
  it('reads serialized instance fields, one entry per instance', () => {
    const e = collectExpiryEntries(
      [aed('p2', { assets: [{ serial: 'S1', padExpiration: inDays(20), batteryExpiration: inDays(200) }, { serial: 'S2', padExpiration: inDays(80) }] })],
      base,
    );
    assert.deepEqual(e.map((x) => [x.serial, x.componentType, x.bucket]), [
      ['S1', 'pads', 'd30'],
      ['S2', 'pads', 'd90'],
      ['S1', 'battery', 'beyond'],
    ]);
  });
  it('falls back to the parent doc fields', () => {
    const e = collectExpiryEntries([aed('p3', { padExpiration: inDays(10), batteryExpiration: inDays(100) })], base);
    assert.deepEqual(e.map((x) => [x.componentType, x.bucket]), [['pads', 'd30'], ['battery', 'beyond']]);
  });
  it('counts a component once when recorded in several places (child doc wins)', () => {
    const items = [
      aed('p4', { batteryExpiration: inDays(10), assets: [{ serial: 'S1', batteryExpiration: inDays(11) }] }),
      item('c4', { isAsset: true, componentType: 'battery', parentAssetId: 'p4', expirationDate: inDays(12) }),
    ];
    const e = collectExpiryEntries(items, base).filter((x) => x.componentType === 'battery');
    assert.equal(e.length, 1);
    assert.equal(e[0].itemId, 'c4');
  });
  it('instances beat the parent field, per type independently', () => {
    const e = collectExpiryEntries(
      [aed('p5', { padExpiration: inDays(5), batteryExpiration: inDays(7), assets: [{ serial: 'S1', padExpiration: inDays(15) }] })],
      base,
    );
    const pads = e.filter((x) => x.componentType === 'pads');
    const bat = e.filter((x) => x.componentType === 'battery');
    assert.deepEqual(pads.map((x) => x.daysLeft), [15]);
    assert.deepEqual(bat.map((x) => x.daysLeft), [7]);
  });
  it('skips lost / retired assets and their lost instances; keeps orphan child docs', () => {
    const items = [
      aed('lost', { lifecycle: 'lost', padExpiration: inDays(5) }),
      aed('ok', { assets: [{ serial: 'A', padExpiration: inDays(5), lifecycle: 'retired' }, { serial: 'B', padExpiration: inDays(6) }] }),
      item('orphan', { isAsset: true, componentType: 'pads', parentAssetId: 'missing', expirationDate: inDays(9) }),
    ];
    const e = collectExpiryEntries(items, base);
    assert.deepEqual(e.map((x) => [x.itemId, x.serial ?? null]), [['ok', 'B'], ['orphan', null]]);
  });
  it('components are not gated on supply-audit confirmation', () => {
    const e = collectExpiryEntries([aed('p6', { lastAuditDate: undefined, padExpiration: inDays(10) })], base);
    assert.equal(e.length, 1);
  });
});

describe('reorderCostExpiringThisFY', () => {
  const fy27 = (entries: ReturnType<typeof collectExpiryEntries>) => reorderCostExpiringThisFY(entries, 2027, 7);
  it('prices lots expiring inside FY27 at the latest unit cost; excludes outside the range', () => {
    const items = [
      item('in1', { batches: [lot('a', 10, new Date(2027, 0, 15), 1.5)] }), // 10 x 150
      item('in2', { batches: [lot('a', 4, new Date(2026, 9, 1), 0.25)] }), // 4 x 25
      item('prevFY', { batches: [lot('a', 10, new Date(2026, 5, 30), 9)] }),
      item('nextFY', { batches: [lot('a', 10, new Date(2027, 6, 1), 9)] }),
    ];
    const r = fy27(collectExpiryEntries(items, base));
    assert.equal(r.cents, 1500 + 100);
    assert.equal(r.lines.length, 2);
    assert.equal(r.noCostCount, 0);
    assert.ok(Number.isInteger(r.cents));
  });
  it('an unpriced lot is counted as no cost, not $0', () => {
    const r = fy27(
      collectExpiryEntries(
        [
          item('priced', { batches: [lot('a', 2, new Date(2027, 1, 1), 1)] }),
          item('unpriced', { batches: [lot('a', 2, new Date(2027, 1, 1))] }),
        ],
        base,
      ),
    );
    assert.equal(r.cents, 200);
    assert.equal(r.noCostCount, 1);
    assert.equal(r.lines.find((l) => l.entry.itemId === 'unpriced')?.cents, null);
  });
  it('includes component replacement when the child doc has a cost', () => {
    const items = [
      item('par', { isAsset: true, assetCategory: 'AED' }),
      item('kid', { isAsset: true, componentType: 'pads', parentAssetId: 'par', expirationDate: new Date(2027, 2, 1), assetValue: 60 }),
    ];
    const r = fy27(collectExpiryEntries(items, base));
    assert.equal(r.cents, 6000);
  });
  it('follows the fiscal start month passed in', () => {
    const entries = collectExpiryEntries([item('x', { batches: [lot('a', 1, new Date(2026, 11, 15), 1)] })], base);
    assert.equal(reorderCostExpiringThisFY(entries, 2027, 7).cents, 100); // Dec 2026 is FY27 (Jul start)
    assert.equal(reorderCostExpiringThisFY(entries, 2027, 1).cents, 0); // calendar FY27 starts Jan 2027
  });
});

describe('shrinkage', () => {
  const at = (y: number, m: number, d = 10) => new Date(y, m - 1, d);
  const asset = (id: string, extra: Record<string, unknown> = {}) =>
    item(id, { isAsset: true, name: `Unit ${id}`, ...extra });
  const hist = (...steps: Array<[string, string, Date]>) => steps.map(([from, to, when]) => ({ from, to, at: when }));
  const run = (items: InventoryItem[]) => shrinkage(items, 2027, 7);

  it('counts assets that moved to lost/damaged/retired in the FY at original cost', () => {
    const r = run([
      asset('lostIn', { lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 10)]), acquisitionCostCents: 120000 }),
      asset('dmgIn', { lifecycle: 'damaged', lifecycleHistory: hist(['active', 'damaged', at(2027, 3)]), assetValue: 250.5 }),
      asset('retIn', { lifecycle: 'retired', lifecycleHistory: hist(['active', 'retired', at(2027, 6, 30)]), acquisitionCostCents: 5000 }),
    ]);
    assert.equal(r.events.length, 3);
    assert.equal(r.totalCents, 120000 + 25050 + 5000);
    assert.deepEqual(r.events.map((e) => e.lifecycle), ['lost', 'damaged', 'retired']);
  });
  it('excludes moves outside the FY and assets never lost', () => {
    const r = run([
      asset('before', { lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 6, 30)]), acquisitionCostCents: 1000 }),
      asset('after', { lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2027, 7, 1)]), acquisitionCostCents: 1000 }),
      asset('fine', { acquisitionCostCents: 1000 }),
      asset('loan', { lifecycle: 'loaned_out', lifecycleHistory: hist(['active', 'loaned_out', at(2026, 10)]) }),
    ]);
    assert.equal(r.events.length, 0);
    assert.equal(r.totalCents, 0);
  });
  it('a recovered asset is not shrinkage', () => {
    const r = run([
      asset('found', {
        lifecycle: 'active',
        lifecycleHistory: hist(['active', 'lost', at(2026, 9)], ['lost', 'active', at(2026, 10)]),
        acquisitionCostCents: 1000,
      }),
    ]);
    assert.equal(r.events.length, 0);
  });
  it('damaged then retired is one loss, dated when first damaged', () => {
    const r = run([
      asset('chain', {
        lifecycle: 'retired',
        lifecycleHistory: hist(['active', 'damaged', at(2026, 8)], ['damaged', 'retired', at(2027, 8)]),
        acquisitionCostCents: 7000,
      }),
    ]);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].at.getMonth(), 7);
    assert.equal(r.events[0].at.getFullYear(), 2026);
    assert.equal(shrinkage([asset('chain', { lifecycle: 'retired', lifecycleHistory: hist(['active', 'damaged', at(2026, 8)], ['damaged', 'retired', at(2027, 8)]), acquisitionCostCents: 7000 })], 2028, 7).events.length, 0);
  });
  it('unknown cost is null and counted, never $0', () => {
    const r = run([
      asset('nocost', { lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 10)]) }),
      asset('cost', { lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 11)]), acquisitionCostCents: 900 }),
    ]);
    assert.equal(r.totalCents, 900);
    assert.equal(r.noCostCount, 1);
    assert.equal(r.events.find((e) => e.itemId === 'nocost')?.costCents, null);
  });
  it('counts serialized instances individually and does not double count the doc', () => {
    const r = run([
      asset('aeds', {
        acquisitionCostCents: 100000,
        lifecycle: 'damaged',
        lifecycleHistory: hist(['active', 'damaged', at(2026, 10)]),
        assets: [
          { serial: 'A', lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 10)]) },
          { serial: 'B', lifecycle: 'damaged', acquisitionCostCents: 90000, lifecycleHistory: hist(['active', 'damaged', at(2027, 1)]) },
          { serial: 'C' },
        ],
      }),
    ]);
    assert.deepEqual(r.events.map((e) => [e.serial, e.costCents]), [['A', 100000], ['B', 90000]]);
    assert.equal(r.totalCents, 190000);
  });
  it('drops existence-retired records', () => {
    const r = run([asset('ghost', { existence: 'retired', lifecycle: 'lost', lifecycleHistory: hist(['active', 'lost', at(2026, 10)]), acquisitionCostCents: 1000 })]);
    assert.equal(r.events.length, 0);
  });
});
