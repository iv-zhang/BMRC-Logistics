/** Pure count-plan regression cases. Run with node --import tsx. */
import assert from 'node:assert/strict';
import type { InventoryItem } from '../app/types';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
// Guard executes before importing any application Firebase clients.
await import('./emulator/guard');
const { buildAuditCountPlan } = await import('../app/lib/audit-count');
const { computeBagStock } = await import('../app/lib/item-status');
const base = {
  id: 'audit-count-test', name: 'OPA', category: 'Airway',
  unopenedBoxes: 0, looseUnits: 0, reorderThreshold: 0, location: 'HQ',
  batches: [], tracksExpiration: false, createdAt: new Date(), updatedAt: new Date(),
} as InventoryItem;

for (const [name, quantity] of [['OPA', 12], ['Splints', 6], ['Cold packs', 60]] as const) {
  const item = { ...base, name };
  const plan = buildAuditCountPlan(item, { countedBoxes: 0, countedLooseUnits: quantity });
  assert.equal(plan.total, quantity);
  assert.equal(plan.patch.looseUnits, quantity);
  assert.equal(plan.patch.totalStockQuantity, quantity);
  assert.equal(plan.verified, false);
  assert.equal('itemsPerBox' in plan.patch, false);
  assert.equal(computeBagStock({ ...item, ...plan.patch }).totalItems, quantity);
}
assert.equal(computeBagStock({ ...base, looseUnits: 12 }).totalItems, 12);
const bagItem = { ...base, itemsPerBox: 10, batches: [{ id: 'lot-a', bagCount: 1, itemsPerBag: 10, looseItems: 0, stock: 10 }] };
const bagPlan = buildAuditCountPlan(bagItem, { countedBoxes: 2, countedLooseUnits: 7 });
assert.equal(bagPlan.total, 27);
assert.equal(computeBagStock({ ...bagItem, ...bagPlan.patch }).totalItems, 27);
assert.equal(bagPlan.patch.totalStockQuantity, 27);
const zero = buildAuditCountPlan(base, { countedBoxes: 0, countedLooseUnits: 0 });
assert.equal(zero.total, 0);
assert.equal(zero.verified, true);
for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => buildAuditCountPlan(base, { countedLooseUnits: value }));
  assert.throws(() => buildAuditCountPlan(base, { countedBoxes: value }));
}
assert.throws(() => buildAuditCountPlan(base, { itemsPerBox: 0 }));
const multiple = { ...bagItem, batches: [...bagItem.batches, { id: 'lot-b', bagCount: 1, itemsPerBag: 10, stock: 10 }] };
const ambiguous = buildAuditCountPlan(multiple, { countedBoxes: 2, countedLooseUnits: 7 });
assert.equal(ambiguous.unresolved, true);
assert.deepEqual(ambiguous.patch, {});
assert.equal(ambiguous.verified, false);
const unknown = buildAuditCountPlan({ ...base, unopenedBoxes: 2 }, { countedBoxes: 2, countedLooseUnits: 7 });
assert.equal(unknown.total, null);
assert.equal(unknown.unresolved, true);
assert.deepEqual(unknown.patch, {});
// Partial legacy package counts preserve previously recorded loose units.
assert.equal(buildAuditCountPlan({ ...base, itemsPerBox: 10, looseUnits: 7 }, { countedBoxes: 2 }).total, 27);
assert.equal(computeBagStock({ ...base, batches: [{ id: 'loose-lot', stock: 12, looseItems: 12 }] }).totalItems, 12);

assert.equal(computeBagStock({ ...base, unopenedBoxes: 2, itemsPerBox: 10, batches: [{ id: 'metadata', stock: 0, looseItems: 0 }] }).totalItems, 20);
assert.equal(unknown.systemTotal, null);

// Discovering sealed packages on a loose-only record must stay an observation
// when the record provides no unit conversion.
const discoveredSealed = buildAuditCountPlan(base, { countedBoxes: 2, countedLooseUnits: 12 });
assert.equal(discoveredSealed.total, null);
assert.equal(discoveredSealed.unresolved, true);
assert.deepEqual(discoveredSealed.patch, {});
const mixedMissingSize = buildAuditCountPlan({ ...base, batches: [
  { id: 'known', stock: 10, bagCount: 1, itemsPerBag: 10 },
  { id: 'unknown', stock: 0, bagCount: 1 },
] }, { countedBoxes: 2, countedLooseUnits: 7 });
assert.equal(mixedMissingSize.total, null);
assert.equal(mixedMissingSize.systemTotal, null);
assert.equal(mixedMissingSize.unresolved, true);
assert.deepEqual(mixedMissingSize.patch, {});

console.log('Audit count pure write-plan and stock-math cases passed');
