import assert from 'node:assert/strict';
import { getStatpackStatusInfo } from '../app/lib/statpack-status';

const knownStatuses = [
  'Ready',
  'Restock Needed',
  'Expired Items',
  'CRITICAL - EXPIRED ITEMS',
  'In Use',
  'Pending Initial Check',
  'In Maintenance',
];

for (const status of knownStatuses) {
  assert.equal(getStatpackStatusInfo(status).label, status);
}

assert.equal(getStatpackStatusInfo(undefined).label, 'Unknown');
assert.equal(getStatpackStatusInfo(null).label, 'Unknown');
assert.equal(getStatpackStatusInfo('Unexpected status').label, 'Unknown');
assert.equal(getStatpackStatusInfo('__proto__').label, 'Unknown');
assert.equal(getStatpackStatusInfo('constructor').label, 'Unknown');
assert.equal(getStatpackStatusInfo('toString').label, 'Unknown');
assert.notEqual(getStatpackStatusInfo(undefined).color, getStatpackStatusInfo('Ready').color);

console.log('Statpack status mapping cases passed.');
