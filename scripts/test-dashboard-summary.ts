import assert from 'node:assert/strict';
import type { InventoryItem, Statpack } from '@/app/types';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('./emulator/guard');
const { DEFAULT_ORG_CONFIG } = await import('@/app/config/org-config');
const { applyOrgConfigDoc } = await import('@/app/lib/org-config-store');
const { getDashboardExpiryAlerts, getLowReserveItems, hydrateDashboardInventory, hydrateDashboardPack } = await import('@/app/lib/dashboard-summary');

const now = new Date('2026-10-17T12:00:00.000Z');
const timestamp = (date: Date) => ({ toDate: () => date });
const item = (id: string, extra: Partial<InventoryItem> = {}) => ({
  id, name: id, category: 'Medical Supplies', unopenedBoxes: 0, reorderThreshold: 0, location: 'HQ',
  ...extra,
}) as InventoryItem;

const hydratedInventory = hydrateDashboardInventory('h1', {
  name: 'Hydrated', lastAuditDate: timestamp(new Date('2026-10-01')),
  lastShelfCheckAt: '2026-10-02T00:00:00.000Z',
  batches: [{ stock: 2, expirationDate: timestamp(new Date('2026-11-01')) },
    { stock: 1, expirationDate: 'not-a-date' }],
});
assert.equal(hydratedInventory.id, 'h1');
assert.ok(hydratedInventory.batches?.[0].expirationDate instanceof Date);
assert.equal(hydratedInventory.batches?.[1].expirationDate, undefined);
assert.ok(hydratedInventory.lastAuditDate instanceof Date);
assert.ok(hydratedInventory.lastShelfCheckAt instanceof Date);
assert.deepEqual(hydrateDashboardInventory('empty', { name: 'Empty' }).batches, []);
const hydratedPack = hydrateDashboardPack('p1', {
  name: 'Pack one', lastCheckedAt: timestamp(new Date('2026-10-16')),
  contents: [{ expirationDate: '2026-10-20T00:00:00.000Z' },
    { expirationDate: 'invalid' }],
});
assert.ok(hydratedPack.contents[0].expirationDate instanceof Date);
assert.equal(hydratedPack.contents[1].expirationDate, undefined);
assert.ok(hydratedPack.lastCheckedAt instanceof Date);
assert.deepEqual(hydrateDashboardPack('empty', { name: 'Empty' }).contents, []);

const low = getLowReserveItems([
  item('loose-low', { looseUnits: 2, reorderThreshold: 2 }),
  item('misleading-legacy-total', { unopenedBoxes: 0, totalStockQuantity: 500, reorderThreshold: 1 }),
  item('expired-only', { batches: [{ id: 'e', stock: 2, bagCount: 1, itemsPerBag: 2, expirationDate: new Date('2026-01-01') }], reorderThreshold: 1 }),
  item('quarantined-only', { batches: [{ id: 'q', stock: 2, bagCount: 1, itemsPerBag: 2, status: 'quarantined' }], reorderThreshold: 1 }),
  item('shelf-does-not-offset', { shelfQuantity: 99, reorderThreshold: 0 }),
  item('zero-without-threshold', {}),
  item('oxygen-excluded', { isOxygen: true, reorderThreshold: 10 }),
  item('adequate', { looseUnits: 3, reorderThreshold: 2 }),
]);
assert.deepEqual(low.map(i => i.id), ['loose-low', 'misleading-legacy-total', 'expired-only', 'quarantined-only', 'shelf-does-not-offset', 'zero-without-threshold']);
assert.ok(low.find(i => i.id === 'expired-only')!.batches![0].bagCount! * low.find(i => i.id === 'expired-only')!.batches![0].itemsPerBag! > 0);
assert.ok(low.find(i => i.id === 'quarantined-only')!.batches![0].bagCount! * low.find(i => i.id === 'quarantined-only')!.batches![0].itemsPerBag! > 0);

applyOrgConfigDoc({ ...DEFAULT_ORG_CONFIG, thresholds: { ...DEFAULT_ORG_CONFIG.thresholds, expirationWarningDays: 5 } });
const realAlerts = getDashboardExpiryAlerts([
  { id: 'pack1', name: 'Medic 1', contents: [
    { itemId: 'x', batchId: 'b', requiredQuantity: 2, currentQuantity: 0, expirationDate: new Date('2026-10-18') },
    { itemId: 'y', batchId: 'b', requiredQuantity: 1, currentQuantity: 1, expirationDate: timestamp(new Date('2026-10-20')) },
  ] },
] as unknown as Statpack[], [
  item('reserve', { room: 'Back Room', batches: [
    { id: 'stocked', stock: 1, expirationDate: new Date('2026-10-19') },
    { id: 'tombstone', stock: 0, expirationDate: new Date('2026-10-18') },
    { id: 'late', stock: 1, expirationDate: new Date('2026-11-01') },
  ] }),
], now);
assert.deepEqual(realAlerts.map(a => [a.src, a.loc]), [['Reserve', 'HQ › Back Room'], ['Pack', 'Medic 1']]);
assert.deepEqual(realAlerts.map(a => a.daysLeft), [2, 3]);

const recentlyExpired = getDashboardExpiryAlerts([], [item('expired-today', { batches: [{ id: 'today', stock: 1, expirationDate: new Date(now.getTime() - 3600000) }] })], now);
assert.equal(recentlyExpired[0].daysLeft, -1);

console.log('Dashboard summary regressions passed');

applyOrgConfigDoc(undefined);
