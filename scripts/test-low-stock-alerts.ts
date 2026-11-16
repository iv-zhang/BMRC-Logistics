/** Pure regression cases for stockStatusWorsened. Run with tsx. */
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import type { InventoryItem } from '../app/types';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
// Guard executes before importing any application Firebase clients.
await import('./emulator/guard');
const { stockStatusWorsened, withJsBatchDates } = await import('../app/lib/low-stock-alerts');

const base = {
  id: 'low-stock-test', name: 'OPA', category: 'Airway',
  unopenedBoxes: 0, looseUnits: 0, reorderThreshold: 10, location: 'HQ',
  batches: [], tracksExpiration: false, createdAt: new Date(), updatedAt: new Date(),
} as InventoryItem;

// Box-tracked: stock = looseUnits (no itemsPerBox).
const box = (units: number): InventoryItem => ({ ...base, looseUnits: units });
assert.equal(stockStatusWorsened(box(50), box(8)), 'low');     // ok -> low
assert.equal(stockStatusWorsened(box(50), box(0)), 'out');     // ok -> out
assert.equal(stockStatusWorsened(box(8), box(0)), 'out');      // low -> out
assert.equal(stockStatusWorsened(box(50), box(40)), null);     // ok -> ok
assert.equal(stockStatusWorsened(box(8), box(5)), null);       // low -> low
assert.equal(stockStatusWorsened(box(0), box(5)), null);       // out -> low (improved)
assert.equal(stockStatusWorsened(box(0), box(0)), null);       // out -> out
assert.equal(stockStatusWorsened(box(5), box(50)), null);      // improvement

// No reorder threshold: only 'out' can alert.
assert.equal(stockStatusWorsened({ ...box(50), reorderThreshold: 0 }, { ...box(1), reorderThreshold: 0 }), null);
assert.equal(stockStatusWorsened({ ...box(50), reorderThreshold: 0 }, { ...box(0), reorderThreshold: 0 }), 'out');

// Bag-tracked: stock from batches.
const bag = (bags: number, loose: number): InventoryItem => ({
  ...base,
  batches: [{ id: 'lot-a', bagCount: bags, itemsPerBag: 10, looseItems: loose, stock: bags * 10 + loose }],
} as InventoryItem);
assert.equal(stockStatusWorsened(bag(5, 0), bag(1, 0)), 'low');   // 50 -> 10 (<= threshold)
assert.equal(stockStatusWorsened(bag(1, 0), bag(0, 0)), 'out');
assert.equal(stockStatusWorsened(bag(5, 0), bag(4, 5)), null);

// Expired is a different axis: an already-expired item never alerts here.
const past = new Date(Date.now() - 86400000);
const expired = { ...bag(5, 0), batches: [{ id: 'lot-a', bagCount: 5, itemsPerBag: 10, looseItems: 0, stock: 50, expirationDate: past }] } as InventoryItem;
assert.equal(stockStatusWorsened(expired, bag(0, 0)), null);

// Firestore Timestamp batches (as read from snapshot.data()).
const { getItemStatus } = await import('../app/lib/item-status');
const future = Timestamp.fromDate(new Date(Date.now() + 365 * 86400000));
const pastTs = Timestamp.fromDate(new Date(Date.now() - 86400000));
const tsBag = (bags: number, exp: unknown): InventoryItem => ({
  ...base,
  tracksExpiration: true,
  batches: [{ id: 'lot-a', bagCount: bags, itemsPerBag: 10, looseItems: 0, stock: bags * 10, expirationDate: exp }],
} as unknown as InventoryItem);

// Documents the bug: un-normalized future Timestamp reads as expired.
assert.equal(getItemStatus(tsBag(5, future)), 'expired');
// Normalized: in-date item that dropped below threshold alerts.
assert.equal(stockStatusWorsened(withJsBatchDates(tsBag(5, future)), withJsBatchDates(tsBag(1, future))), 'low');
assert.equal(stockStatusWorsened(withJsBatchDates(tsBag(5, future)), withJsBatchDates(tsBag(0, future))), 'out');
// Really past-dated Timestamp batch still reads expired and never alerts.
assert.equal(getItemStatus(withJsBatchDates(tsBag(5, pastTs))), 'expired');
assert.equal(stockStatusWorsened(withJsBatchDates(tsBag(5, pastTs)), withJsBatchDates(tsBag(1, pastTs))), null);
// Legacy {seconds, nanoseconds}, Date, null.
const legacy = withJsBatchDates(tsBag(5, { seconds: 1893456000, nanoseconds: 0 })).batches![0].expirationDate;
assert.ok(legacy instanceof Date && legacy.getTime() === 1893456000 * 1000);
const keepDate = new Date('2031-01-01');
assert.equal(withJsBatchDates(tsBag(5, keepDate)).batches![0].expirationDate, keepDate);
assert.equal(withJsBatchDates(tsBag(5, null)).batches![0].expirationDate, undefined);

console.log('low-stock-alerts: all assertions passed');
process.exit(0);
