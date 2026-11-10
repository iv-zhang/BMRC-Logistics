/** Pure count-velocity cases. Run with tsx. */
import assert from 'node:assert/strict';

const { computeCountVelocity } = await import('../app/lib/count-velocity');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const count = (n: number, units: number) => ({ action: 'audit_box_count', timestamp: day(n), details: { countedTotalUnits: units } });

// Fewer than two counts -> null, never 0.
assert.equal(computeCountVelocity([]).unitsPerWeek, null);
assert.equal(computeCountVelocity([count(0, 50)]).unitsPerWeek, null);
assert.equal(computeCountVelocity([count(0, 50)]).samples, 1);
// Zero elapsed time -> null.
assert.equal(computeCountVelocity([count(0, 50), count(0, 40)]).unitsPerWeek, null);
// 50 -> 36 over 14 days = 7/week (rows given newest-first, like the history query).
const simple = computeCountVelocity([count(14, 36), count(0, 50)]);
assert.equal(simple.unitsPerWeek, 7);
assert.equal(simple.since?.getTime(), day(0).getTime());
assert.equal(simple.samples, 2);
// Intake between counts is added back: 50 + 20 - 36 = 34 over 14 days = 17/week.
const withIntake = computeCountVelocity([count(14, 36), { action: 'intake', timestamp: day(7), quantity: 20 }, count(0, 50)]);
assert.equal(withIntake.unitsPerWeek, 17);
// refill_shelf rows are ignored (already part of reserve usage).
const refill = computeCountVelocity([count(14, 36), { action: 'refill_shelf', createdAt: day(7), quantityChange: -10 }, count(0, 50)]);
assert.equal(refill.unitsPerWeek, 7);
// A count that rose with no intake is skipped; later intervals still count.
const rose = computeCountVelocity([count(21, 40), count(14, 60), count(0, 50)]);
assert.equal(rose.unitsPerWeek, 20);
assert.equal(rose.since?.getTime(), day(14).getTime());
// All intervals unusable -> null.
assert.equal(computeCountVelocity([count(7, 50), count(0, 40)]).unitsPerWeek, null);
// {seconds} maps and unknown totals.
const secs = (n: number) => ({ seconds: day(n).getTime() / 1000, nanoseconds: 0 });
assert.equal(computeCountVelocity([{ action: 'audit_box_count', timestamp: secs(7), details: { countedTotalUnits: 0 } }, { action: 'audit_box_count', timestamp: secs(0), details: { countedTotalUnits: 10 } }]).unitsPerWeek, 10);
assert.equal(computeCountVelocity([count(7, 5), { action: 'audit_box_count', timestamp: day(0), details: { countedTotalUnits: null } }]).unitsPerWeek, null);

console.log('Count velocity cases passed');
