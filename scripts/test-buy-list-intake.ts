/** Pure buy-list delivery planner regression cases. Run with tsx. */
import assert from 'node:assert/strict';
import type { BuyListDelivery, BuyListItem } from '../app/types';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
// Guard executes before importing any application Firebase clients.
await import('./emulator/guard');
const { planBuyListDelivery } = await import('../app/lib/buy-list');

const base: BuyListItem = {
  id: 'bl1', itemName: 'Gloves', quantity: 10, unit: 'boxes', priority: 'medium',
  status: 'ordered', addedBy: 'u1', addedAt: new Date(),
};
const delivery = (seq: number, quantity: number, posted: boolean): BuyListDelivery => ({
  seq, quantity, units: quantity * 10, idempotencyKey: `buylist_bl1_${seq}`,
  posted, at: new Date(), by: 'u1',
});

// First delivery: seq 1, key, partial + posted
const p1 = planBuyListDelivery(base, { quantity: 4, final: false, post: true });
assert.equal(p1.seq, 1);
assert.equal(p1.idempotencyKey, 'buylist_bl1_1');
assert.equal(p1.receivedQuantity, 4);
assert.equal(p1.status, 'ordered');
assert.equal(p1.intakeStatus, 'partial');

// Pending entry moves to ordered on a partial delivery
assert.equal(planBuyListDelivery({ ...base, status: 'pending' }, { quantity: 1, final: false, post: true }).status, 'ordered');

// Second partial delivery: distinct key, accumulates
const afterOne: BuyListItem = { ...base, receivedQuantity: 4, deliveries: [delivery(1, 4, true)] };
const p2 = planBuyListDelivery(afterOne, { quantity: 3, final: false, post: true });
assert.equal(p2.seq, 2);
assert.equal(p2.idempotencyKey, 'buylist_bl1_2');
assert.notEqual(p2.idempotencyKey, p1.idempotencyKey);
assert.equal(p2.receivedQuantity, 7);
assert.equal(p2.intakeStatus, 'partial');

// Final flag completes even when short
const fin = planBuyListDelivery(afterOne, { quantity: 3, final: true, post: true });
assert.equal(fin.status, 'received');
assert.equal(fin.intakeStatus, 'posted');

// Reaching (or exceeding) quantity completes
const reach = planBuyListDelivery(afterOne, { quantity: 6, final: false, post: true });
assert.equal(reach.status, 'received');
assert.equal(reach.intakeStatus, 'posted');
assert.equal(planBuyListDelivery(base, { quantity: 12, final: false, post: true }).status, 'received');

// Unknown ordered quantity never auto-completes
assert.equal(planBuyListDelivery({ ...base, quantity: undefined }, { quantity: 99, final: false, post: true }).status, 'ordered');

// Unposted delivery -> needed
assert.equal(planBuyListDelivery(base, { quantity: 10, final: true, post: false }).intakeStatus, 'needed');
// An earlier unposted delivery keeps the entry at needed even if this one posts
const withUnposted: BuyListItem = { ...base, receivedQuantity: 4, deliveries: [delivery(1, 4, false)] };
assert.equal(planBuyListDelivery(withUnposted, { quantity: 6, final: true, post: true }).intakeStatus, 'needed');

// Invalid quantities throw
for (const q of [0, -1, 1.5, NaN]) {
  assert.throws(() => planBuyListDelivery(base, { quantity: q, final: false, post: true }));
}

// Retry stability: same state -> same plan
assert.deepEqual(
  planBuyListDelivery(afterOne, { quantity: 3, final: false, post: true }),
  planBuyListDelivery(afterOne, { quantity: 3, final: false, post: true }),
);

console.log('buy-list intake planner: ok');
process.exit(0);
