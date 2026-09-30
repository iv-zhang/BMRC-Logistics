/**
 * Existence (confirmed / unverified / retired) derivation and the lib selectors
 * that exclude non-confirmed items from alerts and restock.
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/existence.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 * `retireInventoryItem` writes to Firestore and is not exercised here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getExistence, isConfirmedItem, EXISTENCE_BASELINE_CUTOFF } from '../item-status';
import { analyzeRestockNeeds, type DisposableSnapshot } from '../audit-helpers';
import { buildExceptions } from '../reconciliation';
import { computeStorageRollups } from '../storage-analytics';
import type { InventoryItem } from '@/app/types';

const before = new Date(2026, 4, 31, 23, 59); // May 31 2026
const onCutoff = new Date(2026, 5, 1, 0, 0); // Jun 1 2026 00:00
const after = new Date(2026, 8, 1); // Sep 1 2026

const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    category: 'Other',
    unopenedBoxes: 0,
    itemsPerBox: 1,
    reorderThreshold: 5,
    location: 'HQ',
    tracksExpiration: false,
    storageLocation: { zoneId: 'z1' },
    createdAt: after,
    updatedAt: after,
    ...extra,
  }) as unknown as InventoryItem;

describe('getExistence', () => {
  it('cutoff is June 1 2026 (local)', () => {
    assert.equal(EXISTENCE_BASELINE_CUTOFF.getFullYear(), 2026);
    assert.equal(EXISTENCE_BASELINE_CUTOFF.getMonth(), 5);
    assert.equal(EXISTENCE_BASELINE_CUTOFF.getDate(), 1);
  });
  it('confirmed when audited on/after the cutoff', () => {
    assert.equal(getExistence({ lastAuditDate: onCutoff }), 'confirmed');
    assert.equal(getExistence({ lastAuditDate: after }), 'confirmed');
  });
  it('unverified when audited before the cutoff or never', () => {
    assert.equal(getExistence({ lastAuditDate: before }), 'unverified');
    assert.equal(getExistence({}), 'unverified');
    assert.equal(getExistence({ lastAuditDate: new Date('nope') }), 'unverified');
  });
  it('retired wins over a fresh audit date', () => {
    assert.equal(getExistence({ existence: 'retired', lastAuditDate: after }), 'retired');
  });
  it('ignores stored confirmed/unverified (derived, not asserted)', () => {
    assert.equal(getExistence({ existence: 'confirmed' }), 'unverified');
    assert.equal(getExistence({ existence: 'unverified', lastAuditDate: after }), 'confirmed');
  });
  it('coerces Timestamp-like values', () => {
    const ts = { toDate: () => after } as unknown as Date;
    assert.equal(getExistence({ lastAuditDate: ts }), 'confirmed');
  });
  it('isConfirmedItem mirrors it', () => {
    assert.equal(isConfirmedItem({ lastAuditDate: after }), true);
    assert.equal(isConfirmedItem({ existence: 'retired', lastAuditDate: after }), false);
    assert.equal(isConfirmedItem({}), false);
  });
});

describe('analyzeRestockNeeds excludes non-confirmed items', () => {
  const snap = (id: string, existence?: DisposableSnapshot['existence']): DisposableSnapshot => ({
    id,
    name: id,
    category: 'Other',
    location: 'HQ',
    unopenedBoxes: 0,
    itemsPerBox: 1,
    totalUnits: 0,
    openBatchUnits: 0,
    reorderThreshold: 5,
    isLowStock: false,
    isOut: true,
    isExpired: false,
    auditVerified: false,
    existence,
  });

  it('keeps confirmed, drops unverified and retired', () => {
    const out = analyzeRestockNeeds([
      snap('a', 'confirmed'),
      snap('b', 'unverified'),
      snap('c', 'retired'),
    ]);
    assert.deepEqual(out.map((d) => d.itemId), ['a']);
  });
  it('treats a missing existence as confirmed (hand-built snapshots)', () => {
    assert.equal(analyzeRestockNeeds([snap('a')]).length, 1);
  });
});

describe('buildExceptions skips non-confirmed items', () => {
  it('raises nothing for unverified or retired items, still flags confirmed ones', () => {
    const noLoc = { storageLocation: undefined, location: undefined, room: undefined };
    const ex = buildExceptions(
      [
        item('confirmed-ghost', { ...noLoc, lastAuditDate: after }),
        item('unverified-ghost', { ...noLoc }),
        item('retired-ghost', { ...noLoc, existence: 'retired', lastAuditDate: after }),
      ],
      [],
    );
    const ids = new Set(ex.map((e) => e.itemId));
    assert.equal(ids.has('confirmed-ghost'), true);
    assert.equal(ids.has('unverified-ghost'), false);
    assert.equal(ids.has('retired-ghost'), false);
  });
});

describe('computeStorageRollups excludes non-confirmed from alerts', () => {
  it('counts every item but only confirmed ones feed low/out/restock', () => {
    const r = computeStorageRollups([
      item('confirmed-out', { lastAuditDate: after }),
      item('unverified-out'),
      item('retired-out', { existence: 'retired', lastAuditDate: after }),
    ]).byZone.get('z1');
    assert.ok(r);
    assert.equal(r.itemCount, 3);
    assert.equal(r.out, 1);
    assert.deepEqual(r.restockItems.map((x) => x.id), ['confirmed-out']);
  });
});
