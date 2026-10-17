import assert from 'node:assert/strict';
import { statpackEntryKey } from '../app/lib/statpack-entry-identity';
import type { StatpackItem } from '../app/types';

const main: StatpackItem = {
  itemId: 'airway-80', batchId: 'lot:1', compartmentId: 'shared', pocket: 'main',
  requiredQuantity: 2, currentQuantity: 1,
};
const side: StatpackItem = { ...main, pocket: 'side_left', currentQuantity: 4, requiredQuantity: 5 };
const key = statpackEntryKey(main);
assert.notEqual(key, statpackEntryKey(side), 'same SKU/compartment in two pockets must be independent');
for (const field of ['itemId', 'batchId', 'compartmentId', 'variantId', 'assetInstanceId', 'serialNumber'] as const) {
  assert.notEqual(key, statpackEntryKey({ ...main, [field]: 'another' }), `${field} identifies a physical entry`);
}
const recounted: StatpackItem = { ...main, currentQuantity: 0, requiredQuantity: 9, variantName: 'renamed' };
assert.equal(key, statpackEntryKey(recounted), 'counts and labels cannot reset identity');
assert.deepEqual([side, main].map(statpackEntryKey).sort(), [main, side].map(statpackEntryKey).sort(), 'reordering cannot move state');
assert.notEqual(statpackEntryKey({ ...main, itemId: 'a:b', batchId: 'c' }), statpackEntryKey({ ...main, itemId: 'a', batchId: 'b:c' }), 'delimiters in IDs cannot collide');
// All UI maps share this key: changes and resolutions on one physical row must
// leave the other row unchanged, including when preparing a touched-only return.
const counts = { [key]: 0, [statpackEntryKey(side)]: 4 };
const verified = new Set([key]);
const checks = { [key]: { exp: '2030-01' } };
const resolved = { [key]: 'restocked' };
assert.equal(counts[statpackEntryKey(side)], 4);
assert.equal(verified.has(statpackEntryKey(side)), false);
assert.equal(checks[statpackEntryKey(side)], undefined);
assert.equal(resolved[statpackEntryKey(side)], undefined);
const touched = [main, side].filter(it => verified.has(statpackEntryKey(it)));
assert.equal(touched.length, 1);
assert.equal(touched[0].pocket, 'main');
assert.equal(touched[0].compartmentId, 'shared');
assert.equal(touched[0].itemId, 'airway-80', 'UI keys never replace the persisted SKU');
console.log('statpack entry identity: passed');
