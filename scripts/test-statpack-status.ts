import assert from 'node:assert/strict';
import { getStatpackStatusInfo } from '../app/lib/statpack-status';
import { buildStatpackAuditUpdate } from '../app/lib/statpack-audit';
import {
  getStatpackCheckoutUnavailableReason,
  isStatpackCheckinPickerEligible,
  isStatpackCheckoutPickerEligible,
  sortStatpacksByName,
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

// Picker filters run client-side (issue #23); a missing status counts as Ready.
for (const pack of [{ status: 'Ready' }, { status: 'Restock Needed' }, {}, { status: undefined, isCheckedOut: false }]) {
  assert.equal(isStatpackCheckoutPickerEligible(pack), true, JSON.stringify(pack));
}
for (const pack of [
  { status: 'Ready', isCheckedOut: true },
  { status: 'In Maintenance' },
  { status: 'In Use' },
  { status: 'Expired Items' },
  { status: 'Pending Initial Check' },
  { status: 'CRITICAL - EXPIRED ITEMS' },
]) {
  assert.equal(isStatpackCheckoutPickerEligible(pack), false, JSON.stringify(pack));
}
for (const pack of [{ status: 'In Use' }, { status: 'Ready', isCheckedOut: true }]) {
  assert.equal(isStatpackCheckinPickerEligible(pack), true, JSON.stringify(pack));
}
const liveConflict = { status: 'Ready', isCheckedOut: true };
assert.equal(isStatpackCheckoutPickerEligible(liveConflict), false, 'a checked-out Ready pack is unavailable for checkout');
assert.equal(isStatpackCheckinPickerEligible(liveConflict), true, 'a checked-out Ready pack remains available for check-in');
for (const pack of [{ status: 'Ready' }, {}]) {
  assert.equal(isStatpackCheckinPickerEligible(pack), false, JSON.stringify(pack));
}
const unsorted = [{ name: 'b' }, {}, { name: 'a' }];
assert.deepEqual(sortStatpacksByName(unsorted), [{}, { name: 'a' }, { name: 'b' }]);
assert.deepEqual(unsorted, [{ name: 'b' }, {}, { name: 'a' }]);
console.log('Statpack picker eligibility cases passed.');

const auditTime = new Date('2026-10-28T12:00:00.000Z');
const checkedOutAuditPack = {
  status: 'In Use',
  isCheckedOut: true,
  assignedToUserId: 'member-1',
  assignedToUserName: 'Member One',
  checkedOutAt: new Date('2026-10-27T12:00:00.000Z'),
  currentEventId: 'event-1',
};
const auditPatch = buildStatpackAuditUpdate(checkedOutAuditPack, 'Ready', auditTime, 'Auditor');
assert.equal('status' in auditPatch, false, 'audit never writes derived status over live custody');
assert.deepEqual({ ...checkedOutAuditPack, ...auditPatch }, {
  ...checkedOutAuditPack,
  lastAuditAt: auditTime,
  lastAuditBy: 'Auditor',
});
assert.deepEqual(buildStatpackAuditUpdate({ isCheckedOut: false }, 'Ready', auditTime, 'Auditor'), {
  status: 'Ready', lastAuditAt: auditTime, lastAuditBy: 'Auditor',
});
assert.deepEqual(buildStatpackAuditUpdate({ isCheckedOut: false }, 'Restock Needed', auditTime, 'Auditor').status, 'Restock Needed');
assert.deepEqual(buildStatpackAuditUpdate({ isCheckedOut: false }, 'Expired Items', auditTime, 'Auditor').status, 'Expired Items');
const conflictedAuditPack = { isCheckedOut: true, status: 'Ready' };
const conflictedAuditPatch = buildStatpackAuditUpdate(conflictedAuditPack, 'Restock Needed', auditTime, 'Auditor');
assert.equal('status' in conflictedAuditPatch, false, 'audit preserves an existing status/custody conflict for explicit reconciliation');
console.log('Statpack audit custody/status cases passed.');
