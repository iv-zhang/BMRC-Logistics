#!/usr/bin/env node
const assert = require('node:assert/strict');
const {
  NOTES,
  buildLog,
  buildPatch,
  isConflict,
  parseArgs,
  reconcileOne,
} = require('./repair-statpack-checkout-conflicts.cjs');

const actor = { userId: 'admin-uid', userName: 'Logistics Admin' };
assert.deepEqual(parseArgs(['--actor', JSON.stringify(actor)]), { apply: false, actor });
assert.deepEqual(parseArgs(['--actor', JSON.stringify(actor), '--apply']), { apply: true, actor });
assert.throws(() => parseArgs([]), /--actor is required/);
assert.throws(() => parseArgs(['--actor', '{bad json}']), /valid JSON/);
assert.throws(() => parseArgs(['--actor', '{"userId":"x","userName":" "}']), /non-empty string/);

assert.equal(isConflict({ isCheckedOut: true, status: 'Ready' }), true);
assert.equal(isConflict({ isCheckedOut: true, status: 'In Use' }), false);
assert.equal(isConflict({ isCheckedOut: false, status: 'Ready' }), false);
assert.deepEqual(buildPatch(), {
  isCheckedOut: false,
  assignedToUserId: null,
  assignedToUserName: null,
  checkedOutAt: null,
  currentEventId: null,
  currentEvent: null,
});

const pack = {
  id: 'pack-1',
  name: 'BMRC1',
  status: 'Ready',
  isCheckedOut: true,
  currentEventId: 'event-7',
  currentEvent: 'Saturday shift',
};
assert.deepEqual(buildLog(pack, actor, 'SERVER_TIMESTAMP', 'CLIENT_TIME'), {
  statpackId: 'pack-1',
  statpackName: 'BMRC1',
  action: 'checkin',
  notes: NOTES,
  userId: actor.userId,
  userName: actor.userName,
  timestamp: 'SERVER_TIMESTAMP',
  clientTimestamp: 'CLIENT_TIME',
  eventId: 'event-7',
  eventName: 'Saturday shift',
});

function createFakeDb(initialPack) {
  let livePack = initialPack && { ...initialPack };
  const operations = [];
  const logRows = [];
  const db = {
    collection: () => ({ doc: () => ({ id: 'new-log' }) }),
    runTransaction: async (callback) => {
      const pending = [];
      await callback({
        get: async () => ({
          id: 'pack-1',
          exists: Boolean(livePack),
          data: () => livePack,
        }),
        update: (...args) => pending.push({ type: 'update', args }),
        set: (...args) => pending.push({ type: 'set', args }),
      });
      operations.push(...pending);
      for (const operation of pending) {
        if (operation.type === 'update') livePack = { ...livePack, ...operation.args[1] };
        if (operation.type === 'set') logRows.push(operation.args[1]);
      }
    },
  };
  return {
    db,
    operations,
    logRows,
    getLivePack: () => livePack,
    ref: { path: 'statpacks/pack-1' },
  };
}

(async () => {
  const dryDb = createFakeDb({ ...pack, id: 'forged-doc-id', assignedToUserId: null, currentEvent: null });
  const dryRun = await reconcileOne(dryDb.db, { id: 'pack-1', ref: dryDb.ref }, actor, false);
  assert.equal(dryRun.changed, true);
  assert.equal(dryRun.status, 'Ready');
  assert.equal(dryRun.patch.status, undefined, 'repair must leave status untouched');
  assert.equal(dryRun.log.statpackId, 'pack-1', 'snapshot id takes precedence over stored id field');
  assert.equal(dryRun.before.assignedToUserId, null, 'existing null is retained in before display');
  assert.equal(dryRun.before.currentEvent, null, 'existing null is retained in before display');
  assert.equal(dryRun.before.checkedOutAt, '<missing>', 'missing fields are distinguishable from null');
  assert.deepEqual(dryDb.operations, [], 'dry-run transaction must perform no writes');

  const appliedDb = createFakeDb({ ...pack });
  await reconcileOne(appliedDb.db, { id: 'pack-1', ref: appliedDb.ref }, actor, true);
  assert.equal(appliedDb.operations.length, 2, 'statpack update and audit log are one transaction');
  assert.equal(appliedDb.operations[0].type, 'update');
  assert.equal(appliedDb.operations[0].args[0].path, 'statpacks/pack-1');
  assert.deepEqual(appliedDb.operations[0].args[1], buildPatch());
  assert.equal(appliedDb.operations[1].type, 'set');
  assert.equal(appliedDb.operations[1].args[0].id, 'new-log');
  assert.equal(appliedDb.operations[1].args[1].action, 'checkin');
  assert.equal(appliedDb.operations[1].args[1].notes, NOTES);
  assert.equal(appliedDb.operations[1].args[1].eventId, 'event-7');
  assert.equal(appliedDb.operations[1].args[1].userId, actor.userId);
  assert.equal(appliedDb.getLivePack().status, 'Ready', 'repair preserves existing status');
  assert.equal(appliedDb.getLivePack().isCheckedOut, false);

  const secondRun = await reconcileOne(appliedDb.db, { id: 'pack-1', ref: appliedDb.ref }, actor, true);
  assert.equal(secondRun.changed, false, 'second run sees no conflict and is idempotent');
  assert.equal(appliedDb.operations.length, 2, 'second run writes nothing');

  const noLongerConflictDb = createFakeDb({ ...pack, status: 'In Use' });
  const noLongerConflict = await reconcileOne(noLongerConflictDb.db, { id: 'pack-1', ref: noLongerConflictDb.ref }, actor, true);
  assert.equal(noLongerConflict.changed, false);
  assert.deepEqual(noLongerConflictDb.operations, [], 'transaction rechecks live predicate before writing');

  const checkedInDb = createFakeDb({ ...pack, isCheckedOut: false });
  const checkedIn = await reconcileOne(checkedInDb.db, { id: 'pack-1', ref: checkedInDb.ref }, actor, true);
  assert.equal(checkedIn.changed, false, 'transaction skips when live checkout flag was cleared');
  assert.deepEqual(checkedInDb.operations, []);

  const deletedDb = createFakeDb(null);
  const deleted = await reconcileOne(deletedDb.db, { id: 'pack-1', ref: deletedDb.ref }, actor, true);
  assert.equal(deleted.changed, false, 'transaction skips a deleted pack');
  assert.deepEqual(deletedDb.operations, []);

  console.log('Statpack checkout conflict repair cases passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
