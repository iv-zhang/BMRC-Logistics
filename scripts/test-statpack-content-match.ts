import assert from 'node:assert/strict';
import { findStatpackContentIndex } from '../app/lib/statpack-content-match';

const contents = [
  { itemId: 'opa', pocket: 'Main', compartmentId: 'mesh', batchId: 'a' },
  { itemId: 'opa', pocket: 'Front', compartmentId: 'mesh', batchId: 'b' },
  { itemId: 'opa', pocket: 'Main', compartmentId: 'mesh', batchId: 'c' },
];
const used = new Set<number>();
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa', pocket: 'Front', compartmentId: 'mesh' }, used), 1);
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa', pocket: 'Main', batchId: 'c' }, used), 2);
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa', pocket: 'Missing' }, used), -1);
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa', pocket: 'Front', batchId: 'a' }, used), -1);
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa' }, used), 0, 'legacy unqualified entries still match');
used.add(0);
assert.equal(findStatpackContentIndex(contents, { itemId: 'opa' }, used), 1, 'one entry cannot consume the same content twice');
assert.equal(findStatpackContentIndex([{ itemId: 'aed', serialNumber: 'B' }, { itemId: 'aed', serialNumber: 'A' }], { itemId: 'aed', serialNumber: 'A' }, new Set()), 1);
console.log('Statpack content matching checks passed.');
