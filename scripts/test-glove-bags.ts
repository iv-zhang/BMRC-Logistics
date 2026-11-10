import assert from 'node:assert/strict';
import type { InventoryItem } from '../app/types';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('./emulator/guard');
const { computeBagStock, baseUnitLabel } = await import('../app/lib/item-status');

const gloves = {
  id: 'g', name: 'Nitrile Gloves, M', category: 'PPE', unit: 'bag', baseUnit: 'pair',
  unopenedBoxes: 0, looseUnits: 0, reorderThreshold: 0, location: 'HQ',
  batches: [{ id: 'l', lotNumber: 'x', stock: 17, bagCount: 3, itemsPerBag: 5, looseItems: 2, status: 'sealed' }],
} as unknown as InventoryItem;

const s = computeBagStock(gloves);
assert.equal(s.totalItems, 17);
assert.equal(s.totalBags, 3);
assert.equal(s.totalLoose, 2);
assert.equal(baseUnitLabel(gloves, 17), 'pairs');
assert.equal(baseUnitLabel(gloves, 1), 'pair');
assert.equal(baseUnitLabel({}, 1), 'unit');
assert.equal(baseUnitLabel({}, 4), 'units');
assert.equal(baseUnitLabel({ baseUnit: 'Pairs' }, 2), 'pairs');
console.log('glove bag tests passed');
