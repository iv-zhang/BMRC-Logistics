import assert from 'node:assert/strict';
import { getStatpackStatusInfo } from '../app/lib/statpack-status';
import {
  getStatpackCheckoutUnavailableReason,
  STATPACK_CHECKOUT_PICKER_STATUSES,
  STATPACK_MAINTENANCE_CHECKOUT_MESSAGE,
} from '../app/lib/statpack-checkout';

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

assert.deepEqual(STATPACK_CHECKOUT_PICKER_STATUSES, ['Ready', 'Restock Needed']);
for (const status of STATPACK_CHECKOUT_PICKER_STATUSES) {
  assert.equal(getStatpackCheckoutUnavailableReason({ status, isCheckedOut: false }), null);
  assert.equal(
    getStatpackCheckoutUnavailableReason({ status, isCheckedOut: true }),
    'Statpack is already checked out',
  );
}
assert.equal(
  getStatpackCheckoutUnavailableReason({ status: 'In Maintenance' }),
  STATPACK_MAINTENANCE_CHECKOUT_MESSAGE,
);
assert.equal(
  getStatpackCheckoutUnavailableReason({ status: 'In Maintenance', isCheckedOut: true }),
  STATPACK_MAINTENANCE_CHECKOUT_MESSAGE,
);
// Expiry verification remains the existing check-off safety gate. This narrow
// maintenance policy must not silently invent a new status/readiness policy.
for (const status of ['Expired Items', 'Pending Initial Check', 'Unexpected status', undefined]) {
  assert.equal(getStatpackCheckoutUnavailableReason({ status }), null);
}
console.log('Statpack checkout eligibility cases passed.');
